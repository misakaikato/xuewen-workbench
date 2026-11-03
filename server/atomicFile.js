// 原子写与损坏文件保留：先写临时文件再改名，读写中断不留半截目标文件。
// 本模块没有模块级副作用（不定位数据目录），诊断模块与测试脚本可直接导入。
import fs from 'node:fs';
import path from 'node:path';

// Windows 上目标文件被占用时 rename 会抛 EPERM/EACCES/EBUSY，两个版本按同一尝试次数重试：
// 异步版每次失败后按退避表等待（不占事件循环）；同步版只供低频配置写入，立即重试、不等待。
// 最终仍失败时由调用方删除临时文件。
const RENAME_RETRY_BACKOFF = [50, 100, 200, 400, 800];
const RENAME_ATTEMPTS = RENAME_RETRY_BACKOFF.length + 1;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// 改名失败 WARN：同一目标路径每分钟最多一条
const RENAME_WARN_INTERVAL_MS = 60000;
const renameWarnAt = new Map(); // 目标路径 -> 上次 WARN 时间戳
function warnRenameFailure(e, to, attempt) {
  const now = Date.now();
  if (now - (renameWarnAt.get(to) || 0) < RENAME_WARN_INTERVAL_MS) return;
  if (renameWarnAt.size >= 1000) {
    for (const [k, t] of renameWarnAt) if (now - t >= RENAME_WARN_INTERVAL_MS) renameWarnAt.delete(k);
  }
  renameWarnAt.set(to, now);
  console.warn(`[store] 改名失败 ${e.code || e.message}：${to}（第 ${attempt}/${RENAME_ATTEMPTS} 次尝试）`);
}

export function renameWithRetry(from, to) {
  let lastErr;
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      warnRenameFailure(e, to, attempt);
      if (!RENAME_RETRY_CODES.has(e.code)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function renameWithRetryAsync(from, to) {
  let lastErr;
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (e) {
      warnRenameFailure(e, to, attempt);
      if (!RENAME_RETRY_CODES.has(e.code)) throw e;
      lastErr = e;
      if (attempt < RENAME_ATTEMPTS) await new Promise((r) => setTimeout(r, RENAME_RETRY_BACKOFF[attempt - 1]));
    }
  }
  throw lastErr;
}

// 临时文件名带进程内序号：同一目标的并发异步写入各用各的临时文件
let tmpSeq = 0;
export function tmpPathFor(file, tag = '.tmp-') {
  return file + tag + process.pid + '-' + ++tmpSeq;
}

// 同步原子写（低频配置用）：改名因占用失败且目标已存在时，退回覆盖写入目标（非原子）；
// 覆盖也失败才抛错。临时文件无论成败都删除。
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpPathFor(file);
  fs.writeFileSync(tmp, data, 'utf8');
  try {
    renameWithRetry(tmp, file);
  } catch (e) {
    let err = e;
    if (RENAME_RETRY_CODES.has(e.code) && fs.existsSync(file)) {
      try {
        fs.copyFileSync(tmp, file);
        err = null;
      } catch (ce) {
        err = ce;
      }
    }
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    if (err) throw err;
  }
}

// 异步原子写（热路径用）：写临时文件后改名；改名最终失败则删临时文件并抛错
export async function writeFileAtomicAsync(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpPathFor(file);
  await fs.promises.writeFile(tmp, data, 'utf8');
  try {
    await renameWithRetryAsync(tmp, file);
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => { /* 忽略 */ });
    throw e;
  }
}

export function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2));
}

export async function writeJsonAtomicAsync(file, obj) {
  await writeFileAtomicAsync(file, JSON.stringify(obj, null, 2));
}

// 解析失败的用户数据文件改名为 <原名>.corrupt-<时间戳> 保留，返回新路径；改名失败抛错，
// 调用方不得在保留成功之前覆盖原文件。
export function preserveCorrupt(file) {
  const to = `${file}.corrupt-${Date.now()}`;
  renameWithRetry(file, to);
  return to;
}
