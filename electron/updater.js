// 自动更新桥（仅在打包模式下由 main.js 创建注入，见 server/update.js 的桥接约定）：
// - Windows：electron-updater 检查/下载；安装 = 非静默 quitAndInstall(false, true)，
//   安装器显示进度窗口，装完自动重开（build/installer.nsh 控制升级时的页面流）。
// - macOS（未签名）：electron-updater 只做检查；下载自取发布源的 DMG（net.fetch，可续传、重试、sha512 校验，
//   下载过的文件记在 updates/downloads.json，清理只动记录里的文件）；
//   自动安装 = 应用内准备（挂载/校验/复制到目标同目录的 .<名>.new-<ts>/验签，带进度）+ 退出后由
//   mac-install.sh 两次改名替换并重开；预检不可自动替换（DMG 卷 / AppTranslocation / 目录不可写）时回退手动拖拽。
//   启动时后台清理上次中断的残留：挂载点、.new-* 与旧版本遗留的 staging、替换备份、已装过的安装包。
import { app, shell, net } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  macInstallTarget, prepareMacUpdate, launchMacSwap, readPlistValue, cleanupMacLeftovers,
  appBundlePath, swapSidePath, isSwapSidePath,
} from './macInstall.js';
import { downloadDmgToPart } from './dmgDownload.js';
import { consumeInstallOutcome } from './updateOutcome.js';
import {
  pendingFile, resultFile, writePending, clearInstallFiles, readJsonIfExists, readDownloads, updateDownloads,
} from './updatePending.js';

const FIRST_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30_000;
const INSTALLER_LAUNCH_DELAY_MS = 1200; // 让「正在启动安装程序 / 即将重启」先显示出来
const APP_DIR = path.dirname(fileURLToPath(import.meta.url)); // 本文件所在目录（electron/）
const PART_SUFFIX = '.part';

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
let prepareAbort = null; // mac 准备阶段的 AbortController（退出时结束 ditto 并卸载）
let winCancelToken = null; // Windows 下载的 CancellationToken（取消用）
let cancelled = false; // 本次下载是否被用户取消（取消回 available，失败进 error）
let quittingApp = false; // 已进入 before-quit：中止下载但保留 .part 供下次续传
let startupCleanup = Promise.resolve(); // 启动清理（下载与安装开始前等它结束）
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

// 启动时消费跨重启的安装记录（updateOutcome 判定规则）：刚更新成功 / 上次失败 / 用户取消（保留不提示）。
// 返回读到的 pending 与判定，供启动清理使用（消费会删除文件）
function consumeInstallFiles() {
  const dir = updatesDir();
  const pending = readJsonIfExists(pendingFile(dir));
  const result = readJsonIfExists(resultFile(dir));
  if (!pending && !result) return null;
  const outcome = consumeInstallOutcome({ currentVersion: app.getVersion(), pending, result });
  if (outcome.lastInstall) st = { ...st, lastInstall: outcome.lastInstall };
  if (outcome.clear) void clearInstallFiles(dir);
  return { pending, outcome };
}

async function exists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

// 版本号比较（x.y.z 数字段，预发布后缀忽略）：a<b 为负，相等为 0
function compareVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// 启动清理（后台进行）：mac 卸载残留挂载，删目标同目录遗留的 .<名>.new-*、旧版本遗留的 staging 与空挂载点目录；
// 上次已更新成功时补删替换备份，并删除下载记录里版本 ≤ 当前版本的 DMG 与 .part。失败的那次不删，DMG 留给用户手动安装。
async function cleanupAtStartup(prev) {
  const ud = updatesDir();
  const updated = prev?.outcome?.lastInstall?.result === 'updated';
  if (process.platform === 'darwin') {
    const appPath = appBundlePath(process.execPath);
    await cleanupMacLeftovers({
      stagingDir: path.join(ud, 'staging'), // 旧版本的准备目录
      appPath,
      imagePaths: readDownloads(ud).map((r) => r.path),
      isInstalling: () => st.status === 'installing',
    });
    // 新版本已正常运行而备份还在：上次后台删除没做完（备份名须严格符合本应用的命名规则）
    const backup = prev?.pending?.backupPath;
    if (updated && appPath && isSwapSidePath(backup, appPath, 'old') && await exists(backup)) {
      console.log('[update] 删除上次替换遗留的旧版本备份：' + backup);
      await fsp.rm(backup, { recursive: true, force: true });
    }
  }
  if (updated && readDownloads(ud).length) {
    const current = app.getVersion();
    await updateDownloads(ud, async (list) => {
      const keep = [];
      for (const r of list) {
        if (compareVersions(r.version, current) > 0) {
          keep.push(r);
          continue;
        }
        try {
          await fsp.rm(r.path, { force: true });
          console.log('[update] 删除已安装过的安装包：' + r.path);
        } catch (e) {
          console.warn('[update] 删除已安装过的安装包失败：' + r.path + '，' + (e?.message || e));
          keep.push(r);
        }
      }
      return keep;
    });
  }
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

// update-available 时从 UpdateInfo.files（即 latest-mac.yml 的文件清单）记住 DMG 文件名与 sha512：
// 下载 URL 直接拼 <base>/v<tag>/<file>；github 走资产通道，不调 api.github.com——
// 未认证请求限流 60 次/小时/IP，用户点下载时极易撞上 403
let dmgFileName = null;
let dmgSha512 = null; // base64，下载完成后校验

async function releaseDmgUrl(version, signal) {
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
  const r = await net.fetch(api, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'xuewen-workbench-updater' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!r.ok) throw new Error(`查询发布资产失败 (${r.status})`);
  const rel = await r.json();
  const assets = (rel.assets || []).filter((a) => a.name.endsWith('.dmg'));
  const hit = assets.find((a) => a.name.includes(`-${process.arch}`)) || assets[0];
  if (!hit) throw new Error('该版本没有 DMG 资产');
  return hit.browser_download_url;
}

function downloadsDir() {
  try {
    return app.getPath('downloads');
  } catch {
    return updatesDir();
  }
}

// .part 文件名带版本号：正式文件名本身不含版本时在 .part 前补上
function partPathFor(target, version) {
  return path.basename(target).includes(version) ? target + PART_SUFFIX : `${target}.${version}${PART_SUFFIX}`;
}

// 候选目标：原名，被占用时依次加 -1、-2…
function dmgCandidates(dir, fileName, version) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  const list = [];
  for (let i = 0; i < 100; i++) {
    const target = path.join(dir, i ? `${stem}-${i}${ext}` : fileName);
    list.push({ target, part: partPathFor(target, version) });
  }
  return list;
}

