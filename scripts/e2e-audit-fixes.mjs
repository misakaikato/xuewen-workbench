// 走查问题修复 e2e（specs/2026-11-03-audit-fixes.md）：起后端 + BrowserWindow，临时语料，mock 嵌入（RAG 索引为空）。
// 用法：electron scripts/e2e-audit-fixes.mjs [段号...]，不带参数跑全部。
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, atExit } from './tmpdirs.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = makeTmpDir('wb-audit-fixes-');
const corpus = path.join(tmp, 'corpus');
const W = (rel, s) => { fs.mkdirSync(path.dirname(path.join(corpus, rel)), { recursive: true }); fs.writeFileSync(path.join(corpus, rel), s); };
W('笔记/诗句.md', '# 诗句\n\n独有词：雪拥蓝关马不前。\n');
W('标签/改名前.md', '# 改名前\n\n用于标签跟随的文档。\n');
W('待改名目录/内文.md', '# 内文\n\n目录改名时标签也要跟着改。\n');
const longDoc = ['# 长文'];
for (let i = 1; i <= 40; i++) longDoc.push(`\n## 第 ${i} 节\n\n这是第 ${i} 节的正文，内容足够长用来撑开页面。这是第 ${i} 节的正文，内容足够长用来撑开页面。\n\n- 要点：第 ${i} 节`);
W('笔记/长文.md', longDoc.join('\n'));

