#!/usr/bin/env node
// 清理可疑的 .meta.json（title 与文件名严重不符 = 内链错指的头号来源）
// 默认只列出；加 --apply 才真正删除。
// 用法:
//   node scripts/clean-meta.mjs "<库目录>"            列出可疑
//   node scripts/clean-meta.mjs "<库目录>" --apply    删除可疑
//   node scripts/clean-meta.mjs "<库目录>" --all --apply --yes-i-know   删除全部 sidecar
import fs from 'node:fs';
import path from 'node:path';

const base = process.argv[2];
const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const CONFIRM = process.argv.includes('--yes-i-know');
if (!base || !fs.existsSync(base)) {
  console.error('用法: node scripts/clean-meta.mjs <库目录> [--apply] [--all] [--yes-i-know]');
  process.exit(1);
}

const sidecars = [];
(function walk(dir, rel = '') {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isDirectory()) walk(abs, r);
    else if (ent.name.endsWith('.meta.json')) sidecars.push({ abs, rel: r, docRel: r.slice(0, -'.meta.json'.length) });
  }
})(base);

console.log(`库: ${base}`);
console.log(`sidecar 总数: ${sidecars.length}`);

// ── 判定「可疑」：title 与文件名主体严重不符 ──
const longestCommon = (a, b) => {
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
};

const suspicious = [];
const ok = [];
for (const s of sidecars) {
  const name = s.docRel.split('/').pop();
  const stem = name.slice(0, name.length - path.extname(name).length);
  let title = '';
  try {
    const m = JSON.parse(fs.readFileSync(s.abs, 'utf8'));
    title = typeof m?.title === 'string' ? m.title.trim() : '';
  } catch { suspicious.push({ ...s, stem, title: '(无法解析)', why: 'JSON 损坏' }); continue; }
  if (!title) { suspicious.push({ ...s, stem, title, why: 'title 为空' }); continue; }
  const reasons = [];
  if (title.length < 2) reasons.push('title 过短');
  if (/^\d{4}[-/.年]?/.test(title) && !/\p{Script=Han}/u.test(title)) reasons.push('title 是日期/数字');
  const lc = longestCommon(title, stem);
  if (lc < Math.min(3, Math.min(title.length, stem.length))) reasons.push(`与文件名几乎无交集（最长公共片段 ${lc} 字）`);
  if (title.length > stem.length * 2 + 4) reasons.push('title 远长于文件名');
  if (reasons.length) suspicious.push({ ...s, stem, title, why: reasons.join('；') });
  else ok.push(s);
}

console.log(`\n正常: ${ok.length} | 可疑: ${suspicious.length}`);
if (suspicious.length) {
  console.log('\n=== 可疑清单（文件名 → title）===');
  for (const s of suspicious.slice(0, 40)) {
    console.log(`  ${s.docRel}`);
    console.log(`    文件名「${s.stem}」  title「${s.title}」`);
    console.log(`    原因: ${s.why}`);
  }
  if (suspicious.length > 40) console.log(`  ...还有 ${suspicious.length - 40} 条`);
}

// ── 执行 ──
if (!APPLY) {
  console.log('\n（只列出，未删除。确认无误后加 --apply 执行删除；删除前建议先备份这批文件）');
  process.exit(0);
}
if (ALL) {
  if (!CONFIRM) {
    console.error('\n--all 会删除库内全部 sidecar，需同时加 --yes-i-know 确认');
    process.exit(1);
  }
  let n = 0;
  for (const s of sidecars) { fs.unlinkSync(s.abs); n++; }
  console.log(`\n已删除全部 sidecar: ${n} 个`);
  process.exit(0);
}
let n = 0;
for (const s of suspicious) { fs.unlinkSync(s.abs); n++; }
console.log(`\n已删除可疑 sidecar: ${n} 个`);
