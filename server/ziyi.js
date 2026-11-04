// 字义库：全局（与资料库无关）的单字释义，用户在设置里导入字义文件，数据存 <数据目录>/ziyi/。
// 字义文件不随程序分发：仓库与安装包里都没有字义数据。
// 字义文件是一个 JSON（可装在 zip 里）：{ format: 'xuewen-ziyi', version: 1, entries: [{ han, variants?, origin?, meaning, source?, editedAt? }] }
// editedAt 只出现在导出与备份里：导回后这些字仍算本地修改，再次导入时受「保留本地修改」保护。
// origin 标出处：lecture 课堂讲解、ai AI 推导、local 本机新建；缺省为 null（未标注）。
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
// CJK 统一表意文字、扩展 A、兼容区与 2 万以上的扩展区（B 起）；不含々〇与部首
const HAN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{3FFFF}]/u;
const YIELD_EVERY = 256;
const yieldLoop = () => new Promise((r) => setImmediate(r));
export const PACK_FORMAT = 'xuewen-ziyi';
export const ORIGINS = ['lecture', 'ai', 'local'];
const PACK_FILE = '字义库.json';

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

/** 异体字：只收与字头不同的单个汉字，去重 */
function cleanVariants(han, v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (typeof x === 'string' && Array.from(x).length === 1 && HAN_RE.test(x) && x !== han && !out.includes(x)) out.push(x);
  }
  return out;
}

const cleanOrigin = (o) => (ORIGINS.includes(o) ? o : null);
const cleanEditedAt = (t) => (typeof t === 'string' && !Number.isNaN(Date.parse(t)) ? t : null);

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** 取出字义文件的 JSON 文本：直接是 JSON，或 zip 里唯一的一个 .json（忽略 __MACOSX/ 与 _ . 开头的文件） */
function packText(buf) {
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) return buf.toString('utf8');
  let jsons;
  try {
    jsons = new AdmZip(buf).getEntries().filter((ze) => {
      const name = ze.entryName.replace(/\\/g, '/');
      const base = name.split('/').pop();
      return !ze.isDirectory && !name.split('/').includes('__MACOSX') && /\.json$/i.test(base) && !/^[_.]/.test(base);
    });
  } catch {
    throw httpError(400, '不是有效的 zip 文件');
  }
  if (jsons.length !== 1) throw httpError(400, `压缩包里应当只有一个字义 JSON 文件，实际有 ${jsons.length} 个`);
  return jsons[0].getData().toString('utf8');
}

/** 解析字义文件。每 256 条让出一次事件循环 */
export async function parsePack(buf) {
  let obj;
  try {
    obj = JSON.parse(packText(buf).replace(/^\uFEFF/, ''));
  } catch (e) {
    if (e.status) throw e;
    throw httpError(400, '不是有效的 JSON 文件');
  }
  if (!obj || obj.format !== PACK_FORMAT || !Array.isArray(obj.entries)) {
    throw httpError(400, `不是字义库文件（需要 "format": "${PACK_FORMAT}" 和 entries 数组）`);
  }
  const entries = new Map();
  const invalid = [];
  let duplicates = 0;
  for (let i = 0; i < obj.entries.length; i++) {
    if ((i + 1) % YIELD_EVERY === 0) await yieldLoop();
    const x = obj.entries[i];
    const han = x && typeof x.han === 'string' ? x.han.trim() : null;
    const meaning = x && typeof x.meaning === 'string' ? x.meaning : '';
    if (!validHan(han) || !meaning.trim()) {
      invalid.push(`第 ${i + 1} 条${han ? `（${han}）` : ''}`);
      continue;
    }
    if (entries.has(han)) duplicates++;
    entries.set(han, {
      meaning,
      source: typeof x.source === 'string' ? x.source : '',
      origin: cleanOrigin(x.origin),
      variants: cleanVariants(han, x.variants),
      editedAt: cleanEditedAt(x.editedAt),
    });
  }
  return { entries, invalid, duplicates };
}

function sortedEntries(entries) {
  return [...entries.keys()].sort(cmpHan).map((han) => [han, entries.get(han)]);
}

/** 导出 / 备份：与导入同格式的字义文件，装进 zip 压缩 */
function packZipEntries(entries) {
  const out = sortedEntries(entries).map(([han, e]) => ({
    han, ...(e.variants.length ? { variants: e.variants } : {}), origin: e.origin, meaning: e.meaning, source: e.source,
    ...(e.editedAt ? { editedAt: e.editedAt } : {}),
  }));
  return [{ name: PACK_FILE, data: JSON.stringify({ format: PACK_FORMAT, version: VERSION, entries: out }, null, 1) + '\n' }];
}

