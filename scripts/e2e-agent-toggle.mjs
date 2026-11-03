// 智能助手总开关 UI e2e（specs/2026-11-03-agent-toggle.md G3）：起后端 + BrowserWindow，临时语料与数据目录。
// 默认关闭：顶栏无入口、⌘J/Ctrl+J 被忽略、快捷键清单与命令面板无助手、/agent 回到概览并提示、
// 阅读页无 AI 按钮、选区浮动条只有「记笔记」，且整个关闭阶段页面不请求任何 /api/agent 接口。
// 设置页打开开关（不重载页面）：上述入口全部出现，⌘J 打开浮层，阅读页 AI 按钮打开面板，「问 AI」出现。
// 浮层开着时关闭开关：浮层收起；回到阅读页：入口全部消失、面板不在、正文区恢复原宽度。
// 运行：npm run build && ./node_modules/.bin/electron scripts/e2e-agent-toggle.mjs
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = makeTmpDir('wb-agent-toggle-ui-');
const corpus = path.join(tmp, 'corpus');
fs.mkdirSync(corpus, { recursive: true });
const DOC = '论语.md';
const PHRASE = '学而时习之不亦说乎有朋自远方来';
fs.writeFileSync(path.join(corpus, DOC), `# 论语\n\n${PHRASE}，不亦乐乎。\n\n人不知而不愠，不亦君子乎。\n`);

