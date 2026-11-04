// 扫描模块：递归发现目录与文件，符号链接循环保护，chokidar 监听 + 防抖重扫。
// 逐项处理在 createScanWalk 的帧栈驱动器里（深度优先、按 readdir 顺序），
// scanTreeAsync 按时间片推进它，扫描期间不阻塞事件循环。
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import chokidar from 'chokidar';
import { EventEmitter } from 'node:events';
import { withActivity, SLOW_FS_OP_MS } from './lagWatch.js';
import { fsErrorText } from './fsErrors.js';

export const SUPPORTED_EXTS = ['.md', '.json', '.txt', '.doc', '.docx', '.html', '.htm'];
// 元数据旁注文件：<原文件名>.meta.json，不出现在目录树/检索中
export const SIDECAR_SUFFIX = '.meta.json';
export const TRASH_DIR = '.trash'; // 数据源根目录下的应用回收站（不扫描）
export const isSidecar = (name) => String(name).toLowerCase().endsWith(SIDECAR_SUFFIX);
// 派生文件（划线笔记记录）：.<笔记名>.annotations.json —— 默认不在文件树显示，可在设置中打开
export const isAnnotations = (name) => /\.annotations\.json$/i.test(name);
export const isMetaFile = (name) => isSidecar(name) || isAnnotations(name);

// 异步扫描的单片时间预算：每处理约 30ms 用 setImmediate 让出一次事件循环
export const SCAN_SLICE_MS = 30;

function toRel(baseDir, abs) {
  return path.relative(baseDir, abs).split(path.sep).join('/');
}

// 自然排序：带编号内容按数字段比较
export function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const ta = String(a).match(re) || [];
  const tb = String(b).match(re) || [];
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    if (ta[i] === undefined) return -1;
    if (tb[i] === undefined) return 1;
    const na = /^\d+$/.test(ta[i]) ? Number(ta[i]) : null;
    const nb = /^\d+$/.test(tb[i]) ? Number(tb[i]) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na - nb;
    } else {
      const c = ta[i].localeCompare(tb[i], 'zh-CN');
      if (c !== 0) return c;
    }
  }
  return 0;
}

// 同一目录内 stat 预取的在途上限
const STAT_CONCURRENCY = 16;
// realpath 用 Node 的 JS 实现（逐段 lstat），与原同步版 realpathSync 同一实现；
// fs.promises.realpath 走系统原生实现，在部分 Windows 虚拟盘、网络盘上会失败。
const realpathAsync = promisify(fs.realpath);

