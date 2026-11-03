// 测试脚本的临时目录：在系统临时目录下创建并登记，进程以任何方式结束时删除
// （正常结束、process.exit、断言失败抛错、SIGINT/SIGTERM——如 shell timeout）。
// atExit 登记的收尾动作（如杀掉子进程后端）先于删除执行，避免子进程在删除后又写回目录。
// Electron 主进程里信号由 Chromium 接管、不走 Node 信号处理，改由 will-quit 收尾。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dirs = new Set();
const hooks = [];

export function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.add(dir);
  return dir;
}

export function atExit(fn) {
  hooks.push(fn);
}

export function cleanupTmpDirs() {
  for (const fn of hooks.splice(0)) {
    try {
      fn();
    } catch (e) {
      console.error('[tmpdirs] 收尾动作失败:', e.message);
    }
  }
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.error('[tmpdirs] 删除临时目录失败:', dir, e.message);
    }
  }
  dirs.clear();
}

process.on('exit', cleanupTmpDirs);
if (process.versions.electron) {
  const { app } = await import('electron');
  app.on('will-quit', cleanupTmpDirs);
} else {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.on(sig, () => process.exit(code));
  }
}
