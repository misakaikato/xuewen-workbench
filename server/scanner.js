// 扫描模块：递归发现目录与文件，符号链接循环保护，chokidar 监听 + 防抖重扫。
// 逐项处理只有一份（createScanWalk 的帧栈驱动器）：同步 scanTree 与异步 scanTreeAsync
// 只是两个驱动节奏不同的外壳，遍历顺序与结果完全一致（深度优先、按 readdir 顺序）。
import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { EventEmitter } from 'node:events';
import { withActivity } from './lagWatch.js';

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

// 扫描核心：显式帧栈模拟原递归遍历（深度优先，遇到子目录立即下钻）。
// step(budgetMs) 处理若干目录项直到预算用尽；finish() 排序并产出最终结果。
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
  // 帧：{ absDir, relDir, derived, entries|null, index, hasContent }
  const stack = [{ absDir: baseDir, relDir: '', derived: false, entries: null, index: 0, hasContent: false }];

  // 帧初始化：realpath/循环检查、readdir、目录计数。失败记 dirErrors 后放弃该帧。
  function initFrame(frame) {
    if (frame.derived) {
      // .derived/ 内所有文件都收（jsonl/graphml 等不受 SUPPORTED_EXTS 限制），仅作展示
      try {
        frame.entries = fs.readdirSync(frame.absDir, { withFileTypes: true });
      } catch { return false; }
      return true;
    }
    let real;
    try {
      real = fs.realpathSync(frame.absDir);
    } catch (e) {
      dirErrors.push({ path: frame.relDir || '.', reason: '无法解析目录: ' + e.code });
      return false;
    }
    if (visited.has(real)) return false; // 符号链接循环
    visited.add(real);
    try {
      frame.entries = fs.readdirSync(frame.absDir, { withFileTypes: true });
    } catch (e) {
      dirErrors.push({ path: frame.relDir || '.', reason: '目录不可读: ' + e.code });
      return false;
    }
    dirCount++;
    if (frame.relDir) dirs.push(frame.relDir);
    return true;
  }

  function handleDerivedEntry(frame, ent) {
    if (ent.name.startsWith('.')) return;
    const abs = path.join(frame.absDir, ent.name);
    const rel = frame.relDir + '/' + ent.name;
    if (ent.isDirectory()) {
      dirs.push(rel);
      stack.push({ absDir: abs, relDir: rel, derived: true, entries: null, index: 0, hasContent: false });
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      metaFiles.push(rel);
      try {
        const st = fs.statSync(abs);
        derivedFiles.push({
          path: rel,
          name: ent.name,
          base: ent.name.slice(0, ent.name.length - ext.length),
          ext,
          dir: frame.relDir,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch { /* 忽略读不到的文件 */ }
    }
  }

  function handleEntry(frame, ent) {
    const abs = path.join(frame.absDir, ent.name);
    const rel = toRel(baseDir, abs);
    try {
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        const st = fs.statSync(abs); // 跟随符号链接
        isDir = st.isDirectory();
        isFile = st.isFile();
      }
      if (isDir) {
        if (!frame.relDir && ent.name === TRASH_DIR) return;
        if (ent.name.startsWith('.')) {
          // .derived/：加工数据目录，受「显示元数据文件」开关控制
          if (ent.name === '.derived' && showMetaFiles) {
            dirs.push(rel);
            frame.hasContent = true;
            stack.push({ absDir: abs, relDir: rel, derived: true, entries: null, index: 0, hasContent: false });
          }
          return; // 其余隐藏目录（.git / .trash 等）一律不扫描
        }
        frame.hasContent = true;
        stack.push({ absDir: abs, relDir: rel, derived: false, entries: null, index: 0, hasContent: false });
      } else if (isFile) {
        const ext = path.extname(ent.name).toLowerCase();
        if (isSidecar(ent.name)) {
          sidecars.push(rel);
          metaFiles.push(rel);
          if (!showMetaFiles) return; // 默认隐藏；开关打开时作为普通 JSON 显示
        }
        // 派生文件（划线记录）：默认隐藏，仅 collected 到 metaFiles；开关打开时才当普通文件
        if (isAnnotations(ent.name)) {
          metaFiles.push(rel);
          if (!showMetaFiles) return;
        }
        if (!SUPPORTED_EXTS.includes(ext)) return;
        frame.hasContent = true;
        try {
          const st = fs.statSync(abs);
          files.push({
            path: rel,
            name: ent.name,
            base: ent.name.slice(0, ent.name.length - ext.length),
            ext,
            dir: frame.relDir || '',
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
          scanned++;
        } catch (e) {
          fileErrors.push({ path: rel, reason: '无法读取文件信息: ' + e.code });
        }
      }
    } catch (e) {
      fileErrors.push({ path: rel, reason: '访问失败: ' + e.code });
    }
  }

  // 推进遍历：处理目录项直到栈空（done）或时间预算用尽。budgetMs 传 Infinity 即同步跑完。
  function step(budgetMs) {
    const start = Date.now();
    for (;;) {
      const frame = stack[stack.length - 1];
      if (!frame) return { done: true, scanned };
      if (!frame.entries && !initFrame(frame)) {
        stack.pop();
        continue;
      }
      if (frame.index >= frame.entries.length) {
        if (!frame.derived && !frame.hasContent) emptyDirCount++;
        stack.pop();
        continue;
      }
      const ent = frame.entries[frame.index++];
      if (frame.derived) handleDerivedEntry(frame, ent);
      else handleEntry(frame, ent);
      if (Date.now() - start >= budgetMs) return { done: false, scanned };
    }
  }

  function finish() {
    files.sort((a, b) => naturalCompare(a.path, b.path));
    derivedFiles.sort((a, b) => naturalCompare(a.path, b.path));
    dirs.sort(naturalCompare);
    return { files, dirs, sidecars, metaFiles, derivedFiles, dirCount, dirErrors, fileErrors, emptyDirCount };
  }

  return { step, finish };
}

// 同步扫描（与 scanTreeAsync 共用同一份逐项处理核心；当前没有调用方，保留作对照与测试）
export function scanTree(baseDir, opts = {}) {
  const walk = createScanWalk(baseDir, opts);
  walk.step(Infinity); // Infinity 预算必定一次跑完
  return walk.finish();
}

// 分片异步扫描：每遍历约 30ms 让出一次事件循环，扫描期间后端请求与轮询不被阻塞。
// opts.onProgress(scanned) 在每次让出时回调已遍历文件数。
export async function scanTreeAsync(baseDir, opts = {}) {
  const walk = createScanWalk(baseDir, opts);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  for (;;) {
    const r = walk.step(SCAN_SLICE_MS);
    if (onProgress) onProgress(r.scanned);
    if (r.done) return walk.finish();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export class Scanner extends EventEmitter {
  constructor() {
    super();
    this.baseDir = null;
    this.snapshot = null; // { files, dirCount, dirErrors, fileErrors, scannedAt }
    this.scanning = false;
    this.scanned = 0; // 扫描期间已遍历的文件数（非扫描期为 0）
    this.watcher = null;
    this.generation = 0;
    this._debounce = null;
    this.showMetaFiles = false; // 由外部按设置注入；true 时 annotations 等派生文件也进 files
  }

  setBaseDir(baseDir) {
    this.stopWatch();
    this.baseDir = baseDir;
    this.snapshot = null;
    this.generation++;
  }

  async rescan() {
    if (!this.baseDir) return null;
    if (this.scanning) return this.snapshot;
    this.scanning = true;
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
            this.scanned = n;
            const now = Date.now();
            if (now - lastProgress >= 250) {
              lastProgress = now;
              this.emit('scan-progress', { scanned: n });
            }
          },
        })
      );
      this.scanned = result.files.length;
      this.emit('scan-progress', { scanned: this.scanned });
      this.snapshot = { ...result, scannedAt: new Date().toISOString() };
      console.log('[scan] 扫描完成: ' + this.baseDir + '，' + result.files.length + ' 个文件，耗时 ' + (Date.now() - t0) + 'ms');
      this.emit('scan-done', this.snapshot);
      return this.snapshot;
    } finally {
      this.scanning = false;
      this.scanned = 0;
    }
  }

  startWatch() {
    this.stopWatch();
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
      this.watcher.on('error', (e) => this.emit('watch-error', e));
    } catch (e) {
      this.emit('watch-error', e);
    }
  }

  stopWatch() {
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* ignore */ }
      this.watcher = null;
    }
    clearTimeout(this._debounce);
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
    };
  }
}
