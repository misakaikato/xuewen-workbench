// 模型下载回归：断点续传、断开重试、空闲超时、Range 回退、探测不可达源、句柄释放。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeTmpDir } from './tmpdirs.mjs';

const tmp = makeTmpDir('wb-dl-');
let checks = 0;
function test(name, fn) { return Promise.resolve(fn()).then(() => { checks++; console.log('PASS', name); }); }

const { probeHosts, downloadFile, pickFetch } = await import('../server/rag/download.js');

const MB = 1024 * 1024;
const big = crypto.randomBytes(20 * MB);
const bigSha = crypto.createHash('sha256').update(big).digest('hex');

// 打开中的文件在 Windows 上无法重命名/删除；POSIX 下重命名仍能暴露句柄问题
function assertPartReleasable(part) {
  if (!fs.existsSync(part)) return;
  const probe = part + '.probe';
  fs.renameSync(part, probe);
  fs.renameSync(probe, part);
  fs.rmSync(part, { force: true });
}

// /big：首试在 5MB 断开、二试发送到 8MB 后停发（触发空闲超时）、之后正常支持 Range；
// /big-norange：不支持 Range（总是 200 全量）；/repo/resolve/main/config.json 供 probeHosts；
// /always-fail：写 1KB 后恒断开。
const bigRanges = [];
let norangeRange = null;
const server = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  if (req.method === 'HEAD' && req.url === '/repo/resolve/main/config.json') {
    res.writeHead(200, { 'Content-Length': '0' });
    res.end();
    return;
  }
  if (req.url === '/big') {
    const n = bigRanges.length + 1;
    bigRanges.push({ n, range: req.headers.range || null });
    let start = 0;
    let end = big.length - 1;
    if (req.headers.range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (m) { start = Number(m[1]); if (m[2]) end = Number(m[2]); }
    }
    if (n === 1) {
      res.writeHead(200, { 'Content-Length': big.length, 'Accept-Ranges': 'bytes' });
      res.write(big.subarray(0, 5 * MB), () => res.socket.destroy());
      return;
    }
    if (n === 2) {
      res.writeHead(206, {
        'Content-Length': big.length - start,
        'Content-Range': `bytes ${start}-${big.length - 1}/${big.length}`,
        'Accept-Ranges': 'bytes',
      });
      res.write(big.subarray(start, 8 * MB));
      setTimeout(() => res.destroy(), 8000).unref(); // 兜底：客户端未中止则关闭
      return;
    }
    res.writeHead(start > 0 ? 206 : 200, {
      'Content-Length': end - start + 1,
      ...(start > 0 ? { 'Content-Range': `bytes ${start}-${end}/${big.length}` } : {}),
      'Accept-Ranges': 'bytes',
    });
    res.end(big.subarray(start, end + 1));
    return;
  }
  if (req.url === '/big-norange') {
    norangeRange = req.headers.range || null;
    res.writeHead(200, { 'Content-Length': big.length });
    res.end(big);
    return;
  }
  if (req.url === '/always-fail') {
    res.writeHead(200, { 'Content-Length': big.length });
    res.write(big.subarray(0, 1024), () => res.socket.destroy());
    return;
  }
  if (req.url === '/503') {
    res.writeHead(503);
    res.end('nope');
    return;
  }
  if (req.url === '/stall') {
    res.writeHead(200, { 'Content-Length': big.length });
    res.write(big.subarray(0, 10));
    setTimeout(() => res.destroy(), 5000).unref();
    return;
  }
  res.writeHead(404);
  res.end();
});

const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