// 选下载目标：优先续传记录里同版本的 .part；否则取第一个不会覆盖用户文件的名字。
// 「用户文件」= 已存在且不在下载记录里的文件，一律不覆盖、不删除
async function pickDmgPaths(dir, fileName, version, records) {
  const recorded = new Set(records.map((r) => r.path));
  const free = async (p) => recorded.has(p) || !(await exists(p));
  const cands = dmgCandidates(dir, fileName, version);
  for (const c of cands) {
    const resumable = records.some((r) => r.path === c.part && r.version === version);
    if (resumable && await exists(c.part) && await free(c.target)) return c;
  }
  for (const c of cands) {
    if (await free(c.target) && await free(c.part)) return c;
  }
  throw new Error('下载目录里同名文件过多，无法保存安装包');
}

// macOS：自下载 DMG（全量，无差量——差量仅 electron-updater 的 zip/exe 路径可用）。
// 写 .part（先登记进下载记录再落盘），校验通过后改为正式文件名；取消与最终失败删除 .part，
// 应用退出时保留 .part 供下次同版本续传。完成时写待完成记录并做自动安装预检。
async function downloadDmg(version) {
  const ctrl = new AbortController();
  dmgAbort = ctrl;
  const ud = updatesDir();
  let paths = null;
  try {
    await startupCleanup;
    const url = await releaseDmgUrl(version, ctrl.signal);
    ctrl.signal.throwIfAborted();
    const dir = downloadsDir();
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.access(dir, fs.constants.W_OK);
    } catch {
      throw new Error(`下载目录不可写：${dir}`);
    }
    const fileName = path.basename(decodeURIComponent(url.split('/').pop()));
    // 开始新版本的下载：删除记录里其他版本的 .part，去掉文件已不在的条目，再登记本次 .part
    await updateDownloads(ud, async (list) => {
      const keep = [];
      for (const r of list) {
        if (r.path.endsWith(PART_SUFFIX) && r.version !== version) {
          try {
            await fsp.rm(r.path, { force: true });
            continue;
          } catch { /* 删不掉就留着记录，下次再试 */ }
        }
        if (await exists(r.path)) keep.push(r);
      }
      paths = await pickDmgPaths(dir, fileName, version, keep);
      return [...keep.filter((r) => r.path !== paths.part), { path: paths.part, version, at: new Date().toISOString() }];
    });
    ctrl.signal.throwIfAborted();
    await downloadDmgToPart({
      url,
      part: paths.part,
      fetchImpl: (u, opts) => net.fetch(u, opts),
      signal: ctrl.signal,
      sha512: dmgSha512,
      onProgress: (progress) => setState({ progress }),
    });
    // 改为正式文件名；下载期间目标处新出现了用户文件时换下一个空闲名字
    await updateDownloads(ud, async (list) => {
      const recorded = new Set(list.map((r) => r.path));
      let target = paths.target;
      if (!recorded.has(target) && await exists(target)) {
        target = null;
        for (const c of dmgCandidates(dir, fileName, version)) {
          if (recorded.has(c.target) || !(await exists(c.target))) {
            target = c.target;
            break;
          }
        }
        if (!target) throw new Error('下载目录里同名文件过多，无法保存安装包');
      }
      await fsp.rename(paths.part, target);
      paths = { ...paths, target };
      return [
        ...list.filter((r) => r.path !== paths.part && r.path !== target),
        { path: target, version, at: new Date().toISOString() },
      ];
    });
  } catch (e) {
    if (paths && !quittingApp) {
      const { part } = paths;
      await updateDownloads(ud, async (list) => {
        await fsp.rm(part, { force: true });
        return list.filter((r) => r.path !== part);
      }).catch(() => {});
    }
    throw e;
  } finally {
    if (dmgAbort === ctrl) dmgAbort = null;
  }
  const filePath = paths.target;
  dmgInfo = { filePath, version };
  macTarget = await macInstallTarget(process.execPath); // 预检结果决定 ready 的安装模式
  setState({
    status: 'ready', progress: null, error: null, canCancel: false,
    installMode: macTarget.mode,
    installModeReason: macTarget.mode === 'manual' ? macTarget.reason : null,
  });
  // 下载后直接退出、退出时自动安装的路径也要能提示，这里就写待完成记录
  await writePending(updatesDir(), { fromVersion: st.currentVersion, toVersion: version, dmgPath: filePath });
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
    const timer = setTimeout(() => { if (settleCheck) { const fn = settleCheck; settleCheck = null; fn(); } }, CHECK_TIMEOUT_MS);
    timer.unref?.(); // 兜底超时不单独维持进程存活
  });
}

