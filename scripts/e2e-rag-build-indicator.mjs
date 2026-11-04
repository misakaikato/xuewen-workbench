// RAG 索引构建期间离开 RAG 管理页，构建进度仍在顶栏可见（mock 后端，每次嵌入 1.5s 拉长构建窗口）：
// - 停在其他页面时，顶栏出现「正在构建 RAG 索引 n/m」，点它回到 RAG 管理页
// - 构建完成后顶栏指示消失
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = makeTmpDir('wb-rag-build-ind-');
const port = Number(process.env.E2E_RAGBUILD_PORT) || 7498;
const base = `http://127.0.0.1:${port}`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let server, win, passed = 0;
atExit(() => server?.kill('SIGKILL'));
app.on('window-all-closed', () => {});
const exec = (js) => win.webContents.executeJavaScript(js, true);
async function until(js, ms = 10000) {
  for (let i = 0; i < Math.ceil(ms / 100); i++) { if (await exec(js)) return; await pause(100); }
  throw new Error('等待超时：' + js);
}
const check = (name, ok, detail) => { assert.ok(ok, name + ': ' + JSON.stringify(detail)); console.log('PASS', name); passed++; };
async function api(url, body) {
  const r = await fetch(base + url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); assert.ok(r.ok, JSON.stringify(j)); return j;
}
// 应用内跳转（不重载页面，组件真正卸载/挂载）
const spaGo = (to) => exec(`history.pushState({}, '', ${JSON.stringify(to)}); dispatchEvent(new PopStateEvent('popstate')); true`);
const INDICATOR = '[data-testid="rag-index-indicator"]';

async function main() {
  const corpus = path.join(tmp, 'corpus');
  fs.mkdirSync(corpus, { recursive: true });
  for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(corpus, 'n' + i + '.md'), '# 笔记' + i + '\n\n正文' + i + '：星河鹭起。');

  server = spawn(process.execPath, [path.join(root, 'server/index.js')], {
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_DATA_DIR: path.join(tmp, 'data'), WORKBENCH_STATIC_DIR: path.join(root, 'dist'),
      WORKBENCH_RAG_EMBED: 'mock', WORKBENCH_RAG_MOCK_EMBED_MS: '1500',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/config')).ok) { ready = true; break; } } catch { /* 启动中 */ }
    await pause(100);
  }
  assert.ok(ready, 'server ready');
  await api('/api/config', { baseDir: corpus });
  await app.whenReady();
  win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });

  await win.loadURL(base + '/rag');
  const buildBtn = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '构建索引' && !b.disabled)`;
  await until(`!!${buildBtn}`);
  await exec(`${buildBtn}.click()`);
  await until('!!document.querySelector("[data-rag-index-progress]")', 8000);
  check('RAG 管理页出现构建进度', true);

  // 停在其他页面：顶栏显示构建进度
  await spaGo('/settings');
  await until(`location.pathname === '/settings' && !document.querySelector('[data-rag-index-progress]')`);
  await until(`!!document.querySelector('${INDICATOR}')`, 5000);
  const text = await exec(`document.querySelector('${INDICATOR}').textContent`);
  check('其他页面顶栏显示「正在构建 RAG 索引」', text.includes('正在构建 RAG 索引'), text);
  await until(`/\\d+\\/6/.test(document.querySelector('${INDICATOR}')?.textContent || '')`, 5000);
  check('顶栏指示带文件计数', true);

  // 点顶栏指示回到 RAG 管理页
  await exec(`document.querySelector('${INDICATOR}').click()`);
  await until(`location.pathname === '/rag' && !!document.querySelector('[data-rag-index-progress]')`, 4000);
  check('点顶栏指示回到 RAG 管理页并看到进度', true);

  // 完成后顶栏指示消失
  await spaGo('/settings');
  let done = false;
  for (let i = 0; i < 300; i++) {
    const s = await api('/api/rag/status');
    if (s.index.state !== 'building' && s.index.state !== 'pausing') { assert.equal(s.index.state, 'ready', JSON.stringify(s.index)); done = true; break; }
    await pause(200);
  }
  assert.ok(done, '构建在 60 秒内结束');
  await until(`!document.querySelector('${INDICATOR}')`, 4000);
  check('构建完成后顶栏指示消失', true);

  console.log(passed + ' checks passed.');
}
main().then(() => finish(0), (e) => { console.error(e); return finish(1); });
async function finish(code) {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
  }
  win?.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(code);
}
