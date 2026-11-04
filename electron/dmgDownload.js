// mac 安装包下载：写 .part、断点续传、退避重试、空闲超时、sha512 校验。
// 不 import electron：fetch 由调用方注入（updater.js 传 net.fetch，与检查更新同一网络栈与代理），
// 本模块可在 node 下被 scripts/test-dmg-download.mjs 直接驱动。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_ATTEMPTS = 5;
const PROGRESS_TICK_MS = 250;
const LOCAL_FS_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC']); // 本地写盘错误，重试无用

let timing = { backoffMs: [1000, 2000, 4000, 8000], idleTimeoutMs: 60_000 };

// 仅供测试缩短退避与空闲超时；产品代码不调用，也不读任何环境变量
export function setDmgDownloadTiming(t) {
  timing = { ...timing, ...t };
}

function abortError() {
  return Object.assign(new Error('下载已中止'), { aborted: true });
}

// 错误码：依次取 cause.code、code、message 里的 ERR_*（net.fetch 形如 net::ERR_CONNECTION_RESET），最后是 HTTP 状态码
export function downloadErrorCode(e) {
  const c = e?.cause?.code || e?.code;
  if (c) return String(c);
  const m = /(?:net::)?ERR_[A-Z_]+/.exec(String(e?.message || ''));
  if (m) return m[0];
  if (e?.status) return `HTTP ${e.status}`;
  return 'unknown';
}

async function fileSize(p) {
  try {
    return (await fsp.stat(p)).size;
  } catch {
    return 0;
  }
}

// 可被中止的等待：中止时立即结束
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// 流式计算 sha512（base64，与 latest-mac.yml 同口径），不把整个文件读进内存
async function sha512Base64(file, signal) {
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    if (signal.aborted) throw abortError();
    hash.update(chunk);
  }
  return hash.digest('base64');
}

