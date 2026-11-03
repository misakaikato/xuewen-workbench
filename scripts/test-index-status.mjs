// G4（反馈第 4 批·上）：/api/status 的扫描与索引状态字段。
// 断言：添加知识库期间 scanning=true 且 scanned 增长；索引期间 indexing.phase 依次出现
// text / links 且带 done/total；结束后 phase 回到 null、indexError 为 null；
// 顶层与按库（libs[dsId]）都带这些字段。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = makeTmpDir('wb-index-status-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('  ✓', name);
  } catch (e) {
    fail++;
    console.log('  ✗', name, '—', e.message);
  }
};

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

// 语料：8000 个 md（约 50KB 一篇），让扫描与 text/links 两个阶段都持续可观察
const corpus = path.join(tmp, 'corpus');
fs.mkdirSync(corpus, { recursive: true });
const bodyLine = '学问之道无他，求其放心而已矣。博学之，审问之，慎思之，明辨之，笃行之。\n';
const FILE_COUNT = 8000;
for (let i = 0; i < FILE_COUNT; i++) {
  const sub = path.join(corpus, `卷${i % 20}`);
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, `文档${String(i).padStart(5, '0')}.md`), `# 文档${i}\n\n` + bodyLine.repeat(450));
}
// 扫描观测语料：大量小文件拉长扫描窗口（扫描耗时按文件数计），
// 验证「扫描异步化之后状态可以被轮询到」（规格第 7 条的前提）
const scanCorpus = path.join(tmp, 'scan-corpus');
fs.mkdirSync(scanCorpus, { recursive: true });
const SCAN_FILE_COUNT = 40000;
for (let i = 0; i < SCAN_FILE_COUNT; i++) {
  const sub = path.join(scanCorpus, `卷${i % 40}`);
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, `s${String(i).padStart(6, '0')}.md`), `# s${i}\n`);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    WORKBENCH_PORT: String(port),
    WORKBENCH_HOST: '127.0.0.1',
    WORKBENCH_DATA_DIR: path.join(tmp, 'data'),
    WORKBENCH_RAG_EMBED: 'mock',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
proc.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
atExit(() => proc.kill('SIGKILL'));