// 扫描核心：显式帧栈模拟原递归遍历（深度优先，遇到子目录立即下钻）。
// 文件系统调用全部异步；同一目录里需要的 stat 以滑动窗口预取（最多 STAT_CONCURRENCY 个在途），
// 目录项仍按 readdir 原顺序逐个处理，输出与逐项同步处理一致。
// step(budgetMs) 处理若干目录项直到预算用尽；finish() 排序并产出最终结果；
// slowOps() 给出超过 SLOW_FS_OP_MS 的单次调用次数与最慢一次。
function createScanWalk(baseDir, opts = {}) {
  const showMetaFiles = !!opts.showMetaFiles;
  const files = [];
  const dirs = []; // 全部子目录相对路径（含空目录）
  const sidecars = []; // 元数据旁注文件相对路径
  const metaFiles = []; // 派生文件（.annotations.json）相对路径，按开关决定是否进 files
  const derivedFiles = []; // .derived/ 目录内的文件，开关打开时显示（不进 files，避免被索引/检索）
  const dirErrors = []; // { path, reason }
  const fileErrors = [];
  let dirCount = 0;
  let emptyDirCount = 0;
  let scanned = 0; // 已遍历并收入 files 的文件数
  const visited = new Set(); // realpath 防循环
  const slow = { count: 0, maxMs: 0, op: '', path: '' };
  // 帧：{ absDir, relDir, derived, entries|null, index, ahead（已发起预取的下标）, stats（下标 -> 预取结果）, hasContent }
  const newFrame = (absDir, relDir, derived) => ({ absDir, relDir, derived, entries: null, index: 0, ahead: 0, stats: [], hasContent: false });
  const stack = [newFrame(baseDir, '', false)];

  // 计时包装：结果统一为 { value } 或 { error }，预取中的失败不会成为未处理的拒绝
  function timed(op, rel, promise) {
    const t0 = Date.now();
    const note = () => {
      const ms = Date.now() - t0;
      if (ms <= SLOW_FS_OP_MS) return;
      slow.count++;
      if (ms > slow.maxMs) Object.assign(slow, { maxMs: ms, op, path: rel });
    };
    return promise.then(
      (value) => { note(); return { value }; },
      (error) => { note(); return { error }; },
    );
  }

  // 帧初始化：realpath/循环检查、readdir、目录计数。失败记 dirErrors 后放弃该帧。
  async function initFrame(frame) {
    const where = frame.relDir || '.';
    if (frame.derived) {
      // .derived/ 内所有文件都收（jsonl/graphml 等不受 SUPPORTED_EXTS 限制），仅作展示
      const list = await timed('readdir', where, fs.promises.readdir(frame.absDir, { withFileTypes: true }));
      if (list.error) return false;
      frame.entries = list.value;
      return true;
    }
    const real = await timed('realpath', where, realpathAsync(frame.absDir));
    if (real.error) {
      dirErrors.push({ path: where, reason: '无法解析目录：' + fsErrorText(real.error) });
      return false;
    }
    if (visited.has(real.value)) return false; // 符号链接循环
    visited.add(real.value);
    const list = await timed('readdir', where, fs.promises.readdir(frame.absDir, { withFileTypes: true }));
    if (list.error) {
      dirErrors.push({ path: where, reason: '目录不可读：' + fsErrorText(list.error) });
      return false;
    }
    frame.entries = list.value;
    dirCount++;
    if (frame.relDir) dirs.push(frame.relDir);
    return true;
  }

  // 普通文件是否收入 files：旁注与派生文件默认隐藏，开关打开时作为普通 JSON；其余按扩展名
  const keepsFile = (name) =>
    (showMetaFiles || (!isSidecar(name) && !isAnnotations(name))) && SUPPORTED_EXTS.includes(path.extname(name).toLowerCase());

  // 逐项处理时会用到 stat 的目录项：符号链接（跟随判断类型）、要收入的文件、.derived/ 内的文件
  function needsStat(frame, ent) {
    if (frame.derived) return !ent.name.startsWith('.') && !ent.isDirectory() && ent.isFile();
    if (ent.isSymbolicLink()) return true;
    return ent.isFile() && keepsFile(ent.name);
  }

  // 为当前帧下标 [index, index + STAT_CONCURRENCY) 内需要的目录项发起 stat
  function prefetch(frame) {
    const end = Math.min(frame.entries.length, frame.index + STAT_CONCURRENCY);
    for (; frame.ahead < end; frame.ahead++) {
      const ent = frame.entries[frame.ahead];
      if (!needsStat(frame, ent)) continue;
      const abs = path.join(frame.absDir, ent.name);
      frame.stats[frame.ahead] = timed('stat', toRel(baseDir, abs), fs.promises.stat(abs));
    }
  }

  function handleDerivedEntry(frame, ent, res) {
    if (ent.name.startsWith('.')) return;
    const abs = path.join(frame.absDir, ent.name);
    const rel = frame.relDir + '/' + ent.name;
    if (ent.isDirectory()) {
      dirs.push(rel);
      stack.push(newFrame(abs, rel, true));
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      metaFiles.push(rel);
      if (res.error) return; // 忽略读不到的文件
      derivedFiles.push({
        path: rel,
        name: ent.name,
        base: ent.name.slice(0, ent.name.length - ext.length),
        ext,
        dir: frame.relDir,
        size: res.value.size,
        mtimeMs: res.value.mtimeMs,
      });
    }
  }

  function handleEntry(frame, ent, res) {
    const abs = path.join(frame.absDir, ent.name);
    const rel = toRel(baseDir, abs);
    let isDir = ent.isDirectory();
    let isFile = ent.isFile();
    if (ent.isSymbolicLink()) {
      // 跟随符号链接
      if (res.error) {
        fileErrors.push({ path: rel, reason: '访问失败：' + fsErrorText(res.error) });
        return;
      }
      isDir = res.value.isDirectory();
      isFile = res.value.isFile();
    }
    if (isDir) {
      if (!frame.relDir && ent.name === TRASH_DIR) return;
      if (ent.name.startsWith('.')) {
        // .derived/：加工数据目录，受「显示元数据文件」开关控制
        if (ent.name === '.derived' && showMetaFiles) {
          dirs.push(rel);
          frame.hasContent = true;
          stack.push(newFrame(abs, rel, true));
        }
        return; // 其余隐藏目录（.git / .trash 等）一律不扫描
      }
      frame.hasContent = true;
      stack.push(newFrame(abs, rel, false));
    } else if (isFile) {
      const ext = path.extname(ent.name).toLowerCase();
      if (isSidecar(ent.name)) {
        sidecars.push(rel);
        metaFiles.push(rel);
      }
      // 派生文件（划线记录）：默认只收进 metaFiles；开关打开时才当普通文件
      if (isAnnotations(ent.name)) metaFiles.push(rel);
      if (!keepsFile(ent.name)) return;
      frame.hasContent = true;
      if (res.error) {
        fileErrors.push({ path: rel, reason: '无法读取文件信息：' + fsErrorText(res.error) });
        return;
      }
      files.push({
        path: rel,
        name: ent.name,
        base: ent.name.slice(0, ent.name.length - ext.length),
        ext,
        dir: frame.relDir || '',
        size: res.value.size,
        mtimeMs: res.value.mtimeMs,
      });
      scanned++;
    }
  }

  // 推进遍历：处理目录项直到栈空（done）或时间预算用尽。
  async function step(budgetMs) {
    const start = Date.now();
    for (;;) {
      const frame = stack[stack.length - 1];
      if (!frame) return { done: true, scanned };
      if (!frame.entries && !(await initFrame(frame))) {
        stack.pop();
        continue;
      }
      if (frame.index >= frame.entries.length) {
        if (!frame.derived && !frame.hasContent) emptyDirCount++;
        stack.pop();
        continue;
      }
      prefetch(frame);
      const i = frame.index++;
      const ent = frame.entries[i];
      const pending = frame.stats[i];
      frame.stats[i] = undefined;
      const res = pending ? await pending : null;
      if (frame.derived) handleDerivedEntry(frame, ent, res);
      else handleEntry(frame, ent, res);
      if (Date.now() - start >= budgetMs) return { done: false, scanned };
    }
  }

  function finish() {
    files.sort((a, b) => naturalCompare(a.path, b.path));
    derivedFiles.sort((a, b) => naturalCompare(a.path, b.path));
    dirs.sort(naturalCompare);
    return { files, dirs, sidecars, metaFiles, derivedFiles, dirCount, dirErrors, fileErrors, emptyDirCount };
  }

  return { step, finish, slowOps: () => ({ ...slow }) };
}

