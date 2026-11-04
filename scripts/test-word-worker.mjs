// Word 解析不阻塞后端主线程（规格 specs/2026-11-04-word-worker-pool.md 的验收 A1–A8）。
// 语料由脚本现造：4 个「重文档」各 15 万段（本机 mammoth 单个转换约 1.9 秒、主线程连续阻塞约 1 秒）、
// 1 个「超时文档」60 万段（单个转换约 7 秒，超过 WORKBENCH_WORD_TIMEOUT_MS=4000）、17MB 的大文本、50 个小 md。
// 断言：建索引期间 /api/status 单次 ≤ 300ms；Word 正文可检索；超时写入失败缓存且重启不重试、打开时重试；
// 大文本只按文件名收录；连续重扫不重复解析；并发数设置项可读写并校验。
// 用法：node scripts/test-word-worker.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATUS_LIMIT_MS = 300;
const INDEX_LIMIT_MS = 120000;
const RESTART_INDEX_LIMIT_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name + '：' + e.message);
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(String(msg).slice(0, 300));
}
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// ---------- 语料 ----------
const tmp = makeTmpDir('wb-word-worker-');
const corpus = path.join(tmp, 'corpus');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(corpus, { recursive: true });

function makeDocx(paragraphs, marker) {
  const parts = [];
  for (let i = 0; i < paragraphs; i++) {
    parts.push(`<w:p><w:r><w:t>第${i}段：学而时习之不亦说乎有朋自远方来不亦乐乎人不知而不愠不亦君子乎</w:t></w:r></w:p>`);
  }
  parts.push(`<w:p><w:r><w:t>${marker}</w:t></w:r></w:p>`);
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.addFile('word/document.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + parts.join('') + '</w:body></w:document>'));
  return zip.toBuffer();
}

const HEAVY = [1, 2, 3, 4].map((n) => ({ name: `重文档${n}.docx`, marker: `标记甲${n}号` }));
for (const d of HEAVY) fs.writeFileSync(path.join(corpus, d.name), makeDocx(150000, d.marker));
const SLOW_DOC = '超时文档.docx';
fs.writeFileSync(path.join(corpus, SLOW_DOC), makeDocx(600000, '标记丙'));
const BIG_TEXT = '大文本.txt';
{
  const line = '子曰学而时习之不亦说乎有朋自远方来不亦乐乎\n';
  const lines = Math.ceil((17 * 1024 * 1024) / Buffer.byteLength(line));
  fs.writeFileSync(path.join(corpus, BIG_TEXT), line.repeat(lines) + '标记乙\n');
}
for (let i = 0; i < 50; i++) {
  fs.writeFileSync(path.join(corpus, `篇目${String(i).padStart(2, '0')}.md`), `# 篇目${i}\n\n温故而知新，可以为师矣。\n`);
}

// ---------- 后端 ----------
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const logFile = path.join(dataDir, 'logs', 'backend.log');
let proc = null;
let stderr = [];
let exited = null;

async function startServer() {
  stderr = [];
  exited = null;
  proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      WORKBENCH_PORT: String(port),
      WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_DATA_DIR: dataDir,
      WORKBENCH_RAG_EMBED: 'mock',
      WORKBENCH_WORD_TIMEOUT_MS: '4000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', (d) => stderr.push(d));
  proc.on('exit', (code, sig) => { exited = sig || code; });
  for (let i = 0; ; i++) {
    if (exited !== null) throw new Error('后端提前退出：' + exited + '\n' + Buffer.concat(stderr).toString());
    try {
      if ((await fetch(base + '/api/config')).ok) return;
    } catch { /* 启动中 */ }
    if (i > 600) throw new Error('后端 60 秒内未就绪');
    await sleep(100);
  }
}
async function stopServer() {
  if (!proc || exited !== null) return;
  proc.kill('SIGTERM');
  for (let i = 0; i < 100 && exited === null; i++) await sleep(50);
  if (exited === null) proc.kill('SIGKILL');
}
atExit(() => proc?.kill('SIGKILL'));

