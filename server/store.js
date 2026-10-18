// 持久化模块：应用配置、按数据源隔离的状态、缓存与备份目录
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 可通过 WORKBENCH_DATA_DIR 覆盖（Electron 打包版指向 userData）
const DATA_DIR = process.env.WORKBENCH_DATA_DIR
  ? path.resolve(process.env.WORKBENCH_DATA_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const UI_SETTINGS_FILE = path.join(DATA_DIR, 'ui-settings.json'); // 外观主题等界面设置（跨数据源、跨端口）
const UI_THEMES = ['A', 'B', 'C'];

fs.mkdirSync(DATA_DIR, { recursive: true });

export function dataDir() {
  return DATA_DIR;
}

export function dsIdFor(baseDir) {
  return crypto
    .createHash('sha1')
    .update(path.normalize(String(baseDir)).replace(/[\\/]+$/, '').toLowerCase())
    .digest('hex')
    .slice(0, 12);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// 配置文件 v2：{ version: 2, libraries: [{ id, baseDir, name, addedAt }], activeId }
// v1（{ baseDir, savedAt } 单库）读取时自动迁移为单库 v2；损坏回退空
function normalizeLibEntry(e) {
  if (!e || typeof e.baseDir !== 'string' || !e.baseDir.trim()) return null;
  const baseDir = e.baseDir;
  const id = dsIdFor(baseDir);
  const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim() : (path.basename(baseDir) || baseDir);
  return { id, baseDir, name, addedAt: typeof e.addedAt === 'string' ? e.addedAt : new Date().toISOString() };
}

export function listLibs() {
  const raw = readJson(CONFIG_FILE, null);
  if (!raw || typeof raw !== 'object') return { libraries: [], activeId: null };
  const entries = Array.isArray(raw.libraries) ? raw.libraries : raw.baseDir ? [raw] : [];
  let activeId = Array.isArray(raw.libraries) ? (raw.activeId || null) : null;
  const seen = new Set();
  const libraries = [];
  for (const e of entries) {
    const lib = normalizeLibEntry(e);
    if (lib && !seen.has(lib.id)) {
      seen.add(lib.id);
      libraries.push(lib);
    }
  }
  if (activeId && !seen.has(activeId)) activeId = null;
  if (!activeId && libraries.length) activeId = libraries[0].id;
  return { libraries, activeId };
}

function writeLibs(libraries, activeId) {
  writeJsonAtomic(CONFIG_FILE, { version: 2, libraries, activeId });
}

// 添加或激活：同目录（同 id）已存在则仅置为当前，否则追加并置为当前
export function upsertLib(baseDir) {
  const { libraries } = listLibs();
  const id = dsIdFor(baseDir);
  const found = libraries.find((l) => l.id === id);
  if (found) {
    writeLibs(libraries, id);
    return found;
  }
  const lib = { id, baseDir, name: path.basename(baseDir) || baseDir, addedAt: new Date().toISOString() };
  libraries.push(lib);
  writeLibs(libraries, id);
  return lib;
}

// 移除：只从打开列表剔除；activeId 被移除时回落剩余首项。磁盘语料与 sources/<id>/ 派生数据不动
export function removeLib(id) {
  const { libraries, activeId } = listLibs();
  const next = libraries.filter((l) => l.id !== id);
  const nextActive = activeId === id ? next[0]?.id ?? null : activeId;
  writeLibs(next, nextActive);
  return { libraries: next, activeId: nextActive };
}

export function setActiveLib(id) {
  const { libraries } = listLibs();
  if (!libraries.some((l) => l.id === id)) return false;
  writeLibs(libraries, id);
  return true;
}

// 兼容旧调用：单库视角 = 当前激活库
export function getConfig() {
  const { libraries, activeId } = listLibs();
  const active = libraries.find((l) => l.id === activeId) || null;
  if (!active) return null;
  return { baseDir: active.baseDir, dsId: active.id, savedAt: active.addedAt };
}

// 兼容旧调用：添加或激活（多库语义）
export function saveConfig(baseDir) {
  const lib = upsertLib(baseDir);
  return { baseDir: lib.baseDir, dsId: lib.id, savedAt: lib.addedAt };
}

// 界面设置：{ theme: 'A'|'B'|'C', autoUpdate?: boolean }，theme 缺省 A、autoUpdate 缺省 true；文件损坏时回退默认值
export function getUiSettings() {
  const s = readJson(UI_SETTINGS_FILE, null);
  if (!s || typeof s !== 'object') return { theme: 'A', autoUpdate: true };
  return {
    theme: UI_THEMES.includes(s.theme) ? s.theme : 'A',
    autoUpdate: typeof s.autoUpdate === 'boolean' ? s.autoUpdate : true,
  };
}

export function saveUiSettings(patch) {
  const next = { ...getUiSettings(), ...patch };
  writeJsonAtomic(UI_SETTINGS_FILE, next);
  return next;
}

function dsDir(dsId) {
  const d = path.join(DATA_DIR, 'sources', dsId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function getState(dsId, name, fallback) {
  return readJson(path.join(dsDir(dsId), name + '.json'), fallback);
}

export function setState(dsId, name, value) {
  writeJsonAtomic(path.join(dsDir(dsId), name + '.json'), value);
}

export function cacheDir(dsId) {
  const d = path.join(dsDir(dsId), 'cache');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function backupDir(dsId) {
  const d = path.join(dsDir(dsId), 'backups');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
