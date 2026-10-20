// RAG 切块器：结构化切块（不按固定字数硬切）。
// md 按 ATX 标题层级成节，超长节按段落边界二次分组（围栏代码块不拆）；
// docx/纯文本按段落分组；json 数组按条目、对象按顶层键（字段名保留）。
// 每块输出 { headingPath, text }；嵌入文本（headingPath + 正文）由调用方拼接。

import { DEFAULT_RAG_CONFIG } from './config.js';

const MAX_CHARS = 600; // 单块目标上限（CJK 字符数）；超长节按段落聚合二次分组

// ---- md ----

// 扫描行 → 节列表 [{ headingPath, lines }]；围栏内不识别标题
function mdSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let stack = []; // {level, title}
  let cur = { headingPath: '', lines: [] };
  let fence = null; // ``` 或 ~~~
  const flush = () => {
    sections.push(cur);
    cur = { headingPath: stack.map((h) => h.title).join(' > '), lines: [] };
  };
  for (const line of lines) {
    const fm = /^(\s{0,3})(```|~~~)/.exec(line);
    if (fm) {
      if (!fence) fence = fm[2];
      else if (line.trim().startsWith(fence)) fence = null;
      cur.lines.push(line);
      continue;
    }
    if (!fence) {
      const hm = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (hm) {
        flush();
        const level = hm[1].length;
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        stack.push({ level, title: hm[2].trim() });
        cur.headingPath = stack.map((h) => h.title).join(' > ');
        continue; // 标题行本身不进正文
      }
    }
    cur.lines.push(line);
  }
  flush();
  return sections;
}

// 行分组 → 段落单元（空行分隔；围栏块、表格、列表项整体为不可拆单元）
function paragraphs(lines) {
  const units = [];
  let buf = [];
  let fence = null;
  const flush = () => {
    if (buf.length) {
      const t = buf.join('\n').trim();
      if (t) units.push(t);
      buf = [];
    }
  };
  for (const line of lines) {
    const fm = /^(\s{0,3})(```|~~~)/.exec(line);
    if (fm) {
      if (!fence) {
        flush();
        fence = fm[2];
      } else if (line.trim().startsWith(fence)) fence = null;
      buf.push(line);
      continue;
    }
    if (!fence && line.trim() === '') {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return units;
}

// 段落单元聚合成 ≤MAX_CHARS 的块（单元本身超限则独立成块，不硬切）
function groupUnits(units, cfg) {
  const maxChars = cfg.maxChars;
  const out = [];
  let acc = [];
  let len = 0;
  const flush = () => {
    if (acc.length) {
      out.push(acc.join('\n\n'));
      acc = [];
      len = 0;
    }
  };
  for (const u of units) {
    if (len > 0 && len + u.length > maxChars) flush();
    if (u.length > maxChars && cfg.hardSplitOversize) {
      // 硬切模式：超长单元按 maxChars 切片
      flush();
      for (let i = 0; i < u.length; i += maxChars) out.push(u.slice(i, i + maxChars));
      continue;
    }
    acc.push(u);
    len += u.length;
    if (len >= maxChars) flush(); // 单个大单元独立成块（默认不硬切）
  }
  flush();
  return out;
}

export function chunkMarkdown(text, cfg = DEFAULT_RAG_CONFIG.chunk) {
  const out = [];
  for (const sec of mdSections(text)) {
    const units = paragraphs(sec.lines);
    if (!units.length) continue;
    for (const body of groupUnits(units, cfg)) {
      out.push({ headingPath: sec.headingPath, text: body });
    }
  }
  return out;
}

// ---- docx / 纯文本（word.js 提取的段落文本，\n\n 分段） ----

export function chunkPlainText(text, cfg = DEFAULT_RAG_CONFIG.chunk) {
  return groupUnits(paragraphs(text.split(/\r?\n/)), cfg).map((body) => ({ headingPath: '', text: body }));
}

// ---- json：数组按条目，对象按顶层键；字段名保留在块文本里 ----

// 保留原始 JSON 字符串片段，避免合成的「键名: 值」无法定位阅读源码。
export function chunkJson(text, cfg = DEFAULT_RAG_CONFIG.chunk) {
  let data;
  try { data = JSON.parse(text); } catch { return chunkPlainText(text, cfg); }
  if (!data || typeof data !== 'object') {
    return [{ headingPath: '', text: text.trim().slice(0, cfg.jsonValueLimit) }];
  }
  const keys = Array.isArray(data) ? null : Object.keys(data);
  const out = [];
  let depth = 0, quoted = false, escaped = false, start = -1;
  const emit = (end) => {
    const body = text.slice(start, end).trim();
    if (body) out.push({ headingPath: keys ? keys[out.length] : '条目 ' + (out.length + 1), text: body.slice(0, cfg.jsonValueLimit) });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === '{' || ch === '[') {
      if (depth++ === 0) start = i + 1;
    } else if (ch === '}' || ch === ']') {
      if (--depth === 0) emit(i);
    } else if (ch === ',' && depth === 1) { emit(i); start = i + 1; }
  }
  return out.length ? out : [{ headingPath: '', text: text.trim() }];
}

// ---- 统一入口 ----

export function chunkFile(ext, text, cfg = DEFAULT_RAG_CONFIG.chunk) {
  if (ext === '.md') return chunkMarkdown(text, cfg);
  if (ext === '.json') return chunkJson(text, cfg);
  return chunkPlainText(text, cfg); // .txt / .doc / .docx 提取文本
}

// 块的嵌入文本（向量与 FTS 共用，唯一实现处）：[文件名]\n[标题路径]\n\n正文。
// 文件名/标题路径提供语境与检索面——文件名含查询词但正文没有的文件也能命中。
export function embedTextOf(chunk, opts = {}) {
  const { headingContext = true, fileName = '' } = opts;
  const head = [fileName, headingContext ? chunk.headingPath || '' : ''].filter(Boolean).join('\n');
  return head ? head + '\n\n' + chunk.text : chunk.text;
}
