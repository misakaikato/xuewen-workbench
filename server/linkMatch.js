// 自动内链共享匹配模块（服务端与前端浏览器使用同一份逻辑，保证编辑器与阅读器口径一致）。
// 纯函数、无 Node 依赖；所有偏移量均为输入文本的 UTF-16 码元偏移（与 GET /api/file
// 返回的 BOM 剥离后文本一致）。链接只在渲染层存在，绝不写回文档。
import { T2S_MAP } from './t2s.js';

// ---------- 归一化：逐字符 1:1 映射（繁→简 / 全角 ASCII→半角 / 拉丁小写） ----------

export function normalizeChar(ch) {
  const c = ch.charCodeAt(0);
  if (c >= 0xff01 && c <= 0xff5e) return String.fromCharCode(c - 0xfee0); // 全角 ASCII
  const m = T2S_MAP[ch];
  if (m) return m;
  if (c >= 0x41 && c <= 0x5a) return String.fromCharCode(c + 32); // A-Z
  return ch;
}

// 与输入等长的归一化文本（偏移量保持有效）
export function normalizeText(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) out += normalizeChar(s[i]);
  return out;
}

const hasCJK = (s) => /\p{Script=Han}/u.test(s);

// ---------- 词条可用性判定：不像名称的（纯数字/标点、日期、编号、占位名）不进词表 ----------

const DATE_RES = [
  /^\d{4}[-/.]\d{1,2}([-/.]\d{1,2})?$/,       // 2023-05-01 / 2023.5.1
  /^\d{4}年\d{1,2}月\d{1,2}日?$/,               // 2023年5月1日
  /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}日?$/,        // 2023-5-1日 这类混写
  /^\d{8}$/,                                   // 20230501
  /^\d{1,3}[-/.]\d{1,3}([-/.]\d{1,3})?$/,     // 05-01 这类短日期片段
];
const GENERIC_PREFIX_RE = /^(?:讲稿|文章|文档|笔记|草稿|手记|资料|材料)(?:\s*\d+)?$/; // 讲稿1 / 文章12
const CHAPTER_ONLY_RE = /^第?\s*\d+\s*(?:章|节|讲|课|篇|回|部分)?$/; // 第3章 / 12节 / 5
const PLACEHOLDER_RE = /^(?:未命名|新建文档|无标题|新文档|untitled|readme|index)(?:[-_\s]?\d*)$/i;

export function isTermLike(name) {
  const s = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return false;
  if ([...s].length === 1) return false; // 单字词条不自动链
  const cjk = hasCJK(s);
  if (!cjk) {
    if (!/[A-Za-z]/.test(s)) return false; // 纯数字/标点/符号
    if (s.length < 3) return false; // 拉丁词条至少 3 字符
  }
  if (DATE_RES.some((re) => re.test(s))) return false;
  if (GENERIC_PREFIX_RE.test(s) || CHAPTER_ONLY_RE.test(s) || PLACEHOLDER_RE.test(s)) return false;
  return true;
}

// ---------- 词条索引 ----------

// entries: [{term, path, heading?, kind:'title'|'alias'|'heading'}]
// 返回按首归一化字符分桶的自动链接词表：
//   { byChar: Map<首字, Array<{norm, len, isLatin, blocked?, targets:[{path,heading?}]}>>,
//     byNorm: Map<norm, 可链条目>, ambiguous:Set<norm> }
// 屏蔽词与歧义词（同归一化名 → ≥2 个不同文档）不可链（byNorm 不收），但仍以 blocked
// 占位条目进入 byChar 参与最长匹配：命中即整体消费，绝不再回退到其内部的短词条。
export function buildAutoIndex(entries, blocklist = []) {
  const block = new Set(blocklist.map((t) => normalizeText(String(t).trim()).toLowerCase()));
  // norm -> path -> 候选目标（同文档去重，标题优先于别名优先于标题条目）
  const grouped = new Map();
  for (const e of entries) {
    const term = String(e.term ?? '').trim();
    if (!term) continue;
    // force：人工/AI 确认过的条目（概念表），跳过 isTermLike 的启发式过滤，允许「道」「性」这类单字
    if (!e.force && !isTermLike(term)) continue;
    const norm = normalizeText(term);
    if (!grouped.has(norm)) grouped.set(norm, new Map());
    const byPath = grouped.get(norm);
    if (!byPath.has(e.path)) byPath.set(e.path, []);
    byPath.get(e.path).push({ heading: e.heading || null, kind: e.kind || 'title' });
  }
  const kindRank = { title: 0, alias: 1, heading: 2 };
  const byChar = new Map();
  const byNorm = new Map();
  const ambiguous = new Set();
  const addToChar = (item) => {
    const first = item.norm[0];
    if (!byChar.has(first)) byChar.set(first, []);
    byChar.get(first).push(item);
  };
  for (const [norm, byPath] of grouped) {
    if (block.has(norm.toLowerCase()) || byPath.size >= 2) {
      // 屏蔽/歧义（含两篇以上文档同名的通用标题）：不链，只作占位长词整体消费
      if (byPath.size >= 2) ambiguous.add(norm);
      addToChar({ norm, len: norm.length, isLatin: !hasCJK(norm), term: null, targets: [], blocked: true });
      continue;
    }
    const [[path, cands]] = [...byPath];
    cands.sort((a, b) => kindRank[a.kind] - kindRank[b.kind]);
    const item = {
      norm,
      len: norm.length,
      isLatin: !hasCJK(norm),
      term: null, // 由调用方回填展示名
      targets: [{ path, heading: cands[0].heading }],
    };
    byNorm.set(norm, item);
    addToChar(item);
  }
  for (const list of byChar.values()) list.sort((a, b) => b.len - a.len); // 最长优先
  return { byChar, byNorm, ambiguous };
}

