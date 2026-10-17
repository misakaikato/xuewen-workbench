// Electron 外壳：进程内启动 Express 后端（空闲端口，默认 7410），就绪后打开窗口。
// 开发模式（--dev）：同时启动 Vite（HMR），窗口加载 Vite 地址；打包模式：后端直接托管 dist/。
import { app, BrowserWindow, Menu, shell, dialog } from 'electron';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEV = process.argv.includes('--dev') || process.env.WORKBENCH_ELECTRON_DEV === '1';
const HOST = '127.0.0.1';
let win = null;
let vite = null;
let winBg = '#f7f1e3'; // 窗口底色：启动时按持久化主题的纸色设置，避免白闪

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
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

async function start() {
  buildMenu();
  const port = await freePort(Number(process.env.WORKBENCH_PORT) || 7410);
  process.env.WORKBENCH_PORT = String(port);
  process.env.WORKBENCH_HOST = HOST;
  if (app.isPackaged) {
    process.env.WORKBENCH_DATA_DIR = process.env.WORKBENCH_DATA_DIR || path.join(app.getPath('userData'), 'data');
  }
  if (!DEV) process.env.WORKBENCH_STATIC_DIR = path.join(ROOT, 'dist');

  // 删除操作交给系统回收站（失败时后端保留在数据源 .trash/ 中）
  const { setTrashHandler } = await import(pathToFileURL(path.join(ROOT, 'server', 'trash.js')).href);
  setTrashHandler((absPath) => shell.trashItem(absPath));

  // 进程内加载后端（随应用退出而结束）
  await import(pathToFileURL(path.join(ROOT, 'server', 'index.js')).href);

  // 窗口底色随持久化主题（必须在建窗前读取；A 宣纸 / B 纯白 / C 夜读纸色）
  const { getUiSettings } = await import(pathToFileURL(path.join(ROOT, 'server', 'store.js')).href);
  winBg = { A: '#f7f1e3', B: '#ffffff', C: '#1b1c20' }[getUiSettings().theme] || winBg;

  const api = `http://${HOST}:${port}`;
  // 启动时若恢复数据源会先完成扫描再监听，给足时间
  await waitFor(api + '/api/config', 180000);

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
  createWindow(url);
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    title: '学问 Workbench', show: false, backgroundColor: winBg,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  win.loadURL(url);
  win.on('closed', () => { win = null; });
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

app.on('window-all-closed', () => app.quit());
app.on('before-quit', stopChildren);
app.on('will-quit', stopChildren);
process.on('exit', stopChildren);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopChildren(); app.quit(); });
