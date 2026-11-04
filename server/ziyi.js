// 字义库：全局（与资料库无关）的单字释义，用户在设置里导入 zip 字义包，数据存 <数据目录>/ziyi/。
// 字义包不随程序分发：仓库与安装包里都没有字义数据。
// 内存常驻一份 + 每条的归一化文本（繁→简等长映射，偏移可直接回到原文）；所有写操作经同一队列串行。
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { writeJsonAtomicAsync, preserveCorrupt } from './atomicFile.js';
import { normalizeText } from './linkMatch.js';
import { writeZip } from './zip.js';

const VERSION = 1;
const MAX_BACKUPS = 5;
const MAX_HAN_CHARS = 8;
const LOOKUP_MAX = 12;
const SNIPPET_PAD = 40;
const HAN_RE = /\p{Script=Han}/u;

const httpError = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });

/** 单码点时为大写十六进制（扩展区为 5 位），多字为 null */
export function unicodeOf(han) {
  const cps = Array.from(han);
  return cps.length === 1 ? cps[0].codePointAt(0).toString(16).toUpperCase() : null;
}

function cmpHan(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}

function validHan(han) {
  if (typeof han !== 'string' || !han || /\s/.test(han)) return false;
  return Array.from(han).length <= MAX_HAN_CHARS;
}

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** 解析字义包：zip 内任意层级的 *.json；跳过 _ 或 . 开头的文件名、__MACOSX/、非 json 文件 */
export function parsePack(buf) {
  let zip;
  try {
    zip = new AdmZip(buf);
  } catch {
    throw httpError(400, '不是有效的 zip 文件');
  }
  let zipEntries;
  try {
    zipEntries = zip.getEntries();
  } catch {
    throw httpError(400, '不是有效的 zip 文件');
  }
  const entries = new Map();
  const invalid = [];
  let duplicates = 0;
  for (const ze of zipEntries) {
    if (ze.isDirectory) continue;
    const name = ze.entryName.replace(/\\/g, '/');
    const base = name.split('/').pop();
    if (name.split('/').includes('__MACOSX')) continue;
    if (!/\.json$/i.test(base) || base.startsWith('_') || base.startsWith('.')) continue;
    let obj;
    try {
      obj = JSON.parse(ze.getData().toString('utf8').replace(/^﻿/, ''));
    } catch {
      invalid.push(name);
      continue;
    }
    const han = obj && typeof obj.han === 'string' ? obj.han.trim() : null;
    const meaning = obj && typeof obj.meaning === 'string' ? obj.meaning : '';
    if (!validHan(han) || !meaning.trim()) {
      invalid.push(name);
      continue;
    }
    if (entries.has(han)) duplicates++;
    entries.set(han, { meaning, source: typeof obj.source === 'string' ? obj.source : '' });
  }
  return { entries, invalid, duplicates };
}

/** 导出格式与导入相同：<han>.json → { han, unicode, meaning, source } */
function packEntries(entries) {
  return [...entries].map(([han, e]) => ({
    name: `${han}.json`,
    data: JSON.stringify({ han, unicode: unicodeOf(han), meaning: e.meaning, source: e.source }, null, 2) + '\n',
  }));
}

