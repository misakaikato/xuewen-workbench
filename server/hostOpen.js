// 「用系统默认应用打开本地路径」策略（可插拔，与 trash.js 同一桥接模式）：
// Electron 宿主注入 shell.openPath；独立 dev server 回退到平台 opener。
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
