// 重扫与检索的开销不随无关变动和总正文量放大：
// 单元（直接驱动 Indexer）：
//   U1 mtime 与大小都没变的文件复用上一轮正文，不再读盘；变了的重新读
//   U2 新一轮构建开始后，进行中的旧一轮停下并返回 false，新一轮结果完整
//   U3 检索大小写不敏感（小写正文在建索引时算好）
//   U4 约 100MB 正文、20 次检索的平均耗时 ≤ 60ms（逐次对全文 toLowerCase 时约为其数倍）
// 集成（拉起后端）：
//   I1 下载临时文件、压缩包等非支持类型的增删改不触发重扫
//   I2 回收站（.trash）里的变动不触发重扫
//   I3 支持类型的文件改动触发重扫，且只重读改动的那个文件
//   I4 新建目录触发重扫
// 用法：node scripts/test-index-incremental.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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

const tmp = makeTmpDir('wb-index-incr-');
process.env.WORKBENCH_DATA_DIR = path.join(tmp, 'unit-data');
const { Indexer } = await import('../server/indexer.js');

// ---------- 单元 ----------
const unitDir = path.join(tmp, 'unit-corpus');
fs.mkdirSync(unitDir, { recursive: true });
function snapshotOf(dir) {
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    const st = fs.statSync(path.join(dir, name));
    const ext = path.extname(name).toLowerCase();
    files.push({ path: name, name, base: path.basename(name, ext), ext, dir: '', size: st.size, mtimeMs: st.mtimeMs });
  }
  return { files };
}
for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(unitDir, `篇${i}.md`), `# 篇${i}\n\n温故而知新 Alpha${i}\n`);
fs.writeFileSync(path.join(unitDir, 'Mixed.md'), '# Mixed\n\nHello World 标记\n');

{
  const ix = new Indexer();
  ix.reset('unit', unitDir);
  await ix.build(snapshotOf(unitDir));
  const readFile = fs.promises.readFile;
  let reads = 0;
  fs.promises.readFile = (...a) => { reads++; return readFile(...a); };
  try {
    fs.writeFileSync(path.join(unitDir, '篇7.md'), '# 篇7\n\n改过的正文 Beta\n');
    const okBuild = await ix.build(snapshotOf(unitDir));
    check('U1 只重读改动的文件', () => ok(reads === 1, `读盘 ${reads} 次`));
    check('U1 改动文件取到新正文', () => ok(okBuild && ix.texts.get('篇7.md').includes('Beta'), ix.texts.get('篇7.md')));
    check('U1 未变文件正文仍在', () => ok(ix.texts.get('篇8.md')?.includes('Alpha8'), ix.texts.get('篇8.md')));
  } finally {
    fs.promises.readFile = readFile;
  }

  const fresh = new Indexer();
  fresh.reset('unit', unitDir);
  const first = fresh.build(snapshotOf(unitDir));
  const second = fresh.build(snapshotOf(unitDir));
  const [r1, r2] = await Promise.all([first, second]);
  check('U2 旧一轮被取代后返回 false', () => ok(r1 === false, String(r1)));
  check('U2 新一轮建完且完整', () => ok(r2 === true && fresh.texts.size === 301, `r2=${r2} size=${fresh.texts.size}`));

  const r = ix.search('hello world');
  check('U3 小写查询命中大小写混合的正文', () => ok(r.results.some((x) => x.file.path === 'Mixed.md' && x.matches.some((m) => m.field === 'content')), JSON.stringify(r.results.map((x) => x.file.path))));
  const r2b = ix.search('BETA');
  check('U3 大写查询命中小写正文', () => ok(r2b.results.some((x) => x.file.path === '篇7.md'), JSON.stringify(r2b.results.map((x) => x.file.path))));
}

{
  const bigDir = path.join(tmp, 'unit-big');
  fs.mkdirSync(bigDir, { recursive: true });
  const chunk = 'The Quick Brown Fox Jumps Over The Lazy Dog. Lorem Ipsum Dolor Sit Amet. ';
  const body = chunk.repeat(Math.ceil((5 * 1024 * 1024) / chunk.length));
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(bigDir, `大${i}.txt`), body);
  const ix = new Indexer();
  ix.reset('big', bigDir);
  await ix.build(snapshotOf(bigDir));
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) ix.search('needle' + i);
  const avg = (performance.now() - t0) / 20;
  console.log(`  （约 100MB 正文，单次检索平均 ${avg.toFixed(1)}ms）`);
  check('U4 大正文量检索平均 ≤ 60ms', () => ok(avg <= 60, `${avg.toFixed(1)}ms`));
}

// ---------- 集成 ----------
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
const corpus = path.join(tmp, 'corpus');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(path.join(corpus, '.trash'), { recursive: true });
for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(corpus, `笔记${i}.md`), `# 笔记${i}\n\n正文${i}\n`);
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
const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
const scans = () => log().split('\n').filter((l) => l.includes('[scan] 扫描完成')).length;
const lastIndexLine = () => log().split('\n').filter((l) => l.includes('[index] 文本索引构建完成')).pop() || '';
async function waitIdle(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await (await fetch(base + '/api/status')).json();
    if (s.dsId && !s.scanning && s.indexing?.phase == null && s.linksReady) return true;
    await sleep(100);
  }
  return false;
}
// 监听生效后等一段时间：awaitWriteFinish 300ms + 防抖 600ms + 余量
const settle = () => sleep(2500);

try {
  for (let i = 0; ; i++) {
    if (exited !== null) throw new Error('后端提前退出：' + exited);
    try { if ((await fetch(base + '/api/config')).ok) break; } catch { /* 启动中 */ }
    if (i > 600) throw new Error('后端 60 秒内未就绪');
    await sleep(100);
  }
  await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseDir: corpus }) });
  ok(await waitIdle(), '首次索引未完成');
  await settle();
  const s0 = scans();

  fs.writeFileSync(path.join(corpus, '安装包.zip'), Buffer.alloc(1024));
  fs.writeFileSync(path.join(corpus, '视频.mp4.crdownload'), 'partial');
  fs.renameSync(path.join(corpus, '视频.mp4.crdownload'), path.join(corpus, '视频.mp4'));
  fs.writeFileSync(path.join(corpus, '临时.tmp'), 'x');
  fs.rmSync(path.join(corpus, '临时.tmp'));
  await settle();
  check('I1 非支持类型的增删改不触发重扫', () => ok(scans() === s0, `重扫 ${scans() - s0} 次`));

  fs.writeFileSync(path.join(corpus, '.trash', '旧笔记.md'), '# 旧\n');
  await settle();
  check('I2 回收站内的变动不触发重扫', () => ok(scans() === s0, `重扫 ${scans() - s0} 次`));

  fs.writeFileSync(path.join(corpus, '笔记3.md'), '# 笔记3\n\n改过了\n');
  await settle();
  ok(await waitIdle(), '改动后索引未完成');
  check('I3 支持类型的改动触发重扫', () => ok(scans() === s0 + 1, `重扫 ${scans() - s0} 次`));
  check('I3 只重读改动的文件', () => ok(/复用未变 29 个/.test(lastIndexLine()), lastIndexLine()));

  fs.mkdirSync(path.join(corpus, '新目录'));
  await settle();
  check('I4 新建目录触发重扫', () => ok(scans() === s0 + 2, `重扫 ${scans() - s0} 次`));
} finally {
  proc.kill('SIGTERM');
}

console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
