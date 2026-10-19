// 真实 Electron 回归：智能结果中的 TXT 段落定位（查询词不在正文/同词多段/重复片段）。
// 先 npm run build，再 electron scripts/e2e-search-location.mjs。
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-search-location-'));
const corpus = path.join(tmp, 'corpus');
fs.mkdirSync(corpus);
const paragraphs = Array.from({ length: 42 }, (_, i) =>
  `段落编号${i + 1}：共同线索。` + '用于撑长正文，验证点击后续结果时不会跳到第一处。'.repeat(36));
// 两段前 160 字符相同，验证重复定位文本的 occurrence。
paragraphs[36] = paragraphs[35];
fs.writeFileSync(path.join(corpus, '定位测试.txt'), paragraphs.join('\r\n\r\n'));
const port = Number(process.env.E2E_LOCATION_PORT) || 7494;
const base = `http://127.0.0.1:${port}`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
let win;
app.on('window-all-closed', () => {});
const post = async (url, body) => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await r.json();
  assert.ok(r.ok, JSON.stringify(json));
  return json;
};
const exec = (js) => win.webContents.executeJavaScript(js, true);
async function until(js) {
  for (let i = 0; i < 100; i++) {
    if (await exec(js)) return;
    await pause(100);
  }
  throw new Error('等待超时：' + js);
}

async function main() {
  server = spawn(process.execPath, [path.join(root, 'server/index.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_PORT: String(port),
      WORKBENCH_HOST: '127.0.0.1', WORKBENCH_DATA_DIR: path.join(tmp, 'data'),
      WORKBENCH_STATIC_DIR: path.join(root, 'dist'), WORKBENCH_RAG_EMBED: 'mock' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/config')).ok) { ready = true; break; } } catch { /* 启动中 */ }
    await pause(100);
  }
  assert.ok(ready, 'API 启动');
  await post('/api/config', { baseDir: corpus });
  const configResponse = await fetch(base + '/api/rag/config', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ search: { topN: 100, rrfMin: 0.001 } }) });
  assert.ok(configResponse.ok);
  await pause(500); // 等资料库扫描完成后建索引
  await post('/api/rag/index/build', { rebuild: true });
  let hits = [];
  for (let i = 0; i < 150; i++) {
    const r = await fetch(base + '/api/rag/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: '共同线索', limit: 100 }) });
    if (r.ok) hits = (await r.json()).hits;
    if (hits.length >= 40) break;
    await pause(100);
  }
  assert.ok(hits.length >= 40, '索引已生成并返回实际命中块');
  console.log('索引定位字段验证完成：', hits.length);
  await app.whenReady();
  win = new BrowserWindow({ width: 1280, height: 860, show: false,
    webPreferences: { sandbox: true, contextIsolation: true } });
  for (const query of ['不存在于正文的语义问题', '共同线索']) {
    await win.loadURL(base + '/search');
    await until('!!document.querySelector(\'input[placeholder^="用自然语言"]\')');
    console.log('检索页就绪：', query);
    // 复用真实索引返回的段落，强制模拟纯语义召回，排除 mock 嵌入随机排序的干扰。
    await exec(`(() => {
      const original = window.fetch.bind(window);
      const hits = ${JSON.stringify(hits.filter((h) => h.ordinal >= 35 && h.ordinal <= 36).sort((a, b) => a.ordinal - b.ordinal).map((h) => process.env.E2E_LEGACY_LOCATION ? { ...h, location: undefined } : h))};
      window.fetch = (url, options) => String(url).includes('/api/rag/search')
        ? Promise.resolve(new Response(JSON.stringify({ hits, total: hits.length, took: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        : original(url, options);
      const input = document.querySelector('input[placeholder^="用自然语言"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until('document.querySelectorAll("main ul li").length === 2');
    console.log('结果已加载');
    const clicked = await exec(`(() => {
      const cards = [...document.querySelectorAll('main ul li')];
      cards[1].querySelector('button').click();
      return true;
    })()`);
    assert.ok(clicked);
    await until('!!document.querySelector("[data-wb-content-card]")');
    await pause(1200);
    const state = await exec(`(() => {
      const sc = document.querySelector('.wb-paper');
      const content = document.querySelector('[data-wb-content-card]');
      const node = [...content.childNodes].find((n) => n.nodeType === 1);
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const texts = []; let n; while ((n = walker.nextNode())) texts.push(n);
      const full = texts.map((t) => t.data).join('');
      const start = full.indexOf('段落编号36');
      const pos = full.indexOf('段落编号36', start + 1);
      let offset = 0; const range = document.createRange();
      for (const t of texts) {
        if (pos >= offset && pos < offset + t.length) {
          range.setStart(t, pos - offset); range.setEnd(t, pos - offset + 6); break;
        }
        offset += t.length;
      }
      const rect = range.getBoundingClientRect(), viewport = sc.getBoundingClientRect();
      return { scroll: sc.scrollTop, visible: rect.top >= viewport.top && rect.bottom <= viewport.bottom,
        hit: new URL(location.href).searchParams.has('hit') };
    })()`);
    assert.ok(state.visible && state.scroll > 1000 && state.hit, JSON.stringify({ query, state }));
    console.log('PASS TXT 智能段落定位：' + query);
  }
}
main().then(() => finish(0), (e) => { console.error(e); return finish(1); });
async function finish(code) {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  win?.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(code);
}
