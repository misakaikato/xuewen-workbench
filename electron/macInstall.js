// macOS 自动安装（未签名场景）的实现件：预检、准备（挂载/校验/复制/验签）、派发退出后的替换脚本。
// 不 import electron：app 相关值由 updater.js 注入，本模块可在 node 下被 scripts/test-mac-install.mjs 直接驱动。
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const COPY_POLL_MS = 500; // 复制期间的进度采样周期

function run(cmd, args, opts = {}) {
  return execFileP(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...opts });
}

// 读 bundle 的 Info.plist 键值（plutil raw 输出）
export async function readPlistValue(appPath, key) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const { stdout } = await run('plutil', ['-extract', key, 'raw', '-o', '-', plist]);
  return stdout.trim();
}

// 预检：execPath 推出当前 .app 路径；不能自动替换时返回 manual + 原因。
// manual 原因（枚举）：app-translocation（Gatekeeper 随机只读目录）、on-dmg-volume（还在安装包卷里）、
// dir-not-writable / bundle-not-writable（父目录或 bundle 本身不可写，含「App 管理」拦截的可能）。
export async function macInstallTarget(execPath) {
  const m = /^(.*?\.app)\/Contents\//.exec(execPath);
  if (!m) return { mode: 'manual', reason: 'not-in-bundle' };
  const target = m[1];
  if (target.includes('/AppTranslocation/')) return { mode: 'manual', reason: 'app-translocation' };
  if (target.startsWith('/Volumes/')) return { mode: 'manual', reason: 'on-dmg-volume' };
  try {
    await fsp.access(path.dirname(target), fs.constants.W_OK);
  } catch {
    return { mode: 'manual', reason: 'dir-not-writable' };
  }
  try {
    await fsp.access(target, fs.constants.W_OK);
  } catch {
    return { mode: 'manual', reason: 'bundle-not-writable' };
  }
  return { mode: 'auto', target };
}

// 统计目录内普通文件总字节数（lstat，符号链接不计）
async function treeBytes(root) {
  let total = 0;
  async function walk(p) {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) return;
    if (st.isFile()) {
      total += st.size;
      return;
    }
    if (st.isDirectory()) {
      for (const name of await fsp.readdir(p)) await walk(path.join(p, name));
    }
  }
  await walk(root);
  return total;
}

// ditto 复制并周期性汇报进度（统计方式不精确，但单调不减，结束时为 100）
async function dittoWithProgress(src, dest, total, onProgress) {
  const child = spawn('ditto', [src, dest], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr = (stderr + String(d)).slice(-4000);
  });
  let done = 0;
  const report = (transferred) => {
    done = Math.max(done, transferred); // 单调不减
    const percent = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0;
    onProgress?.({ percent, transferred: done, total });
  };
  report(0);
  let sampling = false; // 上一次遍历未结束就跳过本次采样（大 bundle 遍历可能超过采样周期）
  const timer = setInterval(() => {
    if (sampling) return;
    sampling = true;
    treeBytes(dest).then(report).catch(() => { /* 目标尚未创建 */ }).finally(() => { sampling = false; });
  }, COPY_POLL_MS);
  try {
    const code = await new Promise((resolve) => child.on('close', resolve));
    if (code !== 0) {
      const tail = stderr.trim().split('\n').pop() || `ditto 退出码 ${code}`;
      throw new Error('复制新版本失败：' + tail);
    }
    report(total);
    onProgress?.({ percent: 100, transferred: total, total });
  } finally {
    clearInterval(timer);
  }
}

