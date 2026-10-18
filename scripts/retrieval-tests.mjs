// 检索测试套件：精确 + 智能（RAG）双模式，真值（ground truth）由脚本直扫语料建立。
// 用法：node scripts/retrieval-tests.mjs --url http://127.0.0.1:7410 [--verbose]
// 语义题集见 retrieval-cases.json（可自行追加：q + expectBooks 书名关键词）。
// 退出码 0 = 全部通过；1 = 有失败。针对当前激活资料库运行（只读，不改任何数据）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL_BASE = arg('url', 'http://127.0.0.1:7410');
const VERBOSE = process.argv.includes('--verbose');
const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0, skip = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; if (VERBOSE) console.log('  ✓', name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗', name, detail); }
};
const section = (t) => console.log('\n== ' + t + ' ==');

// ---------- API 助手 ----------
const api = {
  async get(u) {
    const r = await fetch(URL_BASE + u);
    if (!r.ok) throw new Error('GET ' + u + ' → ' + r.status);
    return r.json();
  },
  async post(u, body) {
    const r = await fetch(URL_BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('POST ' + u + ' → ' + r.status));
    return j;
  },
};
const exact = (q, params = {}) => api.get('/api/search?' + new URLSearchParams({ q, ...params }));
const smart = (q, limit = 50) => api.post('/api/rag/search', { q, limit });

// ---------- 真值扫描（txt/md/json 直读；Word 走 /api/file 提取管道取文本） ----------
async function scanCorpus() {
  const cfg = await api.get('/api/config');
  if (!cfg.configured) throw new Error('资料库未配置');
  const lib = (cfg.libraries || []).find((l) => l.id === cfg.activeId) || { baseDir: cfg.baseDir };
  const dir = lib.baseDir;
  const files = []; // { rel, text }
  const wordQueue = []; // Word 文件走服务端提取（与检索索引同一提取管道，真值天然一致）
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === '.trash') continue;
      const abs = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (/\.(txt|md|json)$/i.test(e.name)) {
        try {
          files.push({ rel: r, text: fs.readFileSync(abs, 'utf8') });
        } catch { /* 读不了的文件不入真值 */ }
      } else if (/\.(docx?|)$/i.test(e.name)) {
        wordQueue.push(r);
      }
    }
  };
  walk(dir, '');
  let wordOk = 0;
  for (const rel of wordQueue) {
    try {
      const f = await api.get('/api/file?path=' + encodeURIComponent(rel));
      if (f && typeof f.text === 'string' && f.text) {
        files.push({ rel, text: f.text });
        wordOk++;
      }
    } catch { /* 提取失败不入真值（与索引侧行为一致：提不出的文本两侧都没有） */ }
  }
  if (wordQueue.length) console.log(`真值含 Word 提取：${wordOk}/${wordQueue.length} 个 doc/docx`);
  return { dir, files };
}
// 真值口径：content = 仅正文（智能检索的索引面，fileNameContext 后含文件名）；
// any = 正文∪文件名∪路径（精确检索的 name/path/content 三字段联合）
const filesContentWith = (corpus, term) => new Set(corpus.files.filter((f) => f.text.includes(term)).map((f) => f.rel));
const filesAnyWith = (corpus, term) =>
  new Set(corpus.files.filter((f) => f.text.includes(term) || f.rel.includes(term)).map((f) => f.rel));
const filesWith = filesContentWith;

// ---------- 性能测量 ----------
async function p95(fn, n) {
  const ts = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length * 0.95)];
}

// ---------- 主流程 ----------
const corpus = await scanCorpus();
console.log(`目标: ${URL_BASE} · 语料 ${corpus.files.length} 个可扫描文件（${corpus.dir}）`);
if (corpus.files.length < 3) { console.error('可扫描文件过少，套件失去意义'); process.exit(2); }

// 词选取：真值驱动（按文件覆盖数分档）。领域候选优先；不够则从语料 bigram 自举——
// 任何中文语料都能自动选出可用测试词，不依赖人工词表
const CANDIDATES = ['可转债', '止损', '对冲基金', '市盈率', '安全边际', '凯利公式', '复利', '债券', '现金流', '风险', '投资'];
const CJK = (ch) => /[\u4e00-\u9fff]/.test(ch);
function autoTerms(corpus, need) {
  // 每文件抽前 8000 字统计二字词频（跳过标点/数字边界），取高频候选后按文件覆盖数排序
  const cnt = new Map();
  for (const f of corpus.files) {
    const seen = new Set();
    const t = f.text.slice(0, 8000);
    for (let i = 0; i + 2 <= t.length; i++) {
      if (!CJK(t[i]) || !CJK(t[i + 1])) continue;
      const g = t.slice(i, i + 2);
      if (!seen.has(g)) {
        seen.add(g);
        cnt.set(g, (cnt.get(g) || 0) + 1);
      }
    }
  }
  return [...cnt.entries()]
    .filter(([g, n]) => n >= 2 && !/^[一二三四五六七八九十零]$/.test(g))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 300)
    .map(([g]) => ({ t: g, n: filesAnyWith(corpus, g).size }))
    .sort((a, b) => a.n - b.n);
}
let freq = CANDIDATES.map((t) => ({ t, n: filesAnyWith(corpus, t).size })).filter((x) => x.n > 0).sort((a, b) => a.n - b.n);
if (freq.length < 3) {
  const auto = autoTerms(corpus);
  if (auto.length < 2) { console.error('语料规模过小，无法自举测试词'); process.exit(2); }
  freq = auto;
  console.log('测试词自动自举（bigram 文件覆盖分档）');
}
const rare = freq.find((x) => x.n >= 1 && x.n <= 5) || freq[0];
const mid = freq[Math.floor(freq.length / 2)];
const common = freq[freq.length - 1];
console.log(`测试词（真值分档）：低频「${rare.t}」${rare.n} 文件 · 中频「${mid.t}」${mid.n} · 高频「${common.t}」${common.n}`);

