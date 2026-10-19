// Electron 验证：模型错误、空内容、异常 EOF、部分正文、主动停止均有可见反馈。
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-agent-feedback-'));
const port = 7493;
const base = `http://127.0.0.1:${port}`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let server, win;
app.on('window-all-closed', () => {});
const exec = (js) => win.webContents.executeJavaScript(js, true);
async function until(js) {
  for (let i = 0; i < 100; i++) { if (await exec(js)) return; await pause(100); }
  throw new Error('等待超时：' + js);
}
async function main() {
  server = spawn(process.execPath, [path.join(root, 'server/index.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_DATA_DIR: path.join(tmp, 'data'), WORKBENCH_STATIC_DIR: path.join(root, 'dist'), WORKBENCH_RAG_EMBED: 'mock' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/config')).ok) break; } catch { /* 启动中 */ }
    await pause(100);
  }
  const corpus = path.join(tmp, 'corpus'); fs.mkdirSync(corpus);
  await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseDir: corpus }) });
  await app.whenReady();
  win = new BrowserWindow({ width: 1280, height: 860, show: false,
    webPreferences: { sandbox: true, contextIsolation: true } });
  for (const scenario of ['context', 'empty', 'connection', 'partial', 'cancelled', 'success']) {
    await win.loadURL(base + '/agent');
    await until('!!document.querySelector("textarea")');
    await exec(`(() => {
      const original = window.fetch.bind(window);
      const scenario = ${JSON.stringify(scenario)};
      const response = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      window.fetch = async (url, options) => {
        if (String(url).includes('/api/agent/status')) return response({ endpoint: { ready: true, baseUrl: 'http://localhost:1234/v1', model: 'mock' }, skills: [], conversations: [] });
        if (String(url).includes('/api/agent/session')) return response({ id: 'feedback-test', messages: [] });
        if (!String(url).includes('/api/agent/chat')) return original(url, options);
        if (scenario === 'cancelled') return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError'))));
        const frame = (event) => 'data: ' + JSON.stringify(event) + '\\n\\n';
        let events = [];
        if (scenario === 'context') events = [{ t: 'error', failure: { kind: 'context', title: '模型上下文超限', message: '请求超过 8192 tokens，请在 LM Studio 调整。', details: 'exceed_context_size_error' } }, { t: 'done' }];
        if (scenario === 'empty') events = [{ t: 'done' }];
        if (scenario === 'partial') events = [{ t: 'delta', v: '已经收到的部分回答' }];
        if (scenario === 'success') events = [{ t: 'delta', v: '正常回答' }, { t: 'done' }];
        return new Response(events.map(frame).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
      };
    })()`);
    await until('!document.querySelector("textarea").disabled');
    await exec(`(() => {
      const input = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '测试问题');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await pause(100);
    await exec(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '发送').click()`);
    if (scenario === 'cancelled') {
      await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '停止')`);
      await exec(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '停止').click()`);
    }
    if (scenario === 'success') {
      await until('document.body.textContent.includes("正常回答")');
      assert.equal(await exec('!!document.querySelector("[data-agent-failure]")'), false);
    } else {
      try { await until('!!document.querySelector("[data-agent-failure]")'); }
      catch (e) { console.error(await exec('document.body.innerText')); throw e; }
      const text = await exec('document.querySelector("[data-agent-failure]").textContent');
      const expected = { context: '8192', empty: '没有收到正文', connection: '回答连接中断', partial: '回答连接中断', cancelled: '已停止生成' }[scenario];
      assert.ok(text.includes(expected), text);
      if (scenario === 'partial') assert.ok(await exec('document.body.textContent.includes("已经收到的部分回答")'));
      assert.ok(await exec(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '发送')`));
      if (scenario === 'context') {
        fs.writeFileSync('/tmp/wb-agent-feedback.png', (await win.webContents.capturePage()).toPNG());
        await exec(`[...document.querySelectorAll('[data-agent-failure] button')].find((b) => b.textContent === 'Agent 设置').click()`);
        await until('document.body.textContent.includes("测试连通")');
      }
    }
    console.log('PASS', scenario);
  }
}
main().then(() => finish(0), (e) => { console.error(e); return finish(1); });
async function finish(code) {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM'); await new Promise((resolve) => server.once('exit', resolve));
  }
  win?.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(code);
}
