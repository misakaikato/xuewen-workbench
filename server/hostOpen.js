// 「用系统默认应用打开本地路径」策略（可插拔，与 trash.js 同一桥接模式）：
// Electron 宿主注入 shell.openPath；独立 dev server 回退到平台 opener。
// revealInFolder：在系统文件管理器中定位文件（Finder / 资源管理器 / xdg-open）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

let handler = null;

export function setOpenHandler(fn) {
  handler = typeof fn === 'function' ? fn : null;
}

export async function hostOpenPath(absPath) {
  if (handler) {
    await handler(absPath);
    return;
  }
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', absPath] : [absPath];
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.unref();
    resolve(); // spawn 成功即视为已交付系统
  });
}

export async function revealInFolder(absPath) {
  let isDir = false;
  try {
    isDir = fs.statSync(absPath).isDirectory();
  } catch {
    throw new Error('路径不存在（可能已被移动或删除）');
  }
  let cmd;
  let args;
  if (process.platform === 'win32') {
    cmd = 'explorer.exe';
    args = isDir ? [absPath] : ['/select,' + absPath];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = isDir ? [absPath] : ['-R', absPath];
  } else {
    cmd = 'xdg-open';
    args = [isDir ? absPath : path.dirname(absPath)];
  }
  await new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    resolve();
  });
}
