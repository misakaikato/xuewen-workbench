// Electron 外壳：后端放进 utilityProcess（空闲端口，默认 7410），窗口启动即出现并显示启动进度；
// 后端崩溃不拖垮窗口，可重启、可导出诊断包。开发模式（--dev）：同时启动 Vite（HMR）。
import { app, BrowserWindow, Menu, shell, dialog, ipcMain, utilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { disabledUpdateState } from '../server/update.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url)); // 本文件所在目录（electron/）
const ROOT = path.dirname(APP_DIR);
const DEV = process.argv.includes('--dev') || process.env.WORKBENCH_ELECTRON_DEV === '1';
const HOST = '127.0.0.1';
const PROC_START = Date.now();
let win = null;
let vite = null;
let backend = null;
let backendStderr = []; // 后端 stderr 最后 50 行环形缓冲（崩溃时写入 incident）
let quitting = false;
let updateBridge = null; // 打包模式的更新桥（经 RPC 暴露给后端）
let winTheme = 'A';
let winBg = '#f7f1e3'; // 窗口底色：启动时按持久化主题的纸色设置，避免白闪
let dataDirValue = null;
let markSessionEndFn = null;
let appendIncidentFn = null;
let exportDiagnosticsFn = null;
let readIncidentsFn = null;
let logsDirFn = null;
let lastBootPayload = null; // 最新启动页状态（启动页加载完成后补发）
let showingStartup = false;
let uiOrigin = null; // 应用 UI 源（生产=后端端口，开发=Vite 端口），用于 will-navigate 白名单

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  app.whenReady().then(start).catch((e) => {
    dialog.showErrorBox('启动失败', String(e?.stack || e));
    app.quit();
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, HOST);
  });
}

