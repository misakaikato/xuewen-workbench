// Electron 冒烟测试：文件树的 reveal / 展开持久化 / 全部折叠 / 过滤强制展开 / /browse 高亮。
// 用法：./node_modules/.bin/electron scripts/e2e-filetree.mjs [--screenshot <png>]
import { app, BrowserWindow, clipboard } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 7497;
const BASE = `http://127.0.0.1:${PORT}`;
const shotIdx = process.argv.indexOf('--screenshot');
const SHOT = shotIdx > -1 ? process.argv[shotIdx + 1] : null;

app.on('window-all-closed', () => {});
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpObj = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-tree-'));
const tmpData = path.join(tmpObj, 'data');
const corpus = path.join(tmpObj, 'corpus');
// 嵌套目录 + 足量文件让侧栏需要滚动
fs.mkdirSync(path.join(corpus, 'docs/level2/level3'), { recursive: true });
fs.mkdirSync(path.join(corpus, 'notes'), { recursive: true });
fs.writeFileSync(path.join(corpus, 'docs/level2/level3/deep.md'), '# deep\n');
fs.writeFileSync(path.join(corpus, 'top.md'), '# top\n');
fs.writeFileSync(path.join(corpus, 'notes/x.md'), '# x\n');
// 引用计数语料：ly.md 词条为「论语」，note.md 提及它
fs.writeFileSync(path.join(corpus, 'ly.md'), '# 论语\n正文\n');
fs.writeFileSync(path.join(corpus, 'ly.md.meta.json'), JSON.stringify({ id: 'doc_ly', title: '论语', type: '文章' }) + '\n');
fs.writeFileSync(path.join(corpus, 'note.md'), '读论语有感。\n');
for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(corpus, `f${String(i).padStart(2, '0')}.md`), '# f\n');

