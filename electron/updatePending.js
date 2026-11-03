// 跨重启安装记录的落盘位置与读写（路径由调用方给定，不 import electron，便于测试复用）。
// pending.json：install() 与下载完成时写入，标记「有一场安装正在进行」；
// install-result.json：mac-install.sh 在退出后写入替换结果。
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

export function pendingFile(updatesDir) {
  return path.join(updatesDir, 'pending.json');
}

export function resultFile(updatesDir) {
  return path.join(updatesDir, 'install-result.json');
}

export async function writePending(updatesDir, rec) {
  await fsp.mkdir(updatesDir, { recursive: true });
  await fsp.writeFile(pendingFile(updatesDir), JSON.stringify({ ...rec, at: new Date().toISOString() }));
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