export class ZiyiStore {
  constructor(dir, { exportDir } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'entries.json');
    this.backupDir = path.join(dir, 'backups');
    this.exportDir = exportDir || null;
    this.installed = false;
    this.meta = { importedAt: null, sourceName: null };
    this.entries = new Map(); // han -> { meaning, source, editedAt }
    this.norm = new Map(); // han -> { han, meaning, source }（归一化，与原文等长）
    this.order = []; // 按码点排序的 han
    this._loading = null;
    this._queue = Promise.resolve();
  }

  /** 首次访问时读盘一次；损坏文件改名保留、按未安装处理 */
  ready() {
    if (!this._loading) this._loading = this._load();
    return this._loading;
  }

  async _load() {
    let raw;
    try {
      raw = await fs.promises.readFile(this.file, 'utf8');
    } catch {
      return;
    }
    let obj;
    try {
      obj = JSON.parse(raw);
      if (!obj || typeof obj.entries !== 'object' || obj.entries === null) throw new Error('缺少 entries');
    } catch (e) {
      try {
        const kept = preserveCorrupt(this.file);
        console.warn(`[ziyi] entries.json 解析失败（${e.message}），已保留为 ${path.basename(kept)}，按未安装处理`);
      } catch (e2) {
        console.warn(`[ziyi] entries.json 解析失败且无法改名保留：${e2.message}`);
      }
      return;
    }
    const entries = new Map();
    for (const [han, e] of Object.entries(obj.entries)) {
      if (!validHan(han) || !e || typeof e.meaning !== 'string') continue;
      entries.set(han, {
        meaning: e.meaning,
        source: typeof e.source === 'string' ? e.source : '',
        editedAt: typeof e.editedAt === 'string' ? e.editedAt : null,
      });
    }
    this._swap(entries, { importedAt: obj.importedAt ?? null, sourceName: obj.sourceName ?? null });
  }

  _swap(entries, meta) {
    this.entries = entries;
    this.meta = meta;
    this.installed = true;
    this.norm = new Map();
    for (const [han, e] of entries) this._indexOne(han, e);
    this._resort();
  }

  _indexOne(han, e) {
    this.norm.set(han, { han: normalizeText(han), meaning: normalizeText(e.meaning), source: normalizeText(e.source) });
  }

  _resort() {
    this.order = [...this.entries.keys()].sort(cmpHan);
  }

  _serialize() {
    const entries = {};
    for (const han of this.order) entries[han] = this.entries.get(han);
    return { version: VERSION, importedAt: this.meta.importedAt, sourceName: this.meta.sourceName, entries };
  }

  _persist() {
    return writeJsonAtomicAsync(this.file, this._serialize());
  }

  /** 写操作串行：后来者等前者落盘后再基于其结果执行 */
  _serial(fn) {
    const run = this._queue.then(() => this.ready()).then(fn);
    this._queue = run.catch(() => {});
    return run;
  }

  _entryOut(han) {
    const e = this.entries.get(han);
    return { han, unicode: unicodeOf(han), meaning: e.meaning, source: e.source, editedAt: e.editedAt };
  }

  _resolve(han) {
    if (this.entries.has(han)) return { han, resolvedFrom: null };
    const n = normalizeText(han);
    if (n !== han && this.entries.has(n)) return { han: n, resolvedFrom: han };
    return null;
  }

  status() {
    let editedCount = 0;
    for (const e of this.entries.values()) if (e.editedAt) editedCount++;
    return {
      installed: this.installed,
      count: this.installed ? this.entries.size : 0,
      editedCount: this.installed ? editedCount : 0,
      importedAt: this.installed ? this.meta.importedAt : null,
      sourceName: this.installed ? this.meta.sourceName : null,
    };
  }

  get(han) {
    const r = this.installed && typeof han === 'string' && han ? this._resolve(han) : null;
    return r ? { entry: this._entryOut(r.han), resolvedFrom: r.resolvedFrom } : null;
  }

  /** 按码点去重，只保留汉字（跳过空白、标点、拉丁），最多 12 个 */
  lookup(text) {
    const chars = [];
    for (const ch of Array.from(String(text || ''))) {
      if (!HAN_RE.test(ch) || chars.includes(ch)) continue;
      chars.push(ch);
      if (chars.length >= LOOKUP_MAX) break;
    }
    return chars.map((char) => {
      const r = this.get(char);
      return { char, entry: r ? r.entry : null, resolvedFrom: r ? r.resolvedFrom : null };
    });
  }

  search(q, { offset = 0, limit = 50 } = {}) {
    if (!this.installed) return { total: 0, items: [] };
    const query = String(q || '').trim();
    const terms = query ? query.split(/\s+/).map(normalizeText) : [];
    const qn = normalizeText(query);
    const hits = [];
    for (const han of this.order) {
      if (!terms.length) {
        hits.push({ han, tier: 0, count: 0 });
        continue;
      }
      const n = this.norm.get(han);
      if (!terms.every((t) => n.han.includes(t) || n.meaning.includes(t) || n.source.includes(t))) continue;
      let tier;
      let count = 0;
      if (n.han === qn) tier = 0;
      else if (terms.some((t) => n.han.includes(t))) tier = 1;
      else {
        for (const t of terms) count += countOf(n.meaning, t);
        tier = count > 0 ? 2 : 3;
      }
      hits.push({ han, tier, count });
    }
    // order 已按码点排好，稳定排序保持同级码点序
    hits.sort((a, b) => a.tier - b.tier || b.count - a.count);
    const items = hits.slice(offset, offset + limit).map(({ han, tier }) => {
      const e = this.entries.get(han);
      const n = this.norm.get(han);
      let field;
      let snippet;
      if (!terms.length || tier <= 1) {
        field = 'han';
        snippet = clip(e.meaning, 0, SNIPPET_PAD * 2);
      } else {
        field = tier === 2 ? 'meaning' : 'source';
        const hay = field === 'meaning' ? n.meaning : n.source;
        let at = -1;
        let len = 0;
        for (const t of terms) {
          const i = hay.indexOf(t);
          if (i >= 0 && (at < 0 || i < at)) { at = i; len = t.length; }
        }
        snippet = clip(e[field], at - SNIPPET_PAD, at + len + SNIPPET_PAD);
      }
      return { han, unicode: unicodeOf(han), snippet, field, editedAt: e.editedAt };
    });
    return { total: hits.length, items };
  }

  put({ han, meaning, source, expectEditedAt, create } = {}) {
    return this._serial(async () => {
      const h = typeof han === 'string' ? han.trim() : '';
      if (!validHan(h)) throw httpError(400, `字头须为 1–${MAX_HAN_CHARS} 个字且不含空白`);
      if (typeof meaning !== 'string' || !meaning.trim()) throw httpError(400, '释义不能为空');
      if (source !== undefined && typeof source !== 'string') throw httpError(400, '出处须为文本');
      const now = new Date().toISOString();
      if (create) {
        if (this.installed && this.entries.has(h)) throw httpError(409, `「${h}」已有字义`, { code: 'exists' });
        if (!this.installed) {
          this.installed = true;
          this.meta = { importedAt: null, sourceName: null };
        }
      } else {
        const cur = this.installed ? this.entries.get(h) : null;
        if (!cur) throw httpError(404, `「${h}」没有字义`);
        if (expectEditedAt !== undefined && (expectEditedAt ?? null) !== cur.editedAt) {
          throw httpError(409, `「${h}」已被修改，请重新载入后再编辑`, { code: 'conflict' });
        }
      }
      const isNew = !this.entries.has(h);
      const e = { meaning, source: source ?? '', editedAt: now };
      this.entries.set(h, e);
      this._indexOne(h, e);
      if (isNew) this._resort();
      await this._persist();
      return this._entryOut(h);
    });
  }

  remove(han) {
    return this._serial(async () => {
      if (!this.installed || !this.entries.has(han)) throw httpError(404, `「${han}」没有字义`);
      this.entries.delete(han);
      this.norm.delete(han);
      this._resort();
      await this._persist();
    });
  }

  importPack(buf, { keepEdited = true, name = null } = {}) {
    return this._serial(async () => {
      const { entries: incoming, invalid, duplicates } = parsePack(buf);
      if (!incoming.size) {
        throw httpError(400, invalid.length ? `字义包里没有有效条目（${invalid.length} 个文件格式不对）` : '字义包里没有字义文件（*.json）');
      }
      const backup = this.installed ? this._backup() : null;
      const before = this.installed ? this.entries : new Map();
      const now = new Date().toISOString();
      const next = new Map();
      for (const [han, e] of incoming) next.set(han, { ...e, editedAt: null });
      let keptEdited = 0;
      if (keepEdited) {
        for (const [han, e] of before) {
          if (!e.editedAt) continue;
          next.set(han, e);
          keptEdited++;
        }
      }
      let added = 0;
      let updated = 0;
      for (const [han, e] of next) {
        const old = before.get(han);
        if (!old) added++;
        else if (old.meaning !== e.meaning || old.source !== e.source) updated++;
      }
      let removed = 0;
      for (const han of before.keys()) if (!next.has(han)) removed++;
      this._swap(next, { importedAt: now, sourceName: name || null });
      await this._persist();
      return {
        ok: true, count: next.size, added, updated, removed, keptEdited,
        invalid: invalid.slice(0, 20), invalidCount: invalid.length, duplicates, backup,
      };
    });
  }

  exportPack() {
    return this._serial(async () => {
      if (!this.installed) throw httpError(409, '尚未导入字义库');
      let dir = this.exportDir;
      let ok = false;
      if (dir) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.accessSync(dir, fs.constants.W_OK);
          ok = true;
        } catch { /* 回退到数据目录下 */ }
      }
      if (!ok) dir = path.join(this.dir, 'exports');
      const file = path.join(dir, `字义库-${stamp()}.zip`);
      writeZip(file, packEntries(this._sorted()));
      return file;
    });
  }

  uninstall() {
    return this._serial(async () => {
      if (!this.installed) return null;
      const backup = this._backup();
      await fs.promises.rm(this.file, { force: true });
      this.installed = false;
      this.meta = { importedAt: null, sourceName: null };
      this.entries = new Map();
      this.norm = new Map();
      this.order = [];
      return backup;
    });
  }

  _sorted() {
    return this.order.map((han) => [han, this.entries.get(han)]);
  }

  /** 替换或移除前备份成导出格式的 zip，只留最近 5 份 */
  _backup() {
    let file = path.join(this.backupDir, `ziyi-${stamp()}.zip`);
    for (let i = 1; fs.existsSync(file); i++) file = path.join(this.backupDir, `ziyi-${stamp()}-${i}.zip`);
    writeZip(file, packEntries(this._sorted()));
    const all = fs.readdirSync(this.backupDir).filter((f) => /^ziyi-.*\.zip$/.test(f)).sort();
    for (const f of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) {
      try { fs.rmSync(path.join(this.backupDir, f), { force: true }); } catch { /* 删不掉的旧备份下次再清 */ }
    }
    return file;
  }
}

function countOf(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** 截取 [from, to) 的原文片段，超出处加「…」；不切断代理对 */
function clip(text, from, to) {
  let a = Math.max(0, from);
  let b = Math.min(text.length, to);
  if (a > 0 && /[\uDC00-\uDFFF]/.test(text[a])) a--;
  if (b < text.length && /[\uDC00-\uDFFF]/.test(text[b])) b++;
  return (a > 0 ? '…' : '') + text.slice(a, b) + (b < text.length ? '…' : '');
}
