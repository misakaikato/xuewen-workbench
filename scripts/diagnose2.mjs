#!/usr/bin/env node
// 库内诊断 v2：定位「错指」与「表格未链」
// 只输出路径 / 文件名 / sidecar title / 词条 / 表格单元格文本，不输出正文段落
// 用法: node scripts/diagnose2.mjs "<库目录>" [关键词1] [关键词2] ...
import fs from 'node:fs';
import path from 'node:path';
import { buildAutoIndex, extractLinks, termCore, normalizeText } from '../server/linkMatch.js';

const base = process.argv[2];
const keywords = process.argv.slice(3);
if (!base || !fs.existsSync(base)) {
  console.error('用法: node scripts/diagnose2.mjs <库目录> [关键词...]');
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

// 词条：sidecar title 优先，否则 stem（与 links.js 同规则）
const docs = [];
for (const f of files) {
  let title = null;
  try {
    const m = JSON.parse(fs.readFileSync(f.abs + '.meta.json', 'utf8'));
    if (m && typeof m.title === 'string' && m.title.trim()) title = m.title.trim();
  } catch { /* 无旁注 */ }
  const name = f.rel.split('/').pop();
  const stem = name.slice(0, name.length - path.extname(name).length);
  docs.push({ ...f, title, stem, term: title || stem });
}
const entries = docs.map((d) => ({ term: d.term, path: d.rel, kind: 'title' }));
const idx = buildAutoIndex(entries, []);

console.log(`库: ${base}`);
console.log(`文档 ${docs.length} | 词条表 ${idx.byNorm.size} | 歧义 ${idx.ambiguous.size}`);

// ── 1) title 与文件名不符（错指的头号嫌疑）──
const titleMismatch = docs.filter((d) => d.title && d.title !== d.stem);
console.log(`\n=== title 与文件名不一致: ${titleMismatch.length} ===`);
for (const d of titleMismatch.slice(0, 20)) console.log(`  ${d.rel}\n    文件名「${d.stem}」 → title「${d.title}」`);

// ── 2) 关键词：词条 → 目标（定位错指）──
if (keywords.length) {
  console.log(`\n=== 关键词命中（词条 → 目标路径）===`);
  for (const kw of keywords) {
    const k = normalizeText(kw);
    const hits = [...idx.byNorm.entries()].filter(([norm]) => norm.includes(k) || k.includes(norm));
    console.log(`\n「${kw}」相关词条 ${hits.length}:`);
    for (const [norm, item] of hits.slice(0, 12)) {
      console.log(`  词条「${norm}」 → ${item.targets.map((t) => t.path).join(' , ')}`);
    }
    // 该关键词的文档
    const docsHit = docs.filter((d) => normalizeText(d.term).includes(k));
    console.log(`  文件命中 ${docsHit.length}:`);
    for (const d of docsHit.slice(0, 8)) console.log(`    ${d.rel}  (term「${d.term}」，核心「${termCore(normalizeText(d.term))}」)`);
  }
}

// ── 3) 表格单元格未链（定位「表格里没标记」）──
let cells = 0, linked = 0, unlinked = 0, candCells = 0;
const unlinkedSamples = [];
for (const d of docs) {
  if (!d.rel.endsWith('.md')) continue;
  const text = fs.readFileSync(d.abs, 'utf8');
  const links = extractLinks(text, idx, { selfPath: d.rel });
  // 表格行：以 | 开头的行，按 | 切单元格
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cellsInLine = line.split('|').map((c) => c.trim()).filter(Boolean);
    for (const cell of cellsInLine) {
      if (cell.length < 3 || /^[-:\s]+$/.test(cell) || /^\d+$/.test(cell)) continue; // 跳过表头分隔/序号
      cells++;
      const start = text.indexOf(cell, 0);
      // 该单元格文本单独扫描，判断是否可链
      const cellLinks = extractLinks(cell, idx, { selfPath: d.rel });
      if (cellLinks.some((l) => l.target)) linked++;
      else if (cellLinks.some((l) => l.candidates)) candCells++;
      else {
        unlinked++;
        if (unlinkedSamples.length < 25) unlinkedSamples.push({ doc: d.rel, cell: cell.slice(0, 40) });
      }
    }
  }
}
console.log(`\n=== 表格单元格 ===`);
console.log(`  总 ${cells} | 可直链 ${linked} | 候选 ${candCells} | 未链 ${unlinked}`);
console.log(`  未链样例（文档 ← 单元格文本）:`);
for (const s of unlinkedSamples) console.log(`    ${s.doc}  ←  「${s.cell}」`);
