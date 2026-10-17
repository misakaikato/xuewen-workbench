// DMG 后备打包器（不依赖 dmgbuild / Finder AppleScript）：
//   空白 RW 镜像 → 挂载 → cp 克隆 .app + Applications 软链 → force 弹出 → convert UDZO。
// 用途：
//   1) electron-builder 的 dmgbuild 在 macOS 升级后常因 Finder AppleScript 失效；
//      本脚本无 Finder 环节，作为后备可出"朴素窗口"DMG（拖拽安装不受影响）。
//   2) 先做 hdiutil 健康检查：本机 CoreSimulatorService（root 实例）卡死时，
//      DiskArbitration 拒绝一切非强制卸载（提示 "Simulators are still shutting down"），
//      此时任何工具都造不出 DMG——给出诊断与修复命令后退出。
// 详见 docs/ARCHITECTURE.md §9.2。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_NAME = 'Xuewen Workbench';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'ignore', opts.quiet ? 'ignore' : 'inherit'], ...opts });
}

// 健康检查：1MB 空白镜像走一遍 attach → 干净 detach
function hdiutilHealthy() {
  const probe = path.join(fs.mkdtempSync('/tmp/wb-probe-'), 'p.dmg');
  try {
    run('hdiutil', ['create', '-size', '1m', '-fs', 'HFS+', '-volname', 'WBPROBE', probe, '-ov'], { quiet: true });
    const out = execFileSync('hdiutil', ['attach', probe]).toString();
    const dev = (out.match(/^\/dev\/disk\d+/m) || [])[0];
    if (!dev) return false;
    try {
      run('hdiutil', ['detach', dev], { quiet: true });
      return true;
    } catch {
      run('hdiutil', ['detach', dev, '-force'], { quiet: true });
      return false;
    }
  } catch {
    return false;
  } finally {
    fs.rmSync(path.dirname(probe), { recursive: true, force: true });
  }
}

const appPath = path.join(ROOT, 'release', 'mac-arm64', `${APP_NAME}.app`);
if (!fs.existsSync(appPath)) {
  console.error(`未找到 ${appPath}，请先执行 npm run electron:build:mac（zip 产物）`);
  process.exit(1);
}

if (!hdiutilHealthy()) {
  console.error([
    '诊断：本机 hdiutil 磁盘协商被卡死（典型原因：root 属主的 CoreSimulatorService',
    '停在 "Simulators are still shutting down" 状态，拒绝一切非强制卸载；zip 打包不受影响）。',
    '修复（二选一，需要管理员密码）：',
    '  sudo pkill -f CoreSimulatorService   # 服务按需自动重启，运行时盘不受影响',
    '  或重启 Mac',
    '修复后重跑本脚本，或直接用 npm run electron:build:mac（dmgbuild 完整版）。',
  ].join('\n'));
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const outDmg = path.join(ROOT, 'release', `${APP_NAME}-${pkg.version}-arm64-mac.dmg`);
const tmp = fs.mkdtempSync('/tmp/wb-dmg-');
const rw = path.join(tmp, 'rw.dmg');
try {
  // 估算 RW 镜像容量：.app 实占 + Applications 条目 + 15% 余量
  const kb = Number(execFileSync('du', ['-sk', appPath]).toString().split('\t')[0]);
  const sizeMb = Math.ceil((kb * 1.15) / 1024) + 8;
  run('hdiutil', ['create', '-size', `${sizeMb}m`, '-fs', 'HFS+', '-volname', APP_NAME, rw, '-ov'], { quiet: true });
  const out = execFileSync('hdiutil', ['attach', rw]).toString();
  const dev = (out.match(/^\/dev\/disk\d+/m) || [])[0];
  const vol = path.join('/Volumes', APP_NAME);
  try {
    run('cp', ['-cR', appPath, path.join(vol, `${APP_NAME}.app`)]);
    fs.symlinkSync('/Applications', path.join(vol, 'Applications'));
    run('hdiutil', ['detach', dev, '-force'], { quiet: true });
  } catch (e) {
    try { run('hdiutil', ['detach', dev, '-force'], { quiet: true }); } catch { /* ignore */ }
    throw e;
  }
  if (fs.existsSync(outDmg)) fs.unlinkSync(outDmg);
  run('hdiutil', ['convert', rw, '-format', 'UDZO', '-o', outDmg, '-quiet']);
  const mb = (fs.statSync(outDmg).size / 1024 / 1024).toFixed(1);
  console.log(`DMG 已生成: ${outDmg} (${mb} MB)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
