// 模型下载：并发探测可达源 + 单文件断点续传下载。
// 背压与出错时关流交给 stream.promises.pipeline；托管模式（utilityProcess）
// 用 electron.net.fetch 走 Chromium 网络栈与系统代理，否则用 Node 全局 fetch。
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 托管（utilityProcess）时返回 electron.net.fetch（走 Chromium 网络栈与系统代理），否则 Node 全局 fetch
export function pickFetch() {
  if (process.type === 'utility' && process.parentPort) {
    try {
      const { net } = createRequire(import.meta.url)('electron');
      if (net && typeof net.fetch === 'function') return { fetchImpl: net.fetch, kind: 'electron-net' };
    } catch { /* 非 Electron 或 net.fetch 不可用：回退 Node fetch */ }
  }
  return { fetchImpl: globalThis.fetch, kind: 'node' };
}

// 从错误对象提取原因码：err.cause?.code || err.code → Electron net.fetch 的 message 中 ERR_[A-Z_]+ → err.name
function reasonCode(e) {
  const c = e?.cause?.code || e?.code;
  if (c) return String(c);
  const m = /ERR_[A-Z_]+/.exec(String(e?.message || ''));
  if (m) return m[0];
  return String(e?.name || 'unknown');
}

// 原因码 → 中文（对照规格表；未列出的写「网络错误」）
function reasonText(code, idleTimeoutMs) {
  if (code === 'idle-timeout') {
    const s = idleTimeoutMs / 1000;
    const t = Number.isInteger(s) ? String(s) : String(Math.round(s * 10) / 10);
    return `空闲超时（${t} 秒无数据）`;
  }
  if (/^HTTP \d{3}$/.test(code)) return '服务器返回错误';
  if (['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT'].includes(code)) return '连接超时';
  if (['ECONNREFUSED', 'ERR_CONNECTION_REFUSED'].includes(code)) return '连接被拒绝';
  if (['ECONNRESET', 'UND_ERR_SOCKET', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED'].includes(code)) return '连接被重置';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ERR_NAME_NOT_RESOLVED'].includes(code)) return '域名解析失败';
  if (['ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED'].includes(code)) return '代理连接失败';
  if (code === 'ERR_INTERNET_DISCONNECTED') return '网络未连接';
  if (code.includes('CERT') || /^(CERT_|UNABLE_TO_|SELF_SIGNED)/.test(code)) return '证书校验失败';
  return '网络错误';
}

// 并发 HEAD 探测各源上的 config.json，按响应先后返回可达源；全部不可达返回 []
export async function probeHosts(hosts, repoPath, { fetchImpl, timeoutMs = 8000, log }) {
  let seq = 0;
  const reached = [];
  await Promise.all(hosts.map(async (host) => {
    const url = `${host}/${repoPath}/resolve/main/config.json`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    let res;
    try {
      res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
      if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { code: 'HTTP ' + res.status });
      reached.push({ host, n: seq++ });
      if (log) log(`探测 ${host} 可达，${Date.now() - t0}ms`);
    } catch (e) {
      const code = reasonCode(e);
      if (log) log(`探测 ${host} 不可达：${reasonText(code, timeoutMs)}（${code}）`);
    } finally {
      clearTimeout(timer);
      try { await res?.body?.cancel?.(); } catch { /* 忽略 */ }
    }
  }));
  reached.sort((a, b) => a.n - b.n);
  return reached.map((x) => x.host);
}

const partSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

// 最近 5 秒平均速度采样
function makeSpeed() {
  const samples = [];
  return (bytes) => {
    const t = Date.now();
    samples.push({ t, bytes });
    while (samples.length > 1 && t - samples[0].t > 5000) samples.shift();
    if (samples.length < 2) return 0;
    const dt = t - samples[0].t;
    return dt > 0 ? Math.round(((bytes - samples[0].bytes) / dt) * 1000) : 0;
  };
}