export class ZiyiStore {
  constructor(dir, { exportDir } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'entries.json');
    this.backupDir = path.join(dir, 'backups');
    this.exportDir = exportDir || null;
    this.installed = false;
    this.meta = { importedAt: null, sourceName: null };
    this.entries = new Map(); // han -> { meaning, source, origin, variants, editedAt }
    this.variantOf = new Map(); // 异体字 -> 字头
    this.normHeadOf = new Map(); // 繁转简后的字头 -> 原字头（字头是繁体时，查简体也能落到它）
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
    } catch (e) {
      if (e.code === 'ENOENT') return;
      // 读不了（权限、占用）不能当成未安装：否则之后的导入或新建会不备份就覆盖原文件。下次请求再试
      this._loading = null;
      console.warn(`[ziyi] 读取 entries.json 失败：${e.message}`);
      throw httpError(503, '读取字义库失败：' + e.message);
    }
    let obj;
    try {
      obj = JSON.parse(raw);
      if (!obj || typeof obj.entries !== 'object' || obj.entries === null) throw new Error('缺少 entries');
    } catch (e) {
      let kept;
      try {
        kept = preserveCorrupt(this.file);
      } catch (e2) {
        // 保留成功前不得覆盖原文件：不按未安装处理，下次请求再试
        this._loading = null;
        console.warn(`[ziyi] entries.json 解析失败且无法改名保留：${e2.message}`);
        throw httpError(503, '字义库文件已损坏且无法改名保留：' + e2.message);
      }
      console.warn(`[ziyi] entries.json 解析失败（${e.message}），已保留为 ${path.basename(kept)}，按未安装处理`);
      return;
    }
    const entries = new Map();
    for (const [han, e] of Object.entries(obj.entries)) {
      if (!validHan(han) || !e || typeof e.meaning !== 'string') continue;
      entries.set(han, {
        meaning: e.meaning,
        source: typeof e.source === 'string' ? e.source : '',
        origin: cleanOrigin(e.origin),
        variants: cleanVariants(han, e.variants),
        editedAt: typeof e.editedAt === 'string' ? e.editedAt : null,
      });
    }
    await this._swap(entries, { importedAt: obj.importedAt ?? null, sourceName: obj.sourceName ?? null });
  }

  /** 换入一整份数据：先在旁边建好归一化索引（分批让出事件循环），再一次性替换 */
  async _swap(entries, meta) {
    const norm = new Map();
    let n = 0;
    for (const [han, e] of entries) {
      if (++n % YIELD_EVERY === 0) await yieldLoop();
      norm.set(han, normEntry(han, e));
    }
    this.entries = entries;
    this.meta = meta;
    this.installed = true;
    this.norm = norm;
    this._resort();
  }

  _indexOne(han, e) {
    this.norm.set(han, normEntry(han, e));
  }

  /** 码点序、异体字索引与繁转简字头索引（字头本身优先，索引都不覆盖已有字头） */
  _resort() {
    this.order = [...this.entries.keys()].sort(cmpHan);
    this.variantOf = new Map();
    this.normHeadOf = new Map();
    for (const han of this.order) {
      for (const v of this.entries.get(han).variants) if (!this.variantOf.has(v)) this.variantOf.set(v, han);
      const k = normalizeText(han);
      if (k !== han && !this.entries.has(k) && !this.normHeadOf.has(k)) this.normHeadOf.set(k, han);
    }
  }

  _write(entries, meta) {
    const out = {};
    for (const [han, e] of sortedEntries(entries)) out[han] = e;
    return writeJsonAtomicAsync(this.file, { version: VERSION, importedAt: meta.importedAt, sourceName: meta.sourceName, entries: out });
  }

  /** 写操作串行：后来者等前者落盘后再基于其结果执行 */
  _serial(fn) {
    const run = this._queue.then(() => this.ready()).then(fn);
    this._queue = run.catch(() => {});
    return run;
  }

  _entryOut(han) {
    const e = this.entries.get(han);
    return { han, unicode: unicodeOf(han), variants: e.variants, origin: e.origin, meaning: e.meaning, source: e.source, editedAt: e.editedAt };
  }

  /** 字头 → 明确声明的异体字 → 繁简归一后的字头 → 繁体字头（查简体「亿」落到字头「億」）→ 归一后的异体字 */
  _resolve(han) {
    if (this.entries.has(han)) return { han, resolvedFrom: null };
    const v = this.variantOf.get(han);
    if (v) return { han: v, resolvedFrom: han };
    const n = normalizeText(han);
    if (n !== han && this.entries.has(n)) return { han: n, resolvedFrom: han };
    const t = this.normHeadOf.get(n);
    if (t) return { han: t, resolvedFrom: han };
    const vn = n !== han ? this.variantOf.get(n) : null;
    if (vn) return { han: vn, resolvedFrom: han };
    return null;
  }

  status() {
    let editedCount = 0;
    const origins = { lecture: 0, ai: 0, local: 0, none: 0 };
    for (const e of this.entries.values()) {
      if (e.editedAt) editedCount++;
      origins[e.origin ?? 'none']++;
    }
    return {
      installed: this.installed,
      count: this.installed ? this.entries.size : 0,
      editedCount: this.installed ? editedCount : 0,
      origins,
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

  /** origin：只看某一类来源（lecture / ai / local / none） */
  search(q, { offset = 0, limit = 50, origin = null } = {}) {
    if (!this.installed) return { total: 0, items: [] };
    const query = String(q || '').trim();
    const terms = query ? query.split(/\s+/).map(normalizeText) : [];
    const qn = normalizeText(query);
    const hits = [];
    for (const han of this.order) {
      if (origin && (this.entries.get(han).origin ?? 'none') !== origin) continue;
      if (!terms.length) {
        hits.push({ han, tier: 0, count: 0 });
        continue;
      }
      const n = this.norm.get(han);
      if (!terms.every((t) => n.han.includes(t) || n.meaning.includes(t) || n.source.includes(t))) continue;
      let tier;
      let count = 0;
      if (n.heads.includes(qn)) tier = 0;
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
      return { han, unicode: unicodeOf(han), origin: e.origin, snippet, field, editedAt: e.editedAt };
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
      } else {
        const cur = this.installed ? this.entries.get(h) : null;
        if (!cur) throw httpError(404, `「${h}」没有字义`);
        if (expectEditedAt !== undefined && (expectEditedAt ?? null) !== cur.editedAt) {
          throw httpError(409, `「${h}」已被修改，请重新载入后再编辑`, { code: 'conflict' });
        }
      }
      const cur = this.installed ? this.entries.get(h) : null;
      const next = new Map(this.entries);
      // 改字保留原来源与异体字；本机新建的标为 local
      next.set(h, { meaning, source: source ?? '', origin: cur ? cur.origin : 'local', variants: cur ? cur.variants : [], editedAt: now });
      const meta = this.installed ? this.meta : { importedAt: null, sourceName: null };
      // 先落盘再改内存：写失败时界面看到的仍是磁盘上的内容
      await this._write(next, meta);
      const isNew = !this.entries.has(h);
      this.entries = next;
      this.meta = meta;
      this.installed = true;
      this._indexOne(h, next.get(h));
      if (isNew) this._resort();
      return this._entryOut(h);
    });
  }

  remove(han) {
    return this._serial(async () => {
      if (!this.installed || !this.entries.has(han)) throw httpError(404, `「${han}」没有字义`);
      const next = new Map(this.entries);
      next.delete(han);
      await this._write(next, this.meta);
      this.entries = next;
      this.norm.delete(han);
      this._resort();
    });
  }

  importPack(buf, { keepEdited = true, name = null } = {}) {
    return this._serial(async () => {
      const { entries: incoming, invalid, duplicates } = await parsePack(buf);
      if (!incoming.size) {
        throw httpError(400, invalid.length ? `字义文件里没有有效条目（${invalid.length} 条格式不对）` : '字义文件里没有条目');
      }
      const backup = this.installed ? this._backup() : null;
      const before = this.installed ? this.entries : new Map();
      const now = new Date().toISOString();
      const next = new Map(incoming);
      let keptEdited = 0;
      if (keepEdited) {
        // 保留本地改过的释义与出处；来源与异体字以新文件为准（新文件里没有这个字时沿用旧的）
        for (const [han, e] of before) {
          if (!e.editedAt) continue;
          const inc = incoming.get(han);
          next.set(han, inc
            ? { ...inc, meaning: e.meaning, source: e.source, origin: e.origin === 'local' ? 'local' : inc.origin, editedAt: e.editedAt }
            : e);
          keptEdited++;
        }
      }
      let added = 0;
      let updated = 0;
      for (const [han, e] of next) {
        const old = before.get(han);
        if (!old) added++;
        else if (old.meaning !== e.meaning || old.source !== e.source || old.origin !== e.origin || old.variants.join('') !== e.variants.join('')) updated++;
      }
      let removed = 0;
      for (const han of before.keys()) if (!next.has(han)) removed++;
      const meta = { importedAt: now, sourceName: name || null };
      // 原子写成功后才换入内存：写失败时现有数据原样不动
      await this._write(next, meta);
      await this._swap(next, meta);
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
      writeZip(file, packZipEntries(this.entries));
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
      this.variantOf = new Map();
      this.normHeadOf = new Map();
      return backup;
    });
  }


  /** 替换或移除前备份成导出格式的 zip，只留最近 5 份 */
  _backup() {
    let file = path.join(this.backupDir, `ziyi-${stamp()}.zip`);
    for (let i = 1; fs.existsSync(file); i++) file = path.join(this.backupDir, `ziyi-${stamp()}-${i}.zip`);
    writeZip(file, packZipEntries(this.entries));
    // 按修改时间轮转（文件名在同毫秒冲突、夏令时回拨时不保证有序）
    const all = fs.readdirSync(this.backupDir)
      .filter((f) => /^ziyi-.*\.zip$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(this.backupDir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t)
      .map((x) => x.f);
    for (const f of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) {
      try { fs.rmSync(path.join(this.backupDir, f), { force: true }); } catch { /* 删不掉的旧备份下次再清 */ }
    }
    return file;
  }
}

/** 检索用归一化文本：han 含字头与异体字（字头命中档），heads 为逐个的字头与异体字（精确命中档） */
function normEntry(han, e) {
  const heads = [han, ...e.variants].map(normalizeText);
  return { han: heads.join(' '), heads, meaning: normalizeText(e.meaning), source: normalizeText(e.source) };
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
