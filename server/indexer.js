// 索引模块：文件名索引、全文检索（MD/JSON/Word 正文）、引用解析、反向引用
import fs from 'node:fs';
import path from 'node:path';
import { extractWordText } from './word.js';
import { SUPPORTED_EXTS } from './scanner.js';

export class Indexer {
  constructor() {
    this.files = []; // 扫描快照
    this.texts = new Map(); // relPath -> 可检索文本
    this.dsId = null;
    this.baseDir = null;
  }

  reset(dsId, baseDir) {
    this.dsId = dsId;
    this.baseDir = baseDir;
    this.files = [];
    this.texts = new Map();
  }

  // 扫描完成后重建索引文本（md/json 直接读；word 走缓存提取）
  async build(snapshot) {
    this.files = snapshot.files;
    this.texts = new Map();
    const CONCURRENCY = 8;
    const queue = [...this.files];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const f = queue.shift();
        const abs = path.join(this.baseDir, f.path);
        try {
          if (f.ext === '.md' || f.ext === '.json' || f.ext === '.txt' || f.ext === '.html' || f.ext === '.htm') {
            // 与前端 CodeMirror 的文档表示对齐：剥 BOM、CRLF→LF。
            // 否则含 \r 或 BOM 的文件，内链偏移会整体错位（每行差 1 字符），
            // 表现为「标记落到错误位置/表格里没有标记」。
            const raw = fs.readFileSync(abs, 'utf8');
            this.texts.set(f.path, raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'));
          } else {
            const t = await extractWordText(this.dsId, abs, f.path, f.mtimeMs);
            if (t !== null) this.texts.set(f.path, t);
          }
        } catch {
          // 单个文件读取失败不阻塞整体索引
        }
      }
    });
    await Promise.all(workers);
  }

  byName() {
    const m = new Map(); // lower(full name) / lower(base) -> files
    for (const f of this.files) {
      for (const key of [f.name.toLowerCase(), f.base.toLowerCase()]) {
        if (!m.has(key)) m.set(key, []);
        m.get(key).push(f);
      }
    }
    return m;
  }

  // 引用解析：返回 { status: 'unique'|'candidates'|'missing', targets, reason? }
  // name 可为完整文件名、省略扩展名、或相对路径；collection 限定目录范围
  resolveRef(rawName, collectionDirs) {
    const name = String(rawName).trim();
    if (!name) return { status: 'missing', targets: [], reason: '空引用' };

    // 1) 显式相对路径
    if (name.includes('/') || name.includes('\\')) {
      const norm = name.split('\\').join('/').replace(/^\.\//, '');
      const exact = this.files.find((f) => f.path.toLowerCase() === norm.toLowerCase());
      if (exact) return { status: 'unique', targets: [exact] };
      const tail = this.files.filter((f) => f.path.toLowerCase().endsWith('/' + norm.toLowerCase()));
      if (tail.length === 1) return { status: 'unique', targets: tail };
      if (tail.length > 1) return { status: 'candidates', targets: tail };
      return { status: 'missing', targets: [], reason: '路径不存在: ' + name };
    }

    let pool = this.files;
    let scoped = false;
    if (collectionDirs && collectionDirs.length) {
      pool = this.files.filter((f) =>
        collectionDirs.some((d) => f.dir === d || f.dir.startsWith(d + '/') || (d === '' && !f.dir.includes('/')))
      );
      scoped = true;
    }

    const lower = name.toLowerCase();
    const ext = path.posix.extname(lower);
    const hasSupportedExt = SUPPORTED_EXTS.includes(ext);

    // 2) 完整文件名精确匹配
    if (hasSupportedExt) {
      const hits = pool.filter((f) => f.name.toLowerCase() === lower);
      if (hits.length === 1) return { status: 'unique', targets: hits };
      if (hits.length > 1) return { status: 'candidates', targets: hits };
    } else {
      // 3) 省略扩展名：按主体名匹配支持格式
      const hits = pool.filter((f) => f.base.toLowerCase() === lower);
      if (hits.length === 1) return { status: 'unique', targets: hits };
      if (hits.length > 1) return { status: 'candidates', targets: hits };
      // 名称带点但不是受支持扩展名（如 "第3.2节"），仍按完整名再试一次
      if (ext && !hasSupportedExt) {
        const full = pool.filter((f) => f.name.toLowerCase() === lower);
        if (full.length === 1) return { status: 'unique', targets: full };
        if (full.length > 1) return { status: 'candidates', targets: full };
      }
    }

    if (scoped) {
      // 集合内未命中：给全库建议，但不静默跳转
      const global = this.files.filter(
        (f) => f.name.toLowerCase() === lower || f.base.toLowerCase() === lower
      );
      return {
        status: 'missing',
        targets: [],
        suggestions: global,
        reason: '在指定集合范围内未找到「' + name + '」',
      };
    }
    return { status: 'missing', targets: [], reason: '未找到文件: ' + name };
  }

  // 反向引用：正文中提到该文件完整名或主体名的其他文件
  backlinks(file) {
    const out = [];
    const needles = [file.name.toLowerCase()];
    if (file.base.length >= 4) needles.push(file.base.toLowerCase());
    for (const [p, text] of this.texts) {
      if (p === file.path) continue;
      const lower = text.toLowerCase();
      if (needles.some((n) => lower.includes(n))) {
        const f = this.files.find((x) => x.path === p);
        if (f) out.push(f);
      }
    }
    return out;
  }

  // 全局检索：支持多关键词（空格分隔 AND）、引号精确短语
  // filters: { types: ['.md',...], dir: 'rel/prefix'|'', excludeDirs: [] }
  search(query, filters = {}) {
    const q = String(query || '').trim();
    if (!q) return { results: [], total: 0, terms: [] };

    const phrases = [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const terms = q
      .replace(/"[^"]+"/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const all = [...phrases, ...terms];
    if (!all.length) return { results: [], total: 0, terms: [] };

    const types = filters.types && filters.types.length ? filters.types : null;
    const dir = filters.dir || '';
    const excludes = filters.excludeDirs || [];

    const grouped = new Map(); // path -> { file, matches: [{field, snippet, index}] }

    for (const f of this.files) {
      // .html 筛选同时含 .htm（同一格式两种后缀）
      if (types && !types.includes(f.ext) && !(types.includes('.html') && f.ext === '.htm')) continue;
      if (dir && !(f.dir === dir || f.dir.startsWith(dir + '/'))) continue;
      if (excludes.some((d) => f.dir === d || f.dir.startsWith(d + '/'))) continue;

      const matches = [];
      const nameLower = f.name.toLowerCase();
      const pathLower = f.path.toLowerCase();
      const nameHit = all.every((t) => nameLower.includes(t.toLowerCase()));
      const pathHit = all.every((t) => pathLower.includes(t.toLowerCase()));
      if (nameHit) matches.push({ field: 'name', snippet: f.name, score: 3 });
      else if (pathHit) matches.push({ field: 'path', snippet: f.path, score: 2 });

      const text = this.texts.get(f.path);
      if (text) {
        const lower = text.toLowerCase();
        const ok = all.every((t) => lower.includes(t.toLowerCase()));
        if (ok) {
          // 最多取 3 个片段
          let count = 0;
          for (const t of all) {
            let from = 0;
            const tl = t.toLowerCase();
            while (count < 3) {
              const idx = lower.indexOf(tl, from);
              if (idx < 0) break;
              const start = Math.max(0, idx - 40);
              const end = Math.min(text.length, idx + t.length + 60);
              matches.push({
                field: 'content',
                snippet: (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : ''),
                index: idx,
                score: 1,
              });
              count++;
              from = idx + tl.length;
            }
            if (count >= 3) break;
          }
        }
      }

      const contentOk =
        matches.some((m) => m.field === 'content') ||
        !text; // 无文本（读取失败）时仅靠名称判断
      if (matches.length && (nameHit || pathHit || contentOk)) {
        // 要求所有词在「名称+路径+正文」合集中均出现
        const haystack = (f.name + '\n' + f.path + '\n' + (text || '')).toLowerCase();
        if (all.every((t) => haystack.includes(t.toLowerCase()))) {
          grouped.set(f.path, {
            file: f,
            matches: matches.slice(0, 5),
            score: matches.reduce((s, m) => s + m.score, 0),
          });
        }
      }
    }

    const results = [...grouped.values()].sort((a, b) => b.score - a.score);
    return { results: results.slice(0, 200), total: results.length, terms: all };
  }
}
