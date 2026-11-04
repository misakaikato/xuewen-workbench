// 持久化模块：应用配置、按数据源隔离的状态、缓存与备份目录
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './atomicFile.js';

// 原子写原语在 atomicFile.js（无模块级副作用），此处再导出供既有调用方使用
export { renameWithRetry, renameWithRetryAsync, tmpPathFor, writeJsonAtomic, writeJsonAtomicAsync } from './atomicFile.js';

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
      console.warn(`[store] 数据目录改名失败，继续使用新位置 ${USER_DATA_DIR}，旧数据留在 ${oldDir}:`, e.message);
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

// 旧版本（v0.1.1–v0.1.3）数据迁移：那些版本把数据放 Electron userData/data，
// v0.1.4 起改到 ~/.xuewen-workbench。主进程 import 本文件前设置 WORKBENCH_LEGACY_DATA_DIR；
// 后端进程（WORKBENCH_HOSTED=1）跳过，避免两进程同时搬。新数据目录已有资料库则不迁移。
// config.json 最后迁：它不在旧目录而旧目录还有条目、又没有 MIGRATED.txt，说明上次在它之后中断
// （或旧版本先迁了它），这时把剩下的条目接着迁完并写 MIGRATED.txt。
const MIGRATED_MARK = 'MIGRATED.txt';
export function migrateLegacyUserData(legacyDir, targetDir) {
  if (!legacyDir) return { migrated: false };
  const legacy = path.resolve(legacyDir);
  const target = path.resolve(targetDir || DATA_DIR);
  if (legacy === target || !fs.existsSync(legacy)) return { migrated: false };
  const legacyConfig = path.join(legacy, 'config.json');
  if (!fs.existsSync(legacyConfig)) {
    if (fs.existsSync(path.join(legacy, MIGRATED_MARK))) return { migrated: false };
    let rest = [];
    try {
      rest = fs.readdirSync(legacy);
    } catch (e) {
      console.warn('[store] 旧版数据目录读取失败:', e.message);
      return { migrated: false, reason: e.message };
    }
    if (!rest.length) return { migrated: false };
    return moveLegacyEntries(legacy, target, rest, true);
  }
  const newHasLibs = (() => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8'));
      const libs = Array.isArray(raw?.libraries) ? raw.libraries : raw?.baseDir ? [raw] : [];
      return libs.length > 0;
    } catch {
      return false;
    }
  })();
  if (newHasLibs) {
    console.warn(`[store] 旧版数据目录 ${legacy} 与新数据目录 ${target} 都含资料库，不迁移，请手动处理`);
    return { migrated: false, reason: 'both-have-libs' };
  }
  return moveLegacyEntries(legacy, target, fs.readdirSync(legacy), false);
}

// 逐项改名搬到目标目录（目标已有的条目跳过），config.json 放在最后，全部完成才写 MIGRATED.txt
function moveLegacyEntries(legacy, target, names, resumed) {
  try {
    for (const name of names) {
      if (name === 'config.json' || name === MIGRATED_MARK) continue;
      const to = path.join(target, name);
      if (!fs.existsSync(to)) fs.renameSync(path.join(legacy, name), to);
    }
    if (names.includes('config.json')) {
      const to = path.join(target, 'config.json');
      if (fs.existsSync(to)) fs.rmSync(to, { force: true }); // 目标无资料库，旧配置直接覆盖
      fs.renameSync(path.join(legacy, 'config.json'), to);
    }
    fs.writeFileSync(path.join(legacy, MIGRATED_MARK), `数据已迁移到 ${target}\n`, 'utf8');
    console.log(`[store] 旧版数据迁移${resumed ? '（续迁上次中断的剩余条目）' : ''}: ${legacy} → ${target}`);
    return { migrated: true, ...(resumed ? { resumed: true } : {}) };
  } catch (e) {
    console.warn('[store] 旧版数据迁移失败:', e.message);
    return { migrated: false, reason: e.message };
  }
}

