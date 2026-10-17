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

export function getConfig() {
  const cfg = readJson(CONFIG_FILE, null);
  if (!cfg || !cfg.baseDir) return null;
  return { ...cfg, dsId: dsIdFor(cfg.baseDir) };
}

export function saveConfig(baseDir) {
  const cfg = { baseDir, savedAt: new Date().toISOString() };
  writeJsonAtomic(CONFIG_FILE, cfg);
  return { ...cfg, dsId: dsIdFor(baseDir) };
}

// 界面设置：{ theme: 'A'|'B'|'C' }，缺省 A；文件损坏时回退默认值
export function getUiSettings() {
  const s = readJson(UI_SETTINGS_FILE, null);
  if (!s || typeof s !== 'object' || !UI_THEMES.includes(s.theme)) return { theme: 'A' };
  return { theme: s.theme };
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