// ============ A. 精确检索 ============
section('A. 精确检索（真值 = 直扫语料）');
for (const { t, n } of [rare, mid, common]) {
  const r = await exact(t);
  check(`A1 单词「${t}」全量枚举（名/径/文）`, r.total === n, `API ${r.total} vs 真值 ${n}`);
}
{
  // A2 多词 AND = 交集
  const [a, b] = [mid.t, rare.t === mid.t ? common.t : rare.t];
  const truth = new Set([...filesAnyWith(corpus, a)].filter((f) => [...filesAnyWith(corpus, b)].includes(f)));
  const r = await exact(a + ' ' + b);
  check(`A2 多词 AND「${a} ${b}」`, r.total === truth.size, `API ${r.total} vs 真值 ${truth.size}`);
}
{
  // A3 引号短语：短语候选自举（领域词优先，退化用测试词），正文口径
  const PH_CANDS = ['安全边际', '风险控制', '止损', '基本面', '投资策略', '市场监管', rare.t, mid.t];
  const PH = PH_CANDS.find((t) => filesContentWith(corpus, t).size > 0);
  if (PH) {
    const r = await exact('"' + PH + '"');
    const truth = filesContentWith(corpus, PH);
    check(`A3 短语「${PH}」命中文件正文真含`, r.results.every((x) => truth.has(x.file.path)) && r.total > 0, `API ${r.total}`);
  } else { skip++; console.log('  - A3 跳过（无可用短语样例）'); }
}
{
  // A4 文件名命中：取某文件名独有词（数字前缀），验证该文件在结果中
  const f = corpus.files.find((x) => /^\d+-/.test(x.rel));
  const nameWord = (f?.rel || '').replace(/^\d+-/, '').split('.')[0].slice(0, 4);
  if (f && nameWord.length >= 2 && !f.text.includes(nameWord)) {
    const r = await exact(nameWord);
    check(`A4 文件名命中「${nameWord}」`, r.results.some((x) => x.file.path === f.rel), `期望含 ${f.rel}`);
  } else {
    skip++; console.log('  - A4 跳过（无纯文件名命中样例）');
  }
}
{
  // A5 类型筛选
  const r = await exact(mid.t, { types: '.txt' });
  const truth = new Set([...filesAnyWith(corpus, mid.t)].filter((f) => f.endsWith('.txt')));
  check(`A5 类型筛选 type=.txt「${mid.t}」`, r.total === truth.size, `API ${r.total} vs 真值 ${truth.size}`);
}
{
  // A6 边界：空/空格/特殊符号/超长
  const cases = [['', '空查询'], ['   ', '纯空格'], ['*"|"(', '特殊符号'], ['测试'.repeat(250), '超长 1000 字']];
  for (const [q, label] of cases) {
    let ok = true;
    try { await exact(q); } catch { ok = false; }
    check(`A6 边界不炸：${label}`, ok);
  }
}
{
  // A7 结果抽查：随机 5 条命中文件正文真含词
  const r = await exact(mid.t);
  const truth = filesWith(corpus, mid.t);
  const sample = r.results.slice(0, 5);
  const anyTruth = filesAnyWith(corpus, mid.t);
  check('A7 结果抽查（前 5 条均在真值集）', sample.every((x) => anyTruth.has(x.file.path)), `抽查 ${sample.length} 条`);
}

