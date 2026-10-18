// RAG 切块器：结构化切块（不按固定字数硬切）。
// md 按 ATX 标题层级成节，超长节按段落边界二次分组（围栏代码块不拆）；
// docx/纯文本按段落分组；json 数组按条目、对象按顶层键（字段名保留）。
// 每块输出 { headingPath, text }；嵌入文本（headingPath + 正文）由调用方拼接。

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

const jsonItemText = (key, val, limit) => {
  const t = typeof val === 'string' ? val : JSON.stringify(val);
  const body = t && t.length > limit ? t.slice(0, limit) + '…' : t;
  return key ? `${key}: ${body}` : body;
};

export function chunkJson(text, cfg = DEFAULT_RAG_CONFIG.chunk) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return chunkPlainText(text); // 坏 JSON 按纯文本兜底
  }
  const out = [];
  if (Array.isArray(data)) {
    data.forEach((item, i) => {
      const key = item && typeof item === 'object' && !Array.isArray(item)
        ? Object.entries(item).slice(0, 3).map(([k]) => k).join(', ')
        : null;
      out.push({ headingPath: `条目 ${i + 1}`, text: jsonItemText(key, item, cfg.jsonValueLimit) });
    });
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      const t = jsonItemText(k, v, cfg.jsonValueLimit);
      if (t.trim()) out.push({ headingPath: k, text: t });
    }
  } else {
    out.push({ headingPath: '', text: String(data).slice(0, cfg.jsonValueLimit) });
  }
  return out.length ? out : [{ headingPath: '', text: text.slice(0, cfg.jsonValueLimit) }];
}

// ---- 统一入口 ----

export function chunkFile(ext, text, cfg = DEFAULT_RAG_CONFIG.chunk) {
  if (ext === '.md') return chunkMarkdown(text, cfg);
  if (ext === '.json') return chunkJson(text, cfg);
  return chunkPlainText(text, cfg); // .txt / .doc / .docx 提取文本
}

// 块的嵌入文本：标题路径 + 正文（给向量与 FTS 提供语境；headingContext=false 时仅正文）
export function embedTextOf(chunk, headingContext = true) {
  return headingContext && chunk.headingPath ? `${chunk.headingPath}\n\n${chunk.text}` : chunk.text;
}
