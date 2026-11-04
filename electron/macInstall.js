// macOS 自动安装（未签名场景）的实现件：预检、准备（挂载/校验/复制到目标同目录/验签）、派发退出后的替换脚本、
// 启动时清理上次中断的残留（挂载点、目标同目录的 .new-*、旧版本遗留的 staging）。
// 不 import electron：app 相关值由 updater.js 注入，本模块可在 node 下被 scripts/test-mac-install.mjs 直接驱动。
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const COPY_POLL_MS = 500; // 复制期间的进度采样周期
const MOUNT_PREFIX = 'wb-dmg-'; // 本应用在 $TMPDIR 下的私有挂载点目录名前缀

function run(cmd, args, opts = {}) {
  return execFileP(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...opts });
}

function abortedError() {
  return Object.assign(new Error('准备已中止'), { aborted: true });
}

// execPath 所在的 .app 路径；不在 .app 结构中返回 null
export function appBundlePath(execPath) {
  const m = /^(.*?\.app)\/Contents\//.exec(execPath);
  return m ? m[1] : null;
}

// 替换用的目标同目录隐藏名（与目标同卷）：.<名>.new-<ts> 为放准备好的新版本的目录，.<名>.old-<ts> 为旧版备份
export function swapSidePath(target, kind, stamp = Date.now()) {
  return path.join(path.dirname(target), `.${path.basename(target)}.${kind}-${stamp}`);
}

// 严格匹配本应用的替换隐藏名：与目标同目录，名字为 .<目标名>.<kind>-<数字>
export function isSwapSidePath(p, target, kind) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || path.dirname(p) !== path.dirname(target)) return false;
  const prefix = `.${path.basename(target)}.${kind}-`;
  const name = path.basename(p);
  return name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length));
}

// 命令失败时取 stderr 最后一行（如「hdiutil: attach failed - 资源忙」）
function lastLine(e) {
  const lines = String(e?.stderr || e?.message || e).trim().split('\n').filter((l) => l.trim());
  return lines[lines.length - 1] || String(e);
}

// 当前挂着的镜像：hdiutil info -plist 经 plutil 转 JSON → [{ imagePath, device, mountPoints }]
async function listAttachedImages() {
  const { stdout } = await run('/bin/sh', ['-c', 'hdiutil info -plist | plutil -convert json -o - -']);
  const info = JSON.parse(stdout);
  return (Array.isArray(info?.images) ? info.images : []).map((img) => {
    const ents = Array.isArray(img['system-entities']) ? img['system-entities'] : [];
    const devs = ents.map((e) => e?.['dev-entry']).filter((d) => typeof d === 'string');
    return {
      imagePath: typeof img['image-path'] === 'string' ? img['image-path'] : '',
      // 镜像自身的整盘设备排在最前（其后可能还有 APFS 合成盘），卸载它连带所有分区与卷
      device: devs.find((d) => /^\/dev\/disk\d+$/.test(d)) || null,
      mountPoints: ents.map((e) => e?.['mount-point']).filter((m) => typeof m === 'string'),
    };
  });
}

function tmpRoots() {
  const roots = new Set([os.tmpdir()]);
  try { roots.add(fs.realpathSync(os.tmpdir())); } catch { /* 保留原值 */ }
  return roots;
}

function isOwnMountPoint(mp, roots) {
  return path.basename(mp).startsWith(MOUNT_PREFIX) && roots.has(path.dirname(mp));
}

// 卸载一个镜像：先普通 detach；本应用私有挂载点忙时再 -force 一次。
// 挂在别处（如用户在 Finder 里打开着）的不强制，忙说明有人正在用
async function detachImage(img, own) {
  const target = img.device || img.mountPoints[0];
  if (!target) return false;
  try {
    await run('hdiutil', ['detach', target]);
    return true;
  } catch (e) {
    if (!own) {
      console.warn(`[mac-install] 卸载 ${target} 失败：${lastLine(e)}`);
      return false;
    }
  }
  try {
    await run('hdiutil', ['detach', '-force', target]);
    return true;
  } catch (e) {
    console.warn(`[mac-install] 强制卸载 ${target} 失败：${lastLine(e)}`);
    return false;
  }
}