const j = async (url, init) => (await fetch(BASE + url, init)).json();
const post = (url, body) => j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let win = null, server = null;
const exec = async (js) => win.webContents.executeJavaScript(js, true);
// 轮询直到页面里的 JS 求值为真（树渲染是异步的）
const until = async (js, ms = 8000) => {
  for (let i = 0; i < ms / 100; i++) {
    if (await exec(js).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
};
const setFilter = (v) => `(() => {
  const inp = document.querySelector('input[placeholder^="过滤目录与文件"]');
  if (!inp) return false;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(inp, ${JSON.stringify(v)});
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WORKBENCH_PORT: String(PORT),
      WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_DATA_DIR: tmpData,
      WORKBENCH_STATIC_DIR: path.join(ROOT, 'dist'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  for (let i = 0; ; i++) {
    try { await j('/api/config'); break; } catch { if (i > 100) throw new Error('服务端未就绪'); await sleep(100); }
  }
  await app.whenReady();
  app.on('web-contents-created', (_e, wc) => {
    wc.on('console-message', (_ev, level, message) => {
      if (level >= 2 && !String(message).includes('Security Warning')) console.log('RENDERER:', String(message).slice(0, 400));
    });
    wc.on('render-process-gone', (_ev, d) => console.log('GONE:', d.reason));
  });
  win = new BrowserWindow({
    width: 1280, height: 800, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  await post('/api/config', { baseDir: corpus });
  const cfg = await j('/api/config');
  const dsId = cfg.dsId;
  const DEEP = 'docs/level2/level3/deep.md';
  const urlOf = (p) => BASE + '/read/' + p.split('/').map(encodeURIComponent).join('/');

  // ---------- 1. 直接深链打开：reveal ----------
  console.log('== 1. 深链 reveal ==');
  await win.loadURL(urlOf(DEEP));
  await exec("localStorage.setItem('wb:e2e','1'); true");
  check('深链后深层文件行已渲染（父链自动展开）',
    await until(`!!document.querySelector('[data-tpath="${DEEP}"]')`));
  check('当前文件行高亮', await until(`(() => {
    const el = document.querySelector('[data-tpath="${DEEP}"]');
    return !!el && el.className.includes('text-primary');
  })()`));
  check('展开集已持久化到 localStorage',
    await until(`(() => {
      const a = JSON.parse(localStorage.getItem('wb.filetree.open.${dsId}') || '[]');
      return ['docs','docs/level2','docs/level2/level3'].every((x) => a.includes(x));
    })()`));
  const scrollInfo = await exec(`(() => {
    const el = document.querySelector('[data-tpath="${DEEP}"]');
    const box = el?.closest('.overflow-auto');
    return box ? Math.round(box.scrollTop) + '/' + Math.round(el.getBoundingClientRect().top) : 'n/a';
  })()`);
  console.log('    (侧栏 scrollTop / 行 top:', scrollInfo, ')');
  if (SHOT) { try { fs.writeFileSync(SHOT, await win.webContents.capturePage()); console.log('    截图:', SHOT); } catch { /* 忽略 */ } }

  // ---------- 2. 刷新后展开状态保留 ----------
  console.log('== 2. 刷新持久化 ==');
  await win.loadURL(urlOf(DEEP));
  check('刷新后深层文件行仍然渲染（存档生效）',
    await until(`!!document.querySelector('[data-tpath="${DEEP}"]')`));

  // ---------- 3. 全部折叠 ----------
  console.log('== 3. 全部折叠 ==');
  await until(`!!document.querySelector('button[aria-label="全部折叠"]')`);
  await exec(`document.querySelector('button[aria-label="全部折叠"]').click(); true`);
  await sleep(200);
  check('折叠后深层文件行不再渲染',
    await exec(`!document.querySelector('[data-tpath="${DEEP}"]')`));
  check('折叠后 localStorage 展开集为空',
    await exec(`JSON.parse(localStorage.getItem('wb.filetree.open.${dsId}') || '[]').length === 0`));

  // ---------- 4. 过滤时强制展开 ----------
  console.log('== 4. 过滤强制展开 ==');
  await exec(setFilter('deep'));
  await sleep(200);
  check('全部折叠状态下过滤仍能看到深层命中',
    await exec(`!!document.querySelector('[data-tpath="${DEEP}"]')`));
  await exec(setFilter(''));
  await sleep(200);
  check('清空过滤后回到折叠状态',
    await exec(`!document.querySelector('[data-tpath="${DEEP}"]')`));

  // ---------- 5. /browse 跟随与高亮 ----------
  console.log('== 5. /browse 高亮 ==');
  await win.loadURL(BASE + '/browse?dir=' + encodeURIComponent('notes'));
  check('当前目录行高亮',
    await until(`(() => {
      const el = document.querySelector('[data-tpath="notes"]');
      return !!el && el.className.includes('bg-sidebar-accent');
    })()`));
  check('当前目录已展开（成员可见）',
    await until(`!!document.querySelector('[data-tpath="notes/x.md"]')`));

  // ---------- 6. 全部展开 ----------
  console.log('== 6. 全部展开 ==');
  await exec(`document.querySelector('button[aria-label="全部展开"]').click(); true`);
  await sleep(200);
  check('全部展开后深层文件行恢复渲染',
    await exec(`!!document.querySelector('[data-tpath="${DEEP}"]')`));

  // ---------- 7. 键盘导航 ----------
  console.log('== 7. 键盘导航 ==');
  await win.loadURL(BASE + '/');
  await until(`!!document.querySelector('[data-tpath="docs"]')`);
  await exec(`document.querySelector('button[aria-label="全部折叠"]').click(); true`);
  await sleep(150);
  await exec(`document.querySelector('[data-tpath="docs"]').focus(); true`);
  await exec(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); true`);
  check('↓ 焦点移到下一行', (await exec(`document.activeElement?.getAttribute('data-tpath')`)) === 'notes');
  await exec(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); true`);
  check('↑ 回到上一行', (await exec(`document.activeElement?.getAttribute('data-tpath')`)) === 'docs');
  await exec(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); true`);
  await sleep(150);
  check('→ 展开折叠目录', await exec(`!!document.querySelector('[data-tpath="docs/level2"]')`));
  for (const p of ['docs/level2', 'docs/level2/level3']) {
    await exec(`document.querySelector('[data-tpath="${p}"]').focus(); true`);
    await exec(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); true`);
    await sleep(120);
  }
  check('逐层展开到深层目录', await exec(`!!document.querySelector('[data-tpath="${DEEP}"]')`));
  await exec(`document.querySelector('[data-tpath="${DEEP}"]').focus(); true`);
  await exec(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true })); true`);
  check('首字母跳转到 top.md', (await exec(`document.activeElement?.getAttribute('data-tpath')`)) === 'top.md');
  await exec(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  check('Enter 打开文件', await until(`location.pathname.includes('/read/top.md')`));
  // 滚回顶部让 notes 行进入渲染窗口（虚拟滚动：未渲染的行不在 DOM 里）
  await exec(`(() => { const c = document.querySelector('aside .overflow-auto'); if (c) c.scrollTop = 0; return true; })()`);
  await sleep(250);
  await exec(`document.querySelector('[data-tpath="notes"]').focus(); true`);
  await exec(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); true`);
  check('F2 弹出重命名对话框', await until(`!!document.querySelector('[role="dialog"]') && document.querySelector('[role="dialog"]').textContent.includes('重命名')`));
  await exec(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(200);

  // ---------- 8. 右键复制与在系统中显示 ----------
  console.log('== 8. 复制与在系统中显示 ==');
  win.webContents.focus();
  if (!(await exec('document.hasFocus()'))) { win.show(); await sleep(300); win.webContents.focus(); }
  await exec(`(() => { const c = document.querySelector('aside .overflow-auto'); if (c) c.scrollTop = 0; return true; })()`);
  await sleep(250);
  await exec(`document.querySelector('[data-tpath="${DEEP}"]').scrollIntoView(); true`);
  await sleep(150);
  await exec(`document.querySelector('[data-tpath="${DEEP}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); true`);
  check('右键菜单含「在系统中显示」',
    await until(`[...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent.includes('在系统中显示'))`));
  await exec(`[...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.includes('复制相对路径')).click(); true`);
  await sleep(250);
  const clip = await Promise.resolve(clipboard.readText()).catch(() => '');
  check('剪贴板为完整相对路径', clip === DEEP, 'got: ' + JSON.stringify(clip));
  const rv1 = await fetch(BASE + '/api/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '../outside' }) });
  check('/api/reveal 拒绝库外路径', rv1.status === 403, 'status=' + rv1.status);
  const rv2 = await fetch(BASE + '/api/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: DEEP }) });
  check('/api/reveal 合法路径返回 ok', rv2.ok);

  // ---------- 9. 平铺过滤 ----------
  console.log('== 9. 平铺过滤 ==');
  await exec(setFilter('deep'));
  await sleep(250);
  check('平铺模式显示计数', await exec(`document.body.textContent.includes('1 个匹配文件')`));
  check('平铺行显示目录路径', await exec(`!!document.querySelector('[data-tpath="${DEEP}"] [title="docs/level2/level3"]')`));
  check('命中片段高亮', await exec(`!!document.querySelector('[data-tpath="${DEEP}"] mark')`));
  await exec(`(() => { const i = document.querySelector('input[placeholder^="过滤目录与文件"]'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
  await sleep(200);
  check('Esc 清空过滤回到树视图', await exec(`!document.body.textContent.includes('个匹配文件') && !!document.querySelector('[data-kind="dir"][data-tpath="docs"]')`));
  await exec(setFilter('top'));
  await sleep(200);
  await exec(`document.querySelector('[data-tpath="top.md"]').click(); true`);
  await until(`location.pathname.includes('/read/top.md')`);
  check('从平铺结果打开后过滤自动清空', await exec(`!!document.querySelector('[data-kind="dir"][data-tpath="docs"]')`));

  // ---------- 10. 徽标 ----------
  console.log('== 10. 徽标 ==');
  await exec(`localStorage.setItem('wb:draft:${dsId}:top.md', JSON.stringify({ content: '# 草稿', savedAt: Date.now() })); true`);
  await win.loadURL(BASE + '/read/top.md');
  await until(`!!document.querySelector('[data-tpath="top.md"]')`);
  check('草稿徽标出现在文件行', await until(`!!document.querySelector('[data-tpath="top.md"] svg.text-amber-600')`));
  fs.writeFileSync(path.join(corpus, 'f00.md.meta.json'), '{bad json');
  await exec(`(() => { const c = document.querySelector('aside .overflow-auto'); if (c) c.scrollTop = 0; return true; })()`);
  await sleep(250);
  check('元数据问题徽标出现在文件行', await until(`!!document.querySelector('[data-tpath="f00.md"] svg.text-red-500')`, 20000));

  // ---------- 11. 虚拟滚动 ----------
  console.log('== 11. 虚拟滚动 ==');
  const spacerH = await exec(`Number.parseFloat(document.querySelector('aside .overflow-auto > div')?.style.height || '0')`);
  const rendered = await exec(`document.querySelectorAll('aside .overflow-auto [data-tpath]').length`);
  const totalRows = Math.round(spacerH / 28);
  check('总行数按 28px 摊铺（>60 行）', totalRows >= 64, `spacer=${spacerH} rows=${totalRows}`);
  check('渲染行数远小于总行数', rendered > 0 && rendered < totalRows - 15, `rendered=${rendered} total=${totalRows}`);
  await exec(`document.querySelector('[data-tpath="docs"]').focus(); true`);
  await exec(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); true`);
  check('End 跳到最后一行（含滚动后聚焦）', await until(`document.activeElement?.getAttribute('data-idx') === String(${totalRows} - 1)`), 'idx=' + (await exec(`document.activeElement?.getAttribute('data-idx')`)));

  // ---------- 12. 集合视图 ----------
  console.log('== 12. 集合视图 ==');
  await j('/api/collections?x=1').catch(() => {});
  const saveCol = await fetch(BASE + '/api/collections', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collections: [{ name: '文辑', dirs: ['docs'] }] }) });
  check('保存逻辑集合', saveCol.ok);
  await win.loadURL(BASE + '/');
  await until(`!![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '集合')`);
  await exec(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '集合').click(); true`);
  await sleep(250);
  check('集合分组头出现', await until(`!!document.querySelector('[data-tpath="col:文辑"]')`));
  check('集合成员可见（含目录副文本）', await until(`!!document.querySelector('[data-tpath="${DEEP}"] [title="docs/level2/level3"]')`));
  check('未归入集合兜底分组存在', await exec(`!!document.querySelector('[data-tpath="uncat"]')`));
  await exec(`document.querySelector('[data-tpath="col:文辑"]').click(); true`);
  await sleep(200);
  check('分组头可折叠', await exec(`!document.querySelector('[data-tpath="${DEEP}"]')`));
  await exec(`document.querySelector('[data-tpath="col:文辑"]').click(); true`);
  await sleep(200);
  await exec(`document.querySelector('[data-tpath="${DEEP}"]').click(); true`);
  check('点开成员后跳转阅读并切回目录视图', await until(`location.pathname.includes('/read/${DEEP}') && !!document.querySelector('[data-kind="dir"][data-tpath="docs"]')`));
  check('视图切换已持久化', await exec(`JSON.parse(localStorage.getItem('wb.filetree.view.${dsId}') || '"cols"') === 'tree'`));

  // ---------- 13. 被引用数徽标 ----------
  console.log('== 13. 被引用数徽标 ==');
  await exec(`(() => { const c = document.querySelector('aside .overflow-auto'); if (c) c.scrollTop = 1e9; return true; })()`);
  await sleep(300);
  console.log('    (诊断) ly.md 行存在:', await exec(`!!document.querySelector('[data-tpath="ly.md"]')`));
  console.log('    (诊断) ly.md 徽标存在:', await exec(`!!document.querySelector('[data-tpath="ly.md"] [title^="被 "]')`));
  check('引用计数徽标出现（ly.md 被 note.md 引用）', await until(`!!document.querySelector('[data-tpath="ly.md"] [title="被 1 个文档引用"]')`, 15000));
  await exec(`[...document.querySelectorAll('button')].find((b) => b.title.includes('隐藏被引用数')).click(); true`);
  await sleep(200);
  check('引用数开关隐藏徽标', await exec(`!document.querySelector('[data-tpath="ly.md"] [title^="被 "]')`));
  check('开关状态已持久化', await exec(`JSON.parse(localStorage.getItem('wb.filetree.opts.${dsId}') || '{}').refs === false`));
  await exec(`[...document.querySelectorAll('button')].find((b) => b.title.includes('显示被引用数')).click(); true`);

  // ---------- 14. 拖拽插入引用 ----------
  console.log('== 14. 拖入编辑器插引用 ==');
  await win.loadURL(BASE + '/edit/' + encodeURIComponent('note.md'));
  await until(`!!document.querySelector('.cm-editor') && !!window.__wb?.editor()`);
  await sleep(400);
  const dropRes = await exec(`(() => {
    const view = window.__wb?.editor?.();
    if (!view || !view.dom) return 'no-editor';
    const r = view.dom.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.setData('application/x-wb-file', 'ly.md');
    // Chromium 的 DragEvent 构造器不携带 dataTransfer，用 defineProperty 注入；
    // 分栏下第一个 .cm-editor 是预览面板，必须直接派发到可编辑视图的 dom
    const ev = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height / 2, 200) });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    view.contentDOM.dispatchEvent(ev);
    return JSON.stringify({ res: view.state.sliceDoc(0).includes('ly.md') ? 'ok' : 'miss', doc: view.state.sliceDoc(0).slice(0, 60) });
  })()`);
  check('拖入编辑器落成文件名引用', (() => { try { return JSON.parse(dropRes).res === 'ok'; } catch { return false; } })(), dropRes);
  await exec(`window.__wb.save(); true`); // 保存落盘，清掉脏态与草稿，避免整页导航被拦截
  await sleep(400);

  // ---------- 15. 剪贴板与副本 ----------
  console.log('== 15. 剪贴板与副本 ==');
  await win.loadURL(BASE + '/');
  await until(`!!document.querySelector('[data-tpath="docs"]')`);
  await exec(`(() => { const c = document.querySelector('aside .overflow-auto'); if (c) c.scrollTop = 1e9; return true; })()`);
  await sleep(250);
  await exec(`document.querySelector('[data-tpath="top.md"]').scrollIntoView(); true`);
  await sleep(150);
  await exec(`document.querySelector('[data-tpath="top.md"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); true`);
  await until(`[...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent.includes('创建副本'))`);
  await exec(`[...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.includes('创建副本')).click(); true`);
  check('创建副本生成「top - 副本.md」', await until(`!!document.querySelector('[data-tpath="top - 副本.md"]')`, 10000));
  await exec(`document.querySelector('[data-tpath="top - 副本.md"]').focus(); true`);
  await exec(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, bubbles: true })); true`);
  await sleep(150);
  check('剪切行半透明标记', await exec(`document.querySelector('[data-tpath="top - 副本.md"]')?.className.includes('opacity-50')`));
  await exec(`(() => { const c = document.querySelector('aside .overflow-auto'); if (c) c.scrollTop = 0; return true; })()`);
  await sleep(250);
  await exec(`document.querySelector('[data-tpath="docs"]').focus(); true`);
  await exec(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true })); true`);
  check('粘贴=移动到目标目录', await until(`!!document.querySelector('[data-tpath="docs/top - 副本.md"]')`));
  check('原位置行已消失', await exec(`!document.querySelector('[data-tpath="top - 副本.md"]')`));

  // ---------- 16. Browse 共享菜单 ----------
  console.log('== 16. Browse 右键 ==');
  await win.loadURL(BASE + '/browse');
  await until(`!!document.querySelector('ul button')`);
  await exec(`document.querySelector('ul button').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); true`);
  check('浏览页右键共享菜单（含重命名/创建副本）',
    await until(`[...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent.includes('重命名')) && [...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent.includes('创建副本'))`));
  await exec(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);

  // ---------- 17. 侧栏宽度 ----------
  console.log('== 17. 侧栏宽度 ==');
  await win.loadURL(BASE + '/');
  await until(`!!document.querySelector('aside')`);
  // 幂等：清掉历史持久化宽度（复用真实 userData 时上次跑完可能停在 480 上限）
  await exec(`localStorage.removeItem('wb.sidebar.w'); true`);
  await win.loadURL(BASE + '/');
  await until(`!!document.querySelector('aside')`);
  const w0 = await exec(`document.querySelector('aside').getBoundingClientRect().width`);
  await exec(`(() => {
    const h = [...document.querySelectorAll('aside > div')].find((e) => e.className.includes('cursor-col-resize'));
    if (!h) return false;
    h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: Math.round(${w0}) }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Math.round(${w0} + 80) }));
    return true;
  })()`);
  await sleep(400); // 防抖落盘窗口
  await exec(`window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); true`);
  await sleep(150);
  const w1 = await exec(`document.querySelector('aside').getBoundingClientRect().width`);
  check('拖拽调整侧栏宽度（+80px）', Math.abs(w1 - (w0 + 80)) < 4, `w0=${w0} w1=${w1}`);
  check('宽度已持久化', await exec(`Math.abs(Number(localStorage.getItem('wb.sidebar.w')) - ${w0 + 80}) < 4`),
    'stored=' + (await exec(`localStorage.getItem('wb.sidebar.w')`)));

  // ---------- 18. 前缀语法 ----------
  console.log('== 18. 前缀语法 ==');
  await exec(setFilter('>论语'));
  await sleep(150);
  await exec(`(() => { const i = document.querySelector('input[placeholder^="过滤目录与文件"]'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  check('Enter 直达全文检索', await until(`location.pathname === '/search' && location.search.includes('%E8%AE%BA%E8%AF%AD') || location.search.includes('q=')`));

  // ---------- 19. 新建模板（服务端口径） ----------
  console.log('== 19. 新建模板 ==');
  const tplB = await post('/api/file/create', { dsId, dir: '', kind: 'md', name: 'tpl-blank.md', title: 'TplB', bodyTemplate: 'blank' });
  const tplD = await post('/api/file/create', { dsId, dir: '', kind: 'md', name: 'tpl-date.md', title: 'TplD', bodyTemplate: 'title-date' });
  const cb = await j('/api/file?path=' + encodeURIComponent('tpl-blank.md'));
  const cd = await j('/api/file?path=' + encodeURIComponent('tpl-date.md'));
  check('空白模板内容为空', tplB.ok && cb.content === '', JSON.stringify(cb.content));
  check('标题+日期模板含日期行', tplD.ok && cd.content.startsWith('# TplD') && cd.content.includes('日期：'), JSON.stringify(cd.content));

  // ---------- 20. 多选 / 批量移动 / 拖拽移动 / 批量删除 ----------
  console.log('== 20. 多选与批量操作 ==');
  await win.loadURL(BASE + '/');
  await until(`!!document.querySelector('[data-kind="file"]')`);
  // 造三个待操作文件（直接 API 建省 UI 流程）
  await post('/api/file/create', { dsId, dir: '', kind: 'md', name: '批a.md', title: '批a' });
  await post('/api/file/create', { dsId, dir: '', kind: 'md', name: '批b.md', title: '批b' });
  await post('/api/file/create', { dsId, dir: '', kind: 'md', name: '批c.md', title: '批c' });
  await win.loadURL(BASE + '/');
  await until(`!!document.querySelector('[data-tpath="批a.md"]')`);

  // Cmd 多选三个文件
  for (const n of ['批a.md', '批b.md', '批c.md']) {
    await exec(`(() => { const r = document.querySelector('[data-tpath=${JSON.stringify(n)}]'); r.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })); return true; })()`);
    await sleep(60);
  }
  check('Cmd 点选三个文件', await until(`!!document.querySelector('[data-wb-selbar]')`) && Number(await exec(`document.querySelectorAll('[data-sel="1"]').length`)) >= 3);
  check('选择条显示已选 3 项', await exec(`document.querySelector('[data-wb-selbar]').textContent.includes('3') && document.querySelector('[data-wb-selbar]').textContent.includes('项已选')`));

  // 批量移动到「笔记」目录
  await exec(`(() => { const b = [...document.querySelectorAll('[data-wb-selbar] button')].find((x) => x.textContent.includes('移动到')); b.click(); return true; })()`);
  await until(`!!document.querySelector('[data-wb-movetargets]')`);
  await exec(`(() => { const b = [...document.querySelectorAll('[data-wb-movetargets] button')].find((x) => x.textContent.trim() === 'notes'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(800);
  const movedOk = await Promise.all(['notes/批a.md', 'notes/批b.md', 'notes/批c.md'].map(async (pt) => (await j('/api/file?path=' + encodeURIComponent(pt))).name === pt.split('/').pop()));
  check('批量移动三件到 notes/', movedOk.every(Boolean), JSON.stringify(movedOk));
  check('移动后选择清空', await until(`!document.querySelector('[data-wb-selbar]')`) === true);

  // 拖拽移动：把 notes/批a.md 拖回根（拖到根空白区）
  await until(`!!document.querySelector('[data-tpath="notes/批a.md"]')`);
  await exec(`(() => { const r = document.querySelector('[data-tpath="notes/批a.md"]'); r.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })); return true; })()`);
  await sleep(120);
  await exec(`(() => {
    const r = document.querySelector('[data-tpath="notes/批a.md"]');
    const dt = new DataTransfer();
    dt.setData('application/x-wb-file', 'notes/批a.md');
    r.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const sc = document.querySelector('aside .flex-1.overflow-auto');
    if (!sc) return 'SC-MISS matches=' + document.querySelectorAll('aside .overflow-auto').length;
    sc.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    sc.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return 'dropped';
  })()`);
  await sleep(800);
  check('拖到根空白区 = 移回根目录', (await j('/api/file?path=' + encodeURIComponent('批a.md'))).name === '批a.md');

  // 目录行 drop：把根目录 批a.md 拖进 笔记
  await exec(`(() => {
    const dt = new DataTransfer();
    dt.setData('application/x-wb-file', '批a.md');
    const sc = document.querySelector('aside .flex-1.overflow-auto');
    sc.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const dir = document.querySelector('[data-kind="dir"][data-name="notes"]');
    dir.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dir.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  })()`);
  await sleep(800);
  check('拖到目录行 = 移入该目录', (await j('/api/file?path=' + encodeURIComponent('notes/批a.md'))).name === '批a.md');

  // 批量删除（行内确认）
  for (const n of ['notes/批a.md', 'notes/批b.md', 'notes/批c.md']) {
    await exec(`(() => { const r = document.querySelector('[data-tpath=${JSON.stringify(n)}]'); r.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })); return true; })()`);
    await sleep(60);
  }
  await exec(`(() => { const b = [...document.querySelectorAll('[data-wb-selbar] button')].find((x) => x.textContent.includes('删除')); b.click(); return true; })()`);
  await until(`[...document.querySelectorAll('[data-wb-selbar] button')].some((x) => x.textContent.includes('确认删除'))`);
  await exec(`(() => { const b = [...document.querySelectorAll('[data-wb-selbar] button')].find((x) => x.textContent.includes('确认删除')); b.click(); return true; })()`);
  await sleep(900);
  const delOk = await Promise.all(['notes/批a.md', 'notes/批b.md', 'notes/批c.md'].map(async (pt) => {
    const r = await j('/api/file?path=' + encodeURIComponent(pt)).catch(() => null);
    return !r || !r.name;
  }));
  check('批量删除三件（确认后）', delOk.every(Boolean), JSON.stringify(delOk));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  server?.kill();
  app.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); server?.kill(); app.exit(1); });
