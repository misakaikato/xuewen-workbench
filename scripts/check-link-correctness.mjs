#!/usr/bin/env node
// 内链「正确性」检查：不只问有没有链，还问链到的目标是否就是那一篇
// 数据来源：workbench-text（已授权）
import fs from 'node:fs';
import { buildAutoIndex, extractLinks } from '../server/linkMatch.js';

const BASE = '/Users/mayu/Projects/workbench-text';
const read = (f) => fs.readFileSync(BASE + '/' + f, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

// ── 词条源（与真实库同规则：路径 -> stem）──
const paths = [];
for (const line of read('tree.txt').split('\n')) {
  const m = /([^\s│├└─][^│]*\.md)\s*$/.exec(line);
  if (m) paths.push(m[1].trim());
}
let inOther = false;
for (const line of read('02_文章大全排序.md').split('\n')) {
  if (/^## /.test(line)) inOther = /博山文章/.test(line);
  const m = /^\|\s*\d+\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|/.exec(line);
  if (m && inOther) paths.push(`文章大全/博山文章/${m[1]}-${m[2].replace(/\s*⚠.*$/, '').trim()}.md`);
}
const stem = (p) => p.split('/').pop().slice(0, -3);
const entries = paths.map((p) => ({ term: stem(p), path: p, kind: 'title' }));
const idx = buildAutoIndex(entries, []);
console.log(`文档词条: ${paths.length} | 词条表条目: ${idx.byNorm.size} | 歧义: ${idx.ambiguous.size}`);

// ── 逐行验证「提及 → 目标」是否正确 ──
function check(name, rows, pick) {
  let ok = 0, wrong = 0, cand = 0, none = 0;
  const wrongs = [];
  for (const row of rows) {
    const { mention, expectSplit } = pick(row); // expectSplit: 期望 target 路径应包含的片段
    if (!mention) continue;
    const links = extractLinks(mention, idx, { selfPath: null });
    const hit = links.find((l) => l.target) || links.find((l) => l.candidates);
    if (!hit) { none++; continue; }
    if (hit.candidates) { cand++; if (wrongs.length < 8) wrongs.push({ mention, kind: '候选', got: hit.candidates.slice(0, 2) }); continue; }
    // 正确性：target 路径要包含期望片段（日期-标题 或 编号.篇名）
    if (!expectSplit || hit.target.path.includes(expectSplit)) ok++;
    else { wrong++; if (wrongs.length < 8) wrongs.push({ mention, kind: '错指', got: [hit.target.path] }); }
  }
  console.log(`\n=== ${name} ===`);
  console.log(`  正确 ${ok} / 错指 ${wrong} / 候选 ${cand} / 未链 ${none}`);
  for (const w of wrongs) console.log(`  ${w.kind}: 「${w.mention}」 → ${JSON.stringify(w.got)}`);
}

// 02 标题列：期望 target 含「日期-标题」
check('02 标题列（日期+标题 → 对应文档）',
  read('02_文章大全排序.md').split('\n').filter((l) => /^\|\s*\d+\s*\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(l)),
  (l) => {
    const c = l.split('|');
    const date = c[2]?.trim();
    const title = (c[3] || '').replace(/\s*⚠.*$/, '').trim();
    return { mention: title, expectSplit: `${date}-${title}` };
  });

// 01 篇名列：期望 target 含「N.篇名」
check('01 篇名列（篇名 → 编号文档）',
  read('01_讲课转录排序.md').split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l)),
  (l) => {
    const c = l.split('|');
    const no = c[1]?.trim();
    const name = c[2]?.trim();
    const file = c[3]?.trim();
    return { mention: name, expectSplit: file ? file.replace(/\.md$/, '') : null, no };
  });
