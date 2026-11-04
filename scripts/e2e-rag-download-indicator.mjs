// 模型下载期间离开 RAG 管理页，下载进度仍在顶栏可见（ONNX 下载路径，假下载源慢速流式）：
// - 下载开始后切到设置页，再回 RAG 管理页：进度区照常显示
// - 停在其他页面时，顶栏出现「正在下载模型 xx%」，点它回到 RAG 管理页
// - 下载完成后顶栏指示消失
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = makeTmpDir('wb-rag-dl-ind-');
const port = Number(process.env.E2E_RAGDL_PORT) || 7497;
const base = `http://127.0.0.1:${port}`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let server, hostServer, win, passed = 0;
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
const INDICATOR = '[data-testid="rag-model-indicator"]';

// 假下载源：ONNX 五个文件，模型文件 8MB 以约 400KB/s 流式发送，下载窗口约 20 秒
const ONNX_FILES = {
  'config.json': Buffer.from(JSON.stringify({ file: 'config' })),
  'tokenizer.json': Buffer.from(JSON.stringify({ file: 'tok' })),
  'tokenizer_config.json': Buffer.from(JSON.stringify({ file: 'tokcfg' })),
  'special_tokens_map.json': Buffer.from(JSON.stringify({ file: 'stm' })),
  'onnx/model_fp16.onnx': crypto.randomBytes(8 * 1024 * 1024),
};
function startHost() {
  hostServer = http.createServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    const buf = ONNX_FILES[req.url.replace(/^\/.*?\/resolve\/main\//, '')];
    if (!buf) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Length': String(buf.length), 'Accept-Ranges': 'bytes' });
    if (req.method === 'HEAD') { res.end(); return; }
    let off = 0;
    const timer = setInterval(() => {
      if (off >= buf.length) { clearInterval(timer); res.end(); return; }
      const next = Math.min(buf.length, off + 16384);
      res.write(buf.subarray(off, next));
      off = next;
    }, 40);
    res.on('close', () => clearInterval(timer));
  });
  return new Promise((resolve) => hostServer.listen(0, '127.0.0.1', () => resolve(hostServer.address().port)));
}

async function main() {
  const corpus = path.join(tmp, 'corpus');
  fs.mkdirSync(corpus, { recursive: true });
  fs.writeFileSync(path.join(corpus, 'a.md'), '# 甲\n\n正文。');
  const hostPort = await startHost();

  server = spawn(process.execPath, [path.join(root, 'server/index.js')], {
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_DATA_DIR: path.join(tmp, 'data'), WORKBENCH_STATIC_DIR: path.join(root, 'dist'),
      WORKBENCH_RAG_EMBED: 'onnx', WORKBENCH_RAG_MODEL_HOSTS: `http://127.0.0.1:${hostPort}`,
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
  await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('下载模型'))`);
  await exec(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('下载模型')).click()`);
  await until('!!document.querySelector("[data-rag-model-progress]")', 8000);
  check('RAG 管理页出现下载进度', true);

  // 离开再回来：组件重新挂载后从后端状态恢复进度
  await spaGo('/settings');
  await until(`location.pathname === '/settings' && !document.querySelector('[data-rag-model-progress]')`);
  await spaGo('/rag');
  await until('!!document.querySelector("[data-rag-model-progress]")', 4000);
  check('回到 RAG 管理页进度照常显示', true);

  // 停在其他页面：顶栏显示下载进度
  await spaGo('/settings');
  await until(`!!document.querySelector('${INDICATOR}')`, 5000);
  const text = await exec(`document.querySelector('${INDICATOR}').textContent`);
  check('其他页面顶栏显示「正在下载模型」', text.includes('正在下载模型'), text);
  await until(`/\\d+%/.test(document.querySelector('${INDICATOR}')?.textContent || '')`, 5000);
  check('顶栏指示带百分比', true);

  // 点顶栏指示回到 RAG 管理页
  await exec(`document.querySelector('${INDICATOR}').click()`);
  await until(`location.pathname === '/rag' && !!document.querySelector('[data-rag-model-progress]')`, 4000);
  check('点顶栏指示回到 RAG 管理页并看到进度', true);

  // 完成后顶栏指示消失
  let done = false;
  for (let i = 0; i < 300; i++) {
    const s = await api('/api/rag/status');
    if (s.model.state !== 'downloading') { assert.equal(s.model.state, 'ready', JSON.stringify(s.model)); done = true; break; }
    await pause(200);
  }
  assert.ok(done, '下载在 60 秒内结束');
  await until(`!document.querySelector('${INDICATOR}')`, 4000);
  check('下载完成后顶栏指示消失', true);

  console.log(passed + ' checks passed.');
}
main().then(() => finish(0), (e) => { console.error(e); return finish(1); });
async function finish(code) {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
  }
  hostServer?.close();
  win?.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(code);
}
