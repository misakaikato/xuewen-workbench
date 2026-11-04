// 索引模块：文件名索引、全文检索（MD/JSON/Word 正文）、引用解析、反向引用
import fs from 'node:fs';
import path from 'node:path';
import { extractWordText } from './word.js';
import { SUPPORTED_EXTS } from './scanner.js';
import { withActivity, setActivity, SLOW_FS_OP_MS } from './lagWatch.js';
import { decodeText } from './textDecode.js';
import { toEditorText } from './editorText.js';

// 正文大小上限：超过的文件不读正文，只按文件名收录（文件树、文件名检索照常可见）。环境变量供测试覆盖
export const TEXT_INDEX_MAX_BYTES = Number(process.env.WORKBENCH_TEXT_INDEX_MAX_BYTES) || 16 * 1024 * 1024;
export const WORD_INDEX_MAX_BYTES = Number(process.env.WORKBENCH_WORD_INDEX_MAX_BYTES) || 64 * 1024 * 1024;
const MB = (n) => Math.round((n / 1048576) * 10) / 10;
// 单个文件在主线程上的同步处理（解码、换行归一、转小写）超过它记 WARN，写明各步耗时
const SYNC_SLOW_MS = 100;
// 小写正文：建索引时算一次，检索不再逐次对全文 toLowerCase（耗时与总正文量成正比）
// 与原文相同（如纯中文）时丢掉副本、复用原串，不多占内存
const lowerOf = (text) => {
  const low = text.toLowerCase();
  return low === text ? text : low;
};

export class Indexer {
  constructor() {
    this.files = []; // 扫描快照
    this.texts = new Map(); // relPath -> 可检索文本
    this.lower = new Map(); // relPath -> 小写正文（检索用；与原文相同时就是同一个字符串，不多占内存）
    this.stamps = new Map(); // relPath -> 'mtimeMs:size'，下一轮构建据此复用未变文件的正文
    this._buildSeq = 0;
    this.dsId = null;
    this.baseDir = null;
  }

  reset(dsId, baseDir) {
    this.dsId = dsId;
    this.baseDir = baseDir;
    this.files = [];
    this.texts = new Map();
    this.lower = new Map();
    this.stamps = new Map();
  }

