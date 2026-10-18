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
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  server?.kill();
  app.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); server?.kill(); app.exit(1); });