if (process.env.WORKBENCH_HOSTED !== '1') {
  migrateLegacyUserData(process.env.WORKBENCH_LEGACY_DATA_DIR || null, DATA_DIR);
}

// 一次性迁移：sources/<dsId>/ → knowledge/<dsId>/（记忆层设计要求库数据统一在 knowledge/ 下）。
// 目标已存在时逐项合并：目标缺的条目改名搬过去，两边都是目录就往下一层合并，两边同名文件保留目标的；
// 搬空的目录删掉，有冲突留下的条目原地保留。中断后再启动会接着合并。
export function migrateSourcesToKnowledge(dataDir) {
  const oldSources = path.join(dataDir, 'sources');
  if (!fs.existsSync(oldSources)) return { moved: 0, kept: 0 };
  const stat = { moved: 0, kept: 0 };
  const merge = (from, to) => {
    for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, ent.name);
      const dst = path.join(to, ent.name);
      if (!fs.existsSync(dst)) {
        fs.renameSync(src, dst);
        stat.moved++;
      } else if (ent.isDirectory() && fs.statSync(dst).isDirectory()) {
        merge(src, dst);
      } else {
        stat.kept++;
      }
    }
    if (fs.readdirSync(from).length === 0) fs.rmdirSync(from);
  };
  try {
    fs.mkdirSync(path.join(dataDir, 'knowledge'), { recursive: true });
    merge(oldSources, path.join(dataDir, 'knowledge'));
    if (stat.kept) console.warn(`[store] sources → knowledge：${stat.kept} 个条目与 knowledge 中已有的同名，保留在 sources/ 原处`);
  } catch (e) {
    console.warn('[store] sources → knowledge 迁移失败:', e.message);
  }
  return stat;
}

migrateSourcesToKnowledge(DATA_DIR);

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

export async function readJsonAsync(file, fallback) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
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

// 界面设置：{ theme: 'A'|'B'|'C', autoUpdate?: boolean, agentEnabled?: boolean, ... }，theme 缺省 A、autoUpdate 缺省 true、
// agentEnabled 缺省 false（旧数据没有该字段即视为关闭）；文件损坏时回退默认值
export function getUiSettings() {
  const s = readJson(UI_SETTINGS_FILE, null);
  if (!s || typeof s !== 'object') return { theme: 'A', autoUpdate: true, notesDir: '阅读笔记', showMetaFiles: false, agentEnabled: false };
  return {
    theme: UI_THEMES.includes(s.theme) ? s.theme : 'A',
    autoUpdate: typeof s.autoUpdate === 'boolean' ? s.autoUpdate : true,
    notesDir: typeof s.notesDir === 'string' && s.notesDir.trim() ? s.notesDir.trim() : '阅读笔记',
    // 文件树是否显示元数据/派生文件（.meta.json、.annotations.json），默认不显示
    showMetaFiles: typeof s.showMetaFiles === 'boolean' ? s.showMetaFiles : false,
    // 智能助手总开关：关闭时前端隐藏全部助手入口，/api/agent 的生成与写接口返回 409
    agentEnabled: typeof s.agentEnabled === 'boolean' ? s.agentEnabled : false,
  };
}

export function saveUiSettings(patch) {
  const next = { ...getUiSettings(), ...patch };
  writeJsonAtomic(UI_SETTINGS_FILE, next);
  return next;
}

/** 库数据目录路径（knowledge/<dsId>）：验收脚本等外部读取用，不建目录 */
export function knowledgeDir(dsId) {
  return path.join(DATA_DIR, 'knowledge', dsId);
}

function dsDir(dsId) {
  const d = knowledgeDir(dsId);
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

export async function cacheDirAsync(dsId) {
  const d = path.join(knowledgeDir(dsId), 'cache');
  await fs.promises.mkdir(d, { recursive: true });
  return d;
}

export function backupDir(dsId) {
  const d = path.join(dsDir(dsId), 'backups');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