// 卸载镜像路径在 imagePaths 里的挂载；includeOwnMounts 时连同 $TMPDIR/wb-dmg-* 下的挂载一并卸载
async function detachMatching(imagePaths, includeOwnMounts) {
  let images;
  try {
    images = await listAttachedImages();
  } catch (e) {
    console.warn('[mac-install] 读取挂载列表失败：' + lastLine(e));
    return;
  }
  const wanted = new Set();
  for (const p of imagePaths) {
    wanted.add(p);
    try { wanted.add(await fsp.realpath(p)); } catch { /* 文件已不在 */ }
  }
  const roots = tmpRoots();
  for (const img of images) {
    const own = img.mountPoints.some((mp) => isOwnMountPoint(mp, roots));
    if (!(includeOwnMounts && own) && !wanted.has(img.imagePath)) continue;
    console.log(`[mac-install] 卸载残留挂载：${img.imagePath}（${img.mountPoints.join(', ') || img.device}）`);
    await detachImage(img, own);
  }
}

// 独立进程收尾：卸载（忙时 1 秒后 -force）、删空挂载点目录、删半截的新版本目录；应用退出后仍会完成
function detachInBackground(mountPoint, stagingDir) {
  const script = 'hdiutil detach "$1" >/dev/null 2>&1 || { sleep 1; hdiutil detach -force "$1" >/dev/null 2>&1; }; ' +
    'rmdir "$1" 2>/dev/null; rm -rf "$2"; exit 0';
  try {
    const p = spawn('/bin/sh', ['-c', script, 'wb-detach', mountPoint, stagingDir], { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch { /* 下次启动的清理兜底 */ }
}

async function removeLeftover(p, what) {
  try {
    if (fs.existsSync(p)) {
      await fsp.rm(p, { recursive: true, force: true });
      console.log(`[mac-install] 删除残留的${what}：${p}`);
    }
  } catch (e) {
    console.warn(`[mac-install] 删除残留的${what}失败：${p}，${e?.message || e}`);
  }
}

// 启动时清理上次中断的残留（不抛错，失败只记日志）：
// 卸载下载记录里的安装包与 $TMPDIR/wb-dmg-* 下的挂载；没有安装在进行时，删除 appPath 同目录下
// 严格匹配 .<名>.new-<数字> 的新版本目录，以及旧版本遗留的 updates/staging；删除空的 wb-dmg-* 目录
export async function cleanupMacLeftovers({ stagingDir = null, appPath = null, imagePaths = [], isInstalling = () => false }) {
  await detachMatching(imagePaths, true);
  if (!isInstalling()) {
    if (appPath) {
      const dir = path.dirname(appPath);
      let names = [];
      try { names = await fsp.readdir(dir); } catch { /* 目录读不到就跳过 */ }
      for (const name of names) {
        const p = path.join(dir, name);
        if (isSwapSidePath(p, appPath, 'new')) await removeLeftover(p, '新版本目录');
      }
    }
    if (stagingDir) await removeLeftover(stagingDir, ' staging');
  }
  let names = [];
  try { names = await fsp.readdir(os.tmpdir()); } catch { /* 读不到就跳过 */ }
  for (const name of names) {
    if (name.startsWith(MOUNT_PREFIX)) await fsp.rmdir(path.join(os.tmpdir(), name)).catch(() => {}); // 只删空目录
  }
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
  const target = appBundlePath(execPath);
  if (!target) return { mode: 'manual', reason: 'not-in-bundle' };
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

// ditto 复制并周期性汇报进度（统计方式不精确，但单调不减，结束时为 100）；signal 中止时结束 ditto
async function dittoWithProgress(src, dest, total, onProgress, signal) {
  if (signal?.aborted) throw abortedError();
  const child = spawn('ditto', [src, dest], { stdio: ['ignore', 'pipe', 'pipe'] });
  const onAbort = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', onAbort, { once: true });
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
    if (signal?.aborted) throw abortedError();
    if (code !== 0) {
      const tail = stderr.trim().split('\n').pop() || `ditto 退出码 ${code}`;
      throw new Error('复制新版本失败：' + tail);
    }
    report(total);
    onProgress?.({ percent: 100, transferred: total, total });
  } finally {
    clearInterval(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// 准备阶段：挂载 DMG → 校验 bundle id 与版本 → 复制到 stagingDir/<名>.app → 完整性/签名校验。
// 产品里 stagingDir 是目标同目录的隐藏目录 .<名>.new-<ts>（swapSidePath，与目标同卷），退出后的替换脚本
// 只需改名；bundle 在其中保持原名（以 .app 结尾，codesign 验签依赖这一点）。
// 任何一步失败都会删除 stagingDir 并（finally）卸载挂载点；由调用方决定状态机如何呈现。
// signal 中止（应用退出）时结束 ditto，卸载与删除 stagingDir 交给独立进程，应用退出后也不残留。
export async function prepareMacUpdate({ dmgPath, expectedVersion, expectedBundleId, stagingDir, onPhase, onProgress, signal }) {
  const mountPoint = await fsp.mkdtemp(path.join(os.tmpdir(), MOUNT_PREFIX));
  let attached = false;
  let detachHandedOff = false; // 卸载已交给独立进程
  const onAbort = () => {
    if (!attached) return; // 挂载尚未完成：挂载返回后的中止检查会抛错，由 finally 卸载
    detachHandedOff = true;
    detachInBackground(mountPoint, stagingDir);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const checkAborted = () => {
    if (signal?.aborted) throw abortedError();
  };
  let srcTotal = 0; // 源 bundle 普通文件总字节数，verifying 阶段对账用
  try {
    onPhase?.('preparing');
    // 同一镜像已经挂着（上次中断的残留，或在 Finder 里打开着）时再挂会报「资源忙」：先卸载
    await detachMatching([dmgPath], false);
    checkAborted();
    try {
      await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountPoint, dmgPath]);
    } catch (e) {
      throw new Error('挂载安装包失败：' + lastLine(e));
    }
    attached = true;
    checkAborted();
    const names = (await fsp.readdir(mountPoint)).filter((n) => n.endsWith('.app'));
    if (names.length !== 1) throw new Error('安装包与当前应用不匹配');
    const src = path.join(mountPoint, names[0]);
    const bundleId = await readPlistValue(src, 'CFBundleIdentifier');
    if (bundleId !== expectedBundleId) throw new Error('安装包与当前应用不匹配');
    const version = await readPlistValue(src, 'CFBundleShortVersionString');
    if (version !== expectedVersion) throw new Error('安装包与当前应用不匹配');

    checkAborted();
    onPhase?.('copying');
    await fsp.rm(stagingDir, { recursive: true, force: true });
    await fsp.mkdir(stagingDir, { recursive: true });
    srcTotal = await treeBytes(src);
    const staged = path.join(stagingDir, names[0]);
    await dittoWithProgress(src, staged, srcTotal, onProgress, signal);

    checkAborted();
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
    signal?.removeEventListener('abort', onAbort);
    if (!detachHandedOff) {
      if (attached) {
        try {
          await run('hdiutil', ['detach', mountPoint]);
        } catch {
          await run('hdiutil', ['detach', '-force', mountPoint]).catch(() => {});
        }
      }
      await fsp.rmdir(mountPoint).catch(() => {}); // 只删空目录：卸载失败时不会去动镜像里的内容
    }
  }
}

// 派发替换脚本：脚本从 asar 拷出、写待完成记录（含备份路径，启动时可补删）、detached 启动（不等应用退出）。
// staged 是准备阶段已放在目标同目录 .<名>.new-<ts>/ 里的新版本；备份名 .<名>.old-<ts> 也在目标同目录，脚本只做同卷改名。
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
  const backup = swapSidePath(target, 'old');
  await writePending(updatesDir, { fromVersion, toVersion, dmgPath, backupPath: backup });

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
  const child = spawn('/bin/sh', [scriptDest, String(pid), staged, target, resultPath, dmgPath, backup], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  });
  child.unref();
  fs.closeSync(logFd);
  return { script: scriptDest, resultFile: resultPath, logFile };
}
