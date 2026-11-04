// 划线笔记标记 e2e：引文含格式（加粗/链接/行内代码/wikilink/列表）、跨行内标签、跨段、短引文、
// 含自动内链词与老笔记数据——走真实 UI（选区 → 记笔记 → 保存），保存后与重开后都要出现标记。
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, atExit } from './tmpdirs.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = makeTmpDir('wb-note-marks-');
const corpus = path.join(tmp, 'corpus');
const W = (rel, s) => { fs.mkdirSync(path.dirname(path.join(corpus, rel)), { recursive: true }); fs.writeFileSync(path.join(corpus, rel), s); };
W('孔子家语.md', '# 孔子家语\n\n词条源文档。');
W('论语.md', '# 论语\n\n词条源文档。');
W('bold.md', '# 加粗\n\n前文**加粗的词**后文，这是带格式的一句话。\n');
W('link.md', '# 链接\n\n参见[孔子家语](孔子家语.md)这一篇里的说法很重要。\n');
W('code.md', '# 代码\n\n运行 `npm run dev` 即可启动开发服务器。\n');
W('wiki.md', '# 别名\n\n其义见于[[论语|那本经典]]所记的言行之中。\n');
W('short.md', '# 短引文\n\n仁者爱人，克己复礼。又说克己复礼为仁。\n');
W('crlf.md', '# 标题\r\n\r\n第一段的结尾部分文字。\r\n\r\n第二段含**粗体**的开头部分。\r\n');
W('list.md', '# 列表\n\n- 第一项列表内容在这里\n- 第二项列表内容在那里\n');
W('bold.html', '<html><body><p>前文<b>加粗的词</b>后文，这是带格式的一句话。</p></body></html>');
W('link.html', '<html><body><p>参见<a href="x.md">某篇</a>这一篇里的说法很重要。</p></body></html>');
W('short.txt', '温故而知新，可以为师矣。\n');
W('auto.txt', '开头一行\n这里提到孔子家语这部书的一段话。\n结尾一行\n');
W('old.md', '# 老笔记\n\n前文**加粗的词**后文，这是带格式的一句话。\n');
// 老笔记：修复前存下的数据（quote 是渲染后的文字），数据格式不变
W('阅读笔记/old.md', '# old 阅读笔记\n\n## 2026-11-01 10:00 · 1\n> 前文加粗的词后文，这是带格式的一句话\n');
W('阅读笔记/.old.annotations.json', JSON.stringify([
  { at: '2026-11-01T02:00:00.000Z', source: 'old.md', quote: '前文加粗的词后文，这是带格式的一句话', note: '', anchor: '2026-11-01 10:00 · 1' },
], null, 2));