// 单次尝试：.part 已有 N 字节时带 Range 续传；206 接着写，200 清空重写，416 或起点不符清空后交给重试
async function attemptOnce({ url, part, fetchImpl, signal, onProgress }) {
  const offset = await fileSize(part);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  let idle = false;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      ctrl.abort();
    }, timing.idleTimeoutMs);
  };
  arm();
  let res = null;
  try {
    res = await fetchImpl(url, { headers: offset > 0 ? { Range: `bytes=${offset}-` } : {}, signal: ctrl.signal });
    const length = Number(res.headers.get('content-length')) || 0;
    let begin = 0;
    let total = length;
    if (res.status === 206) {
      const m = /^bytes\s+(\d+)-\d+\/(\d+|\*)$/i.exec(res.headers.get('content-range') || '');
      if (!m || Number(m[1]) !== offset) {
        await fsp.rm(part, { force: true });
        throw Object.assign(new Error('续传起点与已下载内容不一致，已清空重来'), { code: 'range-mismatch' });
      }
      begin = offset;
      total = m[2] === '*' ? offset + length : Number(m[2]);
    } else if (res.status === 416) {
      await fsp.rm(part, { force: true });
      throw Object.assign(new Error('续传范围无效，已清空重来'), { status: 416 });
    } else if (res.status !== 200) {
      throw Object.assign(new Error(`服务器返回 ${res.status}`), { status: res.status, fatal: res.status >= 400 && res.status < 500 });
    }
    if (!res.body) throw Object.assign(new Error('响应没有内容'), { status: res.status });

    // 进度：transferred 从已下载字节算起，速度只按本次尝试计算
    let bytes = begin;
    let tickAt = Date.now();
    let tickBytes = begin;
    const report = (force) => {
      const now = Date.now();
      if (!force && now - tickAt < PROGRESS_TICK_MS) return;
      const dt = (now - tickAt) / 1000;
      const bps = dt > 0 ? Math.round((bytes - tickBytes) / dt) : 0;
      onProgress?.({
        percent: total ? Math.min(100, Math.round((bytes / total) * 100)) : 0,
        transferred: bytes, total, bytesPerSecond: bps,
        etaSeconds: total && bps > 0 ? Math.round((total - bytes) / bps) : null,
      });
      tickAt = now;
      tickBytes = bytes;
    };
    report(true);
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        arm();
        report(bytes === total);
        cb(null, chunk);
      },
    });
    const out = fs.createWriteStream(part, { flags: begin > 0 ? 'a' : 'w' });
    await pipeline(Readable.fromWeb(res.body), counter, out);
    if (total && bytes !== total) {
      throw Object.assign(new Error(`内容不完整（${bytes}/${total} 字节）`), { code: 'incomplete' });
    }
  } catch (e) {
    try { await res?.body?.cancel(); } catch { /* 已被读取或已关闭 */ }
    if (signal.aborted) throw abortError();
    if (idle) {
      const s = timing.idleTimeoutMs / 1000;
      throw Object.assign(new Error(`${Number.isInteger(s) ? s : s.toFixed(1)} 秒内没有收到数据`), { code: 'idle-timeout' });
    }
    if (LOCAL_FS_CODES.has(e?.code) && e?.path) {
      const dir = path.dirname(part);
      const msg = e.code === 'ENOSPC' ? `磁盘空间不足，无法保存安装包：${dir}` : `下载目录不可写：${dir}`;
      throw Object.assign(new Error(`${msg}（${e.code}）`), { code: e.code, fatal: true });
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

// 最多尝试 5 次，失败后依次等 1、2、4、8 秒；取消、HTTP 4xx（416 除外）与本地写盘错误不重试
async function fetchWithRetry({ url, part, fetchImpl, signal, onProgress }) {
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    if (signal.aborted) throw abortError();
    try {
      await attemptOnce({ url, part, fetchImpl, signal, onProgress });
      return;
    } catch (e) {
      if (e?.aborted) throw e;
      const code = downloadErrorCode(e);
      console.warn(`[update] 下载安装包第 ${attempt} 次尝试失败：主机 ${host}，已下载 ${await fileSize(part)} 字节，错误码 ${code}，${e?.message || e}`);
      if (e?.fatal) {
        throw Object.assign(new Error(e.status ? `下载安装包失败（${code}）` : e.message), { code });
      }
      if (attempt >= MAX_ATTEMPTS) {
        throw Object.assign(new Error(`下载安装包失败（${code}，已重试 ${attempt} 次）`), { code });
      }
      await sleep(timing.backoffMs[Math.min(attempt - 1, timing.backoffMs.length - 1)], signal);
    }
  }
}

// 下载到 part（可续传）并通过 sha512 校验；校验不符删掉从头重下一次，仍不符报「安装包校验失败」。
// 改名为正式文件名、失败时删 .part 与改写下载记录都由调用方负责。
export async function downloadDmgToPart({ url, part, fetchImpl, signal, sha512, onProgress }) {
  const { host, pathname } = new URL(url);
  const t0 = Date.now();
  const resumeFrom = await fileSize(part);
  console.log(`[update] 开始下载安装包：${host}${pathname}${resumeFrom ? `，从第 ${resumeFrom} 字节续传` : ''}`);
  for (let round = 1; ; round++) {
    await fetchWithRetry({ url, part, fetchImpl, signal, onProgress });
    if (!sha512) {
      console.warn('[update] 发布清单没有安装包的 sha512，跳过完整性校验');
      break;
    }
    if ((await sha512Base64(part, signal)) === sha512) break;
    await fsp.rm(part, { force: true });
    if (round >= 2) throw Object.assign(new Error('安装包校验失败'), { code: 'sha512-mismatch' });
    console.warn('[update] 安装包 sha512 与发布清单不符，删除后从头重下一次');
  }
  console.log(`[update] 安装包下载完成：${host}${pathname}，${await fileSize(part)} 字节，耗时 ${Date.now() - t0}ms`);
}