try {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(base + '/api/config');
      if (r.ok) break;
    } catch { /* 启动中 */ }
    if (i > 150) throw new Error('后端 15 秒内未就绪');
    await sleep(100);
  }

  // ---------- 扫描期：添加扫描观测语料，5ms 轮询捕捉 scanning/scanned ----------
  {
    const samples = [];
    let stop = false;
    const poller = (async () => {
      while (!stop) {
        try {
          const r = await fetch(base + '/api/status');
          samples.push(await r.json());
        } catch { /* 瞬时失败忽略 */ }
        await sleep(5);
      }
    })();
    const add = await fetch(base + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseDir: scanCorpus }),
    });
    assert.equal(add.status, 200, 'POST /api/config 应成功');
    stop = true;
    await poller;
    // 等扫描语料的索引链落定，避免下一段采样混入它的 text/links 阶段
    for (let i = 0; i < 600; i++) {
      const r = await fetch(base + '/api/status');
      const s = await r.json();
      if (!s.scanning && s.indexing?.phase == null && s.linksReady) break;
      await sleep(50);
    }
    const scanningSamples = samples.filter((s) => s.scanning);
    console.log(`  （扫描期采样 ${samples.length} 次，捕捉到 scanning ${scanningSamples.length} 次）`);
    check('扫描期间 /api/status 可轮询到 scanning=true 且 scanned 单调增长', () => {
      assert.ok(scanningSamples.length >= 2, `扫描期样本不足（${scanningSamples.length}）：扫描应分片让出事件循环，轮询不应停摆`);
      const seq = scanningSamples.map((s) => s.scanned ?? 0);
      assert.ok(seq[0] > 0, '扫描期 scanned 应为正数');
      for (let i = 1; i < seq.length; i++) assert.ok(seq[i] >= seq[i - 1], `scanned 应单调递增：${seq[i - 1]} -> ${seq[i]}`);
      assert.ok(new Set(seq).size >= 3, '应观察到多个递增的进度值');
      assert.ok(Math.max(...seq) >= SCAN_FILE_COUNT * 0.8, `扫描进度应接近文件总数（最大 ${Math.max(...seq)}/${SCAN_FILE_COUNT}）`);
    });
  }

  // ---------- 索引期：另加索引观测语料，25ms 轮询捕捉 text/links 阶段 ----------
  // 采样：POST /api/config 触发首扫 + 索引，全程 25ms 轮询 /api/status
  const samples = [];
  let done = false;
  const poller = (async () => {
    while (!done) {
      try {
        const r = await fetch(base + '/api/status');
        const s = await r.json();
        samples.push(s);
      } catch { /* 瞬时失败忽略 */ }
      await sleep(10);
    }
  })();
  const add = await fetch(base + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseDir: corpus }),
  });
  assert.equal(add.status, 200, 'POST /api/config 应成功');
  // 等索引结束：phase 回到 null 且 linksReady=true
  let final = null;
  for (let i = 0; i < 1200; i++) {
    const r = await fetch(base + '/api/status');
    final = await r.json();
    if (!final.scanning && final.indexing?.phase == null && final.linksReady) break;
    await sleep(50);
  }
  done = true;
  await poller;

  const textSamples = samples.filter((s) => s.indexing?.phase === 'text');
  const linksSamples = samples.filter((s) => s.indexing?.phase === 'links');

  console.log(`  （采样 ${samples.length} 次：text ${textSamples.length}，links ${linksSamples.length}）`);

  check('观察到 indexing.phase=text，带 done/total 且 done 单调不减、最终到达 total', () => {
    assert.ok(textSamples.length >= 1, '未观察到 text 阶段');
    for (const s of textSamples) {
      assert.ok(typeof s.indexing.done === 'number' && typeof s.indexing.total === 'number', 'done/total 必须是数字');
      assert.ok(s.indexing.total === FILE_COUNT, `total 应为 ${FILE_COUNT}，实际 ${s.indexing.total}`);
      assert.ok(s.indexing.done >= 0 && s.indexing.done <= s.indexing.total, 'done 应在 [0,total]');
      assert.ok(typeof s.indexing.startedAt === 'number', 'startedAt 必须存在');
    }
    const seq = textSamples.map((s) => s.indexing.done);
    for (let i = 1; i < seq.length; i++) assert.ok(seq[i] >= seq[i - 1], 'text 阶段 done 应单调不减');
    assert.ok(seq[seq.length - 1] >= FILE_COUNT * 0.95, 'text 阶段结束时 done 应接近 total');
  });

  check('观察到 indexing.phase=links（text 之后），带 done/total', () => {
    assert.ok(linksSamples.length >= 1, '未观察到 links 阶段');
    const firstText = samples.indexOf(textSamples[0]);
    const firstLinks = samples.indexOf(linksSamples[0]);
    assert.ok(firstLinks > firstText, 'links 阶段应在 text 之后');
    for (const s of linksSamples) {
      assert.ok(s.indexing.total === FILE_COUNT, `total 应为 ${FILE_COUNT}，实际 ${s.indexing.total}`);
      assert.ok(s.indexing.done >= 0 && s.indexing.done <= s.indexing.total, 'done 应在 [0,total]');
    }
    const seq = linksSamples.map((s) => s.indexing.done);
    for (let i = 1; i < seq.length; i++) assert.ok(seq[i] >= seq[i - 1], 'links 阶段 done 应单调不减');
  });

  check('按库字段 libs[dsId] 同样带 scanned / indexing', () => {
    const withLib = samples.filter((s) => s.dsId && s.libs?.[s.dsId]);
    assert.ok(withLib.length > 0, '缺少按库状态');
    const libText = withLib.filter((s) => s.libs[s.dsId].indexing?.phase === 'text');
    assert.ok(libText.length >= 1, '按库状态未观察到 text 阶段');
    assert.ok(withLib.some((s) => (s.libs[s.dsId].scanned ?? 0) > 0 || !s.scanning), '按库 scanned 字段缺失');
  });

  check('结束后 phase 为 null、indexError 为 null、linksReady=true', () => {
    assert.equal(final.indexing?.phase, null);
    assert.equal(final.indexError, null);
    assert.equal(final.linksReady, true);
    assert.equal(final.libs[final.dsId].indexing.phase, null);
  });
} finally {
  if (proc.exitCode === null) {
    proc.kill('SIGTERM');
    await new Promise((resolve) => proc.once('exit', resolve));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