// ============ B. 智能检索：字面完备性 ============
section('B. 智能检索·字面完备（补位 + 覆盖）');
for (const { t, n } of [rare, mid, common]) {
  const r = await smart(t, 500);
  const truth = new Set([...filesContentWith(corpus, t), ...corpus.files.filter((f) => path.basename(f.rel).includes(t)).map((f) => f.rel)]);
  const covered = new Set(r.hits.map((h) => h.path));
  const ratio = truth.size ? [...truth].filter((f) => covered.has(f)).length / truth.size : 1;
  check(`B1 补位覆盖「${t}」≥90%`, ratio >= 0.9, `覆盖 ${Math.round(ratio * 100)}%（${r.total} 段 / 真值 ${n} 文件）`);
}
{
  // B2 融合段全部在补位段之前
  const r = await smart(mid.t, 200);
  let seenFiller = false, ordered = true;
  for (const h of r.hits) {
    if (h.score === 0) seenFiller = true;
    else if (seenFiller) { ordered = false; break; }
  }
  check('B2 融合段排序在补位段之前', ordered);
  check('B3 计数一致（total ≥ hits，hits ≤ limit）', (r.total ?? 0) >= r.hits.length && r.hits.length <= 200);
}
{
  // B4 排序稳定：同查询 3 次结果一致（1e-4 量化稳定排序）
  const sig = (r) => r.hits.map((h) => h.path + ':' + h.ordinal + ':' + h.score).join('|');
  const a = await smart(mid.t, 100);
  const b = await smart(mid.t, 100);
  const c = await smart(mid.t, 100);
  check('B4 同查询 3 次结果逐段一致', sig(a) === sig(b) && sig(b) === sig(c));
}
{
  // B6 繁简互通（智能模式 t2s 归一后查询）
  const pairs = [['债券', '債券'], ['风险', '風險'], ['投资', '投資'], ['复利', '復利'], ['市场', '市場']];
  let ok = 0, total = 0;
  for (const [s, t] of pairs) {
    const rs = await smart(s, 1), rt = await smart(t, 1);
    if ((rs.total ?? 0) > 0) {
      total++;
      if (Math.abs((rs.total ?? 0) - (rt.total ?? 0)) <= Math.max(5, rs.total * 0.1)) ok++;
    }
  }
  if (total === 0) { skip++; console.log('  - B6 跳过（语料无繁简对候选词）'); }
  else check('B6 繁简互通（繁体查询命中数≈简体）', ok === total, `${ok}/${total} 对一致`);
}

// ============ C. 语义有效性（curated 题集） ============
section('C. 语义有效性（题集见 retrieval-cases.json，判据 top5 命中预期书）');
{
  let cases = [];
  try { cases = JSON.parse(fs.readFileSync(path.join(HERE, 'retrieval-cases.json'), 'utf8')); } catch { /* 无题集则跳过 */ }
  let ran = 0, passed = 0;
  for (const c of cases) {
    // 预期书不在当前库 → 跳过（题集跨库复用）
    const inLib = c.expectBooks.some((b) => corpus.files.some((f) => f.rel.includes(b)));
    if (!inLib) { skip++; if (VERBOSE) console.log('  - 跳过（预期书不在库）:', c.q); continue; }
    const r = await smart(c.q, 5);
    const top5 = r.hits.slice(0, 5).map((h) => h.name);
    const hit = top5.some((n) => c.expectBooks.some((b) => n.includes(b)));
    ran++; if (hit) passed++;
    if (VERBOSE || !hit) console.log(`  ${hit ? '✓' : '✗'} 「${c.q}」→ ${top5.slice(0, 3).join(' / ')}`);
  }
  const TH = arg('semantic-threshold', '0.75');
  check(`C 语义通过率 ≥ ${(Number(TH) * 100).toFixed(0)}%（${passed}/${ran}）`, ran === 0 || passed / ran >= Number(TH));
}

// ============ D. 跨模式一致性 ============
section('D. 跨模式一致性不变量');
for (const { t } of [rare, mid, common]) {
  const e = await exact(t);
  const s = await smart(t, 500);
  // 不变量限定在智能检索的索引面（正文∪文件名）：路径-only 命中是精确检索特有能力，不计入
  const efiles = new Set(e.results.map((x) => x.file.path).filter((f) => corpus.files.some((c) => c.rel === f && (c.text.includes(t) || path.basename(f).includes(t)))));
  const sfiles = new Set(s.hits.map((h) => h.path));
  const cov = [...efiles].filter((f) => sfiles.has(f)).length;
  check(`D1 「${t}」智能(limit500) 覆盖精确文件 ≥90%`, efiles.size === 0 || cov / efiles.size >= 0.9, `${cov}/${efiles.size}`);
  check(`D2 「${t}」精确有结果 ⇒ 智能非空`, e.total === 0 || (s.total ?? 0) > 0);
}

// ============ E. 性能预算 ============
section('E. 性能预算');
await smart(mid.t, 5); // 预热（模型常驻）
{
  const e = await p95(() => exact(mid.t), 10);
  check(`E1 精确检索 p95 < 300ms`, e < 300, `${e.toFixed(0)}ms`);
  const s = await p95(() => smart(mid.t, 50), 10);
  check(`E2 智能检索 p95 < 1500ms`, s < 1500, `${s.toFixed(0)}ms`);
}

// ============ F. 智能边界 ============
section('F. 智能检索边界');
{
  const cases = [['', '空查询'], ['*"|"(', '特殊符号'], ['测试'.repeat(250), '超长 1000 字'], ['PE 市盈率', '中英混合']];
  for (const [q, label] of cases) {
    let ok = true;
    try { await smart(q, 10); } catch { ok = false; }
    check(`F1 边界不炸：${label}`, ok);
  }
}

// ---------- 汇总 ----------
console.log(`\n结果：${pass} 通过 · ${fail} 失败 · ${skip} 跳过`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach((f) => console.log('  -', f));
  process.exit(1);
}
console.log('✅ 检索套件全部通过');
