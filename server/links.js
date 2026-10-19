// 自动内链索引：词条表（文档标题/别名/标题锚点/JSON title）+ 各文档外发链接 + 反向链接。
// 链接只存在于本索引与渲染层，绝不写回数据源内任何文件。
// 缓存：<WORKBENCH_DATA_DIR>/links/<dsId>.json，可随时删除重建（ARCHITECTURE 4.4：SQLite 缓存为后续项，v1 用 JSON 缓存）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir, getState, setState, writeJsonAtomic } from './store.js';
import { SIDECAR_SUFFIX } from './scanner.js';
import {
  normalizeText, isTermLike, buildAutoIndex, extractLinks, extractWikilinks,
} from './linkMatch.js';
import { loadConcepts } from './derived.js';

const CACHE_VERSION = 1;
const LINKS_DIR = () => path.join(dataDir(), 'links');
const cacheFileOf = (dsId) => path.join(LINKS_DIR(), dsId + '.json');

// 读取 md 文本中的 ATX 1–3 级标题（词条 + [[..#锚点]] 解析用）
function headingsOf(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let eol = text.indexOf('\n', i);
    if (eol < 0) eol = text.length;
    let end = eol;
    if (end > i && text[end - 1] === '\r') end--;
    const line = text.slice(i, end);
    const m = /^ {0,3}(#{1,3})(?:\s+(.*))?$/.exec(line);
    if (m) {
      const t = (m[2] || '').trim().replace(/\s+/g, ' ');
      if (t) out.push({ text: t, norm: normalizeText(t) });
    }
    if (eol >= text.length) break;
    i = eol + 1;
  }
  return out;
}

// 粗略纯文本（预览摘录用）：去标题记号/围栏/行内代码/链接语法后压平空白
function plainExcerpt(text, max = 200) {
  let t = text.replace(/\r\n?/g, '\n');
  t = t.replace(/^---\n.*?\n---\n/s, '');
  t = t.replace(/```[^\n]*\n[\s\S]*?```/g, ' ');
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/^ {0,3}#{1,6}\s+/gm, '');
  t = t.replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, n, d) => (d || n));
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, max);
}

// ---------- 反链片段：纯文本净化 + 精确高亮区间 ----------
// 片段由「前缀 + 命中文字 + 后缀」拼接而成：前后缀各自净化后长度不变地参与定位，
// 因此 hiFrom/hiTo 恰好框住命中词（绝不用文本搜索找词，避免把长词内部的超串误标）。
const SNIPPET_HR_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/; // 分隔线整行剔除
const SNIPPET_LEAD_RE = /^(?: {0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d{1,3}[.)][ \t]+))+/; // 可叠加的行首记号