  // 扫描完成后重建索引文本（md/json 直接读；word 走缓存提取）。mtime 与大小都没变的文件直接复用上一轮的正文。
  // 新一轮构建开始后，进行中的旧一轮立即停下并返回 false（连续重扫时不做白工）；正常建完返回 true。
  // onProgress(done, total) 每处理完一个文件回调一次（供 /api/status 暴露索引进度）
  // 单个文件读取或解析超过 SLOW_FS_OP_MS 记 WARN，每次构建最多逐条记 SLOW_LOG_LIMIT 条，其余汇总一行；
  // 超过正文大小上限的文件跳过正文，结束时汇总一行
  async build(snapshot, onProgress) {
    const seq = ++this._buildSeq;
    const t0 = Date.now();
    const label = '建文本索引 ' + (this.baseDir ? path.basename(this.baseDir) : '');
    const SLOW_LOG_LIMIT = 20;
    let slowCount = 0;
    let oversized = 0;
    let largest = null; // 跳过的文件中最大的一个
    let reused = 0;
    await withActivity(label, async () => {
      const prev = { texts: this.texts, lower: this.lower, stamps: this.stamps };
      // 本轮写进自己的表：被取代的旧一轮即使还有在途读取，也写不进新一轮的表
      const texts = new Map();
      const lower = new Map();
      const stamps = new Map();
      const put = (f, text, low) => {
        texts.set(f.path, text);
        lower.set(f.path, low ?? lowerOf(text));
        stamps.set(f.path, f.mtimeMs + ':' + f.size);
      };
      this.files = snapshot.files;
      this.texts = texts;
      this.lower = lower;
      this.stamps = stamps;
      const total = this.files.length;
      let done = 0;
      const CONCURRENCY = 8;
      const queue = [...this.files];
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        let sliceStart = Date.now();
        while (queue.length) {
          if (seq !== this._buildSeq) return;
          const f = queue.shift();
          const fileStart = Date.now();
          if (prev.stamps.get(f.path) === f.mtimeMs + ':' + f.size && prev.texts.has(f.path)) {
            put(f, prev.texts.get(f.path), prev.lower.get(f.path));
            reused++;
            done++;
            if (onProgress) onProgress(done, total);
            continue;
          }
          const isText = f.ext === '.md' || f.ext === '.json' || f.ext === '.txt' || f.ext === '.html' || f.ext === '.htm';
          if (f.size > (isText ? TEXT_INDEX_MAX_BYTES : WORD_INDEX_MAX_BYTES)) {
            oversized++;
            if (!largest || f.size > largest.size) largest = f;
            done++;
            if (onProgress) onProgress(done, total);
            continue;
          }
          try {
            if (isText) {
              // 与前端 CodeMirror 的文档表示逐字符对齐：剥 BOM、纯 CRLF 归一为 LF、
              // 孤立 \r 与混用文档里的 \r 保留；非 UTF-8 经 decodeText 正确解码。
              const buf = await fs.promises.readFile(path.join(this.baseDir, f.path));
              // 同步处理期间登记活动：这一段若阻塞事件循环，[lag] 行会直接点出是哪个文件
              const endActivity = setActivity('处理正文 ' + f.path);
              try {
                const t0 = performance.now();
                const { content, encoding } = decodeText(buf);
                const t1 = performance.now();
                const text = toEditorText(content);
                const t2 = performance.now();
                const low = lowerOf(text);
                const t3 = performance.now();
                put(f, text, low);
                if (t3 - t0 > SYNC_SLOW_MS) {
                  console.warn(`[index] 主线程处理慢：${f.path}（${MB(buf.length)}MB，${encoding}）解码 ${Math.round(t1 - t0)}ms，换行归一 ${Math.round(t2 - t1)}ms，小写 ${Math.round(t3 - t2)}ms`);
                }
              } finally {
                endActivity();
              }
            } else {
              const t = await extractWordText(this.dsId, path.join(this.baseDir, f.path), f.path, f.mtimeMs);
              if (t !== null) put(f, t);
            }
          } catch {
            // 单个文件读取失败不阻塞整体索引
          }
          const ms = Date.now() - fileStart;
          if (ms > SLOW_FS_OP_MS && ++slowCount <= SLOW_LOG_LIMIT) {
            console.warn(`[index] 慢文件：${f.path} 读取或解析耗时 ${ms}ms`);
          }
          done++;
          if (onProgress) onProgress(done, total);
          // 每处理完一个文件检查已用时间，超过 30ms 让出事件循环（结果与顺序不变）
          if (Date.now() - sliceStart > 30) {
            await new Promise((r) => setImmediate(r));
            sliceStart = Date.now();
          }
        }
      });
      await Promise.all(workers);
    });
    if (seq !== this._buildSeq) return false;
    if (slowCount > SLOW_LOG_LIMIT) {
      console.warn(`[index] 慢文件：另有 ${slowCount - SLOW_LOG_LIMIT} 个文件读取或解析超过 ${SLOW_FS_OP_MS}ms 未逐条记录（本次共 ${slowCount} 个）`);
    }
    if (oversized) {
      console.warn(`[index] 跳过正文：${oversized} 个文件超过大小上限（文本 ${MB(TEXT_INDEX_MAX_BYTES)}MB / Word ${MB(WORD_INDEX_MAX_BYTES)}MB），只按文件名收录；最大的是 ${largest.path}（${MB(largest.size)}MB）`);
    }
    console.log('[index] 文本索引构建完成: ' + this.files.length + ' 个文件（复用未变 ' + reused + ' 个），耗时 ' + (Date.now() - t0) + 'ms');
    return true;
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
        const lower = this.lower.get(f.path);
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
