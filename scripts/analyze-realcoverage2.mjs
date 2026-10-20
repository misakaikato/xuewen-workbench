#!/usr/bin/env node
// 真实语料覆盖率 v2：01/02/06 三种提及形态
import fs from 'node:fs';
import { buildAutoIndex, extractLinks } from '../server/linkMatch.js';

const BASE = '/Users/mayu/Projects/workbench-text';
const read = (f) => fs.readFileSync(BASE + '/' + f, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

// ── 词条源 ──
// 1) tree.txt 的 226 个 md
const paths = [];
for (const line of read('tree.txt').split('\n')) {
  const m = /([^\s│├└─][^│]*\.md)\s*$/.exec(line);
  if (m) paths.push(m[1].trim());
}
// 2) 02 排序的博山文章：| N | YYYY-MM-DD | 标题 | → 拼接为磁盘文件名
let inBoshanwenzhang = false;
for (const line of read('02_文章大全排序.md').split('\n')) {
  if (/^## /.test(line)) inBoshanwenzhang = /博山文章/.test(line);
  const m = /^\|\s*\d+\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|/.exec(line);
  if (m && inBoshanwenzhang) {
    const title = m[2].replace(/\s*⚠.*$/, '').trim();
    paths.push(`博山文章/${m[1]}-${title}.md`);
  }
}
const stem = (p) => p.split('/').pop().slice(0, -3);
const entries = paths.map((p) => ({ term: stem(p), path: p, kind: 'title' }));
const idx = buildAutoIndex(entries, []);
console.log(`词条文档数: ${paths.length}`);

// ── 场景 1：01 排序的「篇名」列（劝学 ↔ 1.劝学.md）──
function testRows(name, lines, extractMention, expectStemFromRow) {
  let hit = 0, cand = 0, miss = 0;
  const misses = [];
  for (const line of lines) {
    const mention = extractMention(line);
    if (!mention) continue;
    const links = extractLinks(mention, idx, { selfPath: null });
    const direct = links.find((l) => l.target);
    const candidate = links.find((l) => l.candidates);
    if (direct) hit++;
    else if (candidate) cand++;
    else { miss++; if (misses.length < 15) misses.push(mention); }
  }
  console.log(`\n=== ${name} ===`);
  console.log(`直接链 ${hit} / 候选 ${cand} / 未链 ${miss}`);
  for (const m of misses) console.log(`  ✗ ${m}`);
}

// 01：| 1 | 劝学 | 1.劝学.md |
testRows('01 篇名列（劝学 ↔ 1.劝学.md）',
  read('01_讲课转录排序.md').split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l)),
  (l) => l.split('|')[2]?.trim());

// 02：| 1 | 2021-01-13 | 日月之行，暮西朝东 |（标题列）
testRows('02 标题列（裸标题 ↔ 日期前缀文档）',
  read('02_文章大全排序.md').split('\n').filter((l) => /^\|\s*\d+\s*\|\s*\d{4}-/.test(l)),
  (l) => l.split('|')[3]?.trim().replace(/\s*⚠.*$/, ''));

// 06：- 集合 / 裸标题
testRows('06 概念反查（集合 / 裸标题）',
  read('06_概念反查.md').split('\n').filter((l) => /^- .+ \/ .+/.test(l)),
  (l) => l.replace(/^- /, '').trim());

// 02 博山庐记事标题列（tree.txt 有原文档，含系列后缀案例）
testRows('02 博山庐记事标题列（含 （一）/ - 拷贝 / 序言二）',
  read('02_文章大全排序.md').split('\n').filter((l) => /^\|\s*\d+\s*\|\s*\d{4}-/.test(l)).slice(0, 90),
  (l) => l.split('|')[3]?.trim().replace(/\s*⚠.*$/, ''));
