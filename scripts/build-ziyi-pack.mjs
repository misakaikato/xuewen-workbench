// 合并两套字义目录为一个字义文件（导入「设置 → 字义库」用）：
//   --lecture <目录>  课堂讲解（每字一个 json；字头可带异体，如「类（類 ）」「体-體」）→ origin: lecture
//   --ai <目录>       AI 推导（每字一个 json）→ origin: ai
//   --out <文件>      输出 { format: 'xuewen-ziyi', version: 1, entries: [...] }
// 同一字两边都有时以课堂讲解为准；课堂那边释义为空或「待定」时用 AI 推导的。
// 「同一字」指繁简归一后相同（如课堂「億」与 AI「亿」、课堂「体-體」与 AI「體」），并入课堂字头，AI 字头记为异体字；
// 课堂字头括号里的其他字（可能是通假、古今字，如「藉（籍）」）不算同一字，不合并，各自保留。
// 只打印计数与文件名，不输出任何字义内容。
// 运行：node scripts/build-ziyi-pack.mjs --lecture <hans 目录> --ai <annotations 目录> --out <字义库.json>
import fs from 'node:fs';
import path from 'node:path';
import { PACK_FORMAT } from '../server/ziyi.js';
import { normalizeText } from '../server/linkMatch.js';

const HAN_G = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{3FFFF}]/gu;
// 空、「待定」及带括号句号的写法都算没有释义
const isPending = (m) => !m || /^[\s（(【[]*待定[\s）)】\]。.！!]*$/.test(m);

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) {
    console.error(`缺少 ${name}。用法：node scripts/build-ziyi-pack.mjs --lecture <目录> --ai <目录> --out <文件>`);
    process.exit(64);
  }
  return process.argv[i + 1];
}

/** 个别条目是 docx 富文本 JSON（{"...":{"text":"..."}}），抽出全部 text 拼成纯文本（可能为空串）；不是 JSON 则原样返回 */
function richToText(s) {
  if (typeof s !== 'string') return '';
  if (!s.trimStart().startsWith('{')) return s;
  let d;
  try {
    d = JSON.parse(s);
  } catch {
    return s;
  }
  const texts = [];
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (k === 'text' && typeof v === 'string' && v.trim()) texts.push(v);
        else walk(v);
      }
    }
  };
  if (!d || typeof d !== 'object') return s;
  walk(d);
  return texts.join('\n');
}

/** 读一个目录：返回 Map<字头, { variants, meaning, source, file, rich }>，以及解析失败、无字头的文件名 */
function readDir(dir) {
  const out = new Map();
  const bad = [];
  const noHead = [];
  const dup = [];
  const headMismatch = [];
  let rich = 0;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!/\.json$/i.test(f) || /^[_.]/.test(f)) continue;
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, ''));
    } catch {
      bad.push(f);
      continue;
    }
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      bad.push(f);
      continue;
    }
    const raw = typeof d.han === 'string' && d.han.trim() ? d.han : f.replace(/\.json$/i, '');
    const chars = [...new Set(raw.match(HAN_G) || [])];
    const head = chars[0];
    if (!head) { noHead.push(f); continue; }
    const fileHead = (f.match(HAN_G) || [])[0];
    if (fileHead && fileHead !== head) headMismatch.push(f);
    const meaning0 = typeof d.meaning === 'string' ? d.meaning : '';
    const source0 = typeof d.source === 'string' ? d.source : '';
    const meaning = richToText(meaning0).trim();
    const source = richToText(source0).trim();
    if (meaning !== meaning0.trim() || source !== source0.trim()) rich++;
    if (out.has(head)) dup.push(f);
    out.set(head, { head, variants: chars.slice(1), meaning, source, file: f });
  }
  return { map: out, bad, noHead, dup, headMismatch, rich };
}

const lectureDir = arg('--lecture');
const aiDir = arg('--ai');
const outFile = arg('--out');
const L = readDir(lectureDir);
const A = readDir(aiDir);