async function freePort(preferred) {
  for (let p = preferred; p < preferred + 50; p++) if (await portFree(p)) return p;
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, HOST, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitFor(url, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('等待服务超时: ' + url);
}

function logStartupEnv() {
  const cpus = os.cpus();
  console.log('[env] 版本 ' + app.getVersion() + ' electron=' + process.versions.electron + ' node=' + process.versions.node + ' chrome=' + process.versions.chrome);
  console.log('[env] 系统 ' + os.platform() + ' ' + os.release() + ' ' + os.arch());
  console.log('[env] CPU ' + (cpus[0]?.model || 'unknown') + ' x' + cpus.length);
  console.log('[env] 内存 总 ' + (os.totalmem() / 1024 / 1024 / 1024).toFixed(1) + 'GB 空闲 ' + (os.freemem() / 1024 / 1024 / 1024).toFixed(1) + 'GB');
  console.log('[env] GPU ' + JSON.stringify(app.getGPUFeatureStatus()));
  console.log('[env] 数据目录 ' + dataDirValue + '，打包 ' + app.isPackaged);
}

async function start() {
  // 主进程日志与看门狗：先于任何其他操作初始化，便于取证
  const loggerNs = await import(pathToFileURL(path.join(ROOT, 'server', 'logger.js')).href);
  const { startLagWatch } = await import(pathToFileURL(path.join(ROOT, 'server', 'lagWatch.js')).href);
  // 旧版本（v0.1.1–v0.1.3）数据在 userData/data；交给 store.js 在确定数据目录后迁移
  process.env.WORKBENCH_LEGACY_DATA_DIR = path.join(app.getPath('userData'), 'data');
  const storeNs = await import(pathToFileURL(path.join(ROOT, 'server', 'store.js')).href);
  const diagNs = await import(pathToFileURL(path.join(ROOT, 'server', 'diagnostics.js')).href);
  const { dataDir, getUiSettings } = storeNs;
  const { markSessionStart, markSessionEnd, appendIncident, exportDiagnostics, readIncidents } = diagNs;
  dataDirValue = dataDir();
  markSessionEndFn = markSessionEnd;
  appendIncidentFn = appendIncident;
  exportDiagnosticsFn = exportDiagnostics;
  readIncidentsFn = readIncidents;
  logsDirFn = loggerNs.logsDir;
  loggerNs.initProcessLogger({ dir: logsDirFn(dataDirValue), name: 'main', tag: 'main' });
  startLagWatch({ tag: 'main' });
  logStartupEnv();
  markSessionStart(dataDirValue, { pid: process.pid, version: app.getVersion(), startedAt: new Date().toISOString() });

  buildMenu();
  process.env.WORKBENCH_HOST = HOST;
  if (!DEV) process.env.WORKBENCH_STATIC_DIR = path.join(ROOT, 'dist');
  // 诊断包导出到桌面（可处理 OneDrive 重定向）；导出前备好桌面路径
  process.env.WORKBENCH_DESKTOP_DIR = app.getPath('desktop');

  // 主题决定窗口底色与启动页配色；store 导入已执行数据迁移副作用（先于后端启动）
  winTheme = getUiSettings().theme || 'A';
  winBg = { A: '#f7f1e3', B: '#ffffff', C: '#1b1c20' }[winTheme] || winBg;

  // 跨重启更新提示（启动页首条文案）：读待完成记录判定刚更新成功。
  // 必须在 createUpdaterBridge 之前读——它会消费并删除这些文件（规格 §五「启动页」）
  try {
    const { pendingFile, readJsonIfExists } = await import(pathToFileURL(path.join(ROOT, 'electron', 'updatePending.js')).href);
    const pending = readJsonIfExists(pendingFile(path.join(app.getPath('userData'), 'updates')));
    if (pending?.toVersion && pending.toVersion === app.getVersion()) {
      lastBootPayload = { state: 'starting', step: `已更新到 v${pending.toVersion}，正在启动…` };
    }
  } catch { /* 记录缺失或损坏按普通启动处理 */ }

  // 立即建窗并加载启动页；首帧与 1500ms 兜底先到者显示（见 createStartupWindow）
  createStartupWindow();

  // 选空闲端口（仅供后端监听；窗口已先出现，端口选择不阻塞首屏）
  const port = await freePort(Number(process.env.WORKBENCH_PORT) || 7410);
  process.env.WORKBENCH_PORT = String(port);

  // 自动更新：仅打包模式创建桥接，经 RPC 暴露给后端（dev / 独立 dev:server 时功能停用）
  if (app.isPackaged) {
    const { createUpdaterBridge } = await import(pathToFileURL(path.join(ROOT, 'electron', 'updater.js')).href);
    updateBridge = await createUpdaterBridge({ getUiSettings, logsDir: logsDirFn?.(dataDirValue) });
  }

  startBackend();
}

function startBackend() {
  backendStderr = [];
  const proc = utilityProcess.fork(path.join(ROOT, 'server', 'index.js'), [], {
    serviceName: 'Xuewen Workbench Backend',
    stdio: 'pipe',
    env: {
      ...process.env,
      WORKBENCH_PORT: process.env.WORKBENCH_PORT,
      WORKBENCH_HOST: HOST,
      WORKBENCH_HOSTED: '1',
      WORKBENCH_DESKTOP_DIR: app.getPath('desktop'),
      WORKBENCH_APP_VERSION: app.getVersion(),
      ...(DEV ? {} : { WORKBENCH_STATIC_DIR: path.join(ROOT, 'dist') }),
    },
  });
  backend = proc;
  proc.on('spawn', () => console.log('[backend] 后端进程 fork，pid=' + proc.pid));
  proc.stdout?.on('data', (d) => process.stdout.write(d));
  proc.stderr?.on('data', (d) => {
    process.stderr.write(d);
    for (const line of String(d).split(/\r?\n/)) {
      if (line.trim()) { backendStderr.push(line); if (backendStderr.length > 50) backendStderr.shift(); }
    }
  });
  proc.on('message', (msg) => handleBackendMessage(msg));
  proc.on('exit', (code) => {
    if (quitting || backend !== proc) return; // 应用退出或重启中，旧进程退出不记
    backend = null;
    console.error('[backend] 后端进程退出，code=' + code);
    appendIncidentFn?.(dataDirValue, {
      kind: 'backend-exit',
      at: new Date().toISOString(),
      detail: { code, stderrTail: backendStderr },
    });
    sendBoot({ state: 'error', message: '后台服务意外退出（代码 ' + code + '）' });
    if (win && !win.isDestroyed()) {
      showingStartup = false; // 切回启动页，did-finish-load 时补发错误态
      win.loadFile(path.join(APP_DIR, 'startup.html'), { query: { theme: winTheme } });
    }
  });
}

function handleBackendMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'boot') sendBoot({ state: 'starting', step: String(msg.step || '') });
  else if (msg.t === 'ready') onBackendReady(msg.port);
  else if (msg.t === 'rpc') handleRpc(msg);
}

