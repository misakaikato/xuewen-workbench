// 反馈第 2 批 UI 回归（G4/G5，mock 后端）：
// - G5：运行时保持 loading 2.5s，测试台「测试」按钮立即忙碌，加载态文字含「首次加载嵌入模型」
// - G4：构建进度区出现阶段文字/文件计数/当前文件；暂停出现「正在暂停…」，最终停在已暂停
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rag-fb2-'));
const port = Number(process.env.E2E_RAGFB_PORT) || 7495;
const base = `http://127.0.0.1:${port}`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let server, win, passed = 0;
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
const setNativeValue = (el, v) => `(() => { const el = ${el};
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)});
  el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

async function main() {
  // 语料：先只放 a.md（预置一条已完成的索引，检索测试台开箱可用，且首次构建不会自动发生）
  const corpus = path.join(tmp, 'corpus');
  fs.mkdirSync(corpus, { recursive: true });
  fs.writeFileSync(path.join(corpus, 'a.md'), '# 预置\n\n预置内容：麒麟踏云。');
  // 预置 rag.db（在 Electron-as-node 子进程里跑，避免主进程加载原生模块）
  const preseed = path.join(tmp, 'preseed.mjs');
  fs.writeFileSync(preseed, `
import fs from 'node:fs';
import path from 'node:path';
import { dsIdFor } from ${JSON.stringify(path.join(root, 'server/store.js'))};
import { RagStore } from ${JSON.stringify(path.join(root, 'server/rag/store.js'))};
import { DIM } from ${JSON.stringify(path.join(root, 'server/rag/embed.js'))};
const corpus = ${JSON.stringify(corpus)};
const dataDir = ${JSON.stringify(path.join(tmp, 'data'))};
const dsId = dsIdFor(corpus);
const rs = new RagStore(path.join(dataDir, 'knowledge', dsId, 'rag.db'));
rs.metaSet('dim', String(DIM));
const st = fs.statSync(path.join(corpus, 'a.md'));
rs.replaceChunks('a.md', st.mtimeMs + ':' + st.size, [{ headingPath: '预置', text: '预置内容：麒麟踏云。' }], 'md', () => '预置 内容 麒麟 踏云');
const ids = rs.db.prepare('SELECT id FROM chunks WHERE path=?').all('a.md').map((r) => r.id);
rs.writeVecs(ids.map((id) => ({ id, vec: new Float32Array(DIM) })));
rs.markFileDone('a.md');
rs.close();
console.log('preseed ok', dsId);
`);
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [preseed], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('preseed exit ' + c))));
  });

  // mock 后端 + 可控延迟（只作用于 mock）：加载 2.5s、每次嵌入 2s（拉长构建窗口）
  server = spawn(process.execPath, [path.join(root, 'server/index.js')], {
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_DATA_DIR: path.join(tmp, 'data'), WORKBENCH_STATIC_DIR: path.join(root, 'dist'),
      WORKBENCH_RAG_EMBED: 'mock', WORKBENCH_RAG_MOCK_LOAD_MS: '2500', WORKBENCH_RAG_MOCK_EMBED_MS: '2000',
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
  win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true } });

  // ---- G5：测试台首次检索触发运行时加载（2.5s） ----
  await win.loadURL(base + '/rag');
  await until('!!document.querySelector("input[placeholder^=\'输入问题测试\']")');
  await exec(setNativeValue(`document.querySelector("input[placeholder^='输入问题测试']")`, '预置'));
  await exec(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '测试').click()`);
  await until(`document.querySelector("button:not([disabled])") && [...document.querySelectorAll('button')].some((b) => b.getAttribute('aria-busy') === 'true')`, 3000);
  check('G5 点测试后按钮立即 aria-busy', await exec(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('测试') && b.getAttribute('aria-busy') === 'true')`));
  await until('!!document.querySelector("[data-rag-test-loading]")', 4000);
  // 轮询拿到 runtime loading 最多滞后 1s：等文字就位再断言（仍在 2.5s 加载窗口内）
  await until(`document.querySelector('[data-rag-test-loading]') && document.querySelector('[data-rag-test-loading]').textContent.includes('首次加载嵌入模型')`, 4000);
  const loadText = await exec(`document.querySelector('[data-rag-test-loading]').textContent`);
  check('G5 加载态文字含「首次加载嵌入模型」', loadText.includes('首次加载嵌入模型'), loadText);
  await until(`!document.querySelector('[data-rag-test-loading]') && document.body.textContent.includes('共 ')`, 15000);
  check('G5 检索完成出结果', await exec(`document.body.textContent.includes('段（显示')`));

  // ---- G4：新增 6 个文件 → 重扫后自动增量构建（每次嵌入 2s，窗口足够观察与暂停） ----
  for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(corpus, 'g' + i + '.md'), '# 增量' + i + '\n\n增量内容' + i + '：星河鹭起。');
  await api('/api/rescan', {});
  let building = false;
  for (let i = 0; i < 150; i++) {
    const s = await api('/api/rag/status');
    if (s.index?.state === 'building') { building = true; break; }
    await pause(200);
  }
  assert.ok(building, '服务端进入 building');
  await until('!!document.querySelector("[data-rag-index-progress]")', 8000);
  const phase = await exec(`document.querySelector('[data-rag-index-progress] [data-rag-phase]').textContent`);
  check('G4 进度区出现阶段文字', /切块|嵌入|等待文本索引|加载模型/.test(phase), phase);
  check('G4 进度区出现文件计数', await exec(`!!document.querySelector('[data-rag-index-progress]') && /个文件/.test(document.querySelector('[data-rag-index-progress]').textContent)`));
  await until('!!document.querySelector("[data-rag-current-file]")', 15000);
  const curFile = await exec(`document.querySelector('[data-rag-current-file]').textContent`);
  check('G4 显示当前文件名', curFile.includes('.md'), curFile);
  // 点暂停 → 出现「正在暂停…」→ 最终停在已暂停
  await exec(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '暂停').click()`);
  await until(`document.body.textContent.includes('正在暂停…')`, 6000);
  check('G4 暂停后出现「正在暂停…」', true);
  await until(`[...document.querySelectorAll('.bg-card')].some((c) => c.textContent.includes('已暂停'))`, 20000);
  check('G4 最终停在已暂停', await exec(`!(document.querySelector('[data-rag-index-progress]'))`));

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
