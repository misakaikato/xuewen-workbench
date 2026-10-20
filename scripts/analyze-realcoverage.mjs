#!/usr/bin/env node
// 真实语料内链覆盖率分析：tree.txt 的文件名 → 04_内容索引.md 的提及命中情况
// 只读 /Users/mayu/Projects/workbench-text，不触碰其他数据
import fs from 'node:fs';
import { buildAutoIndex, extractLinks, termCore, normalizeText } from '../server/linkMatch.js';

const BASE = '/Users/mayu/Projects/workbench-text';
const tree = fs.readFileSync(BASE + '/tree.txt', 'utf8');

// 1) 从 tree.txt 提取全部 .md 文件路径
const paths = [];
for (const line of tree.split('\n')) {
  const m = /([^\s│├└─][^│]*\.md)\s*$/.exec(line);
  if (m) paths.push(m[1].trim());
}
console.log(`文件总数: ${paths.length}`);

// 2) 建词条（模拟 links.js：stem 作 title）
const stem = (p) => {
  const n = p.split('/').pop();
  return n.slice(0, n.length - 3);
};
const entries = paths.map((p) => ({ term: stem(p), path: p, kind: 'title' }));
const idx = buildAutoIndex(entries, []);

// 3) 对 04_内容索引.md 的「文件名」列逐个验证：该单元格文本是否产出指向该文档的链接
const index4 = fs.readFileSync(BASE + '/04_内容索引.md', 'utf8');
const rows = index4.split('\n').filter((l) => l.startsWith('|') && /\.md\s*\|/.test(l));
console.log(`索引行数: ${rows.length}`);

let hit = 0, miss = 0, cand = 0;
const misses = [];
for (const row of rows) {
  const cells = row.split('|').map((c) => c.trim());
  const fileName = cells[2]; // | # | 文件名 | 主题 | ...
  if (!fileName || !fileName.endsWith('.md')) continue;
  // 该单元格文本作为「提及」，扫描全表词条
  const links = extractLinks(fileName, idx, { selfPath: null });
  // 期望：链接覆盖整个文件名主体，target 是某个真实文档
  const direct = links.find((l) => l.target && l.term.replace(/\.md$/, '').length >= stem(fileName).length * 0.6);
  const candidate = links.find((l) => l.candidates);
  if (direct) hit++;
  else if (candidate) { cand++; misses.push({ fileName, kind: '候选', got: candidate.candidates?.slice(0, 2) }); }
  else { miss++; misses.push({ fileName, kind: '未链', got: links.map((l) => l.term).slice(0, 3) }); }
}

console.log(`\n=== 04 内容索引「文件名」列 ===`);
console.log(`命中(直接链): ${hit}`);
console.log(`候选(歧义): ${cand}`);
console.log(`未链: ${miss}`);
if (misses.length) {
  console.log(`\n未链/候选样本（前 30）:`);
  for (const m of misses.slice(0, 30)) console.log(`  ${m.kind === '未链' ? '✗' : '△'} ${m.fileName}  → ${JSON.stringify(m.got ?? [])}`);
}