const port = Number(process.env.E2E_NOTE_MARKS_PORT) || 7536;
const base = `http://127.0.0.1:${port}`;
let server, win, passed = 0;
atExit(() => server?.kill('SIGKILL'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('window-all-closed', () => {});
const exec = (js) => win.webContents.executeJavaScript(js, true);
async function until(js, ms = 8000) {
  const t0 = Date.now();
  for (;;) { if (await exec(js)) return; if (Date.now() - t0 > ms) throw new Error('等待超时 ' + js); await pause(60); }
}
const check = (name, ok, detail) => { assert.ok(ok, name + ': ' + JSON.stringify(detail)); console.log('PASS', name); passed++; };
async function api(url, body) {
  const r = await fetch(base + url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  assert.ok(r.ok, url + ' -> ' + JSON.stringify(j));
  return j;
}
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const CARD = '[data-wb-content-card]';
async function open(file, ready) {
  await win.loadURL(base + '/read/' + enc(file));
  await until(`!!document.querySelector('${CARD}') && document.querySelector('${CARD}').textContent.includes(${JSON.stringify(ready)})`);
  await pause(400);
}
// 正文卡片内所有标记的文字（同一处引文可能被隐藏记号/行内标签切成多个元素）
const markText = () => exec(`[...document.querySelectorAll('${CARD} .cm-note-mark')].map((e) => e.textContent).join('|')`);
const markCount = (t) => exec(`[...document.querySelectorAll('${CARD} .cm-note-mark')].filter((e) => e.textContent === ${JSON.stringify(t)}).length`);

// 在正文卡片的拼接文字里，从 a 的第一处起点选到其后 b 的终点（可跨文本节点、跨部件），派发 mouseup
const selectJs = (a, b) => `(() => {
  const card = document.querySelector('${CARD}');
  const w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  const nodes = []; let n; while ((n = w.nextNode())) nodes.push(n);
  const all = nodes.map((x) => x.data).join('');
  const s = all.indexOf(${JSON.stringify(a)}); if (s < 0) return 'NOTFOUND:a';
  const e0 = all.indexOf(${JSON.stringify(b)}, s); if (e0 < 0) return 'NOTFOUND:b';
  const e = e0 + ${b.length};
  const loc = (p, end) => { let off = 0; for (const x of nodes) { if (end ? p <= off + x.length : p < off + x.length) return [x, p - off]; off += x.length; } return null; };
  const [sn, so] = loc(s, false); const [en, eo] = loc(e, true);
  const r = document.createRange(); r.setStart(sn, so); r.setEnd(en, eo);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  card.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return 'OK:' + sel.toString();
})()`;

async function takeNote(a, b) {
  const sel = await exec(selectJs(a, b));
  assert.ok(sel.startsWith('OK:'), '选区失败 ' + sel);
  await pause(300);
  const clicked = await exec(`(() => { const b=[...document.querySelectorAll('[data-wb-selbar] button')].find((b) => b.textContent.includes('记笔记')); if (!b) return false; b.click(); return true; })()`);
  assert.ok(clicked, '记笔记按钮未出现，选区：' + sel);
  await until(`!!document.querySelector('textarea[placeholder^="写下你的想法"]')`);
  await exec(`(() => { const b=[...document.querySelectorAll('button')].find((b) => b.textContent.trim()==='保存笔记'); b.click(); return true; })()`);
  return sel.slice(3);
}

// 一个用例：打开 → 选区记笔记 → 1.5 秒内出现含 expect 的标记 → 重开文档仍在
async function noteCase(name, file, a, b, expect, { waitFor = null, extra = null } = {}) {
  await open(file, a);
  if (waitFor) await until(`!!document.querySelector('${CARD} ${waitFor}')`, 10000);
  const sel = await takeNote(a, b);
  try {
    await until(`[...document.querySelectorAll('${CARD} .cm-note-mark')].map((e) => e.textContent).join('').includes(${JSON.stringify(expect)})`, 1500);
  } catch { /* 下面的断言给出实际标记文字 */ }
  check(`${name}：保存后出现标记`, (await markText()).replace(/\|/g, '').includes(expect), { sel, marks: await markText() });
  if (extra) await extra('保存后');
  await open(file, a);
  if (waitFor) await until(`!!document.querySelector('${CARD} ${waitFor}')`, 10000);
  await until(`!!document.querySelector('${CARD} .cm-note-mark')`, 5000).catch(() => {});
  check(`${name}：重开后标记仍在`, (await markText()).replace(/\|/g, '').includes(expect), await markText());
  if (extra) await extra('重开后');
}

async function main() {
  server = spawn(process.execPath, [path.join(root, 'server/index.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_PORT: String(port), WORKBENCH_DATA_DIR: path.join(tmp, 'data'), WORKBENCH_STATIC_DIR: path.join(root, 'dist'), WORKBENCH_RAG_EMBED: 'mock' },
    stdio: 'ignore',
  });
  let ready = false;
  for (let i = 0; i < 150; i++) { try { await api('/api/config'); ready = true; break; } catch { /* 后端未起 */ } await pause(100); }
  assert.ok(ready, 'server ready');
  await api('/api/config', { baseDir: corpus });
  await pause(1500); // 等扫描 + 内链索引就绪

  await app.whenReady();
  win = new BrowserWindow({ width: 1300, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const renderErrors = [];
  win.webContents.on('console-message', (event) => { if (event.level === 'error') renderErrors.push(event.message); });

  // ---------- markdown ----------
  await noteCase('md 加粗', 'bold.md', '前文', '一句话', '前文加粗的词后文，这是带格式的一句话');
  await noteCase('md 链接', 'link.md', '参见', '很重要', '参见孔子家语这一篇里的说法很重要');
  await noteCase('md 行内代码', 'code.md', '运行', '服务器', '运行 npm run dev 即可启动开发服务器');
  await noteCase('md wikilink 别名', 'wiki.md', '其义', '之中', '其义见于那本经典所记的言行之中', { waitFor: '.wb-wikilink' });
  await noteCase('md 4 字短引文', 'short.md', '克己复礼', '克己复礼', '克己复礼', {
    extra: async (when) => check(`md 4 字短引文：${when}两处都标`, (await markCount('克己复礼')) === 2, await markText()),
  });
  await noteCase('md CRLF 跨段含加粗', 'crlf.md', '结尾部分', '开头部分', '第二段含粗体的开头部分');
  await noteCase('md 跨列表项（选区含圆点）', 'list.md', '•', '在那里', '第一项列表内容在这里');

  // ---------- HTML（DOM 阅读器，与 Word/JSON 同一路径） ----------
  await noteCase('html 跨 <b>', 'bold.html', '前文', '一句话', '前文加粗的词后文，这是带格式的一句话', {
    extra: async (when) => {
      if (when !== '保存后') return;
      // 库内别的文件变化 → 重扫 → 全局状态刷新：正文 DOM 不得被重置冲掉标记
      W('触发重扫.md', '# 触发重扫');
      await pause(7000);
      check('html 跨 <b>：库内变化重扫后标记仍在', (await markText()).replace(/\|/g, '').includes('前文加粗的词后文，这是带格式的一句话'), await markText());
    },
  });
  await noteCase('html 跨原文超链接', 'link.html', '参见', '很重要', '这一篇里的说法很重要', {
    extra: async (when) => check(`html 跨原文超链接：${when}无嵌套锚点且原链接仍在`,
      await exec(`!document.querySelector('${CARD} a a') && !!document.querySelector('${CARD} a[href="x.md"]')`)),
  });

  // ---------- TXT ----------
  await noteCase('txt 4 字短引文', 'short.txt', '温故而知', '温故而知', '温故而知');
  await noteCase('txt 含自动内链词', 'auto.txt', '这里提到', '一段话', '这部书的一段话', {
    waitFor: '.wb-autolink',
    extra: async (when) => check(`txt 含自动内链词：${when}内链仍在`, await exec(`!!document.querySelector('${CARD} .wb-autolink')`)),
  });

  // ---------- 老笔记数据 ----------
  await open('old.md', '前文');
  await until(`!!document.querySelector('${CARD} .cm-note-mark')`, 5000).catch(() => {});
  check('老笔记（渲染文字引文）打开即出标记', (await markText()).replace(/\|/g, '').includes('前文加粗的词后文，这是带格式的一句话'), await markText());

  check('渲染进程无报错', renderErrors.length === 0, renderErrors.slice(-5));
  console.log(`${passed} note-mark checks passed.`);
}
main().then(() => finish(0), (e) => { console.error(e); return finish(1); });
async function finish(code) {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r)); }
  win?.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(code);
}
