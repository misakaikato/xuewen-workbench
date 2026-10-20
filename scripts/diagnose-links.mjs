#!/usr/bin/env node
// 内链诊断：只输出「文件名级」信息，不输出任何正文内容
// 用法: node scripts/diagnose-links.mjs "/path/to/你的库"
import fs from 'node:fs';
import path from 'node:path';
import { buildAutoIndex, extractLinks, termCore, normalizeText, MATCH_ENGINE_VERSION } from '../server/linkMatch.js';

const base = process.argv[2];
if (!base || !fs.existsSync(base)) {
  console.error('用法: node scripts/diagnose-links.mjs <库目录>');
  process.exit(1);
}

const EXTS = ['.md', '.txt', '.json'];
const files = [];
(function walk(dir, rel = '') {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isDirectory()) walk(abs, r);
    else if (EXTS.includes(path.extname(ent.name))) files.push({ abs, rel: r });
  }
})(base);

// 词条源：文件名 stem 或同名 .meta.json 的 title（与 links.js 同规则）
const entries = [];
const metaOf = new Map();
for (const f of files) {
  let title = null;
  try {
    const m = JSON.parse(fs.readFileSync(f.abs + '.meta.json', 'utf8'));
    if (m && typeof m.title === 'string' && m.title.trim()) title = m.title.trim();
  } catch { /* 无旁注 */ }
  const name = f.rel.split('/').pop();
  const stem = name.slice(0, name.length - path.extname(name).length);
  const term = title || stem;
  metaOf.set(f.rel, { title, stem, term });
  entries.push({ term, path: f.rel, kind: 'title' });
}

const idx = buildAutoIndex(entries, []);

console.log(`引擎版本: ${MATCH_ENGINE_VERSION}`);
console.log(`库: ${base}`);
console.log(`文档: ${files.length} | 词条表条目: ${idx.byNorm.size} | 歧义(不直链): ${idx.ambiguous.size}`);

// 1) 文件名形态分类（只看名字，不看内容）
const shape = { 编号前缀: 0, 日期前缀: 0, 括号后缀: 0, 纯标题: 0 };
const samples = { 编号前缀: [], 日期前缀: [], 括号后缀: [] };
for (const [rel, m] of metaOf) {
  const n = normalizeText(m.term);
  const core = termCore(n);
  if (core === n) {
    if (/[(（][^()（）]{0,12}[)）]$/.test(n)) { shape.括号后缀++; if (samples.括号后缀.length < 5) samples.括号后缀.push(rel); }
    else shape.纯标题++;
  } else if (/^\d|^[A-Za-z]{1,3}\d/.test(n)) {
    if (/^\d{4}[-/.年]/.test(n)) { shape.日期前缀++; if (samples.日期前缀.length < 5) samples.日期前缀.push(rel); }
    else { shape.编号前缀++; if (samples.编号前缀.length < 5) samples.编号前缀.push(rel); }
  } else shape.括号后缀++;
}
console.log('\n=== 文件名形态 ===');
for (const [k, v] of Object.entries(shape)) console.log(`  ${k}: ${v}`);
for (const [k, list] of Object.entries(samples)) {
  if (list.length) console.log(`  ${k}样例: ${list.join(' | ')}`);
}

// 2) 词条 → 核心 对照（只看名字层面的变化，判断包装是否剥离正确）
const stripped = [];
for (const [rel, m] of metaOf) {
  const n = normalizeText(m.term);
  const core = termCore(n);
  if (core !== n) stripped.push({ rel, term: m.term, core });
}
console.log(`\n=== 剥离出核心的文档: ${stripped.length} ===`);
for (const x of stripped.slice(0, 10)) console.log(`  ${x.term}  →  核心「${x.core}」`);

// 3) 每篇文档的链接统计（不输出正文）
let totalLinks = 0, totalCand = 0, noLinkDocs = 0;
const noLinkList = [];
for (const f of files) {
  const text = fs.readFileSync(f.abs, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const links = extractLinks(text, idx, { selfPath: f.rel });
  const direct = links.filter((l) => l.target).length;
  const cand = links.filter((l) => l.candidates).length;
  totalLinks += direct;
  totalCand += cand;
  if (direct + cand === 0) { noLinkDocs++; if (noLinkList.length < 20) noLinkList.push(f.rel); }
}
console.log(`\n=== 链接统计（不读正文，只计数） ===`);
console.log(`  直链总数: ${totalLinks} | 候选总数: ${totalCand} | 零链接文档: ${noLinkDocs}`);
if (noLinkList.length) {
  console.log('  零链接文档（前 20）:');
  for (const r of noLinkList) console.log(`    ${r}`);
}

// 4) 歧义词条（这些只会给候选，不会直链）
console.log(`\n=== 歧义词条（同核心多文档，只给候选）: ${idx.ambiguous.size} ===`);
const amb = [...idx.ambiguous].slice(0, 10);
for (const a of amb) console.log(`  ${a}`);