// AI 目录的字头与某条课堂字头繁简归一后相同：改挂到那条课堂字头上
const alias = new Map();
for (const h of L.map.keys()) {
  const k = normalizeText(h);
  if (!alias.has(k)) alias.set(k, h);
}
const aiMap = new Map();
const aliased = [];
const aliasClash = [];
for (const [a, e] of A.map) {
  const target = L.map.has(a) ? a : alias.get(normalizeText(a)) ?? a;
  if (target !== a) aliased.push(e.file);
  if (aiMap.has(target)) {
    // 同一课堂字头下有两条 AI：字头完全相同的那条优先
    aliasClash.push(e.file);
    if (target !== a) continue;
  }
  aiMap.set(target, e);
}
// 异体字可疑：一个字头下 ≥2 个异体字，或异体字本身也是另一条的字头
const manyVariants = [];
const variantIsHead = [];
for (const [h, l] of L.map) {
  if (l.variants.length >= 2) manyVariants.push(l.file);
  if (l.variants.some((v) => v !== h && (L.map.has(v) || aiMap.has(v)))) variantIsHead.push(l.file);
}

const entries = [];
const stat = { lecture: 0, ai: 0, overlap: 0, overlapLecture: 0, overlapPendingUsedAi: 0, pendingSkipped: [] };
const heads = [...new Set([...L.map.keys(), ...aiMap.keys()])].sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
for (const han of heads) {
  const l = L.map.get(han);
  const a = aiMap.get(han);
  const lectureOk = l && !isPending(l.meaning);
  if (l && a) stat.overlap++;
  // 并入的 AI 字头（繁简不同写法）记为异体字，查它也落到本条
  const variants = [...new Set([...(l ? l.variants : []), ...(a ? a.variants : []), ...(a && a.head !== han ? [a.head] : [])])].filter((v) => v !== han);
  if (lectureOk) {
    if (a) stat.overlapLecture++;
    entries.push({ han, ...(variants.length ? { variants } : {}), origin: 'lecture', meaning: l.meaning, source: l.source });
    stat.lecture++;
  } else if (a && !isPending(a.meaning)) {
    if (l) stat.overlapPendingUsedAi++;
    entries.push({ han, ...(variants.length ? { variants } : {}), origin: 'ai', meaning: a.meaning, source: a.source });
    stat.ai++;
  } else {
    stat.pendingSkipped.push((l || a).file);
  }
}

fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ format: PACK_FORMAT, version: 1, generatedAt: new Date().toISOString(), entries }, null, 1) + '\n');

const list = (xs) => (xs.length ? `${xs.length}（${xs.slice(0, 10).join('、')}${xs.length > 10 ? ' …' : ''}）` : '0');
console.log(`课堂讲解目录：${L.map.size} 字；解析失败 ${list(L.bad)}；无字头 ${list(L.noHead)}；同字多文件 ${list(L.dup)}；文件名与 han 字段首字不一致 ${list(L.headMismatch)}；富文本转纯文本 ${L.rich}`);
console.log(`AI 推导目录：${A.map.size} 字；解析失败 ${list(A.bad)}；无字头 ${list(A.noHead)}；同字多文件 ${list(A.dup)}；文件名与 han 字段首字不一致 ${list(A.headMismatch)}；富文本转纯文本 ${A.rich}`);
console.log(`AI 字头按繁简并入课堂字头：${list(aliased)}；并入时同一课堂字头下已有 AI 条目而舍去：${list(aliasClash)}`);
console.log(`两边都有：${stat.overlap} 字，其中用课堂讲解 ${stat.overlapLecture}，课堂释义为空或「待定」改用 AI 推导 ${stat.overlapPendingUsedAi}`);
console.log(`请核对异体字：一个字头带 ≥2 个异体字 ${list(manyVariants)}；异体字本身也是字头 ${list(variantIsHead)}`);
console.log(`两边都没有可用释义而跳过：${list(stat.pendingSkipped)}`);
console.log(`输出 ${entries.length} 字（课堂讲解 ${stat.lecture}，AI 推导 ${stat.ai}）→ ${path.resolve(outFile)}（${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB）`);
