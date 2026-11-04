// 文件监听的开销不随目录里的文件总数放大（下载目录这类混着大量非文档文件的库）：
// 语料：50 篇笔记 + 300 个目录 × 80 个无关文件（约 2.4 万个）。
// W1 监听建立后后端打开的文件描述符 < 300（逐文件逐目录各开一个监听时约为文件总数）
// W2 添加资料库与监听建立期间 /api/status 单次 ≤ 300ms
// W3 监听照常工作：改笔记触发重扫；新增无关文件不触发；新建与删除名字带点的目录都触发
// W4 库根目录被改名（移走）后识别为不可达，改回来后自动恢复
// 文件描述符计数用 lsof（macOS / Linux）；Windows 上跳过 W1。
// 用法：node scripts/test-watch-scale.mjs
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATUS_LIMIT_MS = 300;
const FD_LIMIT = 300;
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
    console.log('  ✗ ' + name + '：' + String(e.message).slice(0, 300));
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
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
const tmp = makeTmpDir('wb-watch-scale-');
const corpus = path.join(tmp, 'corpus');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(corpus, { recursive: true });
for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(corpus, `笔记${i}.md`), `# 笔记${i}\n\n正文${i}\n`);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
for (let d = 0; d < 300; d++) {
  const dir = path.join(corpus, '素材', `批次${String(d).padStart(3, '0')}`);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(dir, `图${i}.png`), png);
}

// ---------- 后端 ----------
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: { ...process.env, WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1', WORKBENCH_DATA_DIR: dataDir, WORKBENCH_RAG_EMBED: 'mock' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let exited = null;
proc.on('exit', (c, s) => { exited = s || c; });
atExit(() => proc.kill('SIGKILL'));
const logFile = path.join(dataDir, 'logs', 'backend.log');
const scans = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '').split('\n').filter((l) => l.includes('[scan] 扫描完成')).length;
async function waitIdle(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await (await fetch(base + '/api/status')).json();
    if (s.dsId && !s.scanning && s.indexing?.phase == null && s.linksReady) return true;
    await sleep(100);
  }
  return false;
}
// 监听生效后等一段时间：防抖 600ms + 余量
const settle = () => sleep(2000);
function openFds(pid) {
  try {
    return execFileSync('lsof', ['-n', '-P', '-p', String(pid)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\n').length - 2;
  } catch {
    return null;
  }
}

try {
  for (let i = 0; ; i++) {
    if (exited !== null) throw new Error('后端提前退出：' + exited);
    try { if ((await fetch(base + '/api/config')).ok) break; } catch { /* 启动中 */ }
    if (i > 600) throw new Error('后端 60 秒内未就绪');
    await sleep(100);
  }

  // ---------- W2：添加资料库到监听建立后 5 秒，每 100ms 一次 /api/status ----------
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
  await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseDir: corpus }) });
  ok(await waitIdle(), '首次索引未完成');
  await sleep(5000);
  polling = false;
  await poller;
  const max = Math.max(...samples.map((x) => x.ms));
  console.log(`  （/api/status 采样 ${samples.length} 次，最大 ${max.toFixed(0)}ms）`);
  check(`W2 添加资料库与监听建立期间 /api/status 单次 ≤ ${STATUS_LIMIT_MS}ms`, () => {
    ok(samples.every((x) => x.ok), '有请求失败');
    ok(max <= STATUS_LIMIT_MS, `最大 ${max.toFixed(0)}ms`);
  });

  // ---------- W1 ----------
  if (process.platform !== 'win32') {
    const fds = openFds(proc.pid);
    console.log(`  （后端打开的文件描述符 ${fds}）`);
    check(`W1 约 2.4 万个文件时后端打开的文件描述符 < ${FD_LIMIT}`, () => ok(fds !== null && fds < FD_LIMIT, String(fds)));
  }

  // ---------- W3 ----------
  await settle();
  const s0 = scans();
  fs.writeFileSync(path.join(corpus, '素材', '批次000', '新图.png'), png);
  fs.writeFileSync(path.join(corpus, '安装包.zip'), Buffer.alloc(2048));
  await settle();
  check('W3 新增无关文件不触发重扫', () => ok(scans() === s0, `重扫 ${scans() - s0} 次`));

  fs.writeFileSync(path.join(corpus, '笔记7.md'), '# 笔记7\n\n改过了\n');
  await settle();
  ok(await waitIdle(), '改动后索引未完成');
  check('W3 改笔记触发重扫', () => ok(scans() === s0 + 1, `重扫 ${scans() - s0} 次`));

  fs.mkdirSync(path.join(corpus, 'v1.2'));
  await settle();
  ok(await waitIdle(), '新建目录后索引未完成');
  check('W3 新建名字带点的目录触发重扫', () => ok(scans() === s0 + 2, `重扫 ${scans() - s0} 次`));
  const tree = await (await fetch(base + '/api/tree')).json();
  check('W3 新目录出现在目录树里', () => ok(JSON.stringify(tree.tree).includes('"v1.2"'), '目录树里没有 v1.2'));

  fs.rmdirSync(path.join(corpus, 'v1.2'));
  await settle();
  check('W3 删除名字带点的目录触发重扫', () => ok(scans() === s0 + 3, `重扫 ${scans() - s0} 次`));

  // ---------- W4 ----------
  const moved = corpus + '-moved';
  fs.renameSync(corpus, moved);
  let unreachable = false;
  for (let i = 0; i < 100 && !unreachable; i++) {
    unreachable = !!(await (await fetch(base + '/api/status')).json()).unreachable;
    if (!unreachable) await sleep(100);
  }
  check('W4 库根被改名后 10 秒内识别为不可达', () => ok(unreachable, '仍报告可达'));
  fs.renameSync(moved, corpus);
  let back = false;
  for (let i = 0; i < 300 && !back; i++) {
    const s = await (await fetch(base + '/api/status')).json();
    back = !s.unreachable && s.watching;
    if (!back) await sleep(100);
  }
  check('W4 改回来后 30 秒内恢复并重开监听', () => ok(back, '未恢复'));
} finally {
  proc.kill('SIGTERM');
}

console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