// mac 自动安装：应用内准备（进度进状态机），成功后派发替换脚本再退出；失败不退出、回退手动
async function installMacAuto() {
  const { filePath: dmgPath, version } = dmgInfo;
  // 新版本直接复制到目标同目录的隐藏目录 .<名>.new-<ts>（预检 auto 已保证目录可写，与目标同卷），退出后脚本只需改名
  const newDir = swapSidePath(macTarget.target, 'new');
  let prepared = false;
  try {
    await startupCleanup;
    const bundleId = await readPlistValue(macTarget.target, 'CFBundleIdentifier');
    // 准备阶段可被退出中止（结束 ditto、卸载挂载点、删掉半截的新版本目录）
    prepareAbort = new AbortController();
    let staged;
    try {
      ({ staged } = await prepareMacUpdate({
        dmgPath,
        expectedVersion: version,
        expectedBundleId: bundleId,
        stagingDir: newDir,
        onPhase: (phase) => setState({ status: 'installing', phase, error: null }),
        onProgress: (p) => setState({ progress: { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: 0, etaSeconds: null } }),
        signal: prepareAbort.signal,
      }));
    } finally {
      prepareAbort = null;
    }
    prepared = true;
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
    // 准备好了但派发失败：删掉目标同目录的新版本目录（准备阶段自身失败时已由 prepareMacUpdate 删除）
    if (prepared) await fsp.rm(newDir, { recursive: true, force: true }).catch(() => {});
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
  dmgInfo = null;
  macTarget = null;
  dmgFileName = null;
  dmgSha512 = null;
  cancelled = false;
  quittingApp = false;
  const prev = consumeInstallFiles(); // 最早的启动提示来源：上次安装的结果
  startupCleanup = cleanupAtStartup(prev).catch((e) => console.warn('[update] 启动清理失败：' + (e?.message || e)));

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
      onBeforeQuit: () => {},
    };
  }
  autoUpdater = updater;
  autoUpdater.autoDownload = false; // 检测到新版不自动下载，等用户点横幅（规格 A4）
  autoUpdater.autoInstallOnAppQuit = true; // 下载完成后正常退出也会安装
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => {
    const files = Array.isArray(info?.files) ? info.files : [];
    const dmgs = files.filter((f) => String(f?.url || '').endsWith('.dmg'));
    const dmg = dmgs.find((f) => String(f.url).includes(`-${process.arch}`)) || dmgs[0] || null;
    dmgFileName = dmg ? String(dmg.url) : null;
    dmgSha512 = typeof dmg?.sha512 === 'string' && dmg.sha512 ? dmg.sha512 : null;
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
            if (cancelled || quittingApp) {
              setState({ status: 'available', progress: null, canCancel: false, error: null });
            } else {
              console.warn('[update] 下载安装包失败：' + (e?.message || e));
              setState({ status: 'error', error: String(e?.message || e), progress: null, canCancel: false });
            }
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
      // mac 下载完成（ready）后又遇检查类错误进入 error 时 DMG 仍在盘上：允许直接手动安装
      const canInstall = st.status === 'ready'
        || (process.platform === 'darwin' && st.status === 'error' && dmgInfo);
      if (!canInstall) throw Object.assign(new Error('安装包未就绪'), { notReady: true });
      if (process.platform === 'darwin') {
        if (!dmgInfo) throw Object.assign(new Error('安装包未就绪'), { notReady: true });
        if (st.status === 'ready' && st.installMode === 'auto' && macTarget?.target) {
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
    // 应用退出（main.js 的 before-quit）：下载中止并保留 .part 供下次续传；
    // 准备阶段结束 ditto 并卸载挂载点（卸载交给独立进程，退出后仍会完成）
    onBeforeQuit: () => {
      quittingApp = true;
      dmgAbort?.abort();
      prepareAbort?.abort();
    },
  };
}