try {
  await test('pickFetch 独立模式为 node', () => {
    const { fetchImpl, kind } = pickFetch();
    assert.equal(kind, 'node');
    assert.equal(fetchImpl, globalThis.fetch);
  });

  await test('probeHosts 返回可达源', async () => {
    const hosts = await probeHosts([base], 'repo', { fetchImpl: globalThis.fetch, timeoutMs: 2000 });
    assert.deepEqual(hosts, [base]);
  });

  await test('probeHosts 全部不可达返回 []', async () => {
    // 先占用一个端口再关闭，确保探测目标无监听
    const s = http.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const dead = `http://127.0.0.1:${s.address().port}`;
    await new Promise((r) => s.close(r));
    const hosts = await probeHosts([dead], 'repo', { fetchImpl: globalThis.fetch, timeoutMs: 500 });
    assert.deepEqual(hosts, []);
  });

  await test('断点续传：断开 + 空闲超时后 sha256 一致且后续请求带 Range', async () => {
    bigRanges.length = 0;
    const dest = path.join(tmp, 'resume.bin');
    const r = await downloadFile({
      urls: [`${base}/big`], dest, fetchImpl: globalThis.fetch,
      idleTimeoutMs: 1000, maxAttempts: 5, backoffMs: [10, 10, 10, 10, 10],
    });
    assert.equal(r.resumed, true);
    assert.equal(r.attempts, 3);
    assert.equal(fs.statSync(dest).size, big.length);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex'), bigSha);
    assert.equal(bigRanges[0].range, null, '首次请求不应带 Range');
    const off = (i) => Number((bigRanges[i].range || '').replace(/^bytes=(\d+)-$/, '$1'));
    assert.ok(/^bytes=\d+-$/.test(bigRanges[1].range || ''), '第二次请求应带 Range');
    assert.ok(/^bytes=\d+-$/.test(bigRanges[2].range || ''), '第三次请求应带 Range');
    assert.ok(off(2) > off(1), '后续请求偏移应递增');
  });

  await test('源不支持 Range 时截断重下仍成功', async () => {
    const dest = path.join(tmp, 'norange.bin');
    fs.writeFileSync(dest + '.part', Buffer.alloc(1000, 7)); // 预置脏 .part
    const r = await downloadFile({
      urls: [`${base}/big-norange`], dest, fetchImpl: globalThis.fetch,
      idleTimeoutMs: 5000, maxAttempts: 3, backoffMs: [10, 10],
    });
    assert.equal(r.resumed, false);
    assert.equal(fs.statSync(dest).size, big.length);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex'), bigSha);
    assert.ok(/^bytes=\d+-$/.test(norangeRange || ''), '续传请求应带 Range');
  });

  await test('失败后 .part 可立即删除（无句柄残留）', async () => {
    const dest = path.join(tmp, 'fail.bin');
    let threw = false;
    try {
      await downloadFile({
        urls: [`${base}/always-fail`], dest, fetchImpl: globalThis.fetch,
        idleTimeoutMs: 5000, maxAttempts: 1, backoffMs: [],
      });
    } catch { threw = true; }
    assert.ok(threw, '应抛错');
    assertPartReleasable(dest + '.part');
  });

  await test('503 最终错误消息含中文原因与 HTTP 503', async () => {
    const dest = path.join(tmp, '503.bin');
    let msg = '';
    try {
      await downloadFile({
        urls: [`${base}/503`], dest, fetchImpl: globalThis.fetch,
        idleTimeoutMs: 5000, maxAttempts: 2, backoffMs: [10],
      });
    } catch (e) { msg = String(e.message); }
    assert.ok(msg.includes('服务器返回错误（HTTP 503）'), '应含中文原因与码：' + msg);
    assert.ok(msg.includes('已尝试 2 次'), '应含尝试次数：' + msg);
  });

  await test('停发触发空闲超时最终消息含 idle-timeout', async () => {
    const dest = path.join(tmp, 'stall.bin');
    let msg = '';
    try {
      await downloadFile({
        urls: [`${base}/stall`], dest, fetchImpl: globalThis.fetch,
        idleTimeoutMs: 300, maxAttempts: 2, backoffMs: [10],
      });
    } catch (e) { msg = String(e.message); }
    assert.ok(msg.includes('空闲超时'), '应含空闲超时：' + msg);
    assert.ok(msg.includes('（idle-timeout）'), '应含原因码：' + msg);
  });

  await test('连接重置（socket.destroy）最终消息含 UND_ERR_SOCKET', async () => {
    const dest = path.join(tmp, 'reset.bin');
    let msg = '';
    try {
      await downloadFile({
        urls: [`${base}/always-fail`], dest, fetchImpl: globalThis.fetch,
        idleTimeoutMs: 5000, maxAttempts: 2, backoffMs: [10],
      });
    } catch (e) { msg = String(e.message); }
    assert.ok(msg.includes('连接被重置（UND_ERR_SOCKET）'), '应含连接被重置：' + msg);
  });

  await test('fetch 桩 net::ERR_CONNECTION_RESET 提取 ERR_CONNECTION_RESET', async () => {
    const dest = path.join(tmp, 'stub.bin');
    const stub = () => Promise.reject(new TypeError('net::ERR_CONNECTION_RESET'));
    let msg = '';
    try {
      await downloadFile({
        urls: ['http://stub.invalid/x'], dest, fetchImpl: stub,
        idleTimeoutMs: 5000, maxAttempts: 2, backoffMs: [10],
      });
    } catch (e) { msg = String(e.message); }
    assert.ok(msg.includes('连接被重置（ERR_CONNECTION_RESET）'), '应含连接被重置：' + msg);
  });

  await test('probeHosts 不可达日志含「不可达」与原因码', async () => {
    const s = http.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const dead = `http://127.0.0.1:${s.address().port}`;
    await new Promise((r) => s.close(r));
    const lines = [];
    const hosts = await probeHosts([dead], 'repo', {
      fetchImpl: globalThis.fetch, timeoutMs: 500,
      log: (m) => lines.push(m),
    });
    assert.deepEqual(hosts, []);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('不可达'), '日志应含「不可达」：' + lines[0]);
    assert.ok(/（[A-Z0-9_]+）$/.test(lines[0]), '日志应含原因码：' + lines[0]);
  });

  console.log('\n' + checks + ' checks passed');
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
}
