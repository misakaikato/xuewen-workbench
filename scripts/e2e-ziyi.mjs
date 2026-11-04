// 字义库 UI e2e（specs/2026-11-04-ziyi.md 验收 2）：起后端 + BrowserWindow，临时语料与数据目录，字义包运行时合成。
// 导入前：顶栏无「字义」、单字选区不浮出操作条、两字选区只有「记笔记」、阅读页无字义按钮。
// 设置页导入后：顶栏出现「字义」；单字选区只有「字义」，点开侧栏显示释义；两字选区有「记笔记」和「字义」；
// Alt 点击某字侧栏切到该字且不触发其他动作；侧栏内编辑保存后字义库页检索得到并高亮；字义库页新建。
// 运行：npm run build && ./node_modules/.bin/electron scripts/e2e-ziyi.mjs
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, atExit } from './tmpdirs.mjs';
import { writeZip } from '../server/zip.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = makeTmpDir('wb-ziyi-ui-');
const corpus = path.join(tmp, 'corpus');
fs.mkdirSync(corpus, { recursive: true });
const DOC = '诗.md';
fs.writeFileSync(path.join(corpus, DOC), '# 诗\n\n宛在水中央，甲乙丙丁。\n\n另起一段文字。\n');

const packFile = path.join(tmp, 'test-ziyi.zip');
const entry = (han, meaning) => ({ name: `annotations/${han}.json`, data: JSON.stringify({ han, meaning, source: '测试出处' }) });
writeZip(packFile, [entry('宛', '测试释义：宛，曲折之意。'), entry('甲', '测试释义：甲，第一。'), entry('乙', '测试释义：乙，第二。')]);
const PACK_B64 = fs.readFileSync(packFile).toString('base64');

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
const api = (url) => fetch(base + url).then((r) => r.json());

