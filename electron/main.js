// Electron 外壳：进程内启动 Express 后端（空闲端口，默认 7410），就绪后打开窗口。
// 开发模式（--dev）：同时启动 Vite（HMR），窗口加载 Vite 地址；打包模式：后端直接托管 dist/。
import { app, BrowserWindow, Menu, shell, dialog, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url)); // 本文件所在目录（electron/）
const ROOT = path.dirname(APP_DIR);
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
    // WORKBENCH_DATA_DIR 不设 → server/store.js 默认用 ~/XuewenWorkbenchData（用户目录，不跟 app 走）
  }
  if (!DEV) process.env.WORKBENCH_STATIC_DIR = path.join(ROOT, 'dist');

  // 删除操作交给系统回收站（失败时后端保留在数据源 .trash/ 中）
  const { setTrashHandler } = await import(pathToFileURL(path.join(ROOT, 'server', 'trash.js')).href);
  setTrashHandler((absPath) => shell.trashItem(absPath));

  // 自动更新：仅打包模式注入桥接（dev / 独立 dev:server 时功能停用）。
  // 必须在加载后端之前注入，路由挂载时才能拿到桥接。
  if (app.isPackaged) {
    const { createUpdaterBridge } = await import(pathToFileURL(path.join(ROOT, 'electron', 'updater.js')).href);
    const { getUiSettings } = await import(pathToFileURL(path.join(ROOT, 'server', 'store.js')).href);
    const { setUpdateBridge } = await import(pathToFileURL(path.join(ROOT, 'server', 'update.js')).href);
    setUpdateBridge(await createUpdaterBridge({ getUiSettings }));
  }

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

function createWindow(url) {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    title: '学问 Workbench', show: false, backgroundColor: winBg,
    icon: path.join(ROOT, 'assets', 'icons', 'icon.png'),
    // macOS：隐藏式标题栏，红绿灯内嵌顶栏（渲染侧顶栏做拖拽区，见 Layout wb-drag）
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(APP_DIR, 'preload.cjs') },
  });
  win.webContents.on('preload-error', (_e, p, err) => {
    console.error('[preload-error]', p, err && err.message ? err.message : err);
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