// 下载单个文件到 dest（经 dest + '.part'）：断点续传、空闲超时、重试、背压。
// 连续两次在同一源失败则换下一个源；超过 maxAttempts 抛中文错误（取最后一次尝试的原因）。
export async function downloadFile({
  urls, dest, fetchImpl, idleTimeoutMs = 30000, maxAttempts = 5,
  backoffMs = [2000, 4000, 8000, 16000, 30000], onProgress, isCancelled, log,
}) {
  const part = dest + '.part';
  const name = path.basename(dest);
  const say = (msg) => { if (log) log(msg); };
  let hostIdx = 0;
  let failsOnHost = 0;
  let lastCode = 'unknown';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isCancelled?.()) throw new Error('已取消');
    const url = urls[hostIdx % urls.length];
    const host = new URL(url).host;
    const offset = partSize(part);

    let r = await tryOnce({ url, host, name, offset, part, attempt, idleTimeoutMs, fetchImpl, onProgress, say });
    if (r.ok) {
      await fs.promises.rename(part, dest);
      say(`下载 ${name} 完成：${r.bytes} 字节（HTTP ${r.status}），耗时 ${r.ms}ms，平均 ${r.avgBps} B/s`);
      return { bytes: r.bytes, total: r.total, host, attempts: attempt, resumed: r.resumed };
    }
    if (r.status === 416) {
      // 服务端文件小于已下载的 .part：删除后从头再来一次
      fs.rmSync(part, { force: true });
      r = await tryOnce({ url, host, name, offset: 0, part, attempt, idleTimeoutMs, fetchImpl, onProgress, say });
      if (r.ok) {
        await fs.promises.rename(part, dest);
        say(`下载 ${name} 完成：${r.bytes} 字节（HTTP ${r.status}），耗时 ${r.ms}ms，平均 ${r.avgBps} B/s`);
        return { bytes: r.bytes, total: r.total, host, attempts: attempt, resumed: false };
      }
    }
    const code = r.code || 'unknown';
    lastCode = code;
    if (isCancelled?.()) throw new Error('已取消'); // 取消不重试
    say(`下载 ${name} 第 ${attempt} 次尝试失败（${host}）：${reasonText(code, idleTimeoutMs)}（${code}）`);
    failsOnHost++;
    if (failsOnHost >= 2) { hostIdx = (hostIdx + 1) % urls.length; failsOnHost = 0; }
    if (attempt < maxAttempts) await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]);
  }
  throw new Error(`下载 ${name} 失败（已尝试 ${maxAttempts} 次）：${reasonText(lastCode, idleTimeoutMs)}（${lastCode}）`);
}

// 单次尝试：发请求（带 Range 续传）→ pipeline 写 .part → 返回结果对象（失败统一带 code）。
async function tryOnce({ url, host, name, offset, part, attempt, idleTimeoutMs, fetchImpl, onProgress, say }) {
  const ctrl = new AbortController();
  let idleTimer = setTimeout(() => ctrl.abort(), idleTimeoutMs);
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => ctrl.abort(), idleTimeoutMs); };
  const headers = { 'Accept-Encoding': 'identity' };
  if (offset > 0) headers.Range = `bytes=${offset}-`;
  say(`下载 ${name} 第 ${attempt} 次尝试（${host}，起始偏移 ${offset}）`);

  let res;
  try {
    res = await fetchImpl(url, { headers, redirect: 'follow', signal: ctrl.signal });
  } catch (e) {
    clearTimeout(idleTimer);
    return { ok: false, code: reasonCode(e) };
  }

  const status = res.status;
  const cl = Number(res.headers.get('content-length')) || 0;
  if (status === 416) {
    clearTimeout(idleTimer);
    await res.body?.cancel?.().catch(() => {});
    return { ok: false, status: 416, code: 'HTTP 416' };
  }
  if (status !== 200 && status !== 206) {
    clearTimeout(idleTimer);
    await res.body?.cancel?.().catch(() => {});
    return { ok: false, code: 'HTTP ' + status };
  }
  if (!res.body) {
    clearTimeout(idleTimer);
    return { ok: false, code: 'HTTP ' + status };
  }

  const append = status === 206;
  const begin = append ? offset : 0;
  const total = append ? offset + cl : cl;
  let bytes = begin;
  const t0 = Date.now();
  const speed = makeSpeed();
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      resetIdle();
      if (onProgress) onProgress({ bytes, total, host, attempt, speedBps: speed(bytes) });
      cb(null, chunk);
    },
  });
  const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, out);
    clearTimeout(idleTimer);
    const ms = Date.now() - t0;
    return { ok: true, bytes, total, resumed: append, ms, avgBps: ms > 0 ? Math.round((bytes - begin) / (ms / 1000)) : 0, status };
  } catch (e) {
    clearTimeout(idleTimer);
    if (ctrl.signal.aborted) return { ok: false, code: 'idle-timeout' };
    return { ok: false, code: reasonCode(e) };
  }
}
