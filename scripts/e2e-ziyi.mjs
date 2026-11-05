// 字义库 UI e2e（specs/2026-11-04-ziyi.md 验收 2）：起后端 + BrowserWindow，临时语料与数据目录，字义包运行时合成。
// 导入前：顶栏无「字义」、单字选区不浮出操作条、两字选区只有「记笔记」、阅读页无字义按钮。
// 设置页导入后：顶栏出现「字义」；单字选区只有「字义」，点开侧栏显示释义；两字选区有「记笔记」和「字义」；
// 扩展区单字选区同样只有「字义」；Alt 点击某字侧栏切到该字且不触发其他动作；原位编辑态 Alt 不拦截（留给编辑器列选区）；
// 侧栏内编辑保存后字义库页检索得到并高亮；字义库页新建。
// 字形演变（假 zi.tools）：侧栏查字显示字形格、点开放大；上游不响应时同时取多个字也不卡住其它接口；
// 后端字形接口本身卡住时连看 8 个字，换字即取消在途的字形请求，字义照常显示；查字义卡住时右栏到时报错、可重试、写进 renderer.log。
// 关闭开关后不显示字形区、也不再请求。
// 运行：npm run build && ./node_modules/.bin/electron scripts/e2e-ziyi.mjs
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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
fs.writeFileSync(path.join(corpus, DOC), '# 诗\n\n宛在水中央，甲乙丙丁𠀀。\n\n另起一段文字。\n');

// 字义文件装在 zip 里上传（同时覆盖 zip 外壳的解析）；宛、甲为课堂讲解，乙为 AI 推导
const packFile = path.join(tmp, 'test-ziyi.zip');
const entry = (han, meaning, origin) => ({ han, meaning, source: '测试出处', origin });
writeZip(packFile, [{ name: '字义库.json', data: JSON.stringify({ format: 'xuewen-ziyi', version: 1, entries: [
  entry('宛', '测试释义：宛，曲折之意。', 'lecture'), entry('甲', '测试释义：甲，第一。', 'lecture'), entry('乙', '测试释义：乙，第二。', 'ai'),
] }) }]);
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

// 假 zi.tools：任何字都返回两个代表字形（1×1 PNG），记录请求过的字
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const ziHits = [];
let ziHang = false; // 模拟上游黑洞：收下请求但永不回应
const fakeZi = http.createServer((req, res) => {
  const ch = decodeURIComponent(req.url).replace(/^\/api\/zi\//, '');
  ziHits.push(ch);
  if (ziHang) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ yi: { tubrief: [['k', '1', ch, ch, PNG, '甲骨', '商', '賓組', '', 1], ['k', '2', ch, ch, PNG, '篆', '秦', '說文', '', 1]] } }));
});
const ziPort = await freePort();
await new Promise((r) => fakeZi.listen(ziPort, '127.0.0.1', r));
atExit(() => fakeZi.close());
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

// Alt + 点击正文里的某个字（在字的中心派发 mousedown / mouseup / click）：返回 click 是否被 preventDefault，
// 以及 mousedown 是否传到了正文（被字义拦截时捕获阶段就 stopPropagation，传不到）
const altClick = (ch) => exec(`(() => {
  const card = document.querySelector('[data-wb-content-card]');
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.data.indexOf(${JSON.stringify(ch)});
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(n, i);
    r.setEnd(n, i + 1);
    const b = r.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, altKey: true, button: 0, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 };
    const target = document.elementFromPoint(init.clientX, init.clientY);
    let reached = false;
    const mark = () => { reached = true; };
    target.addEventListener('mousedown', mark, { once: true });
    target.dispatchEvent(new MouseEvent('mousedown', init));
    target.removeEventListener('mousedown', mark);
    target.dispatchEvent(new MouseEvent('mouseup', init));
    const click = new MouseEvent('click', init);
    target.dispatchEvent(click);
    return { downReached: reached, click: click.defaultPrevented };
  }
  return null;
})()`);