const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const want = (n) => !only.length || only.includes(n);
const port = Number(process.env.E2E_AUDIT_PORT) || 7538;
const base = `http://127.0.0.1:${port}`;
let server, win, passed = 0;
atExit(() => server?.kill('SIGKILL'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('window-all-closed', () => {});
const exec = (js) => win.webContents.executeJavaScript(js, true);
async function until(js, ms = 8000) {
  const t0 = Date.now();
  for (;;) { if (await exec(js)) return true; if (Date.now() - t0 > ms) throw new Error('等待超时 ' + js); await pause(80); }
}
const check = (name, ok, detail) => { assert.ok(ok, name + ': ' + JSON.stringify(detail)); console.log('PASS', name); passed++; };
async function api(url, body, method = 'POST') {
  const r = await fetch(base + url, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  assert.ok(r.ok, url + ' -> ' + JSON.stringify(j));
  return j;
}
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const CARD = '[data-wb-content-card]';
const pageText = () => exec('document.body.innerText');
async function openRead(file, ready) {
  await win.loadURL(base + '/read/' + enc(file));
  await until(`!!document.querySelector('${CARD}') && document.querySelector('${CARD}').textContent.includes(${JSON.stringify(ready)})`);
  await pause(400);
}

// ---------- 1 检索：智能索引为空时改用精确，关键词入口带 mode=exact ----------
async function caseSearch() {
  await win.loadURL(base + '/search?q=' + encodeURIComponent('雪拥蓝关'));
  await until(`location.search.includes('mode=exact')`, 8000);
  await until(`document.body.innerText.includes('个文件命中') && !document.body.innerText.includes('0 个文件命中')`, 8000);
  const t = await pageText();
  check('1 智能索引为空：自动改用精确检索并出结果', t.includes('诗句.md'), t.slice(0, 300));
  check('1 智能索引为空：给出已改用精确检索的说明', t.includes('已改用精确检索'), t.slice(0, 300));

  await win.loadURL(base + '/');
  await until(`document.body.innerText.includes('知识库概览')`);
  await exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
  await until(`!!document.querySelector('[cmdk-input]')`);
  await exec(`(() => { const el=document.querySelector('[cmdk-input]'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(el,'雪拥蓝关'); el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await until(`[...document.querySelectorAll('[cmdk-item]')].some((e) => e.textContent.includes('全文检索'))`);
  await exec(`[...document.querySelectorAll('[cmdk-item]')].find((e) => e.textContent.includes('全文检索')).click()`);
  await until(`location.pathname === '/search'`);
  check('1 命令面板「全文检索」带 mode=exact', await exec(`location.search.includes('mode=exact')`), await exec('location.href'));
}

// ---------- 3 跳转后目标不被吸顶区挡住：目录、#锚点、文内查找（查找条打开时） ----------
const geomJs = (sel) => `(() => {
  const sticky = document.querySelector('.wb-paper .sticky.top-0');
  const target = ${sel};
  return target ? { stickyBottom: Math.round(sticky.getBoundingClientRect().bottom), top: Math.round(target.getBoundingClientRect().top) } : null;
})()`;
const lineWith = (text) => `[...document.querySelectorAll('.cm-line')].find((e) => e.textContent.trim() === ${JSON.stringify(text)})`;
async function caseJumpOffset() {
  await openRead('笔记/长文.md', '第 1 节');
  await exec(`[...document.querySelectorAll('aside button')].find((b) => b.textContent.trim() === '第 30 节').click()`);
  await pause(900);
  const g1 = await exec(geomJs(lineWith('第 30 节')));
  check('3 目录跳转：标题在吸顶区下方可见', g1 && g1.top >= g1.stickyBottom, g1);

  await win.loadURL(base + '/read/' + enc('笔记/长文.md') + '#' + encodeURIComponent('第 25 节'));
  await until(`!!document.querySelector('${CARD}')`);
  await pause(1500);
  const g2 = await exec(geomJs(lineWith('第 25 节')));
  check('3 #锚点跳转：标题在吸顶区下方可见', g2 && g2.top >= g2.stickyBottom, g2);

  await exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`);
  await until(`!!document.querySelector('input[placeholder^="文内查找"]')`);
  await exec(`(() => { const el=document.querySelector('input[placeholder^="文内查找"]'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(el,'这是第 33 节的正文'); el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await pause(900);
  const g3 = await exec(geomJs(`document.querySelector('.cm-rd-find-current')`));
  check('3 文内查找（查找条打开）：命中在吸顶区下方可见', g3 && g3.top >= g3.stickyBottom, g3);
  await exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
}

// ---------- 4 改名 / 删除后标签跟随 ----------
const tabNames = () => exec(`[...document.querySelectorAll('[role="tab"]')].map((e) => e.textContent.trim())`);
async function treeMenu(name, item) {
  const ok = await exec(`(() => {
    const el = [...document.querySelectorAll('aside *')].find((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(name)} && e.getClientRects().length);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5, button: 2 }));
    return true;
  })()`);
  assert.ok(ok, '目录树里找不到 ' + name);
  await until(`[...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent.trim() === ${JSON.stringify(item)})`);
  await exec(`[...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.trim() === ${JSON.stringify(item)}).click()`);
  await until(`!!document.querySelector('[role="dialog"], [role="alertdialog"]')`);
}
async function dialogConfirm(button, value) {
  if (value !== undefined) {
    await exec(`(() => { const el=document.querySelector('[role="dialog"] input'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  }
  await exec(`[...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(button)}).click()`);
  await until(`!document.querySelector('[role="dialog"], [role="alertdialog"]')`, 8000);
  await pause(800);
}
async function caseTabsFollow(dsId) {
  await openRead('标签/改名前.md', '用于标签跟随');
  await openRead('笔记/诗句.md', '雪拥蓝关');
  await openRead('标签/改名前.md', '用于标签跟随');
  const before = await tabNames();
  const idx = before.indexOf('改名前');
  await treeMenu('改名前.md', '重命名');
  await dialogConfirm('重命名', '改名后');
  await until(`decodeURIComponent(location.pathname).endsWith('改名后.md')`);
  const after = await tabNames();
  check('4 改名：标签换成新名且位置不变', !after.includes('改名前') && after.indexOf('改名后') === idx && after.length === before.length, { before, after });

  await treeMenu('改名后.md', '删除');
  await dialogConfirm('移到回收站');
  await openRead('笔记/诗句.md', '雪拥蓝关');
  const afterDel = await tabNames();
  check('4 删除：标签随之消失', !afterDel.includes('改名后') && afterDel.includes('诗句'), afterDel);

  await openRead('待改名目录/内文.md', '目录改名时');
  await treeMenu('待改名目录', '重命名');
  await dialogConfirm('重命名', '已改名目录');
  await pause(500);
  const stored = await exec(`JSON.parse(localStorage.getItem('wb:tabs:${dsId}') || '[]')`);
  check('4 目录改名：其下已打开文档的标签一起改', stored.includes('已改名目录/内文.md') && !stored.some((p) => p.startsWith('待改名目录/')), stored);
}

// ---------- 2 库目录短暂不可达：保留上次结果、如实提示，目录回来后自动恢复并继续监听 ----------
async function caseUnreachable() {
  const moved = corpus + '-moved';
  await win.loadURL(base + '/');
  await until(`document.body.innerText.includes('自动监听已开启')`);
  const countText = () => exec(`(() => { const el = [...document.querySelectorAll('div')].find((d) => d.textContent.trim() === '全部文档'); return el?.parentElement?.textContent || ''; })()`);
  const before = await countText();
  fs.renameSync(corpus, moved);
  try {
    await until(`document.body.innerText.includes('知识库目录暂时无法访问')`, 20000);
    const t = await pageText();
    check('2 不可达：概览如实提示原因', t.includes('不存在或已被移走') && t.includes('目录恢复后会自动重新扫描'), t.slice(0, 400));
    check('2 不可达：顶栏显示目录不可访问、不再写自动监听已开启', t.includes('目录不可访问') && !t.includes('自动监听已开启'), t.slice(0, 200));
    check('2 不可达：文档数保持上次结果', (await countText()) === before, { before, now: await countText() });
    check('2 不可达：不再出现「其余内容正常」的误导提示', !t.includes('其余内容正常'), t.slice(0, 300));
  } finally {
    fs.renameSync(moved, corpus);
  }
  await until(`!document.body.innerText.includes('知识库目录暂时无法访问') && document.body.innerText.includes('自动监听已开启')`, 20000);
  check('2 目录回来：自动恢复且监听重开', true);
  W('笔记/恢复后新建.md', '# 恢复后新建');
  await until(`document.body.innerText.includes('恢复后新建.md')`, 15000);
  check('2 目录回来：新建文件自动出现在目录树', true);
}

async function main() {
  server = spawn(process.execPath, [path.join(root, 'server/index.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_PORT: String(port), WORKBENCH_DATA_DIR: path.join(tmp, 'data'), WORKBENCH_STATIC_DIR: path.join(root, 'dist'), WORKBENCH_RAG_EMBED: 'mock' },
    stdio: 'ignore',
  });
  let ready = false;
  for (let i = 0; i < 150; i++) { try { await api('/api/config', undefined); ready = true; break; } catch { /* 后端未起 */ } await pause(100); }
  assert.ok(ready, 'server ready');
  const cfg = await api('/api/config', { baseDir: corpus });
  await pause(1500); // 等扫描 + 索引就绪
  const dsId = cfg.dsId;

  await app.whenReady();
  win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const renderErrors = [];
  win.webContents.on('console-message', (event) => { if (event.level === 'error' && !/status of (404|409|400)/.test(event.message)) renderErrors.push(event.message); });

  if (want(1)) await caseSearch();
  if (want(3)) await caseJumpOffset();
  if (want(4)) await caseTabsFollow(dsId);
  if (want(2)) await caseUnreachable(); // 会移动语料目录，放在最后

  check('渲染进程无代码报错', renderErrors.length === 0, renderErrors.slice(-5));
  console.log(`${passed} audit-fix checks passed.`);
}
main().then(() => finish(0), (e) => { console.error(e); return finish(1); });
async function finish(code) {
  if (!fs.existsSync(corpus) && fs.existsSync(corpus + '-moved')) fs.renameSync(corpus + '-moved', corpus);
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r)); }
  win?.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(code);
}
