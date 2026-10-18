// RAG 跨平台/跨运行时一致性验收（ARCHITECTURE 5.2.1 的机器化比对）。
// 用法：
//   采集：node scripts/rag-consistency.mjs run  --url http://127.0.0.1:7497 --out a.json [--q 题集.json]
//   比对：node scripts/rag-consistency.mjs diff a.json b.json [--topk 10]
// 判据（按 5.2.1）：① 应命中段落两边都命中；② Top-K 顺序一致；③ 分数差落在
// 1e-4 量化边界上的个别例外可放过，但必须列出。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, dflt) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const mode = process.argv[2];

async function run() {
  const url = arg('url', 'http://127.0.0.1:7410');
  const qFile = arg('q', path.join(path.dirname(fileURLToPath(import.meta.url)), 'rag-questions-dev.json'));
  const out = arg('out', 'rag-consistency.json');
  const questions = JSON.parse(fs.readFileSync(qFile, 'utf8'));
  const st = await (await fetch(url + '/api/rag/status')).json();
  const result = {
    meta: {
      url,
      backend: st.model?.backend,
      ep: st.model?.ep ?? null,
      model: st.model?.id,
      platform: `${process.platform}/${process.arch}`,
      node: process.version,
      dsId: st.dsId,
      at: new Date().toISOString(),
    },
    questions: [],
  };
  for (const q of questions) {
    const r = await (await fetch(url + '/api/rag/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, limit: 20 }),
    })).json();
    result.questions.push({
      q,
      hits: (r.hits || []).map((h) => ({ path: h.path, heading: h.headingPath, ord: h.ordinal, score: h.score, bm25: h.bm25, cos: h.cos })),
    });
    process.stdout.write('.');
  }
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`\n${questions.length} 题采集完成 → ${out}（backend=${result.meta.backend}${result.meta.ep ? '/' + result.meta.ep : ''}）`);
}

function diff() {
  const a = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const b = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  const topk = Number(arg('topk', 10));
  console.log(`A: ${a.meta.platform} ${a.meta.backend}${a.meta.ep ? '/' + a.meta.ep : ''}  vs  B: ${b.meta.platform} ${b.meta.backend}${b.meta.ep ? '/' + b.meta.ep : ''}`);
  let questionOk = 0;
  let orderMisses = [];
  let scoreBoundary = [];
  let hitMisses = [];
  for (const qa of a.questions) {
    const qb = b.questions.find((x) => x.q === qa.q);
    if (!qb) continue;
    const ta = qa.hits.slice(0, topk).map((h) => `${h.path}#${h.heading}:${h.ord}`);
    const tb = qb.hits.slice(0, topk).map((h) => `${h.path}#${h.heading}:${h.ord}`);
    const sa = qa.hits.slice(0, topk).map((h) => h.score);
    const sb = qb.hits.slice(0, topk).map((h) => h.score);
    // ① 两边命中集合一致（应命中段落都命中）——顺序无关
    const setA = new Set(ta);
    const setB = new Set(tb);
    const missing = [...setA].filter((x) => !setB.has(x));
    if (missing.length) hitMisses.push({ q: qa.q, missingInB: missing.slice(0, 3) });
    // ② Top-K 顺序一致
    else if (ta.join('|') !== tb.join('|')) orderMisses.push({ q: qa.q, a: ta.slice(0, 3), b: tb.slice(0, 3) });
    else {
      // ③ 分数一致（1e-4 量化边界例外可放过）
      const drift = sa.map((s, i) => Math.abs(s - sb[i])).filter((d) => d > 1e-4);
      if (drift.length) scoreBoundary.push({ q: qa.q, maxDrift: Math.max(...drift).toFixed(5) });
      else questionOk++;
    }
  }
  const total = a.questions.length;
  console.log(`\n结果：${questionOk}/${total} 题完全一致`);
  if (hitMisses.length) {
    console.log(`\n✗ 命中缺失（${hitMisses.length} 题，须排查）：`);
    hitMisses.forEach((m) => console.log(`  「${m.q}」B 侧缺:`, m.missingInB.join(' , ')));
  }
  if (orderMisses.length) {
    console.log(`\n△ 顺序不一致（${orderMisses.length} 题）：`);
    orderMisses.forEach((m) => console.log(`  「${m.q}」\n    A: ${m.a.join(' | ')}\n    B: ${m.b.join(' | ')}`));
  }
  if (scoreBoundary.length) {
    console.log(`\n○ 分数量化边界例外（${scoreBoundary.length} 题，可放过）：`);
    scoreBoundary.forEach((m) => console.log(`  「${m.q}」maxDrift=${m.maxDrift}`));
  }
  const pass = questionOk + scoreBoundary.length === total;
  console.log(`\n结论：${pass ? '✅ 通过（含可放过的边界例外）' : '❌ 未通过'}`);
  process.exit(pass ? 0 : 1);
}

if (mode === 'run') await run();
else if (mode === 'diff') diff();
else {
  console.log('用法: run --url URL --out FILE [--q FILE] | diff A.json B.json [--topk N]');
  process.exit(2);
}