// ---------- 文本结构分析：跳过区（代码/链接/URL/HTML/wikilink/围栏/YAML）与分节 ----------

function mergeRanges(out) {
  out.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

// 计算不应自动加链接的区间：围栏代码、行内代码、既有 Markdown 链接（文字与目标）、
// 图片、URL、HTML 标签、[[wikilink]]（单独处理）、YAML front matter、链接引用定义。
export function computeSkipRanges(text) {
  const out = [];
  const n = text.length;
  let i = 0;

  // YAML front matter：文件以 --- 行开头时跳过整个块
  if (/^---[ \t]*\r?\n/.test(text)) {
    const m = /\r?\n---[ \t]*(?=\r?\n)/.exec(text.slice(0, 100000));
    if (m) {
      out.push([0, m.index + m[0].length]);
      i = m.index + m[0].length;
    }
  }

  // 逐行处理：围栏代码整块跳过；其余行内扫描
  const push = (a, b) => {
    if (b > a) out.push([a, b]);
  };
  while (i < n) {
    let eol = text.indexOf('\n', i);
    if (eol < 0) eol = n;
    let end = eol;
    if (end > i && text[end - 1] === '\r') end--;
    const line = text.slice(i, end);
    const fence = /^(\s{0,3})(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[2][0].repeat(fence[2].length);
      // 找到闭合围栏行（同级或更长），未闭合则到文末
      let j = eol + 1;
      let close = -1;
      while (j < n) {
        let e2 = text.indexOf('\n', j);
        if (e2 < 0) e2 = n;
        let en2 = e2;
        if (en2 > j && text[en2 - 1] === '\r') en2--;
        const l2 = text.slice(j, en2);
        if (new RegExp('^\\s{0,3}' + (marker[0] === '`' ? '`{3,}' : '~{3,}')).test(l2)) {
          close = e2;
          break;
        }
        j = e2 + 1;
      }
      push(i, close < 0 ? n : Math.min(close + 1, n));
      i = close < 0 ? n : close + 1;
      continue;
    }
    inlineScan(line, i, push);
    i = eol + 1;
  }
  return mergeRanges(out);
}

// 单行内扫描：行内代码、wikilink、Markdown 链接/图片、URL、HTML 标签、引用定义
function inlineScan(line, base, push) {
  const n = line.length;
  let i = 0;
  while (i < n) {
    const ch = line[i];
    // 行内代码：等长反引号配对
    if (ch === '`') {
      let run = 0;
      while (i + run < n && line[i + run] === '`') run++;
      const close = findRun(line, i + run, run);
      if (close >= 0) {
        push(base + i, base + close + run);
        i = close + run;
        continue;
      }
      i += run;
      continue;
    }
    // [[wikilink]]
    if (ch === '[' && line[i + 1] === '[') {
      const close = line.indexOf(']]', i + 2);
      if (close >= 0) {
        push(base + i, base + close + 2);
        i = close + 2;
        continue;
      }
    }
    // Markdown 链接/图片 [文字](目标)、![替代](来源)、引用式 [文字][label]：整段（文字+目标）跳过
    if (ch === '!' && line[i + 1] === '[') {
      const r = matchBracketLink(line, i + 1);
      if (r) {
        push(base + i, base + r.end);
        i = r.end;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '[') {
      const r = matchBracketLink(line, i);
      if (r) {
        push(base + i, base + r.end);
        i = r.end;
        continue;
      }
      // 引用定义 [label]: url —— 整行剩余部分跳过
      const def = /^(\[[^\[\]]+\]):[ \t]*\S/.exec(line.slice(i));
      if (def) {
        push(base + i, base + n);
        return;
      }
      i++;
      continue;
    }
    // URL
    if ((ch === 'h' || ch === 'H') && /^https?:\/\//i.test(line.slice(i))) {
      const m = /^[^\s<>()\[\]]+/.exec(line.slice(i));
      if (m) {
        push(base + i, base + i + m[0].length);
        i += m[0].length;
        continue;
      }
    }
    // HTML 标签（含自动链接 <https://…>）
    if (ch === '<') {
      const m = /^<\/?[A-Za-z][^<>]*>/.exec(line.slice(i));
      if (m) {
        push(base + i, base + i + m[0].length);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
}

function findRun(line, from, run) {
  let i = from;
  while (i < line.length) {
    if (line[i] === '`') {
      let r = 0;
      while (i + r < line.length && line[i + r] === '`') r++;
      if (r === run) return i;
      i += r;
    } else i++;
  }
  return -1;
}

// [文字](目标)（目标允许一层嵌套括号）或 [文字][引用名]：返回整段末尾，未命中返回 null
function matchBracketLink(line, at) {
  const m = /^\[[^\[\]\r\n]*\]/.exec(line.slice(at));
  if (!m) return null;
  const after = at + m[0].length;
  const c = line[after];
  if (c === '(') {
    let i = after + 1;
    let depth = 1;
    while (i < line.length && depth > 0) {
      const ch = line[i];
      if (ch === '\\' && i + 1 < line.length) {
        i += 2;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return { end: i + 1 };
      }
      i++;
    }
    return null;
  }
  if (c === '[') {
    const m2 = /^\[[^\[\]\r\n]*\]/.exec(line.slice(after));
    if (m2) return { end: after + m2[0].length };
  }
  return null;
}

// 分节边界：ATX 标题行与其后内容、setext 标题（=== / --- 下划线）均开启新节
export function computeSectionStarts(text) {
  const starts = [];
  let i = 0;
  const n = text.length;
  let prevParaStart = -1;
  let prevParaBlank = true;
  while (i <= n) {
    let eol = text.indexOf('\n', i);
    if (eol < 0) eol = n;
    let end = eol;
    if (end > i && text[end - 1] === '\r') end--;
    const line = text.slice(i, end);
    if (/^ {0,3}#{1,6}(\s|$)/.test(line)) {
      starts.push(i);
      prevParaBlank = true;
    } else if (/^ {0,3}(=+|-+)\s*$/.test(line) && !prevParaBlank && prevParaStart >= 0) {
      starts.push(prevParaStart); // setext 标题行本身开新节
      prevParaBlank = true;
    } else if (line.trim() === '') {
      prevParaBlank = true;
    } else {
      if (prevParaBlank) prevParaStart = i;
      prevParaBlank = false;
    }
    if (eol >= n) break;
    i = eol + 1;
  }
  return starts;
}

// ---------- 自动链接提取 ----------

const isWordChar = (ch) => /[a-z0-9_]/.test(ch);

// text: 原文；autoIndex: buildAutoIndex 的结果；opts.selfPath: 本文路径（不链自身）
// 返回 [{from, to, term, norm, target:{path, heading?}}]（不含被忽略判定——那由服务端状态层处理）
export function extractLinks(text, autoIndex, opts = {}) {
  const selfPath = opts.selfPath ?? null;
  const out = [];
  if (!autoIndex || autoIndex.byChar.size === 0) return out;
  const norm = normalizeText(text);
  const n = norm.length;
  const skips = computeSkipRanges(text);
  const sections = computeSectionStarts(text);
  let skipI = 0;
  let secI = 0;
  let seen = new Set(); // 本节内已链接的词条（按 norm）
  for (let i = 0; i < n;) {
    // 越过分节边界：清空已见集合
    while (secI < sections.length && i >= sections[secI]) {
      seen = new Set();
      secI++;
    }
    // 跳过区间直接前进
    while (skipI < skips.length && skips[skipI][1] <= i) skipI++;
    if (skipI < skips.length && i >= skips[skipI][0]) {
      i = skips[skipI][1];
      continue;
    }
    const bucket = autoIndex.byChar.get(norm[i]);
    if (bucket) {
      let consumeTo = 0; // 最长命中即消费（即使因自身/已见而不链，也不再匹配其内部短词）
      for (const item of bucket) {
        const j = i + item.len;
        if (j > n || !norm.startsWith(item.norm, i)) continue;
        // 拉丁/数字词条要求词边界（Ren 不得命中 Renaissance 内部）
        if (item.isLatin && ((i > 0 && isWordChar(norm[i - 1])) || (j < n && isWordChar(norm[j])))) continue;
        // 与跳过区重叠：换更短词条再试（可能止于跳过区之前）
        if (skipI < skips.length && j > skips[skipI][0]) continue;
        consumeTo = j;
        if (!item.blocked) { // 屏蔽/歧义/通用长词：整体消费，不链也不再试内部短词
          const t = item.targets.find((t2) => t2.path !== selfPath); // 不链自身
          if (t && !seen.has(item.norm)) {
            seen.add(item.norm);
            out.push({
              from: i,
              to: j,
              term: text.slice(i, j),
              norm: item.norm,
              target: t,
            });
          }
        }
        break; // 桶内已按长度降序，首个可行命中即最长（含被消费的占位长词）
      }
      if (consumeTo) {
        i = consumeTo;
        continue;
      }
    }
    i++;
  }
  return out;
}

// ---------- [[wikilink]] 解析 ----------

// 返回 [{from, to, name, heading, display}]；国栏/行内代码内的 [[...]] 不算（自动链接的
// 跳过区把 wikilink 本身也列为跳过，这里只排除代码类区域）
export function extractWikilinks(text) {
  const out = [];
  const re = /\[\[([^\[\]\r\n]*?)\]\]/g;
  let m;
  while ((m = re.exec(text))) {
    const from = m.index;
    const to = from + m[0].length;
    if (inCode(text, from)) continue;
    let body = m[1];
    let display = null;
    const bar = body.indexOf('|');
    if (bar >= 0) {
      display = body.slice(bar + 1).trim();
      body = body.slice(0, bar);
    }
    let heading = null;
    const hash = body.indexOf('#');
    if (hash >= 0) {
      heading = body.slice(hash + 1).trim() || null;
      body = body.slice(0, hash);
    }
    const name = body.trim();
    if (!name && !heading) continue;
    out.push({ from, to, name, heading, display, raw: m[0] });
  }
  return out;
}

// 光标处 wikilink 名称段（供 [[ 自动补全）：返回 {name, from}（name 为已输入部分，from 为其起点）
export function wikiNameAt(text, pos) {
  const seg = text.slice(0, pos);
  const open = seg.lastIndexOf('[[');
  if (open < 0) return null;
  const after = seg.slice(open + 2);
  if (/[\r\n\[\]]/.test(after)) return null; // 已闭合或跨行
  const close = text.indexOf(']]', open + 2);
  if (close >= 0 && pos > close) return null;
  const bar = after.indexOf('|');
  if (bar >= 0) return null; // 已进入显示文字部分
  const hash = after.indexOf('#');
  if (hash >= 0) return null; // 已进入标题锚部分
  return { name: after, from: open + 2 };
}

// 某位置是否在国栏代码或行内代码内（wikilink 在代码里不解析）
function inCode(text, pos) {
  let i = 0;
  let inFence = false;
  while (i <= pos) {
    let eol = text.indexOf('\n', i);
    if (eol < 0) eol = text.length;
    let end = eol;
    if (end > i && text[end - 1] === '\r') end--;
    const line = text.slice(i, end);
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    else if (inFence) {
      // 国栏内
    } else {
      // 行内代码：等长反引号配对区间包含 pos 则在代码内（扫整行，避免截断满气配对）
      let j = 0;
      while (j < line.length) {
        if (line[j] === '`') {
          let run = 0;
          while (j + run < line.length && line[j + run] === '`') run++;
          let k = j + run;
          let close = -1;
          while (k < line.length) {
            if (line[k] === '`') {
              let r2 = 0;
              while (k + r2 < line.length && line[k + r2] === '`') r2++;
              if (r2 === run) {
                close = k;
                break;
              }
              k += r2;
            } else k++;
          }
          if (close >= 0) {
            if (pos - i >= j && pos - i < close + run) return true;
            j = close + run; // 配对成功：既过开也过关，避免把关闭反引号再当开标记
          } else {
            j += run;
          }
        } else j++;
      }
    }
    if (eol >= text.length) break;
    i = eol + 1;
  }
  return inFence;
}