// 分片异步扫描：每遍历约 30ms 让出一次事件循环，扫描期间后端请求与轮询不被阻塞。
// opts.onProgress(scanned) 在每次让出时回调已遍历文件数。
// 结束时若有单次 stat/readdir/realpath 超过 SLOW_FS_OP_MS，记一行 WARN（次数与最慢一次）。
export async function scanTreeAsync(baseDir, opts = {}) {
  const walk = createScanWalk(baseDir, opts);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  for (;;) {
    const r = await walk.step(SCAN_SLICE_MS);
    if (onProgress) onProgress(r.scanned);
    if (r.done) {
      const slow = walk.slowOps();
      if (slow.count) {
        console.warn(`[scan] 慢文件操作：${baseDir} 扫描中 ${slow.count} 次超过 ${SLOW_FS_OP_MS}ms，最慢 ${slow.maxMs}ms（${slow.op} ${slow.path}）`);
      }
      return walk.finish();
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export class Scanner extends EventEmitter {
  constructor() {
    super();
    this.baseDir = null;
    this.snapshot = null; // { files, dirCount, dirErrors, fileErrors, scannedAt }
    this.running = false; // 扫描进行中：rescan 一开始即为 true（防重入、等待扫描结束用）
    // 对外状态（scanning / scanned）只在进度上报点更新：首个时间片上报后 scanning 才为 true，
    // 状态里不会出现“扫描中但一个文件都没遍历”的中间态（与原同步首片一致）
    this.scanning = false;
    this.scanned = 0; // 扫描期间已遍历的文件数（非扫描期为 0）
    this.watcher = null;
    this.generation = 0;
    this._debounce = null;
    this.showMetaFiles = false; // 由外部按设置注入；true 时 annotations 等派生文件也进 files
    // 根目录不可达（移动硬盘拔出、网络盘断开、目录被移走）：{ since, reason }。
    // 期间保留上一份快照、关掉失效的监听，并定时探测；目录回来后自动重扫并重开监听。
    this.unreachable = null;
    this.probeIntervalMs = 5000;
    this._probe = null;
    this._watchWanted = false; // 调用过 startWatch 且未 stopWatch：恢复可达后据此重开监听
  }

  setBaseDir(baseDir) {
    this.stopWatch();
    this.baseDir = baseDir;
    this.snapshot = null;
    this.unreachable = null;
    this.generation++;
  }

  async rescan() {
    if (!this.baseDir) return null;
    if (this.running) return this.snapshot;
    this.running = true;
    this.scanned = 0;
    this.emit('scan-start');
    const t0 = Date.now();
    // 进度事件节流到 250ms（启动页与状态轮询共用，末尾再补一次终值）
    let lastProgress = 0;
    try {
      const result = await withActivity('扫描 ' + path.basename(this.baseDir), () =>
        scanTreeAsync(this.baseDir, {
          showMetaFiles: this.showMetaFiles,
          onProgress: (n) => {
            this.scanning = true;
            this.scanned = n;
            const now = Date.now();
            if (now - lastProgress >= 250) {
              lastProgress = now;
              this.emit('scan-progress', { scanned: n });
            }
          },
        })
      );
      if (result.dirErrors.some((e) => e.path === '.')) {
        const err = await fs.promises.access(this.baseDir).then(() => null, (e) => e);
        this._enterUnreachable(err ? fsErrorText(err) : '无法访问');
        if (this.snapshot) {
          // 保留上一份快照、不发 scan-done：空结果会让文本/内链/RAG 索引把全部文档当成已删除
          console.warn('[scan] 知识库目录不可访问，保留上次扫描结果: ' + this.baseDir + '（' + this.unreachable.reason + '）');
          return this.snapshot;
        }
      } else if (this.unreachable || (this._watchWanted && !this.watcher)) {
        this._leaveUnreachable();
      }
      this.scanned = result.files.length;
      this.emit('scan-progress', { scanned: this.scanned });
      this.snapshot = { ...result, scannedAt: new Date().toISOString() };
      console.log('[scan] 扫描完成: ' + this.baseDir + '，' + result.files.length + ' 个文件，耗时 ' + (Date.now() - t0) + 'ms');
      this.emit('scan-done', this.snapshot);
      return this.snapshot;
    } finally {
      this.running = false;
      this.scanning = false;
      this.scanned = 0;
    }
  }

  startWatch() {
    this._watchWanted = true;
    if (!this.unreachable) this._openWatcher(); // 不可达期间只记意图，恢复后由 _leaveUnreachable 打开
  }

  stopWatch() {
    this._watchWanted = false;
    this._closeWatcher();
    clearTimeout(this._probe);
    this._probe = null;
  }

  _openWatcher() {
    this._closeWatcher();
    if (!this.baseDir) return;
    try {
      this.watcher = chokidar.watch(this.baseDir, {
        ignoreInitial: true,
        depth: 30,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      });
      const trigger = () => {
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => this.rescan(), 600);
      };
      this.watcher.on('all', trigger);
      // 监听出错（如 Windows 上根目录被删）也重扫一次：由扫描结果判断是否已不可达
      this.watcher.on('error', (e) => {
        this.emit('watch-error', e);
        trigger();
      });
    } catch (e) {
      this.emit('watch-error', e);
    }
  }

  _closeWatcher() {
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* ignore */ }
      this.watcher = null;
    }
    clearTimeout(this._debounce);
  }

  _enterUnreachable(reason) {
    if (this.unreachable) this.unreachable.reason = reason;
    else this.unreachable = { since: new Date().toISOString(), reason };
    this._closeWatcher(); // 根目录没了，监听已失效
    this._scheduleProbe();
  }

  _leaveUnreachable() {
    this.unreachable = null;
    clearTimeout(this._probe);
    this._probe = null;
    if (this._watchWanted && !this.watcher) this._openWatcher();
  }

  // 可达性探测：setTimeout 链（上一次结束才排下一次，慢盘不堆积），可达即重扫，由扫描结果决定是否恢复
  _scheduleProbe() {
    if (this._probe) return;
    const baseDir = this.baseDir;
    this._probe = setTimeout(async () => {
      this._probe = null;
      if (!this.unreachable || this.baseDir !== baseDir) return;
      const ok = await fs.promises.access(baseDir).then(() => true, () => false);
      if (ok && this.unreachable && this.baseDir === baseDir) {
        await this.rescan().catch((e) => console.warn('[scan] 恢复扫描失败: ' + e.message));
      }
      if (this.unreachable && this.baseDir === baseDir) this._scheduleProbe();
    }, this.probeIntervalMs);
    this._probe.unref?.();
  }

  status() {
    return {
      baseDir: this.baseDir,
      scanning: this.scanning,
      watching: !!this.watcher,
      generation: this.generation,
      scannedAt: this.snapshot?.scannedAt || null,
      scanned: this.scanned,
      counts: this.snapshot
        ? {
            files: this.snapshot.files.length,
            dirs: this.snapshot.dirCount,
            md: this.snapshot.files.filter((f) => f.ext === '.md').length,
            json: this.snapshot.files.filter((f) => f.ext === '.json').length,
            txt: this.snapshot.files.filter((f) => f.ext === '.txt').length,
            doc: this.snapshot.files.filter((f) => f.ext === '.doc').length,
            docx: this.snapshot.files.filter((f) => f.ext === '.docx').length,
            html: this.snapshot.files.filter((f) => f.ext === '.html' || f.ext === '.htm').length,
          }
        : null,
      dirErrors: this.snapshot?.dirErrors || [],
      fileErrors: this.snapshot?.fileErrors || [],
      unreachable: this.unreachable ? { ...this.unreachable } : null,
    };
  }
}
