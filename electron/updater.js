// 自动更新桥（仅在打包模式下由 main.js 创建注入，见 server/update.js 的桥接约定）：
// - Windows：electron-updater 全自动（检查/差量下载/静默安装/重启）
// - macOS（未签名）：electron-updater 只做检查；下载为自取 GitHub Release 的 DMG，
//   安装 = openPath(DMG) + 退出，用户拖入 Applications。将来签名后 mac 分支可切回 electron-updater。
import { app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const FIRST_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30_000;

let autoUpdater = null;
let publishCfg = null; // { owner, repo }，来自打包产物 resources/app-update.yml
let st = newState(false);
let dmgInfo = null; // { filePath, version } macOS 已下载的安装包
let checkTimer = null;
let intervalTimer = null;
let settleCheck = null; // check() 的 settle 回调（一次性）
let busy = () => ['checking', 'downloading', 'ready', 'installing'].includes(st.status);

function newState(enabled) {
  return { enabled, status: 'idle', currentVersion: app.getVersion(), info: null, progress: null, error: null };
}

function setState(patch) {
  st = { ...st, ...patch };
  if (['available', 'not-available', 'error'].includes(st.status) && settleCheck) {
    const fn = settleCheck;
    settleCheck = null;
    fn();
  }
}

// 解析 resources/app-update.yml（扁平键值，electron-builder 生成）里的 GitHub 仓库坐标
function readPublishConfig() {
  try {
    const file = path.join(process.resourcesPath, 'app-update.yml');
    const map = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^(\w[\w-]*):\s*(\S+)\s*$/);
      if (m) map[m[1]] = m[2];
    }
    if (map.provider === 'github' && map.owner && map.repo) return { owner: map.owner, repo: map.repo };
  } catch { /* 未配置 publish 或文件缺失 */ }
  return null;
}

async function releaseDmgUrl(version) {
  if (!publishCfg) throw new Error('缺少发布配置（app-update.yml）');
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

// macOS：自下载 DMG（全量，无差量——差量仅 electron-updater 的 zip/exe 路径可用）
async function downloadDmg(version) {
  const url = await releaseDmgUrl(version);
  const dir = (() => {
    try { return app.getPath('downloads'); } catch { return path.join(app.getPath('userData'), 'updates'); }
  })();
  await fs.promises.mkdir(dir, { recursive: true });
  const fileName = decodeURIComponent(url.split('/').pop());
  const filePath = path.join(dir, fileName);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`下载安装包失败 (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(filePath);
  let transferred = 0;
  let lastTick = 0;
  let lastBytes = 0;
  setState({ status: 'downloading', progress: { percent: 0, transferred: 0, total, bytesPerSecond: 0 }, error: null });
  try {
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
          },
        });
        lastTick = now;
        lastBytes = transferred;
      }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    dmgInfo = { filePath, version };
    setState({ status: 'ready', progress: null, error: null });
  } catch (e) {
    try { await fs.promises.unlink(filePath); } catch { /* 半截文件可能尚未创建 */ }
    throw e;
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

export async function createUpdaterBridge({ getUiSettings }) {
  publishCfg = readPublishConfig();
  st = newState(true);

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
  if (!updater) {
    setState({ status: 'error', error: 'electron-updater 不可用（更新功能已停用）' });
    return {
      state: () => st,
      check: async () => st,
      download: async () => st,
      install: async () => st,
    };
  }
  autoUpdater = updater;
  autoUpdater.autoDownload = false; // 检测到新版不自动下载，等用户点横幅（规格 A4）
  autoUpdater.autoInstallOnAppQuit = true; // 下载完成后正常退出也会安装
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => setState({
    status: 'available',
    info: {
      version: info?.version || null,
      releaseDate: info?.releaseDate || null,
      notes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : null,
    },
    error: null,
  }));
  autoUpdater.on('update-not-available', () => setState({ status: 'not-available', info: null, error: null }));
  autoUpdater.on('error', (e) => setState({ status: 'error', error: String(e?.message || e) }));
  autoUpdater.on('download-progress', (p) => setState({
    status: 'downloading',
    progress: {
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    },
  }));
  autoUpdater.on('update-downloaded', () => setState({ status: 'ready', progress: null, error: null }));

  checkTimer = setTimeout(() => { scheduledCheck({ getUiSettings }); }, FIRST_CHECK_DELAY_MS);
  intervalTimer = setInterval(() => { scheduledCheck({ getUiSettings }); }, CHECK_INTERVAL_MS);
  checkTimer.unref?.();
  intervalTimer.unref?.();

  return {
    state: () => st,
    check: () => doCheck().then(() => st),
    download: async () => {
      if (busy()) return st; // 幂等：downloading/ready 中重复调用直接返回快照
      if (st.status !== 'available') throw new Error('当前状态不可下载');
      if (process.platform === 'darwin') {
        try {
          await downloadDmg(st.info?.version);
        } catch (e) {
          setState({ status: 'error', error: String(e?.message || e), progress: null });
        }
        return st;
      }
      autoUpdater.downloadUpdate().catch((e) => setState({ status: 'error', error: String(e?.message || e) }));
      return st;
    },
    install: async () => {
      if (st.status !== 'ready') throw Object.assign(new Error('安装包未就绪'), { notReady: true });
      if (process.platform === 'darwin') {
        if (!dmgInfo) throw Object.assign(new Error('安装包未就绪'), { notReady: true });
        // openPath 失败返回错误串而不 reject；失败时保持 ready 让用户可重试
        const openErr = await shell.openPath(dmgInfo.filePath);
        if (openErr) throw new Error('打开安装包失败：' + openErr);
        setState({ status: 'installing', error: null });
        app.quit(); // 用户拖入 Applications 完成替换
      } else {
        setState({ status: 'installing', error: null });
        autoUpdater.quitAndInstall(true, true); // 静默安装 + 装完重启
      }
      return { ok: true };
    },
    openRelease: async () => {
      if (!publishCfg) throw new Error('缺少发布配置（app-update.yml）');
      await shell.openExternal(`https://github.com/${publishCfg.owner}/${publishCfg.repo}/releases`);
    },
  };
}