let server, win, passed = 0;
atExit(() => server?.kill('SIGKILL'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('window-all-closed', () => {});
const exec = (js) => win.webContents.executeJavaScript(js, true);
async function until(js, ms = 6000) {
  const t0 = Date.now();
  for (;;) {
    if (await exec(js)) return;
    if (Date.now() - t0 > ms) throw new Error('等待超时 ' + js);
    await pause(50);
  }
}
const check = (name, ok, detail) => {
  assert.ok(ok, name + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
  console.log('PASS', name);
  passed++;
};
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

// 页面发出的 /api/agent 请求（关闭阶段应为空）
const agentRequests = [];

// ---------- 页内动作 ----------
// 派发快捷键：返回事件是否被 preventDefault（关闭时 ⌘J 应被完全忽略）
const pressKey = (init) => exec(`(() => {
  const ev = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(init)}));
  document.body.dispatchEvent(ev);
  return ev.defaultPrevented;
})()`);
const escape = () => exec(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
const quickOpen = () => exec(`!!document.querySelector('textarea[placeholder^="问点什么"]')`);
const topbarHasAgent = () => exec(`!!document.querySelector('header a[href="/agent"]') || document.querySelector('header').textContent.includes('智能助手')`);
// SPA 内跳转（不整页加载，开关状态只在内存里变化）
const spaGo = async (to) => {
  await exec(`(() => { history.pushState({}, '', ${JSON.stringify(to)}); dispatchEvent(new PopStateEvent('popstate', { state: {} })); return true; })()`);
  await until(`decodeURIComponent(location.pathname) === ${JSON.stringify(decodeURIComponent(to.split('?')[0]))}`);
};
async function shortcutsList() {
  await exec(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })); true`);
  await until(`[...document.querySelectorAll('[role=dialog]')].some((d) => d.textContent.includes('快捷键'))`);
  const text = await exec(`[...document.querySelectorAll('[role=dialog]')].find((d) => d.textContent.includes('快捷键')).textContent`);
  await escape();
  await until(`![...document.querySelectorAll('[role=dialog]')].some((d) => d.textContent.includes('快捷键'))`);
  return text;
}
// 命令面板里搜「助手」，返回可见条目文字
async function paletteSearch(q) {
  await pressKey({ key: 'k', metaKey: true });
  await until(`!!document.querySelector('[cmdk-input]')`);
  await exec(`(() => {
    const input = document.querySelector('[cmdk-input]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(q)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await pause(300);
  const items = await exec(`[...document.querySelectorAll('[cmdk-item]')].map((el) => el.textContent.trim())`);
  await escape();
  await until(`!document.querySelector('[cmdk-input]')`);
  return items;
}
// 阅读页：在正文里选中 PHRASE 并派发 mouseup，返回浮动条按钮文字
async function selectionBar() {
  const diag = await exec(`(() => {
    const card = document.querySelector('[data-wb-content-card]');
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(${JSON.stringify(PHRASE.slice(0, 6))});
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, Math.min(n.data.length, i + 6));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      card.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return 'OK:' + sel.toString();
    }
    return 'NO-TEXT';
  })()`);
  assert.ok(String(diag).startsWith('OK:'), '选区失败: ' + diag);
  await until(`!!document.querySelector('[data-wb-selbar]')`);
  const buttons = await exec(`[...document.querySelectorAll('[data-wb-selbar] button')].map((b) => b.textContent.trim())`);
  // 收起浮动条：点正文外
  await exec(`window.getSelection().removeAllRanges(); document.querySelector('header').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); true`);
  await until(`!document.querySelector('[data-wb-selbar]')`);
  return buttons;
}
const aiButton = () => exec(`!!document.querySelector('button[title^="AI 助手"]')`);
const aiPanel = () => exec(`!!document.querySelector('aside[data-wb-overlay]')`);
const contentWidth = () => exec(`Math.round(document.querySelector('[data-wb-content-card]').getBoundingClientRect().width)`);
async function openRead() {
  await spaGo('/read/' + enc(DOC));
  await until(`!!document.querySelector('[data-wb-content-card]') && document.querySelector('[data-wb-content-card]').textContent.includes(${JSON.stringify(PHRASE.slice(0, 6))})`, 8000);
  await pause(300);
}
async function setToggle(on) {
  await spaGo('/settings');
  await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '智能助手')`);
  await exec(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '智能助手').click(); true`);
  await until(`!!document.querySelector('[data-agent-toggle-section] button[role=switch]')`);
  const sw = `document.querySelector('[data-agent-toggle-section] button[role=switch]')`;
  await until(`!${sw}.disabled`);
  const was = await exec(`${sw}.getAttribute('aria-checked') === 'true'`);
  if (was !== on) await exec(`${sw}.click(); true`);
  await until(`${sw}.getAttribute('aria-checked') === '${on}' && !${sw}.disabled`);
  const saved = await fetch(base + '/api/ui-settings').then((r) => r.json());
  return saved.agentEnabled;
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
  await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseDir: corpus }) });
  await pause(800); // 等扫描与索引
  await app.whenReady();
  win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  win.webContents.session.webRequest.onCompleted({ urls: [base + '/api/agent/*'] }, (d) => agentRequests.push(`${d.method} ${new URL(d.url).pathname} ${d.statusCode}`));

  // ================= 默认关闭 =================
  console.log('— 默认关闭');
  check('后端缺省 agentEnabled:false', (await fetch(base + '/api/ui-settings').then((r) => r.json())).agentEnabled === false);
  await win.loadURL(base + '/');
  await until(`!!document.querySelector('header a[href="/settings"]')`);
  await pause(500); // 启动读取界面设置完成
  check('顶栏没有「智能助手」', !(await topbarHasAgent()));
  const metaJ = await pressKey({ key: 'j', metaKey: true });
  const ctrlJ = await pressKey({ key: 'j', ctrlKey: true });
  await pause(400);
  check('⌘J / Ctrl+J 被忽略：不出现浮层、不拦截按键', !(await quickOpen()) && !metaJ && !ctrlJ, { metaJ, ctrlJ });
  const help = await shortcutsList();
  check('快捷键清单没有 ⌘J 浮层助手一行', !help.includes('⌘J') && !help.includes('浮层智能助手'), help);
  const items = await paletteSearch('助手');
  check('命令面板搜「助手」没有智能助手', !items.some((t) => t.includes('智能助手')), items);
  const pages = await paletteSearch('');
  check('命令面板页面组不列智能助手', pages.length > 0 && !pages.some((t) => t.includes('智能助手')), pages);

  // 地址栏直接访问 /agent
  await win.loadURL(base + '/agent');
  await until(`location.pathname === '/'`, 8000);
  await until(`document.body.textContent.includes('智能助手已关闭，可在 设置 → 智能助手 中打开')`);
  check('地址栏访问 /agent 落到 / 并出现提示 toast', !!(await exec(`document.querySelector('[data-toast-kind]')`)));
  // 应用内旧链接跳 /agent
  await spaGo('/browse');
  await exec(`(() => { history.pushState({}, '', '/agent'); dispatchEvent(new PopStateEvent('popstate', { state: {} })); return true; })()`);
  await until(`location.pathname === '/'`);
  check('应用内跳转 /agent 同样回到 /', true);

  await openRead();
  check('阅读页没有 AI 按钮', !(await aiButton()));
  check('阅读页没有 AI 面板', !(await aiPanel()));
  const widthOff = await contentWidth();
  const barOff = await selectionBar();
  check('选区浮动条有「记笔记」、没有「问 AI」', barOff.some((t) => t.includes('记笔记')) && !barOff.some((t) => t.includes('问 AI')), barOff);
  check('关闭阶段页面没有请求任何 /api/agent 接口', agentRequests.length === 0, agentRequests);

  // ================= 设置页打开（不重载） =================
  console.log('— 设置页打开开关');
  await exec(`window.__agentToggleMarker = 'same-page'; true`); // 页面若重载，这个标记会丢
  check('设置页打开开关并已保存到服务端', (await setToggle(true)) === true);
  check('未重载页面（同一页面实例）', (await exec(`window.__agentToggleMarker`)) === 'same-page');
  check('顶栏出现「智能助手」', await topbarHasAgent());
  const metaJOn = await pressKey({ key: 'j', metaKey: true });
  await until(`!!document.querySelector('textarea[placeholder^="问点什么"]')`);
  check('⌘J 打开浮层助手', metaJOn === true);
  await escape();
  await until(`!document.querySelector('textarea[placeholder^="问点什么"]')`);
  await pressKey({ key: 'j', ctrlKey: true });
  await until(`!!document.querySelector('textarea[placeholder^="问点什么"]')`);
  check('Ctrl+J 打开浮层助手', true);
  await escape();
  await until(`!document.querySelector('textarea[placeholder^="问点什么"]')`);
  check('快捷键清单出现 ⌘J 一行', (await shortcutsList()).includes('浮层智能助手'));
  check('命令面板搜「助手」出现智能助手', (await paletteSearch('助手')).some((t) => t.includes('智能助手')));
  await exec(`document.querySelector('header a[href="/agent"]').click(); true`);
  await until(`location.pathname === '/agent' && !!document.querySelector('textarea')`, 8000);
  check('顶栏入口进入 /agent 完整页', true);

  await openRead();
  check('阅读页出现 AI 按钮', await aiButton());
  await exec(`document.querySelector('button[title^="AI 助手"]').click(); true`);
  await until(`!!document.querySelector('aside[data-wb-overlay] textarea, aside[data-wb-overlay] [contenteditable=true]')`, 8000);
  check('AI 按钮打开阅读页面板', await aiPanel());
  const widthPanel = await contentWidth();
  check('面板打开时正文区变窄', widthPanel < widthOff, { widthOff, widthPanel });
  const barOn = await selectionBar();
  check('选区浮动条出现「问 AI」与「记笔记」', barOn.some((t) => t.includes('问 AI')) && barOn.some((t) => t.includes('记笔记')), barOn);

  // ================= 关闭（浮层开着时） =================
  console.log('— 再关闭开关');
  await spaGo('/settings');
  await exec(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '智能助手').click(); true`);
  await until(`!!document.querySelector('[data-agent-toggle-section] button[role=switch]')`);
  await pressKey({ key: 'j', metaKey: true });
  await until(`!!document.querySelector('textarea[placeholder^="问点什么"]')`);
  // 浮层不拦焦点：键盘用户可以 Tab 到背后的开关；这里直接点开关
  await exec(`document.querySelector('[data-agent-toggle-section] button[role=switch]').click(); true`);
  await until(`document.querySelector('[data-agent-toggle-section] button[role=switch]').getAttribute('aria-checked') === 'false'`);
  await until(`!document.querySelector('textarea[placeholder^="问点什么"]')`);
  check('关闭时开着的浮层收起', true);
  check('关闭已保存到服务端', (await fetch(base + '/api/ui-settings').then((r) => r.json())).agentEnabled === false);
  check('顶栏「智能助手」消失', !(await topbarHasAgent()));
  await pressKey({ key: 'j', metaKey: true });
  await pause(400);
  check('⌘J 不再打开浮层', !(await quickOpen()));
  check('快捷键清单不再有 ⌘J', !(await shortcutsList()).includes('⌘J'));
  check('命令面板不再有智能助手', !(await paletteSearch('助手')).some((t) => t.includes('智能助手')));
  // 回到刚才开着 AI 面板的阅读页
  await exec(`history.back(); true`);
  await until(`decodeURIComponent(location.pathname) === ${JSON.stringify('/read/' + DOC)}`);
  await until(`!!document.querySelector('[data-wb-content-card]')`, 8000);
  await pause(500);
  check('阅读页 AI 按钮消失', !(await aiButton()));
  check('阅读页 AI 面板已收起', !(await aiPanel()));
  const widthBack = await contentWidth();
  check('正文区恢复原宽度', widthBack === widthOff, { widthOff, widthBack });
  const barBack = await selectionBar();
  check('选区浮动条只剩「记笔记」', barBack.some((t) => t.includes('记笔记')) && !barBack.some((t) => t.includes('问 AI')), barBack);
  await exec(`(() => { history.pushState({}, '', '/agent'); dispatchEvent(new PopStateEvent('popstate', { state: {} })); return true; })()`);
  await until(`location.pathname === '/'`);
  check('关闭后再访问 /agent 回到 /', true);

  // ================= 保存失败 =================
  console.log('— 保存失败');
  await spaGo('/settings');
  await exec(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '智能助手').click(); true`);
  await until(`!!document.querySelector('[data-agent-toggle-section] button[role=switch]')`);
  // 只让这一次保存失败（模拟服务端写盘出错），读取照常
  await exec(`(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      if (String(url).includes('/api/ui-settings') && options?.method === 'PUT') {
        window.fetch = original;
        return new Response(JSON.stringify({ error: '模拟写盘失败' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      return original(url, options);
    };
    return true;
  })()`);
  await exec(`document.querySelector('[data-agent-toggle-section] button[role=switch]').click(); true`);
  await until(`document.body.textContent.includes('智能助手开关保存失败：模拟写盘失败')`);
  await until(`(() => { const sw = document.querySelector('[data-agent-toggle-section] button[role=switch]'); return sw.getAttribute('aria-checked') === 'false' && !sw.disabled; })()`);
  check('保存失败：提示错误且开关回到服务端实际值（关）', true);
  check('保存失败后入口仍隐藏', !(await topbarHasAgent()));
  console.log(`\n全部通过：${passed} 项`);
}

main().then(() => finish(0), (e) => { console.error(e); return finish(1); });
async function finish(code) {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  win?.destroy();
  app.exit(code);
}