function sendBoot(payload) {
  lastBootPayload = payload;
  if (showingStartup && win && !win.isDestroyed()) win.webContents.send('wb:boot', payload);
}

async function onBackendReady(port) {
  const api = `http://${HOST}:${port}`;
  console.log('[backend] 后端就绪: ' + api + '，距进程启动 ' + (Date.now() - PROC_START) + 'ms');
  let url = api + '/';
  if (DEV) {
    const vport = await freePort(3000);
    vite = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(vport), '--strictPort', '--host', HOST], {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    url = `http://${HOST}:${vport}/`;
    await waitFor(url, 60000);
  }
  console.log('[electron] api=' + api + ' ui=' + url + ' data=' + (process.env.WORKBENCH_DATA_DIR || 'server/data'));
  uiOrigin = new URL(url).origin;
  if (win && !win.isDestroyed()) win.loadURL(url);
}

async function handleRpc({ id, method, args }) {
  const result = { t: 'rpc-result', id };
  try {
    result.ok = true;
    result.value = await callRpc(method, args || []);
  } catch (e) {
    result.ok = false;
    result.error = String(e?.message || e);
  }
  backend?.postMessage(result);
}

async function callRpc(method, args) {
  switch (method) {
    case 'shell.trashItem': return shell.trashItem(args[0]);
    case 'shell.openPath': {
      const err = await shell.openPath(args[0]);
      if (err) throw new Error(err);
      return undefined;
    }
    case 'shell.showItemInFolder': shell.showItemInFolder(args[0]); return undefined;
    case 'update.state': return updateBridge ? updateBridge.state() : disabledUpdateState();
    case 'update.check':
    case 'update.download':
    case 'update.install':
    case 'update.cancel':
    case 'update.openInstaller':
    case 'update.openRelease': {
      if (!updateBridge) throw new Error('update-disabled');
      return updateBridge[method.slice('update.'.length)]();
    }
    case 'host.info': return { gpu: app.getGPUFeatureStatus() };
    default: throw new Error('unknown-method');
  }
}

// 主进程直接导出（后端不可用时）：summary 只含环境与日志信息，不含正文/密钥
function mainSummary() {
  const cpus = os.cpus();
  return {
    app: { version: app.getVersion(), hosted: true },
    runtime: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
    os: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: cpus[0]?.model || 'unknown', cores: cpus.length, totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1), freeMemGB: +(os.freemem() / 1024 ** 3).toFixed(1) },
    host: { gpu: app.getGPUFeatureStatus() },
    dataDir: dataDirValue,
    logsDir: logsDirFn?.(dataDirValue),
    incidents: readIncidentsFn?.(dataDirValue) || [],
    backend: 'not-running',
  };
}