const getJson = async (url) => (await fetch(base + url)).json();
const send = (method, url, body) => fetch(base + url, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
const logText = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
const countLines = (text, needle) => text.split('\n').filter((l) => l.includes(needle)).length;

// 每 100ms 一次 /api/status，直到索引结束（扫描完成、文本与内链索引结束）；返回采样与完成时刻
async function pollUntilIndexed(limitMs, during = async () => {}) {
  const samples = [];
  let polling = true;
  const t0 = Date.now();
  const poller = (async () => {
    while (polling) {
      const s0 = performance.now();
      let s = null;
      let okRes = false;
      try {
        const r = await fetch(base + '/api/status');
        s = await r.json();
        okRes = r.ok;
      } catch { /* 记为失败样本 */ }
      const ms = performance.now() - s0;
      samples.push({ at: Date.now() - t0, ms, ok: okRes, s });
      if (ms < 100) await sleep(100 - ms);
    }
  })();
  await during();
  let doneAt = null;
  while (Date.now() - t0 < limitMs + 5000) {
    const last = samples[samples.length - 1]?.s;
    if (samples.length > 5 && last && last.dsId && !last.scanning && last.indexing?.phase == null && last.linksReady) {
      doneAt = samples[samples.length - 1].at;
      break;
    }
    await sleep(50);
  }
  polling = false;
  await poller;
  return { samples, doneAt };
}

const cacheFileOf = (dsId, rel) =>
  path.join(dataDir, 'knowledge', dsId, 'cache', 'word-' + crypto.createHash('sha1').update(rel).digest('hex') + '.json');
const readCache = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const contentHits = (r) => (r.results || []).filter((x) => x.matches.some((m) => m.field !== 'name' && m.field !== 'path')).map((x) => x.file.path);

try {
  await startServer();

  // ---------- 首次建索引：A1 主线程不阻塞；期间连续重扫供 A7 ----------
  let addStatus = 0;
  const first = await pollUntilIndexed(INDEX_LIMIT_MS, async () => {
    addStatus = (await send('POST', '/api/config', { baseDir: corpus })).status;
    for (let i = 0; i < 3; i++) {
      void send('POST', '/api/rescan', {}).catch(() => {});
      await sleep(300);
    }
  });
  const lat = first.samples.map((x) => x.ms).sort((a, b) => a - b);
  const maxMs = lat[lat.length - 1] || 0;
  const over = first.samples.filter((x) => x.ms > STATUS_LIMIT_MS);
  console.log(`  （索引完成于 ${first.doneAt ?? '未完成'}ms；/api/status 采样 ${first.samples.length} 次，最大 ${maxMs.toFixed(0)}ms，超过 ${STATUS_LIMIT_MS}ms ${over.length} 次）`);
  if (over.length) console.log('  （超限样本：' + over.slice(0, 8).map((x) => `${x.at}ms 处 ${x.ms.toFixed(0)}ms`).join('，') + '）');

  check('添加资料库成功', () => ok(addStatus === 200, `POST /api/config 返回 ${addStatus}`));
  check(`A1 建索引期间 /api/status 单次 ≤ ${STATUS_LIMIT_MS}ms`, () => {
    ok(first.samples.every((x) => x.ok), `有 ${first.samples.filter((x) => !x.ok).length} 次请求失败`);
    ok(over.length === 0, `最大 ${maxMs.toFixed(0)}ms，超限 ${over.length} 次`);
  });
  check(`建索引 ${INDEX_LIMIT_MS / 1000} 秒内完成`, () => ok(first.doneAt !== null, '未完成'));

  const dsId = first.samples[first.samples.length - 1].s.dsId;

  // ---------- A2 Word 正文可检索；超时文档不进正文 ----------
  for (const d of HEAVY) {
    const hits = contentHits(await getJson('/api/search?q=' + encodeURIComponent(d.marker)));
    check(`A2 检索「${d.marker}」正文命中 ${d.name}`, () => ok(hits.includes(d.name), '实际：' + JSON.stringify(hits)));
  }
  {
    const r = await getJson('/api/search?q=' + encodeURIComponent('标记丙'));
    check('A2 超时文档的正文不在索引里', () => ok((r.results || []).length === 0, '实际：' + JSON.stringify(r.results)));
  }

  // ---------- A3 超时写入失败缓存 ----------
  const slowCache = cacheFileOf(dsId, SLOW_DOC);
  const c1 = readCache(slowCache);
  check('A3 超时文档写入失败缓存（WORD_TIMEOUT）', () => ok(c1?.failed?.code === 'WORD_TIMEOUT', JSON.stringify(c1)));
  check('A3 日志记录超时', () => ok(logText().split('\n').some((l) => l.includes(SLOW_DOC) && l.includes('解析超时')), '未找到'));

  // ---------- A6 大文本只按文件名收录 ----------
  {
    const r1 = await getJson('/api/search?q=' + encodeURIComponent('标记乙'));
    check('A6 大文本正文不在索引里', () => ok((r1.results || []).length === 0, '实际：' + JSON.stringify(r1.results?.map((x) => x.file.path))));
    const r2 = await getJson('/api/search?q=' + encodeURIComponent('大文本'));
    const hit = (r2.results || []).find((x) => x.file.path === BIG_TEXT);
    check('A6 大文本可按文件名找到', () => ok(hit && hit.matches.some((m) => m.field === 'name'), JSON.stringify(r2.results)));
    check('A6 日志有跳过正文汇总', () => ok(/\[index\] 跳过正文：1 个文件/.test(logText()), '未找到'));
  }

  // ---------- A7 连续重扫不重复解析 ----------
  {
    const text = logText();
    for (const name of [...HEAVY.map((d) => d.name), SLOW_DOC]) {
      const n = countLines(text, '[word] 开始解析 ' + name);
      check(`A7 ${name} 只解析一次`, () => ok(n === 1, `开始解析 ${n} 次`));
    }
  }

  // ---------- A8 并发数设置 ----------
  {
    const r = await send('PUT', '/api/ui-settings', { wordConcurrency: 4 });
    const g = await getJson('/api/ui-settings');
    check('A8 保存并发数 4', () => ok(r.status === 200 && g.wordConcurrency === 4, `status=${r.status} 读回=${g.wordConcurrency}`));
    check('A8 并发数立即生效（日志）', () => ok(logText().includes('[word] 解析并发数：4'), '未找到'));
    for (const bad of [0, 9, 2.5, '3']) {
      const rb = await send('PUT', '/api/ui-settings', { wordConcurrency: bad });
      check(`A8 非法值 ${JSON.stringify(bad)} 返回 400`, () => ok(rb.status === 400, `status=${rb.status}`));
    }
  }

  // ---------- A4 重启不重试 ----------
  const statBefore = fs.statSync(slowCache).mtimeMs;
  await stopServer();
  fs.rmSync(path.join(dataDir, 'ui-settings.json'), { force: true });
  await startServer();
  {
    const g = await getJson('/api/ui-settings');
    check('A8 无设置文件时并发数为 2', () => ok(g.wordConcurrency === 2, `读回=${g.wordConcurrency}`));
  }
  const second = await pollUntilIndexed(RESTART_INDEX_LIMIT_MS);
  check(`A4 重启后 ${RESTART_INDEX_LIMIT_MS / 1000} 秒内建完索引`, () => ok(second.doneAt !== null && second.doneAt <= RESTART_INDEX_LIMIT_MS, `完成于 ${second.doneAt ?? '未完成'}`));
  const c2 = readCache(slowCache);
  check('A4 重启后失败缓存未被改写', () => {
    ok(fs.statSync(slowCache).mtimeMs === statBefore, '缓存文件被改写');
    ok(c2?.failed?.at === c1?.failed?.at, `at ${c1?.failed?.at} → ${c2?.failed?.at}`);
  });
  check('A4 重启后没有重新解析', () => ok(countLines(logText(), '[word] 开始解析 ' + SLOW_DOC) === 1, '超时文档被再次解析'));

  // ---------- A5 打开时重试 ----------
  {
    const r = await fetch(base + '/api/file?path=' + encodeURIComponent(SLOW_DOC));
    const j = await r.json();
    check('A5 打开超时文档返回非 2xx 且原因以「解析超时」开头', () => ok(!r.ok && String(j.error).startsWith('解析超时'), `status=${r.status} error=${j.error}`));
    const c3 = readCache(slowCache);
    check('A5 打开时重试并更新失败缓存时间', () => ok(c3?.failed?.at && c3.failed.at !== c1?.failed?.at, `at ${c1?.failed?.at} → ${c3?.failed?.at}`));
  }
} finally {
  await stopServer();
}

console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