// 准备阶段：挂载 DMG → 校验 bundle id 与版本 → 复制到 staging → 完整性/签名校验。
// 任何一步失败都会清理 staging 并（finally）卸载挂载点；由调用方决定状态机如何呈现。
export async function prepareMacUpdate({ dmgPath, expectedVersion, expectedBundleId, stagingDir, onPhase, onProgress }) {
  const mountPoint = await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-dmg-'));
  let attached = false;
  let srcTotal = 0; // 源 bundle 普通文件总字节数，verifying 阶段对账用
  try {
    onPhase?.('preparing');
    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountPoint, dmgPath]);
    attached = true;
    const names = (await fsp.readdir(mountPoint)).filter((n) => n.endsWith('.app'));
    if (names.length !== 1) throw new Error('安装包与当前应用不匹配');
    const src = path.join(mountPoint, names[0]);
    const bundleId = await readPlistValue(src, 'CFBundleIdentifier');
    if (bundleId !== expectedBundleId) throw new Error('安装包与当前应用不匹配');
    const version = await readPlistValue(src, 'CFBundleShortVersionString');
    if (version !== expectedVersion) throw new Error('安装包与当前应用不匹配');

    onPhase?.('copying');
    await fsp.rm(stagingDir, { recursive: true, force: true });
    await fsp.mkdir(stagingDir, { recursive: true });
    srcTotal = await treeBytes(src);
    const staged = path.join(stagingDir, names[0]);
    await dittoWithProgress(src, staged, srcTotal, onProgress);

    onPhase?.('verifying');
    // 完整性对账：staged 与源的普通文件总字节数应一致（符号链接不计入，ditto 原样保留）
    const stagedBytes = await treeBytes(staged);
    if (stagedBytes !== srcTotal) throw new Error('复制后的新版本校验未通过');
    // 签名验证：当前 mac 包未签名（build.identity 为 null），只对带 _CodeSignature 的 bundle 验签；
    // 未签名时上面的字节对账 + 下面的版本复核就是替代校验
    const signed = await fsp.access(path.join(staged, 'Contents', '_CodeSignature', 'CodeResources')).then(() => true).catch(() => false);
    if (signed) await run('codesign', ['--verify', '--deep', staged]);
    const stagedVersion = await readPlistValue(staged, 'CFBundleShortVersionString');
    if (stagedVersion !== expectedVersion) throw new Error('复制后的新版本校验未通过');
    return { staged };
  } catch (e) {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  } finally {
    if (attached) {
      try {
        await run('hdiutil', ['detach', mountPoint]);
      } catch {
        await run('hdiutil', ['detach', '-force', mountPoint]).catch(() => {});
      }
    }
    await fsp.rm(mountPoint, { recursive: true, force: true }).catch(() => {});
  }
}

// 派发替换脚本：脚本从 asar 拷出、写待完成记录、detached 启动（不等应用退出）。
// env 显式构造：WB_MAC_INSTALL_NO_OPEN 只属于测试，绝不从用户环境继承。
export async function launchMacSwap({ pid, staged, target, dmgPath, fromVersion, toVersion, updatesDir, logsDir, scriptSrc, writePending }) {
  await fsp.mkdir(updatesDir, { recursive: true });
  await fsp.mkdir(logsDir, { recursive: true });
  const scriptDest = path.join(updatesDir, 'mac-install.sh');
  // 不用 copyFile：Electron 对 asar 的补丁不保证覆盖 fs.promises.copyFile；
  // 读 asar 内文件（readFile）是明确支持的路径
  const scriptContent = await fsp.readFile(scriptSrc);
  await fsp.writeFile(scriptDest, scriptContent);
  await fsp.chmod(scriptDest, 0o755);
  await writePending(updatesDir, { fromVersion, toVersion, dmgPath });

  const resultPath = path.join(updatesDir, 'install-result.json');
  await fsp.rm(resultPath, { force: true }).catch(() => {});
  const logFile = path.join(logsDir, 'mac-install.log');
  const logFd = fs.openSync(logFile, 'a'); // stdio 需要 fd；spawn 返回后子进程已持有副本
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME || os.homedir(),
    TMPDIR: process.env.TMPDIR,
  };
  delete env.WB_MAC_INSTALL_NO_OPEN; // 防御：测试开关不得进入产品派发路径
  const child = spawn('/bin/sh', [scriptDest, String(pid), staged, target, resultPath, dmgPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  });
  child.unref();
  fs.closeSync(logFd);
  return { script: scriptDest, resultFile: resultPath, logFile };
}
