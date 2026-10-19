// P0/P1 动效与外观改动后的视觉验证截图：三主题 Dashboard + 侧栏折叠终态。
// 用法：node_modules/.bin/electron scripts/e2e-ui-shots.mjs <输出目录>
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2] || path.join(ROOT, 'docs', 'ui-shots');
const PORT = 7497;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
const tmpObj = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-shots-'));
const tmpData = path.join(tmpObj, 'data');
const tmpCorpus = path.join(tmpObj, 'test-data');

async function waitApi() {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(BASE + '/api/config');
      if (r.ok) return;
    } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 30000) throw new Error('服务等待超时');
    await sleep(200);
  }
}

let win = null;
let server = null;

async function main() {
  fs.cpSync(path.join(ROOT, 'test-data'), tmpCorpus, { recursive: true });
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WORKBENCH_PORT: String(PORT),
      WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_DATA_DIR: tmpData,
      WORKBENCH_STATIC_DIR: path.join(ROOT, 'dist'),
      WORKBENCH_RAG_EMBED: 'mock',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  await waitApi();
  await fetch(BASE + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseDir: path.join(tmpCorpus, 'ds-a') }),
  });
  await app.whenReady();
  win = new BrowserWindow({
    width: 1440, height: 900, show: false, paintWhenInitiallyHidden: true,
    // 与 electron/main.js 一致：验证 hiddenInset 顶栏布局（pl-[78px] + 拖拽区）
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const exec = (js) => win.webContents.executeJavaScript(js, true);
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    console.log('shot:', name);
  };

  for (const theme of ['A', 'B', 'C']) {
    // 主题是服务端权威持久化：走 API 切换，themedIndexHtml 会在首帧注入 data-theme
    await fetch(BASE + '/api/ui-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    });
    await win.loadURL(BASE + '/');
    await sleep(2500); // 等扫描/统计与路由入场动画完成
    await shot(`dashboard-${theme}.png`);
    if (theme === 'A') {
      // 命令面板：⌘K 打开（空白查询 = 最近/固定/页面/动作）
      await exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true })); true`);
      await sleep(500);
      await shot('palette-empty.png');
      // 输入查询：文件过滤 + 全文检索项
      await exec(`document.querySelector('[cmdk-input]')?.focus(); true`);
      await exec(`(() => { const i = document.querySelector('input[placeholder^="检索文件"]'); if (!i) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(i, '第'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await sleep(500);
      await shot('palette-query.png');
      await exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
      await sleep(300);
      // 快捷键清单
      await exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' })); true`);
      await sleep(400);
      await shot('shortcuts.png');
      await exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
      await sleep(300);
      // 折叠侧栏终态（动画 200ms，等 400ms 截终态）
      await exec(`document.querySelector('button[aria-label="折叠侧栏"]')?.click(); true`);
      await sleep(450);
      await shot(`dashboard-${theme}-collapsed.png`);
      await exec(`document.querySelector('button[aria-label="折叠侧栏"]')?.click(); true`);
      await sleep(450);
      // 阅读页：取树里第一个 md
      const href = await exec(`(() => { const a = document.querySelector('aside a[href^="/read/"]'); return a ? a.getAttribute('href') : null; })()`);
      if (href) {
        await win.loadURL(BASE + href);
        await sleep(1800);
        await shot(`read-${theme}.png`);
      }
    }
  }
  console.log('done ->', OUT);
  await app.exit(0);
}

main().catch((e) => { console.error(e); app.exit(1); });
