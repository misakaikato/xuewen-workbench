// 自动更新桥（仅在打包模式下由 main.js 创建注入，见 server/update.js 的桥接约定）：
// - Windows：electron-updater 检查/下载；安装 = 非静默 quitAndInstall(false, true)，
//   安装器显示进度窗口，装完自动重开（build/installer.nsh 控制升级时的页面流）。
// - macOS（未签名）：electron-updater 只做检查；下载自取发布源的 DMG；
//   自动安装 = 应用内准备（挂载/校验/复制/验签，带进度）+ 退出后由 mac-install.sh
//   替换并重开；预检不可自动替换（DMG 卷 / AppTranslocation / 目录不可写）时回退手动拖拽。
import { app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { macInstallTarget, prepareMacUpdate, launchMacSwap, readPlistValue } from './macInstall.js';
import { consumeInstallOutcome } from './updateOutcome.js';
import { pendingFile, resultFile, writePending, clearInstallFiles, readJsonIfExists } from './updatePending.js';

const FIRST_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30_000;
const INSTALLER_LAUNCH_DELAY_MS = 1200; // 让「正在启动安装程序 / 即将重启」先显示出来
const APP_DIR = path.dirname(fileURLToPath(import.meta.url)); // 本文件所在目录（electron/）

let autoUpdater = null;
let CancellationToken = null;
let publishCfg = null; // { provider:'github', owner, repo } | { provider:'generic', url }，来自打包产物 resources/app-update.yml
let st = newState(false);
let dmgInfo = null; // { filePath, version } macOS 已下载的安装包
let macTarget = null; // 预检结果 { mode:'auto', target } | { mode:'manual', reason }
let logsDirValue = null; // 主进程日志目录（mac-install.log 落这里，诊断包可带上）
let checkTimer = null;
let intervalTimer = null;
let settleCheck = null; // check() 的 settle 回调（一次性）
let dmgAbort = null; // mac 下载的 AbortController（取消用）
let winCancelToken = null; // Windows 下载的 CancellationToken（取消用）
let cancelled = false; // 本次下载是否被用户取消（取消回 available，失败进 error）
let busy = () => ['checking', 'downloading', 'ready', 'installing'].includes(st.status);

function newState(enabled) {
  return {
    enabled, status: 'idle', currentVersion: app.getVersion(), info: null, progress: null, error: null,
    phase: null, canCancel: false, installMode: null, installModeReason: null, lastInstall: null,
  };
}

function setState(patch) {
  st = { ...st, ...patch };
  if (['available', 'not-available', 'error'].includes(st.status) && settleCheck) {
    const fn = settleCheck;
    settleCheck = null;
    fn();
  }
}

function updatesDir() {
  return path.join(app.getPath('userData'), 'updates');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 启动时消费跨重启的安装记录（updateOutcome 判定规则）：刚更新成功 / 上次失败 / 用户取消（保留不提示）
function consumeInstallFiles() {
  const dir = updatesDir();
  const pending = readJsonIfExists(pendingFile(dir));
  const result = readJsonIfExists(resultFile(dir));
  if (!pending && !result) return;
  const outcome = consumeInstallOutcome({ currentVersion: app.getVersion(), pending, result });
  if (outcome.lastInstall) st = { ...st, lastInstall: outcome.lastInstall };
  if (outcome.clear) void clearInstallFiles(dir);
}

// 解析 resources/app-update.yml（扁平键值，electron-builder 生成）里的发布源坐标：
// github（owner/repo）或 generic（url，DMG 地址为 <url>/<dmgFileName>）
function readPublishConfig() {
  try {
    const file = path.join(process.resourcesPath, 'app-update.yml');
    const map = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^(\w[\w-]*):\s*(\S+)\s*$/);
      if (m) map[m[1]] = m[2];
    }
    if (map.provider === 'github' && map.owner && map.repo) return { provider: 'github', owner: map.owner, repo: map.repo };
    if (map.provider === 'generic' && map.url) return { provider: 'generic', url: map.url.replace(/\/+$/, '') };
  } catch { /* 未配置 publish 或文件缺失 */ }
  return null;
}

// update-available 时从 UpdateInfo.files（即 latest-mac.yml 的文件清单）记住 DMG 文件名：
// 下载 URL 直接拼 <base>/v<tag>/<file>；github 走资产通道，不调 api.github.com——
// 未认证请求限流 60 次/小时/IP，用户点下载时极易撞上 403
let dmgFileName = null;