// 系统目录选择（供「添加知识库」使用）：渲染进程 → preload → 这里
ipcMain.handle('wb:selectDirectory', async (_e, defaultPath) => {
  const r = await dialog.showOpenDialog(win ?? undefined, {
    title: '选择知识库根目录',
    defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '选择此目录',
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle('wb:exportDiagnostics', async () => {
  // 后端已就绪时走后端导出（含资料库/RAG 统计）；失败或不就绪回退主进程导出
  if (backend) {
    try {
      const r = await fetch(`http://${HOST}:${process.env.WORKBENCH_PORT}/api/diagnostics/export`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.file) return { file: j.file };
    } catch { /* 回退 */ }
  }
  try {
    const { file } = await exportDiagnosticsFn({ dataDir: dataDirValue, outDir: process.env.WORKBENCH_DESKTOP_DIR, summary: mainSummary() });
    try { shell.showItemInFolder(file); } catch { /* 定位失败不影响 */ }
    return { file };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
});

ipcMain.handle('wb:restartBackend', async () => {
  const old = backend;
  backend = null; // 先解除引用，旧进程 exit 不再记录
  if (old) { try { old.kill(); } catch { /* 已退出 */ } }
  const port = await freePort(Number(process.env.WORKBENCH_PORT) || 7410);
  process.env.WORKBENCH_PORT = String(port);
  startBackend();
  return { ok: true };
});

function attachWindowEvents() {
  win.webContents.on('preload-error', (_e, p, err) => {
    console.error('[preload-error]', p, err && err.message ? err.message : err);
  });
  win.on('unresponsive', () => console.warn('[window] 窗口无响应'));
  win.on('responsive', () => console.log('[window] 窗口恢复响应'));
  // Windows 关机或注销不触发 will-quit：按正常退出处理（写会话结束标记、后端退出不记异常），下次启动不误报
  win.on('session-end', () => {
    console.log('[window] 系统关机或注销，按正常退出处理');
    quitting = true;
    if (dataDirValue) markSessionEndFn?.(dataDirValue);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[window] 渲染进程退出: reason=' + details.reason + ' exitCode=' + details.exitCode);
    appendIncidentFn?.(dataDirValue, { kind: 'renderer-gone', at: new Date().toISOString(), detail: { reason: details.reason, exitCode: details.exitCode } });
  });
  win.webContents.on('did-finish-load', () => {
    showingStartup = win.webContents.getURL().includes('startup.html');
    if (showingStartup && lastBootPayload) win.webContents.send('wb:boot', lastBootPayload);
  });
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  // 只允许在启动页与应用 UI 源内导航；其余跳转拦截，http(s) 交给系统浏览器
  win.webContents.on('will-navigate', (e, url) => {
    const startup = pathToFileURL(path.join(APP_DIR, 'startup.html')).href;
    const allowed = url.startsWith(startup) || (uiOrigin && (url === uiOrigin || url.startsWith(uiOrigin + '/')));
    if (allowed) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
}

function createStartupWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    title: '学问 Workbench', show: false, backgroundColor: winBg,
    icon: path.join(ROOT, 'assets', 'icons', 'icon.png'),
    // macOS：隐藏式标题栏，红绿灯内嵌顶栏（渲染侧顶栏做拖拽区，见 Layout wb-drag）
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(APP_DIR, 'preload.cjs') },
  });
  console.log('[window] 窗口创建，距进程启动 ' + (Date.now() - PROC_START) + 'ms');
  attachWindowEvents();
  // 首帧与 1500ms 兜底先到者显示（只一次）：渲染进程/GPU 异常导致首帧不来时窗口仍会出现
  let shown = false;
  const showOnce = () => {
    if (shown) return;
    shown = true;
    if (win && !win.isDestroyed()) win.show();
  };
  win.once('ready-to-show', showOnce);
  const showTimer = setTimeout(() => {
    if (!shown) console.warn('[window] 首帧 1500ms 内未就绪，先行显示窗口');
    showOnce();
  }, 1500);
  win.loadFile(path.join(APP_DIR, 'startup.html'), { query: { theme: winTheme } });
  win.on('closed', () => { clearTimeout(showTimer); win = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function stopChildren() {
  if (vite && !vite.killed) { try { vite.kill(); } catch { /* ignore */ } }
}

app.on('child-process-gone', (_e, details) => {
  if (details.reason === 'clean-exit') return; // 正常退出不记
  if (details.name === 'Xuewen Workbench Backend') return; // 后端另有 backend-exit 记录，避免重复
  console.error('[child] 子进程退出: type=' + details.type + ' reason=' + details.reason + ' exitCode=' + details.exitCode + ' name=' + (details.name || ''));
  appendIncidentFn?.(dataDirValue, { kind: 'child-gone', at: new Date().toISOString(), detail: { type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name } });
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  updateBridge?.onBeforeQuit?.(); // mac：下载中止并保留 .part；准备阶段结束 ditto 并卸载挂载点
  if (backend) { try { backend.kill(); } catch { /* ignore */ } }
  stopChildren();
});
app.on('will-quit', () => {
  stopChildren();
  if (dataDirValue) markSessionEndFn?.(dataDirValue);
});
process.on('exit', stopChildren);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopChildren(); app.quit(); });
