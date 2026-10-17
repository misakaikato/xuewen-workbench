// 扫描模块：递归发现目录与文件，符号链接循环保护，chokidar 监听 + 防抖重扫
import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { EventEmitter } from 'node:events';

export const SUPPORTED_EXTS = ['.md', '.json', '.doc', '.docx'];
// 元数据旁注文件：<原文件名>.meta.json，不出现在目录树/检索中
export const SIDECAR_SUFFIX = '.meta.json';
export const TRASH_DIR = '.trash'; // 数据源根目录下的应用回收站（不扫描）
export const isSidecar = (name) => String(name).toLowerCase().endsWith(SIDECAR_SUFFIX);

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

export function scanTree(baseDir) {
  const files = [];
  const dirs = []; // 全部子目录相对路径（含空目录）
  const sidecars = []; // 元数据旁注文件相对路径
  const dirErrors = []; // { path, reason }
  const fileErrors = [];
  let dirCount = 0;
  let emptyDirCount = 0;
  const visited = new Set(); // realpath 防循环

  function walk(absDir, relDir) {
    let real;
    try {
      real = fs.realpathSync(absDir);
    } catch (e) {
      dirErrors.push({ path: relDir || '.', reason: '无法解析目录: ' + e.code });
      return;
    }
    if (visited.has(real)) return; // 符号链接循环
    visited.add(real);

    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      dirErrors.push({ path: relDir || '.', reason: '目录不可读: ' + e.code });
      return;
    }
    dirCount++;
    if (relDir) dirs.push(relDir);
    let hasContent = false;

    for (const ent of entries) {
      const abs = path.join(absDir, ent.name);
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
          if (!relDir && ent.name === TRASH_DIR) continue;
          hasContent = true;
          walk(abs, rel);
        } else if (isFile) {
          const ext = path.extname(ent.name).toLowerCase();
          if (isSidecar(ent.name)) { sidecars.push(rel); continue; }
          if (!SUPPORTED_EXTS.includes(ext)) continue;
          hasContent = true;
          try {
            const st = fs.statSync(abs);
            files.push({
              path: rel,
              name: ent.name,
              base: ent.name.slice(0, ent.name.length - ext.length),
              ext,
              dir: relDir || '',
              size: st.size,
              mtimeMs: st.mtimeMs,
            });
          } catch (e) {
            fileErrors.push({ path: rel, reason: '无法读取文件信息: ' + e.code });
          }
        }
      } catch (e) {
        fileErrors.push({ path: rel, reason: '访问失败: ' + e.code });
      }
    }
    if (!hasContent) emptyDirCount++;
  }

  walk(baseDir, '');
  files.sort((a, b) => naturalCompare(a.path, b.path));
  dirs.sort(naturalCompare);
  return { files, dirs, sidecars, dirCount, dirErrors, fileErrors, emptyDirCount };
}

export class Scanner extends EventEmitter {
  constructor() {
    super();
    this.baseDir = null;
    this.snapshot = null; // { files, dirCount, dirErrors, fileErrors, scannedAt }
    this.scanning = false;
    this.watcher = null;
    this.generation = 0;
    this._debounce = null;
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
    this.emit('scan-start');
    try {
      // 放到 setImmediate 中避免阻塞事件循环太久
      const result = await new Promise((resolve, reject) => {
        setImmediate(() => {
          try {
            resolve(scanTree(this.baseDir));
          } catch (e) {
            reject(e);
          }
        });
      });
      this.snapshot = { ...result, scannedAt: new Date().toISOString() };
      this.emit('scan-done', this.snapshot);
      return this.snapshot;
    } finally {
      this.scanning = false;
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
      counts: this.snapshot
        ? {
            files: this.snapshot.files.length,
            dirs: this.snapshot.dirCount,
            md: this.snapshot.files.filter((f) => f.ext === '.md').length,
            json: this.snapshot.files.filter((f) => f.ext === '.json').length,
            doc: this.snapshot.files.filter((f) => f.ext === '.doc').length,
            docx: this.snapshot.files.filter((f) => f.ext === '.docx').length,
          }
        : null,
      dirErrors: this.snapshot?.dirErrors || [],
      fileErrors: this.snapshot?.fileErrors || [],
    };
  }
}
