// 跨重启更新记录的落盘位置与读写（路径由调用方给定，不 import electron，便于测试复用）。
// pending.json：install() 与下载完成时写入，标记「有一场安装正在进行」；
// install-result.json：mac-install.sh 在退出后写入替换结果；
// downloads.json：应用下载过的 DMG 与 .part（路径、版本、时间），清理只针对这份记录里的文件。
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

export function pendingFile(updatesDir) {
  return path.join(updatesDir, 'pending.json');
}

export function resultFile(updatesDir) {
  return path.join(updatesDir, 'install-result.json');
}

export function downloadsFile(updatesDir) {
  return path.join(updatesDir, 'downloads.json');
}

let tmpSeq = 0;

// 原子写：先写同目录临时文件并落盘，再改名覆盖；中途失败删除临时文件
export async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}`;
  try {
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(JSON.stringify(value));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export async function writePending(updatesDir, rec) {
  await writeJsonAtomic(pendingFile(updatesDir), { ...rec, at: new Date().toISOString() });
}

export async function clearInstallFiles(updatesDir) {
  await fsp.rm(pendingFile(updatesDir), { force: true }).catch(() => {});
  await fsp.rm(resultFile(updatesDir), { force: true }).catch(() => {});
}

// 启动早期的同步读（小 JSON，与 readPublishConfig 同口径）；缺失返回 null
export function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 下载记录：只保留结构合法的条目 { path, version, at }
export function readDownloads(updatesDir) {
  const list = readJsonIfExists(downloadsFile(updatesDir));
  if (!Array.isArray(list)) return [];
  return list.filter((r) => r && typeof r.path === 'string' && path.isAbsolute(r.path) && typeof r.version === 'string');
}

// 串行改写下载记录：mutate 拿到当前列表（可在其中增删文件），返回新列表后原子写回
let downloadsChain = Promise.resolve();
export function updateDownloads(updatesDir, mutate) {
  const run = downloadsChain.then(async () => {
    const next = await mutate(readDownloads(updatesDir));
    await writeJsonAtomic(downloadsFile(updatesDir), next);
    return next;
  });
  downloadsChain = run.catch(() => {});
  return run;
}