// 净化片段：剥行首 Markdown 记号、解链接/wikilink/行内代码语法只留文字、去 HTML 标签、折叠空白
function snippetPlain(part) {
  const lines = part.split(/\r?\n/).map((l) => (SNIPPET_HR_RE.test(l) ? '' : l.replace(SNIPPET_LEAD_RE, '')));
  let t = lines.join(' ');
  t = t.replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, n, d) => (d || n));
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  t = t.replace(/`+([^`]*)`+/g, '$1');
  t = t.replace(/<[^<>]+>/g, ' ');
  // 上下文窗口可能把 wikilink 切成两半：丢掉悬空的半段（前缀尾部 [[开头无闭合 / 后缀首部 无开头]]），
  // 避免片段里残留孤立的 [[ 或 ]] 记号
  t = t.replace(/\[\[[^\[\]]*$/, '');
  t = t.replace(/^[^\[\]]*\]\]/, '');
  return t.replace(/\s+/g, ' ');
}

// 命中词两侧紧贴的强调记号（**、*、__、_、~~）剥除，避免片段里悬着孤立星号
const stripEmphTail = (s) => s.replace(/[*_~]+$/, '');
const stripEmphHead = (s) => s.replace(/^[*_~]+/, '');

export class LinkIndex {
  constructor() {
    this.reset(null, null);
  }

  reset(dsId, baseDir) {
    this.dsId = dsId;
    this.baseDir = baseDir;
    this.ready = false;
    this.building = false;
    this.buildSeq = 0;
    this.files = new Map(); // path -> {mtimeMs, size, links, title, excerpt, headings}
    this.autoIndex = null;
    this.vocab = []; // 词条展示表（含歧义项，不含通用标题）：[{term, path, heading, ambiguous}]
    this.resolve = { byName: new Map(), byPath: new Map() }; // wikilink 解析
    this.backlinks = new Map(); // 目标 path -> Map<来源 path, links[]>
    this.sidecarIds = new Map(); // path -> sidecar id
    this.stats = { files: 0, terms: 0, links: 0, lastFullMs: 0, lastUpdateMs: 0 };
    this._textsOf = null; // () => Map<path, text>（索引器的内存文本）
    this._run = Promise.resolve();
    this._dirty = true;
    this._cache = null;
    this._vocabSig = null;
    this._everBuilt = false;
    this._pendingMeta = null; // 构建期间的 fileMeta（供 extractFor 查新标题锚点）
  }

  // 索引器文本访问器（indexer.build 每次会换 Map，故存取值函数）
  useTextsOf(fn) {
    this._textsOf = fn;
  }

  textOf(p) {
    const raw = this._textsOf ? this._textsOf().get(p) : null;
    if (raw == null) return null;
    return raw.startsWith('\uFEFF') ? { text: raw.slice(1), bom: true } : { text: raw, bom: false };
  }

  // ---------- 词条表构建 ----------

  // 从快照 + 旁注 + 内存文本构建词条原始条目；同时得到标题/摘录/标题锚点/旁注 id
  collectVocab(snapshot, texts) {
    const entries = [];
    const sidecarIds = new Map();
    const fileMeta = new Map(); // path -> {title, excerpt, headings}
    const sidecarData = new Map();
    for (const sc of snapshot.sidecars || []) {
      const target = sc.slice(0, sc.length - SIDECAR_SUFFIX.length);
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.baseDir, sc), 'utf8'));
        if (meta && typeof meta === 'object') sidecarData.set(target, meta);
      } catch { /* 非法旁注跳过 */ }
    }
    const stemOf = (name) => name.slice(0, name.length - path.extname(name).length);
    for (const f of snapshot.files) {
      const meta = sidecarData.get(f.path);
      let title = null;
      if (meta && typeof meta.title === 'string' && meta.title.trim()) title = meta.title.trim();
      if (f.ext === '.json') {
        const t = texts.get(f.path);
        if (t) {
          try {
            const data = JSON.parse(t.startsWith('\uFEFF') ? t.slice(1) : t);
            if (data && typeof data.title === 'string' && data.title.trim()) title = data.title.trim();
          } catch { /* 非法 JSON 跳过 */ }
        }
      }
      if (title == null) title = stemOf(f.name);
      if (meta && typeof meta.id === 'string' && meta.id) sidecarIds.set(f.path, meta.id);
      fileMeta.set(f.path, { title, excerpt: null, headings: [] });
      entries.push({ term: title, path: f.path, kind: 'title' });
      if (meta && Array.isArray(meta.aliases)) {
        for (const a of meta.aliases) {
          if (typeof a === 'string' && a.trim()) entries.push({ term: a.trim(), path: f.path, kind: 'alias' });
        }
      }
    }
    // md 标题锚点（1–3 级）进入词条；记录各文档标题清单供 [[..#锚点]] 与预览用
    const headingDocs = new Map(); // normHeading -> Set<path>（仅统计用，不两处重复判定）
    for (const f of snapshot.files) {
      if (f.ext !== '.md') continue;
      const raw = texts.get(f.path);
      if (raw == null) continue;
      const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
      const fm = fileMeta.get(f.path);
      fm.headings = headingsOf(text);
      fm.excerpt = plainExcerpt(text);
      for (const h of fm.headings) {
        entries.push({ term: h.text, path: f.path, heading: h.text, kind: 'heading' });
      }
    }
    for (const f of snapshot.files) {
      const fm = fileMeta.get(f.path);
      if (!fm.excerpt) {
        const raw = texts.get(f.path);
        if (raw != null) fm.excerpt = plainExcerpt(raw.startsWith('\uFEFF') ? raw.slice(1) : raw);
      }
    }
    return { entries, sidecarIds, fileMeta };
    // 通用标题（≥2 个文档里都出现的同名标题）交给 buildAutoIndex：同名跨文档 → 歧义占位，
    // 不自动链，但作为长词整体消费，阻止其内部短词成链
  }

  vocabSignature(entries, blocklist) {
    const h = crypto.createHash('sha256');
    h.update(JSON.stringify([...blocklist].sort()));
    h.update('\n');
    const sorted = [...entries].map((e) => [e.term, e.path, e.heading || '', e.kind]).sort();
    h.update(JSON.stringify(sorted));
    return h.digest('hex');
  }

  // wikilink 名称解析表：归一化 title/别名/主体名/完整路径（含与不含扩展名）
  buildResolve(entries, snapshot) {
    const byName = new Map(); // norm -> Set<path>
    const byPath = new Map(); // normPath(含/不含扩展名) -> path
    for (const e of entries) {
      if (e.kind === 'heading' || e.kind === 'concept') continue; // 概念不是文档，[[..]] 不指向它
      const norm = normalizeText(e.term);
      if (!norm) continue;
      if (!byName.has(norm)) byName.set(norm, new Set());
      byName.get(norm).add(e.path);
    }
    for (const f of snapshot.files) {
      const np = normalizeText(f.path).toLowerCase();
      byPath.set(np, f.path);
      const noExt = f.path.slice(0, f.path.length - f.ext.length);
      byPath.set(normalizeText(noExt).toLowerCase(), f.path);
    }
    this.resolve = { byName, byPath };
  }

  // ---------- 单文件提取 ----------

  extractFor(p, text) {
    const out = [];
    for (const l of extractLinks(text, this.autoIndex, { selfPath: p })) {
      out.push({ from: l.from, to: l.to, term: l.term, norm: l.norm, kind: 'auto', target: l.target, display: null });
    }
    for (const w of extractWikilinks(text)) {
      const norm = normalizeText(w.name);
      const r = this.resolveWiki(w.name);
      if (r.status === 'unique') {
        let heading = w.heading;
        if (heading) {
          const fm = (this._pendingMeta && this._pendingMeta.get(r.path)) || this.files.get(r.path);
          const hit = fm?.headings.find((h) => h.norm === normalizeText(heading));
          heading = hit ? hit.text : heading; // 规范成文档里的实际写法
        }
        out.push({
          from: w.from, to: w.to, term: w.name, norm, kind: 'wiki',
          target: { path: r.path, heading }, display: w.display,
        });
      } else if (r.status === 'candidates') {
        out.push({ from: w.from, to: w.to, term: w.name, norm, kind: 'wiki', target: null, candidates: r.paths, display: w.display });
      } else {
        out.push({ from: w.from, to: w.to, term: w.name, norm, kind: 'wiki-missing', target: null, display: w.display });
      }
    }
    out.sort((a, b) => a.from - b.from);
    return out;
  }

  // 按标题/别名/主体名/路径（归一化）解析 wikilink 名称
  resolveWiki(name) {
    const s = String(name || '').trim();
    if (!s) return { status: 'missing' };
    const hits = new Set();
    const byName = normalizeText(s);
    if (this.resolve.byName.has(byName)) for (const p of this.resolve.byName.get(byName)) hits.add(p);
    const lower = byName.toLowerCase();
    if (this.resolve.byPath.has(lower)) hits.add(this.resolve.byPath.get(lower));
    // 路径后缀匹配（含扩展名）：唯一尾部命中也接受
    if (s.includes('/')) {
      for (const [np, p] of this.resolve.byPath) {
        if (np.endsWith('/' + lower)) hits.add(p);
      }
    }
    if (hits.size === 1) return { status: 'unique', path: [...hits][0] };
    if (hits.size > 1) return { status: 'candidates', paths: [...hits].sort() };
    return { status: 'missing' };
  }

  // ---------- 构建 / 增量 ----------

  // 索引构建完成后调用（snapshot 为扫描快照，indexer 提供内存文本）；
  // 串行执行避免并发重建；定期让出事件循环，不长时间阻塞请求处理。
  async rebuild(snapshot, indexer) {
    if (!this.dsId || !this.baseDir) return;
    this._run = this._run.then(() => this._rebuildNow(snapshot, indexer)).catch((e) => {
      console.error('链接索引构建失败:', e.message);
      this.building = false;
    });
    return this._run;
  }

  async _rebuildNow(snapshot, indexer) {
    if (!this._textsOf) this.useTextsOf(() => indexer.texts);
    const t0 = Date.now();
    this.building = true;
    try {
      const texts = indexer.texts;
      const blocklist = this.blocklist();
      const { entries, sidecarIds, fileMeta } = this.collectVocab(snapshot, texts);
      // 加工数据里的概念：概念名与别名也进词条表，target 用 concept: 前缀（前端据此打开概念详情）
      // 与文档词条同名时会被 buildAutoIndex 判为歧义而不链，属可接受行为
      try {
        const { concepts } = loadConcepts(this.baseDir);
        for (const c of concepts) {
          entries.push({ term: c.name, path: 'concept:' + c.name, kind: 'concept', force: true });
          for (const a of c.aliases) entries.push({ term: a, path: 'concept:' + c.name, kind: 'concept', force: true });
        }
      } catch (e) { console.error('[links] 概念词条接入失败:', e.message); }
      this.sidecarIds = sidecarIds;
      this._pendingMeta = fileMeta;
      const sig = this.vocabSignature(entries, blocklist);
      const vocabChanged = this._vocabSig !== sig;
      this.autoIndex = buildAutoIndex(entries, blocklist);
      this.buildResolve(entries, snapshot);
      // 词条展示表：norm -> 原始条目（同名同目标取首个，展示名保留原文）
      const normEntry = new Map();
      for (const e of entries) {
        const key = normalizeText(e.term) + '\u0000' + e.path + '\u0000' + (e.heading || '');
        if (!normEntry.has(key)) normEntry.set(key, e);
      }
      this.vocab = [...this.autoIndex.byNorm.values()].map((it) => {
        const e = normEntry.get(it.norm + '\u0000' + it.targets[0].path + '\u0000' + (it.targets[0].heading || ''));
        return { term: e ? e.term : it.norm, path: it.targets[0].path, heading: it.targets[0].heading, ambiguous: false };
      });
      for (const norm of this.autoIndex.ambiguous) {
        for (const [key, e] of normEntry) {
          if (key.split('\u0000')[0] === norm) {
            this.vocab.push({ term: e.term, path: null, heading: null, ambiguous: true });
            break;
          }
        }
      }

      // 缓存：词表未变且 mtime/size 一致的文件复用旧结果
      let cache = this._cache;
      if (!cache || cache.dsId !== this.dsId || cache.vocabSig !== sig) {
        cache = this._readCache();
        this._cache = cache;
      }
      const old = vocabChanged ? null : cache;

      const nextFiles = new Map();
      let changed = vocabChanged;
      let count = 0;
      for (const f of snapshot.files) {
        if (f.ext !== '.md' && f.ext !== '.json') continue;
        const fm = fileMeta.get(f.path);
        const prev = old?.files[f.path];
        if (prev && prev.mtimeMs === f.mtimeMs && prev.size === f.size) {
          nextFiles.set(f.path, { title: fm.title, excerpt: prev.excerpt ?? fm.excerpt, headings: fm.headings, mtimeMs: prev.mtimeMs, size: prev.size, links: prev.links });
        } else {
          const raw = texts.get(f.path);
          const text = raw == null ? '' : raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
          nextFiles.set(f.path, {
            mtimeMs: f.mtimeMs, size: f.size,
            links: this.extractFor(f.path, text),
            title: fm.title, excerpt: fm.excerpt, headings: fm.headings,
          });
          changed = true;
        }
        if (++count % 40 === 0) await new Promise((r) => setImmediate(r));
      }
      if (this.files.size !== nextFiles.size) changed = true;
      this.files = nextFiles;
      this._vocabSig = sig;
      this._pendingMeta = null;
      this.rebuildBacklinks();
      this.ready = true;
      this.buildSeq++;
      const ms = Date.now() - t0;
      if (vocabChanged || !this._everBuilt) this.stats.lastFullMs = ms;
      else this.stats.lastUpdateMs = ms;
      this._everBuilt = true;
      this.stats.files = this.files.size;
      this.stats.terms = this.vocab.filter((v) => !v.ambiguous).length;
      this.stats.links = [...this.files.values()].reduce((s, d) => s + d.links.length, 0);
      if (changed || this._dirty) this.writeCache();
      this._dirty = false;
    } finally {
      this.building = false;
    }
  }

  rebuildBacklinks() {
    const map = new Map(); // 目标 path -> Map<来源 path, links[]>
    const add = (target, from, link) => {
      if (!map.has(target)) map.set(target, new Map());
      const m = map.get(target);
      if (!m.has(from)) m.set(from, []);
      m.get(from).push(link);
    };
    for (const [p, doc] of this.files) {
      for (const l of doc.links) {
        if (l.kind === 'wiki-missing' || !l.target) continue;
        if (this.isIgnored(p, l)) continue;
        add(l.target.path, p, l);
      }
    }
    this.backlinks = map;
  }

  // ---------- 缓存 ----------

  _readCache() {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFileOf(this.dsId), 'utf8'));
      if (c && c.version === CACHE_VERSION && c.dsId === this.dsId && c.baseDir === this.baseDir) return c;
    } catch { /* 无缓存或损坏：重建 */ }
    return null;
  }

  writeCache() {
    if (!this.dsId) return;
    const files = {};
    for (const [p, d] of this.files) {
      files[p] = { mtimeMs: d.mtimeMs, size: d.size, links: d.links, title: d.title, excerpt: d.excerpt, headings: d.headings };
    }
    writeJsonAtomic(cacheFileOf(this.dsId), {
      version: CACHE_VERSION, dsId: this.dsId, baseDir: this.baseDir,
      vocabSig: this._vocabSig, writtenAt: new Date().toISOString(), files,
    });
  }

  cacheExists() {
    try {
      fs.accessSync(cacheFileOf(this.dsId));
      return true;
    } catch {
      return false;
    }
  }

  // ---------- 用户控制：屏蔽词表 / 忽略 ----------

  blocklist() {
    const v = getState(this.dsId, 'linkBlocklist', []);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  }

  saveBlocklist(terms) {
    setState(this.dsId, 'linkBlocklist', terms);
    this._cache = null; // 词表变化，缓存按词表签名重新判定
  }

  docKey(p) {
    return this.sidecarIds.get(p) || p;
  }

  isIgnored(p, link) {
    if (!link.target) return false;
    const key = this.docKey(p);
    const norm = link.norm || normalizeText(link.term);
    return this.ignores().some((e) => e.key === key && e.term === norm && e.targetPath === link.target.path);
  }

  ignores() {
    const v = getState(this.dsId, 'linkIgnores', []);
    return Array.isArray(v) ? v : [];
  }

  setIgnore(path, term, targetPath, ignore) {
    const key = this.docKey(path);
    const norm = normalizeText(String(term || ''));
    let list = this.ignores().filter((e) => !(e.key === key && e.term === norm && e.targetPath === targetPath));
    if (ignore) list.push({ key, term: norm, targetPath });
    setState(this.dsId, 'linkIgnores', list);
    this.rebuildBacklinks(); // 忽略变化立即反映到反向链接
    this._dirty = true;
    return list.length;
  }

  clearIgnores() {
    setState(this.dsId, 'linkIgnores', []);
    this.rebuildBacklinks();
    this._dirty = true;
  }

  ignoredCount() {
    return this.ignores().length;
  }

  // 改名/移动：忽略记录按旁注 id 跟随文档；无旁注的把路径键迁移到新路径；
  // 引用了旧目标路径的条目也一并改指新路径（索引本身随重扫重建）。文件夹则按前缀迁移。
  notifyRename(oldRel, newRel, isDir = false) {
    const list = this.ignores();
    let changed = false;
    const mapPath = (p) => {
      if (p === oldRel) return newRel;
      if (isDir && p.startsWith(oldRel + '/')) return newRel + p.slice(oldRel.length);
      return p;
    };
    for (const e of list) {
      const nk = e.key.includes('/') || !isDir ? mapPath(e.key) : e.key; // 路径键才按前缀迁移，id 键不动
      const nt = mapPath(e.targetPath);
      if (nk !== e.key) {
        e.key = this.sidecarIds.get(nk) || nk;
        changed = true;
      }
      if (nt !== e.targetPath) {
        e.targetPath = nt;
        changed = true;
      }
    }
    if (changed) setState(this.dsId, 'linkIgnores', list);
  }

  // ---------- 查询 ----------

  linksOf(p) {
    const doc = this.files.get(p);
    if (!doc) return [];
    return doc.links.map((l) => ({ ...l, ignored: this.isIgnored(p, l) }));
  }

  // 反向链接：目标 path -> [{path,title,count,kinds,snippets}]，按提及次数降序
  backlinksOf(p) {
    const m = this.backlinks.get(p);
    if (!m || !m.size) return [];
    const out = [];
    for (const [src, links] of m) {
      const doc = this.files.get(src);
      const kinds = [...new Set(links.map((l) => l.kind))];
      const snippets = [];
      const t = doc ? this.textOf(src) : null;
      for (const l of links.slice(0, 5)) {
        if (!t) {
          snippets.push({ text: l.term, offset: l.from, hiFrom: 0, hiTo: l.term.length, term: l.term });
          continue;
        }
        const ctx = 36;
        const a = Math.max(0, l.from - ctx);
        const b = Math.min(t.text.length, l.to + ctx);
        // 高亮文字用链接的精确 from/to 区间：wikilink 用显示文字，自动链恰为词条本身
        const hi = l.kind === 'wiki' && l.display ? l.display : l.term;
        const prefix = stripEmphTail(snippetPlain(t.text.slice(a, l.from)));
        const suffix = stripEmphHead(snippetPlain(t.text.slice(l.to, b)));
        const lead = a > 0 ? '…' : '';
        const tail = b < t.text.length ? '…' : '';
        const hiFrom = lead.length + prefix.length;
        snippets.push({ text: lead + prefix + hi + suffix + tail, offset: l.from, hiFrom, hiTo: hiFrom + hi.length, term: hi });
      }
      out.push({ path: src, title: doc?.title || src, count: links.length, kinds, snippets });
    }
    out.sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1));
    return out;
  }

  terms(q, max = 50) {
    const nq = normalizeText(String(q || '')).toLowerCase();
    const list = this.vocab
      .filter((v) => !v.ambiguous)
      .filter((v) => !String(v.path || '').startsWith('concept:')) // 概念条目不进 wikilink 补全
      .filter((v) => !nq || normalizeText(v.term).toLowerCase().startsWith(nq))
      .sort((a, b) => a.term.length - b.term.length || (a.term < b.term ? -1 : 1));
    return list.slice(0, max).map((v) => ({ term: v.term, path: v.path, heading: v.heading || null }));
  }

  previewOf(p) {
    const doc = this.files.get(p);
    if (!doc) return null;
    return { path: p, title: doc.title, excerpt: doc.excerpt || '' };
  }

  status() {
    return {
      ready: this.ready, building: this.building, buildSeq: this.buildSeq,
      files: this.stats.files, terms: this.stats.terms, links: this.stats.links,
      lastFullMs: this.stats.lastFullMs, lastUpdateMs: this.stats.lastUpdateMs,
      ignoredCount: this.ignoredCount(),
    };
  }
}
