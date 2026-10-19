// 持久化模块：应用配置、按数据源隔离的状态、缓存与备份目录
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 数据目录优先级：环境变量 > 用户目录（~/XuewenWorkbenchData）> 开发回退
// 参考 Claude Code / Codex：数据放用户目录，不跟应用包走
const USER_DATA_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.xuewen-workbench');

function migrateIfNeeded() {
  // 旧位置（userData 下）存在且新位置不存在 → 自动迁移
  const oldDir = process.env.WORKBENCH_DATA_DIR
    ? path.join(process.env.WORKBENCH_DATA_DIR) // electron 传入的 userData 路径
    : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
  if (oldDir !== USER_DATA_DIR && fs.existsSync(oldDir) && !fs.existsSync(USER_DATA_DIR)) {
    try {
      fs.mkdirSync(path.dirname(USER_DATA_DIR), { recursive: true });
      fs.renameSync(oldDir, USER_DATA_DIR);
      console.log(`[store] 数据目录迁移: ${oldDir} → ${USER_DATA_DIR}`);
    } catch (e) {
      console.warn('[store] 迁移失败，继续使用旧位置:', e.message);
    }
  }
}

const DATA_DIR = process.env.WORKBENCH_DATA_DIR
  ? path.resolve(process.env.WORKBENCH_DATA_DIR)
  : (migrateIfNeeded(), USER_DATA_DIR);
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const UI_SETTINGS_FILE = path.join(DATA_DIR, 'ui-settings.json'); // 外观主题等界面设置（跨数据源、跨端口）
const UI_THEMES = ['A', 'B', 'C'];

fs.mkdirSync(DATA_DIR, { recursive: true });

// 一次性迁移：sources/<dsId>/ → knowledge/<dsId>/（记忆层设计要求库数据统一在 knowledge/ 下）
try {
  const oldSources = path.join(DATA_DIR, 'sources');
  const newKnowledge = path.join(DATA_DIR, 'knowledge');
  if (fs.existsSync(oldSources)) {
    fs.mkdirSync(newKnowledge, { recursive: true });
    for (const name of fs.readdirSync(oldSources)) {
      const from = path.join(oldSources, name);
      const to = path.join(newKnowledge, name);
      if (!fs.existsSync(to)) fs.renameSync(from, to);
    }
    // 全部迁完才删空目录
    if (fs.readdirSync(oldSources).length === 0) fs.rmdirSync(oldSources);
  }
} catch (e) {
  console.warn('[store] sources → knowledge 迁移失败:', e.message);
}

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
  const d = path.join(DATA_DIR, 'knowledge', dsId);
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