const spaGo = async (to) => {
  await exec(`(() => { history.pushState({}, '', ${JSON.stringify(to)}); dispatchEvent(new PopStateEvent('popstate', { state: {} })); return true; })()`);
  await until(`decodeURIComponent(location.pathname) === ${JSON.stringify(decodeURIComponent(to.split('?')[0]))}`);
};
const navHasZiyi = () => exec(`!!document.querySelector('[data-wb-ziyi-nav]')`);
// 在正文里选中 text 并派发 mouseup；返回浮动条按钮文字（没有浮动条返回 null），浮动条保持打开
async function select(text) {
  const diag = await exec(`(() => {
    const card = document.querySelector('[data-wb-content-card]');
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(${JSON.stringify(text)});
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + ${text.length});
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      card.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return 'OK:' + sel.toString();
    }
    return 'NO-TEXT';
  })()`);
  assert.ok(String(diag).startsWith('OK:'), '选区失败: ' + diag);
  await pause(300);
  return exec(`document.querySelector('[data-wb-selbar]') ? [...document.querySelectorAll('[data-wb-selbar] button')].map((b) => b.textContent.trim()) : null`);
}
async function clearSel() {
  await exec(`window.getSelection().removeAllRanges(); document.querySelector('header').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); true`);
  await until(`!document.querySelector('[data-wb-selbar]')`);
}
async function openRead() {
  await spaGo('/read/' + enc(DOC));
  await until(`!!document.querySelector('[data-wb-content-card]') && document.querySelector('[data-wb-content-card]').textContent.includes('宛在水中央')`, 8000);
  await pause(300);
}
// 在 textarea / input 上写值并触发 React 的 onChange
const setValue = (selector, value) => exec(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
const clickButton = (scope, label) => exec(`(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
  if (!b) return false;
  b.click();
  return true;
})()`);

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
  await pause(800);
  await app.whenReady();
  win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true } });

  // ================= 导入前 =================
  console.log('— 导入前');
  await win.loadURL(base + '/');
  await until(`!!document.querySelector('header a[href="/settings"]')`);
  await pause(500);
  check('顶栏没有「字义」', !(await navHasZiyi()));
  await openRead();
  check('阅读页没有字义按钮', !(await exec(`!!document.querySelector('[data-wb-ziyi-toggle]')`)));
  check('单字选区不浮出操作条', (await select('宛')) === null);
  await exec(`window.getSelection().removeAllRanges(); true`);
  const bar0 = await select('甲乙');
  check('两字选区只有「记笔记」', JSON.stringify(bar0) === JSON.stringify(['记笔记']), bar0);
  await clearSel();

  // ================= 设置页导入 =================
  console.log('— 设置页导入');
  await spaGo('/settings?tab=ziyi');
  await until(`!!document.querySelector('[data-wb-ziyi-settings]')`);
  await until(`document.querySelector('[data-wb-ziyi-status]').textContent.includes('尚未导入')`);
  check('?tab=ziyi 直达字义库分页且显示未导入', true);
  await exec(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(PACK_B64)}), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'test-ziyi.zip', { type: 'application/zip' }));
    const input = document.querySelector('[data-wb-ziyi-file]');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await until(`document.querySelector('[data-wb-ziyi-status]').textContent.includes('已导入 3 字')`, 8000);
  check('导入后状态显示 3 字', true);
  await until(`document.body.textContent.includes('字义包已导入')`);
  check('导入结果 toast', true);
  await until(`!!document.querySelector('[data-wb-ziyi-nav]')`);
  check('导入后顶栏出现「字义」（不重载）', true);

  // ================= 阅读页 =================
  console.log('— 阅读页');
  await openRead();
  check('阅读页出现字义按钮', await exec(`!!document.querySelector('[data-wb-ziyi-toggle]')`));
  const bar1 = await select('宛');
  check('单字选区只有「字义」', JSON.stringify(bar1) === JSON.stringify(['字义']), bar1);
  await exec(`document.querySelector('[data-wb-ziyi-sel]').click(); true`);
  await until(`!!document.querySelector('[data-wb-ziyi-panel] [data-wb-ziyi-entry="宛"] [data-wb-ziyi-text]')`);
  check('点「字义」侧栏显示该字释义', (await exec(`document.querySelector('[data-wb-ziyi-panel] [data-wb-ziyi-text]').textContent`)).includes('测试释义：宛'));
  check('点「字义」后浮动条收起', !(await exec(`!!document.querySelector('[data-wb-selbar]')`)));

  const bar2 = await select('甲乙');
  check('两字选区有「记笔记」和「字义」', bar2.includes('记笔记') && bar2.includes('字义') && !bar2.includes('问 AI'), bar2);
  await exec(`document.querySelector('[data-wb-ziyi-sel]').click(); true`);
  await until(`document.querySelectorAll('[data-wb-ziyi-panel] [data-wb-ziyi-entry]').length === 2`);
  check('多字选区逐字列出', (await exec(`[...document.querySelectorAll('[data-wb-ziyi-panel] [data-wb-ziyi-entry]')].map((e) => e.dataset.wbZiyiEntry).join('')`)) === '甲乙');

  // Alt 点击「丙」：没有条目，显示「暂无字义」
  const pathBefore = await exec(`location.pathname`);
  const altResult = await exec(`(() => {
    const card = document.querySelector('[data-wb-content-card]');
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf('丙');
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + 1);
      const b = r.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, altKey: true, button: 0, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 };
      const target = document.elementFromPoint(init.clientX, init.clientY);
      const down = new MouseEvent('mousedown', init);
      target.dispatchEvent(down);
      target.dispatchEvent(new MouseEvent('mouseup', init));
      const click = new MouseEvent('click', init);
      target.dispatchEvent(click);
      return { down: down.defaultPrevented, click: click.defaultPrevented };
    }
    return null;
  })()`);
  check('Alt 点击被拦截（mousedown 与 click 都 preventDefault）', altResult && altResult.down && altResult.click, altResult);
  await until(`document.querySelector('[data-wb-ziyi-panel-input]').value === '丙'`);
  await until(`!!document.querySelector('[data-wb-ziyi-panel] [data-wb-ziyi-entry="丙"]')`);
  check('Alt 点击侧栏切到该字', (await exec(`document.querySelector('[data-wb-ziyi-panel]').textContent`)).includes('暂无字义'));
  check('Alt 点击不离开当前文档', (await exec(`location.pathname`)) === pathBefore);

  // 侧栏内直接改字：输入框查「甲」并编辑
  await setValue('[data-wb-ziyi-panel-input]', '甲');
  await until(`!!document.querySelector('[data-wb-ziyi-panel] [data-wb-ziyi-entry="甲"] [data-wb-ziyi-text]')`);
  check('侧栏输入框查字', true);
  await clickButton('[data-wb-ziyi-panel] [data-wb-ziyi-entry="甲"]', '编辑');
  await until(`!!document.querySelector('[data-wb-ziyi-panel] [data-wb-ziyi-meaning]')`);
  await setValue('[data-wb-ziyi-panel] [data-wb-ziyi-meaning]', '测试释义：甲，侧栏改写过的天干之首。');
  await clickButton('[data-wb-ziyi-panel] [data-wb-ziyi-entry="甲"]', '保存');
  await until(`(document.querySelector('[data-wb-ziyi-panel] [data-wb-ziyi-entry="甲"] [data-wb-ziyi-text]')?.textContent || '').includes('侧栏改写过')`);
  const saved = await api('/api/ziyi/entry?han=' + encodeURIComponent('甲'));
  check('侧栏编辑已保存到后端', saved.entry.meaning.includes('侧栏改写过') && !!saved.entry.editedAt, saved);

  // 打开 AI 之外的互斥：再点工具栏字义按钮收起侧栏
  await exec(`document.querySelector('[data-wb-ziyi-toggle]').click(); true`);
  await until(`!document.querySelector('[data-wb-ziyi-panel]')`);
  check('工具栏按钮收起侧栏', true);

  // ================= 字义库页 =================
  console.log('— 字义库页');
  await exec(`document.querySelector('[data-wb-ziyi-nav]').click(); true`);
  await until(`location.pathname === '/ziyi' && !!document.querySelector('[data-wb-ziyi-search]')`);
  await until(`document.querySelectorAll('[data-wb-ziyi-hit]').length === 3`);
  check('字义库页列出全部', true);
  await setValue('[data-wb-ziyi-search]', '改写过');
  await until(`new URLSearchParams(location.search).get('q') === '改写过' && document.querySelectorAll('[data-wb-ziyi-hit]').length === 1`);
  check('检索到侧栏修改后的内容', (await exec(`document.querySelector('[data-wb-ziyi-hit]').dataset.wbZiyiHit`)) === '甲');
  check('命中词高亮', (await exec(`document.querySelector('[data-wb-ziyi-hit] mark')?.textContent`)) === '改写过');
  await exec(`document.querySelector('[data-wb-ziyi-hit]').click(); true`);
  await until(`new URLSearchParams(location.search).get('han') === '甲' && !!document.querySelector('[data-wb-ziyi-detail] [data-wb-ziyi-entry="甲"] [data-wb-ziyi-text]')`);
  check('点击结果显示详情并同步 URL', true);

  await setValue('[data-wb-ziyi-new]', '戊');
  await exec(`document.querySelector('[data-wb-ziyi-new]').form.requestSubmit(); true`);
  await until(`!!document.querySelector('[data-wb-ziyi-detail] [data-wb-ziyi-entry="戊"]') && document.querySelector('[data-wb-ziyi-detail]').textContent.includes('暂无字义')`);
  await clickButton('[data-wb-ziyi-detail] [data-wb-ziyi-entry="戊"]', '新建');
  await until(`!!document.querySelector('[data-wb-ziyi-detail] [data-wb-ziyi-meaning]')`);
  await setValue('[data-wb-ziyi-detail] [data-wb-ziyi-meaning]', '测试释义：戊，新建条目。');
  await clickButton('[data-wb-ziyi-detail] [data-wb-ziyi-entry="戊"]', '创建');
  await until(`(document.querySelector('[data-wb-ziyi-detail] [data-wb-ziyi-entry="戊"] [data-wb-ziyi-text]')?.textContent || '').includes('新建条目')`);
  check('字义库页新建', (await api('/api/ziyi/status')).count === 4);

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
