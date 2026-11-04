// RAG 构建与检索不阻塞后端主线程（mock 嵌入，每批 1ms 模拟真实运行时的异步推理）。
// 语料：8 篇约 1.3M 字的中文长文（段落以空行分隔，每篇两千多块），外加 40 篇短文。
// R1 构建期间 /api/status 单次 ≤ 100ms，构建完成
// R2 检索（limit 100，命中大量分块）进行中 /api/status 单次 ≤ 100ms，结果非空且带定位信息
// 对照：--rev <git 版本> 改跑该版本的 server/（git show 落到临时目录），同一套断言。
// 用法：node scripts/test-rag-nonblocking.mjs [--rev <git 版本>]
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ELECTRON = createRequire(import.meta.url)('electron'); // better-sqlite3 按 Electron ABI 编译，后端用 Electron 当 Node 跑
const STATUS_LIMIT_MS = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const revAt = process.argv.indexOf('--rev');
const REV = revAt > 0 ? process.argv[revAt + 1] : null;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name + '：' + String(e.message).slice(0, 300));
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

const tmp = makeTmpDir('wb-rag-nb-');
let serverDir = path.join(ROOT, 'server');
if (REV) {
  const appDir = path.join(tmp, 'app');
  const list = execFileSync('git', ['-C', ROOT, 'ls-tree', '-r', '-z', '--name-only', REV, 'server', 'schema'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  for (const f of list) {
    fs.mkdirSync(path.join(appDir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(appDir, f), execFileSync('git', ['-C', ROOT, 'show', `${REV}:${f}`]));
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(appDir, 'node_modules'), 'dir');
  serverDir = path.join(appDir, 'server');
}
console.log(`== 被测后端：${REV ? `${REV}（git show 落到临时目录）` : '当前工作区'} ==`);

// ---------- 语料 ----------
const corpus = path.join(tmp, 'corpus');
fs.mkdirSync(corpus, { recursive: true });
const para = (i) => `第${i}段：学而时习之，不亦说乎？有朋自远方来，不亦乐乎？人不知而不愠，不亦君子乎？温故而知新，可以为师矣。`;
for (let d = 0; d < 8; d++) {
  const parts = [`# 长文${d}`];
  for (let sec = 0; sec < 400; sec++) {
    parts.push(`\n## 第${sec}节\n`);
    for (let i = 0; i < 60; i++) parts.push(para(sec * 60 + i));
  }
  fs.writeFileSync(path.join(corpus, `长文${d}.md`), parts.join('\n\n'));
}
for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(corpus, `短文${i}.md`), `# 短文${i}\n\n${para(i)}\n`);

// ---------- 后端 ----------
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const proc = spawn(ELECTRON, [path.join(serverDir, 'index.js')], {
  env: {
    ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1',
    WORKBENCH_DATA_DIR: path.join(tmp, 'data'), WORKBENCH_RAG_EMBED: 'mock', WORKBENCH_RAG_MOCK_EMBED_MS: '1',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let exited = null;
proc.on('exit', (c, s) => { exited = s || c; });
atExit(() => proc.kill('SIGKILL'));
const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

// 在 fn 执行期间每 100ms 采一次 /api/status
async function sampleDuring(fn) {
  const samples = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const t0 = performance.now();
      let okRes = false;
      try { okRes = (await fetch(base + '/api/status')).ok; } catch { /* 记为失败样本 */ }
      const ms = performance.now() - t0;
      samples.push({ ms, ok: okRes });
      if (ms < 100) await sleep(100 - ms);
    }
  })();
  let result;
  try {
    result = await fn();
  } finally {
    polling = false;
    await poller;
  }
  return { samples, max: Math.max(0, ...samples.map((x) => x.ms)), result };
}

try {
  for (let i = 0; ; i++) {
    if (exited !== null) throw new Error('后端提前退出：' + exited);
    try { if ((await fetch(base + '/api/config')).ok) break; } catch { /* 启动中 */ }
    if (i > 600) throw new Error('后端 60 秒内未就绪');
    await sleep(100);
  }
  await post('/api/config', { baseDir: corpus });
  for (let i = 0; i < 600; i++) {
    const s = await (await fetch(base + '/api/status')).json();
    if (s.dsId && !s.scanning && s.indexing?.phase == null && s.linksReady) break;
    await sleep(100);
  }

  // ---------- R1 构建 ----------
  const build = await sampleDuring(async () => {
    const r = await post('/api/rag/index/build', { rebuild: true });
    ok(r.ok, 'build 返回 ' + r.status);
    for (let i = 0; i < 3000; i++) {
      const s = await (await fetch(base + '/api/rag/status')).json();
      if (s.index.state === 'ready') return s.index;
      if (s.index.state === 'error') throw new Error('构建失败：' + s.index.error);
      await sleep(100);
    }
    throw new Error('构建 300 秒内未完成');
  });
  console.log(`  （构建：${build.result.chunks} 块；/api/status 采样 ${build.samples.length} 次，最大 ${build.max.toFixed(0)}ms）`);
  check(`R1 构建期间 /api/status 单次 ≤ ${STATUS_LIMIT_MS}ms`, () => ok(build.max <= STATUS_LIMIT_MS, `最大 ${build.max.toFixed(0)}ms`));

  // ---------- R2 检索 ----------
  let hits = null;
  const search = await sampleDuring(async () => {
    for (let i = 0; i < 4; i++) {
      const r = await (await post('/api/rag/search', { q: '温故而知新 可以为师', limit: 100 })).json();
      hits = r.hits;
    }
  });
  console.log(`  （检索 4 次：/api/status 采样 ${search.samples.length} 次，最大 ${search.max.toFixed(0)}ms；命中 ${hits?.length ?? 0} 条）`);
  check(`R2 检索期间 /api/status 单次 ≤ ${STATUS_LIMIT_MS}ms`, () => ok(search.max <= STATUS_LIMIT_MS, `最大 ${search.max.toFixed(0)}ms`));
  const fingerprint = crypto.createHash('sha1').update(JSON.stringify(hits.map((h) => [h.path, h.ordinal, h.location.occurrence, h.score, h.cos]))).digest('hex').slice(0, 12);
  console.log(`  （检索结果指纹 ${fingerprint}：新旧版本对照时应相同）`);
  check('R2 检索有结果且带定位信息', () => ok(hits?.length > 0 && hits.every((h) => h.location && typeof h.location.occurrence === 'number'), JSON.stringify(hits?.[0])));
} finally {
  proc.kill('SIGTERM');
}

console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