async function main() {
  server = spawn(process.execPath, [path.join(root, 'server/index.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_DATA_DIR: path.join(tmp, 'data'), WORKBENCH_STATIC_DIR: path.join(root, 'dist'), WORKBENCH_RAG_EMBED: 'mock',
      WORKBENCH_ZITOOLS_API: `http://127.0.0.1:${ziPort}/api` },
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
  check('设置页显示来源计数', (await exec(`document.querySelector('[data-wb-ziyi-status]').textContent`)).includes('课堂讲解 2，AI 推导 1'));
  check('导入后状态显示 3 字', true);
  await until(`document.body.textContent.includes('字义文件已导入')`);
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
  check('侧栏标出「课堂讲解」', (await exec(`document.querySelector('[data-wb-ziyi-panel] [data-wb-ziyi-origin]')?.textContent`)) === '课堂讲解');
  check('点「字义」后浮动条收起', !(await exec(`!!document.querySelector('[data-wb-selbar]')`)));

  const bar2 = await select('甲乙');
  check('两字选区有「记笔记」和「字义」', bar2.includes('记笔记') && bar2.includes('字义') && !bar2.includes('问 AI'), bar2);
  await exec(`document.querySelector('[data-wb-ziyi-sel]').click(); true`);
  await until(`document.querySelectorAll('[data-wb-ziyi-panel] [data-wb-ziyi-entry]').length === 2`);
  check('多字选区逐字列出', (await exec(`[...document.querySelectorAll('[data-wb-ziyi-panel] [data-wb-ziyi-entry]')].map((e) => e.dataset.wbZiyiEntry).join('')`)) === '甲乙');
  check('多字各自标出来源', (await exec(`[...document.querySelectorAll('[data-wb-ziyi-panel] [data-wb-ziyi-origin]')].map((e) => e.dataset.wbZiyiOrigin).join(',')`)) === 'lecture,ai');
  const barB = await select('𠀀');
  check('扩展 B 区单字选区只有「字义」', JSON.stringify(barB) === JSON.stringify(['字义']), barB);
  await clearSel();

  // Alt 点击「丙」：没有条目，显示「暂无字义」
  const pathBefore = await exec(`location.pathname`);
  const altResult = await altClick('丙');
  check('Alt 点击被拦截（mousedown 不传到正文、click 被 preventDefault）', altResult && !altResult.downReached && altResult.click, altResult);
  await until(`document.querySelector('[data-wb-ziyi-panel-input]').value === '丙'`);
  await until(`!!document.querySelector('[data-wb-ziyi-panel] [data-wb-ziyi-entry="丙"]')`);
  check('Alt 点击侧栏切到该字', (await exec(`document.querySelector('[data-wb-ziyi-panel]').textContent`)).includes('暂无字义'));
  check('Alt 点击不离开当前文档', (await exec(`location.pathname`)) === pathBefore);

  // 原位编辑态：Alt 不拦截，侧栏不跟着变
  await exec(`document.querySelector('button[title="进入编辑 (Ctrl+E)"]').click(); true`);
  await until(`document.querySelector('[data-wb-content-card] .cm-content')?.getAttribute('contenteditable') === 'true'`);
  const altEdit = await altClick('甲');
  check('编辑态 Alt 点击不被拦截（mousedown 传到编辑器、click 不被阻止）', altEdit && altEdit.downReached && !altEdit.click, altEdit);
  check('编辑态 Alt 点击不切换侧栏', (await exec(`document.querySelector('[data-wb-ziyi-panel-input]').value`)) === '丙');
  await exec(`document.querySelector('button[title="保存并回到阅读 (Ctrl+E)"]').click(); true`);
  await until(`document.querySelector('[data-wb-content-card] .cm-content')?.getAttribute('contenteditable') !== 'true'`);
  check('退出编辑', true);

  // 字形演变：侧栏里当前是「丙」（没有字义也显示字形）
  await until(`document.querySelectorAll('[data-wb-ziyi-panel] [data-wb-ziyi-glyphs="丙"] [data-wb-ziyi-glyph]').length === 2`);
  check('侧栏显示字形演变（没有字义的字也显示）', ziHits.includes('丙'));
  await exec(`document.querySelector('[data-wb-ziyi-panel] [data-wb-ziyi-glyph]').click(); true`);
  await until(`!!document.querySelector('[data-wb-ziyi-glyph-dialog] img')`);
  check('点字形放大并显示时代与书体', (await exec(`document.querySelector('[data-wb-ziyi-glyph-dialog]').textContent`)).includes('商 · 甲骨文'));
  await exec(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await until(`!document.querySelector('[data-wb-ziyi-glyph-dialog]')`);
  check('关闭放大', true);


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
  await exec(`document.querySelector('[data-wb-ziyi-origin-opt="ai"]').click(); true`);
  await until(`new URLSearchParams(location.search).get('origin') === 'ai' && document.querySelectorAll('[data-wb-ziyi-hit]').length === 1`);
  check('按来源筛选：AI 推导只剩乙', (await exec(`document.querySelector('[data-wb-ziyi-hit]').dataset.wbZiyiHit`)) === '乙');
  await exec(`document.querySelector('[data-wb-ziyi-origin-opt="all"]').click(); true`);
  await until(`!new URLSearchParams(location.search).get('origin') && document.querySelectorAll('[data-wb-ziyi-hit]').length === 3`);
  check('切回全部', true);
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
  check('新建条目标为「本机新建」', (await exec(`document.querySelector('[data-wb-ziyi-detail] [data-wb-ziyi-origin]')?.textContent`)) === '本机新建');
  await until(`!!document.querySelector('[data-wb-ziyi-origin-opt="local"]')`);
  check('来源筛选出现「本机新建」', (await exec(`document.querySelector('[data-wb-ziyi-origin-opt="local"]').textContent`)).includes('1'));

  // 上游不响应时，页面同时取 8 个没缓存的字形，其它接口仍立即返回（取字形不占住浏览器到后端的连接）
  ziHang = true;
  const stall = await exec(`(async () => {
    const chars = [...'庚辛壬癸子丑寅卯'];
    const glyphReqs = chars.map((c) => fetch('/api/ziyi/glyphs?han=' + encodeURIComponent(c)).then((r) => r.status));
    const t0 = performance.now();
    const ok = (await fetch('/api/ui-settings')).ok;
    const ms = performance.now() - t0;
    return { ok, ms, statuses: await Promise.all(glyphReqs) };
  })()`);
  check('上游卡住时取字形不拖慢其它接口', stall.ok && stall.ms < 1500 && stall.statuses.every((x) => x === 202), stall);
  ziHang = false;

  // 后端的字形接口本身卡住（经一层代理模拟）：连看 8 个字，换字即取消在途的字形请求，字义照常显示——
  // 不取消的话卡住的请求会攒满浏览器同主机 6 个连接，第 7 个字起连字义也查不出来
  const proxyPort = await freePort();
  let hangEntry = null;
  const proxy = http.createServer((req, res) => {
    const hang = req.method === 'GET' && (req.url.startsWith('/api/ziyi/glyphs?')
      || (hangEntry && req.url.startsWith('/api/ziyi/entry?han=' + encodeURIComponent(hangEntry))));
    if (hang) return;
    const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r));
  atExit(() => proxy.close());
  const goHan = (c) => exec(`(() => { history.pushState({}, '', '/ziyi?han=' + encodeURIComponent(${JSON.stringify(c)})); dispatchEvent(new PopStateEvent('popstate', { state: {} })); return true; })()`);
  await win.loadURL(`http://127.0.0.1:${proxyPort}/ziyi`);
  await until(`!!document.querySelector('[data-wb-ziyi-search]')`, 8000);
  const shownChars = [];
  for (const c of '庚辛壬癸子丑寅卯') {
    await goHan(c);
    try {
      await until(`!!document.querySelector('[data-wb-ziyi-detail] [data-wb-ziyi-entry="${c}"] [data-wb-ziyi-glyphs]')`, 3000);
      shownChars.push(c);
    } catch { /* 记下没显示的字 */ }
    await pause(300); // 让字形请求发出去并卡住
  }
  check('字形接口卡住时连看 8 个字都显示', shownChars.join('') === '庚辛壬癸子丑寅卯', shownChars.join(''));

  // 查字义本身卡住：右栏显示载入中，到时改为报错并可重试，失败写进 renderer.log
  hangEntry = '辰';
  await goHan('辰');
  await until(`(document.querySelector('[data-wb-ziyi-detail-loading]')?.textContent || '').includes('正在载入「辰」')`);
  check('查字义未返回时右栏显示「正在载入」', true);
  await until(`!!document.querySelector('[data-wb-ziyi-detail-error]')`, 20000);
  check('查字义超时右栏报错', (await exec(`document.querySelector('[data-wb-ziyi-detail-error]').textContent`)).includes('15 秒内没有响应'));
  hangEntry = null;
  await clickButton('[data-wb-ziyi-detail-error]', '重试');
  await until(`!!document.querySelector('[data-wb-ziyi-detail] [data-wb-ziyi-entry="辰"]') && document.querySelector('[data-wb-ziyi-detail]').textContent.includes('暂无字义')`);
  check('重试后显示', true);
  await pause(2500); // 界面日志每 2s 批量上报
  const rendererLog = fs.readFileSync(path.join(tmp, 'data', 'logs', 'renderer.log'), 'utf8');
  check('查字义失败写进 renderer.log', rendererLog.includes('[ziyi] 载入「辰」的字义失败：15 秒内没有响应'), rendererLog.slice(-300));
  await win.loadURL(base + '/ziyi');
  await until(`!!document.querySelector('[data-wb-ziyi-search]')`, 8000);

  // 关闭联网取字形：字义库页详情不再显示字形区，也不再请求
  await spaGo('/settings?tab=ziyi');
  await until(`!!document.querySelector('[data-wb-ziyi-glyphs-setting] button[role=switch]:not([disabled])')`);
  await exec(`document.querySelector('[data-wb-ziyi-glyphs-setting] button[role=switch]').click(); true`);
  await until(`document.querySelector('[data-wb-ziyi-glyphs-setting] button[role=switch]').getAttribute('aria-checked') === 'false' && !document.querySelector('[data-wb-ziyi-glyphs-setting] button[role=switch]').disabled`);
  check('设置页关闭字形开关', (await api('/api/ui-settings')).ziyiGlyphs === false);
  const hitsBefore = ziHits.length;
  await spaGo('/ziyi');
  await exec(`(() => { history.pushState({}, '', '/ziyi?han=' + encodeURIComponent('乙')); dispatchEvent(new PopStateEvent('popstate', { state: {} })); return true; })()`);
  await until(`!!document.querySelector('[data-wb-ziyi-detail] [data-wb-ziyi-entry="乙"] [data-wb-ziyi-text]')`);
  await pause(500);
  check('关闭后不显示字形区、不请求 zi.tools', !(await exec(`!!document.querySelector('[data-wb-ziyi-glyphs]')`)) && ziHits.length === hitsBefore, ziHits.slice(hitsBefore));

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