async function releaseDmgUrl(version) {
  if (!publishCfg) throw new Error('缺少发布配置（app-update.yml）');
  if (publishCfg.provider === 'generic') {
    if (!dmgFileName) throw new Error('发布源清单缺少 DMG 文件名');
    return `${publishCfg.url}/${encodeURIComponent(dmgFileName)}`;
  }
  if (dmgFileName) {
    return `https://github.com/${publishCfg.owner}/${publishCfg.repo}/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(dmgFileName)}`;
  }
  // 回退：files 缺失（异常清单）时才查 API
  const tag = encodeURIComponent(`v${version}`);
  const api = `https://api.github.com/repos/${publishCfg.owner}/${publishCfg.repo}/releases/tags/${tag}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(api, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'xuewen-workbench-updater' }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`查询发布资产失败 (${r.status})`);
    const rel = await r.json();
    const assets = (rel.assets || []).filter((a) => a.name.endsWith('.dmg'));
    const hit = assets.find((a) => a.name.includes(`-${process.arch}`)) || assets[0];
    if (!hit) throw new Error('该版本没有 DMG 资产');
    return hit.browser_download_url;
  } finally {
    clearTimeout(timer);
  }
}

// macOS：自下载 DMG（全量，无差量——差量仅 electron-updater 的 zip/exe 路径可用）。
// 可被 AbortController 取消；下载完成时写待完成记录并做自动安装预检。
async function downloadDmg(version) {
  const url = await releaseDmgUrl(version);
  const dir = (() => {
    try { return app.getPath('downloads'); } catch { return path.join(app.getPath('userData'), 'updates'); }
  })();
  await fs.promises.mkdir(dir, { recursive: true });
  const fileName = decodeURIComponent(url.split('/').pop());
  const filePath = path.join(dir, fileName);
  const ctrl = new AbortController();
  dmgAbort = ctrl;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`下载安装包失败 (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(filePath);
    let transferred = 0;
    let lastTick = 0;
    let lastBytes = 0;
    setState({ progress: { percent: 0, transferred: 0, total, bytesPerSecond: 0, etaSeconds: null } });
    for await (const chunk of res.body) {
      out.write(chunk);
      transferred += chunk.length;
      const now = Date.now();
      if (now - lastTick > 250 || transferred === total) {
        const dt = (now - lastTick) / 1000;
        const bps = dt > 0 ? Math.round((transferred - lastBytes) / dt) : 0;
        setState({
          progress: {
            percent: total ? Math.round((transferred / total) * 100) : 0,
            transferred, total, bytesPerSecond: bps,
            etaSeconds: total && bps > 0 ? Math.round((total - transferred) / bps) : null,
          },
        });
        lastTick = now;
        lastBytes = transferred;
      }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    dmgInfo = { filePath, version };
    macTarget = await macInstallTarget(process.execPath); // 预检结果决定 ready 的安装模式
    setState({
      status: 'ready', progress: null, error: null, canCancel: false,
      installMode: macTarget.mode,
      installModeReason: macTarget.mode === 'manual' ? macTarget.reason : null,
    });
    // 下载后直接退出、退出时自动安装的路径也要能提示，这里就写待完成记录
    await writePending(updatesDir(), { fromVersion: st.currentVersion, toVersion: version, dmgPath: filePath });
  } catch (e) {
    try { await fs.promises.unlink(filePath); } catch { /* 半截文件可能尚未创建 */ }
    throw e;
  } finally {
    dmgAbort = null;
  }
}

// 定时检查：跳过进行中的流程；ui-settings.autoUpdate 关闭时只静默跳过（手动检查不受影响）
async function scheduledCheck({ getUiSettings }) {
  if (busy()) return;
  try {
    if (getUiSettings().autoUpdate === false) return;
  } catch { /* 设置读取失败不阻断检查 */ }
  try { await doCheck(); } catch { /* 错误已进入 state，勿抛 */ }
}

function doCheck() {
  return new Promise((resolve) => {
    settleCheck = resolve;
    setState({ status: 'checking', error: null });
    autoUpdater.checkForUpdates().catch((e) => {
      setState({ status: 'error', error: String(e?.message || e) });
    });
    setTimeout(() => { if (settleCheck) { const fn = settleCheck; settleCheck = null; fn(); } }, CHECK_TIMEOUT_MS);
  });
}

// mac 自动安装：应用内准备（进度进状态机），成功后派发替换脚本再退出；失败不退出、回退手动
async function installMacAuto() {
  const { filePath: dmgPath, version } = dmgInfo;
  try {
    const bundleId = await readPlistValue(macTarget.target, 'CFBundleIdentifier');
    const { staged } = await prepareMacUpdate({
      dmgPath,
      expectedVersion: version,
      expectedBundleId: bundleId,
      stagingDir: path.join(updatesDir(), 'staging'),
      onPhase: (phase) => setState({ status: 'installing', phase, error: null }),
      onProgress: (p) => setState({ progress: { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: 0, etaSeconds: null } }),
    });
    await launchMacSwap({
      pid: process.pid,
      staged,
      target: macTarget.target,
      dmgPath,
      fromVersion: st.currentVersion,
      toVersion: version,
      updatesDir: updatesDir(),
      logsDir: logsDirValue || path.join(app.getPath('userData'), 'logs'),
      scriptSrc: path.join(APP_DIR, 'mac-install.sh'),
      writePending,
    });
  } catch (e) {
    // 准备失败：DMG 仍就绪，交回手动安装（保持 ready，界面在此状态下展示 error 作为原因）
    setState({ status: 'ready', phase: null, progress: null, error: String(e?.message || e), installMode: 'manual', installModeReason: 'prepare-failed' });
    return { ok: false, error: String(e?.message || e) };
  }
  setState({ status: 'installing', phase: 'restarting', error: null });
  await delay(INSTALLER_LAUNCH_DELAY_MS);
  app.quit();
  return { ok: true };
}

export async function createUpdaterBridge({ getUiSettings, logsDir }) {
  publishCfg = readPublishConfig();
  st = newState(true);
  logsDirValue = logsDir || null;
  consumeInstallFiles(); // 最早的启动提示来源：上次安装的结果

  // electron-updater 是 CJS 包：asar 内 ESM 动态 import 的命名导出探测不可靠
  // （autoUpdater 拿到 undefined，设置 autoDownload 直接 TypeError），
  // 用 createRequire 走 CJS 互操作，双形状兼容并防御缺包
  const nodeRequire = createRequire(import.meta.url);
  let upd = null;
  try {
    upd = nodeRequire('electron-updater');
  } catch {
    upd = null;
  }
  const updater = upd?.autoUpdater ?? upd?.default?.autoUpdater ?? null;
  CancellationToken = upd?.CancellationToken ?? upd?.default?.CancellationToken ?? null;
  if (!CancellationToken) CancellationToken = class { constructor() { this.cancelled = false; } cancel() { this.cancelled = true; } };
  if (!updater) {
    setState({ status: 'error', error: 'electron-updater 不可用（更新功能已停用）' });
    return {
      state: () => st,
      check: async () => st,
      download: async () => st,
      install: async () => st,
      cancel: async () => st,
      openInstaller: async () => { throw new Error('update-disabled'); },
    };
  }
  autoUpdater = updater;
  autoUpdater.autoDownload = false; // 检测到新版不自动下载，等用户点横幅（规格 A4）
  autoUpdater.autoInstallOnAppQuit = true; // 下载完成后正常退出也会安装
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => {
    const files = Array.isArray(info?.files) ? info.files : [];
    const dmgs = files.map((f) => String(f?.url || '')).filter((n) => n.endsWith('.dmg'));
    dmgFileName = dmgs.find((n) => n.includes(`-${process.arch}`)) || dmgs[0] || null;
    setState({
      status: 'available',
      info: {
        version: info?.version || null,
        releaseDate: info?.releaseDate || null,
        notes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : null,
      },
      error: null,
    });
  });
  autoUpdater.on('update-not-available', () => setState({ status: 'not-available', info: null, error: null }));
  autoUpdater.on('error', (e) => {
    if (cancelled) return; // 用户取消触发的下载中断不是错误
    setState({ status: 'error', error: String(e?.message || e) });
  });
  autoUpdater.on('download-progress', (p) => setState({
    status: 'downloading',
    progress: {
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
      etaSeconds: p.total && p.bytesPerSecond > 0 ? Math.round((p.total - p.transferred) / p.bytesPerSecond) : null,
    },
  }));
  autoUpdater.on('update-downloaded', (info) => {
    setState({ status: 'ready', progress: null, error: null, canCancel: false, installMode: 'auto', installModeReason: null });
    void writePending(updatesDir(), { fromVersion: st.currentVersion, toVersion: info?.version || st.info?.version }).catch(() => {});
  });

  checkTimer = setTimeout(() => { scheduledCheck({ getUiSettings }); }, FIRST_CHECK_DELAY_MS);
  intervalTimer = setInterval(() => { scheduledCheck({ getUiSettings }); }, CHECK_INTERVAL_MS);
  checkTimer.unref?.();
  intervalTimer.unref?.();

  return {
    state: () => st,
    check: () => doCheck().then(() => st),
    // 两端都立即返回快照，下载后台进行：原先 mac 等下载完才返回，会撞 RPC 的 30 秒超时
    download: async () => {
      if (busy()) return st; // 幂等：downloading/ready 中重复调用直接返回快照
      if (st.status !== 'available') throw new Error('当前状态不可下载');
      cancelled = false;
      const version = st.info?.version;
      setState({
        status: 'downloading',
        progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0, etaSeconds: null },
        error: null,
        canCancel: true,
      });
      if (process.platform === 'darwin') {
        void (async () => {
          try {
            await downloadDmg(version);
          } catch (e) {
            if (cancelled) setState({ status: 'available', progress: null, canCancel: false, error: null });
            else setState({ status: 'error', error: String(e?.message || e), progress: null, canCancel: false });
          }
        })();
        return st;
      }
      winCancelToken = new CancellationToken();
      autoUpdater.downloadUpdate(winCancelToken).catch((e) => {
        if (cancelled) setState({ status: 'available', progress: null, canCancel: false, error: null });
        else setState({ status: 'error', error: String(e?.message || e), progress: null, canCancel: false });
      });
      return st;
    },
    cancel: async () => {
      if (st.status !== 'downloading') return st; // 非下载中取消是幂等空操作
      cancelled = true;
      try { winCancelToken?.cancel(); } catch { /* 下载已结束 */ }
      dmgAbort?.abort(); // 取消后的状态复位由后台下载的 catch 统一处理
      return st;
    },
    install: async () => {
      if (st.status !== 'ready') throw Object.assign(new Error('安装包未就绪'), { notReady: true });
      if (process.platform === 'darwin') {
        if (!dmgInfo) throw Object.assign(new Error('安装包未就绪'), { notReady: true });
        if (st.installMode === 'auto' && macTarget?.target) {
          // 同步占位：进入任何 await 之前先离开 ready，防止重复点击并发准备两份
          setState({ status: 'installing', phase: 'preparing', error: null });
          return installMacAuto();
        }
        // manual：打开 DMG 后退出，用户拖入 Applications（预检判定不可自动替换）
        await writePending(updatesDir(), { fromVersion: st.currentVersion, toVersion: dmgInfo.version, dmgPath: dmgInfo.filePath });
        const openErr = await shell.openPath(dmgInfo.filePath); // 失败返回错误串而不 reject；保持 ready 可重试
        if (openErr) throw new Error('打开安装包失败：' + openErr);
        setState({ status: 'installing', phase: 'restarting', error: null });
        app.quit();
      } else {
        await writePending(updatesDir(), { fromVersion: st.currentVersion, toVersion: st.info?.version });
        setState({ status: 'installing', phase: 'launching-installer', error: null });
        await delay(INSTALLER_LAUNCH_DELAY_MS);
        autoUpdater.quitAndInstall(false, true); // 非静默安装 + 装完运行（installer.nsh 完成页启动）
      }
      return { ok: true };
    },
    openRelease: async () => {
      if (!publishCfg) throw new Error('缺少发布配置（app-update.yml）');
      const url = publishCfg.provider === 'generic'
        ? publishCfg.url
        : `https://github.com/${publishCfg.owner}/${publishCfg.repo}/releases`;
      await shell.openExternal(url);
    },
    openInstaller: async () => {
      const p = st.lastInstall?.dmgPath; // 只打开状态机里的安装包，不接受前端传入路径
      if (!p) throw Object.assign(new Error('没有可打开的安装包'), { noInstaller: true });
      const err = await shell.openPath(p);
      if (err) throw new Error('打开安装包失败：' + err);
    },
  };
}
