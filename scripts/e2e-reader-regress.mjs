// 阅读页回归 e2e（R2–R8）：起后端 + BrowserWindow + executeJavaScript，临时语料，mock 嵌入。
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, atExit } from './tmpdirs.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = makeTmpDir('wb-reader-regress-');
const corpus = path.join(tmp, 'corpus');
fs.mkdirSync(path.join(corpus, '词条'), { recursive: true });
fs.writeFileSync(path.join(corpus, '词条', '孔子家语.md'), '# 孔子家语\n\n词条源文档。');
fs.writeFileSync(path.join(corpus, '词条', '论语.md'), '# 论语\n\n词条源文档。');
const longLines = ['# 长文档标题'];
for (let i = 1; i <= 80; i++) longLines.push(`\n## 第 ${i} 节\n\n这是第 ${i} 节的内容，这里提到孔子家语和论语。这是一段需要划线记录的重要文字，用于验证划线笔记标记。`);
fs.writeFileSync(path.join(corpus, 'long.md'), longLines.join('\n'));
fs.writeFileSync(path.join(corpus, 'other.md'), '# 另一篇\n\n这里也提到孔子家语。');
fs.writeFileSync(path.join(corpus, 'note-src.md'), '# 笔记源\n\n这是一段需要划线记录的重要文字，先出现一次。\n\n再出现一次：这是一段需要划线记录的重要文字。');
fs.writeFileSync(path.join(corpus, 'txt.txt'), '纯文本开头\n这里提到孔子家语\n第二段提到论语\n结尾');

const port = Number(process.env.E2E_READER_PORT) || 7494;
const base = `http://127.0.0.1:${port}`;
let server, win, passed = 0;
atExit(() => server?.kill('SIGKILL'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('window-all-closed', () => {});
const exec = (js) => win.webContents.executeJavaScript(js, true);
async function until(js, ms = 6000) {
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
async function open(file, query = '') {
  await win.loadURL(base + '/read/' + enc(file) + query);
  await until('!!document.querySelector("[data-wb-content-card]")');
  await pause(500);
}
const setNativeValue = (el, value) => exec(`(() => { const el=${el}; const proto=el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const set=Object.getOwnPropertyDescriptor(proto,'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);

async function main() {
  // 预构造助手对话（R6 用）：一条用户消息 + 一条助手消息
  const { dsIdFor } = await import('../server/store.js');
  const dsId = dsIdFor(corpus);
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(path.join(dataDir, 'knowledge', dsId, 'conversations', 'default'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'conversations.json'), JSON.stringify({
    conversations: [{ id: 'conv1', title: '测试对话', dsId, agentId: 'default', pinned: false, folderId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    folders: [],
  }));
  fs.writeFileSync(path.join(dataDir, 'knowledge', dsId, 'conversations', 'default', 'conv1.jsonl'),
    JSON.stringify({ role: 'user', text: '请介绍一下孔子家语', at: new Date().toISOString() }) + '\n' +
    JSON.stringify({ role: 'assistant', text: '旧回答内容', tools: [], thinking: '', at: new Date().toISOString() }) + '\n');

  server = spawn(process.execPath, [path.join(root, 'server/index.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_PORT: String(port), WORKBENCH_DATA_DIR: dataDir, WORKBENCH_STATIC_DIR: path.join(root, 'dist'), WORKBENCH_RAG_EMBED: 'mock' },
    stdio: 'ignore',
  });
  let ready = false;
  for (let i = 0; i < 150; i++) { try { await api('/api/config'); ready = true; break; } catch { /* */ } await pause(100); }
  assert.ok(ready, 'server ready');
  await api('/api/config', { baseDir: corpus });
  // 助手默认关闭：准备阶段打开总开关（R3 阅读页 AI 侧栏、R6 助手消息编辑要用）
  await fetch(base + '/api/ui-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentEnabled: true }) });
  await pause(1500); // 等扫描 + 内链索引就绪

  await app.whenReady();
  win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const renderErrors = [];
  win.webContents.on('console-message', (event) => { if (event.level === 'error') renderErrors.push(event.message); });

  // 打开 long.md 并启用 e2e 钩子
  await open('long.md');
  await exec(`localStorage.setItem('wb:e2e','1')`);
  await win.reload();
  await pause(700);
  await until('!!window.__wbr && !!window.__wbr.editor()');

  // ---------- R2 滚动不因任意写入整页重载 ----------
  {
    await exec(`(() => { const sc=document.querySelector('.wb-paper'); sc.scrollTop = sc.scrollHeight/2; return true; })()`);
    await pause(300);
    const before = await exec(`document.querySelector('.wb-paper').scrollTop`);
    const docElBefore = await exec(`(() => { const el=document.querySelector('.ro-doc .cm-content'); return el ? true : false; })()`);
    fs.appendFileSync(path.join(corpus, 'other.md'), '\n触发重扫的行\n');
    await pause(7000); // 等 5s 轮询 + 重扫 + 树刷新
    const after = await exec(`document.querySelector('.wb-paper').scrollTop`);
    const cardText = await exec(`document.querySelector('[data-wb-content-card]')?.textContent.slice(0,30) || ''`);
    check('R2 改其它文件后滚动位置不变', Math.abs(Number(before) - Number(after)) <= 4, { before, after });
    check('R2 正文未出现加载态', !cardText.includes('加载中'), cardText);
    check('R2 阅读视图仍在', !!docElBefore && await exec(`!!document.querySelector('.ro-doc .cm-content')`));
    // 改当前文件 → 内容原地更新，滚动不回顶
    const cur = await exec(`window.__wbr.editor().state.sliceDoc(0)`);
    const marker = '\nR2 原地更新哨兵行';
    fs.appendFileSync(path.join(corpus, 'long.md'), marker);
    await pause(7000);
    await until(`window.__wbr.editor().state.sliceDoc(0).includes('R2 原地更新哨兵行')`, 9000);
    const afterChangeScroll = await exec(`document.querySelector('.wb-paper').scrollTop`);
    check('R2 改当前文件内容原地更新', await exec(`window.__wbr.editor().state.sliceDoc(0).includes('R2 原地更新哨兵行')`) && await exec(`window.__wbr.editor().state.sliceDoc(0)`) !== cur);
    check('R2 改当前文件滚动不回顶', Number(afterChangeScroll) > 0, afterChangeScroll);

    // 原位编辑中 Ctrl+S 保存（触发重扫）后继续输入：5 秒后编辑态仍在、输入不丢
    await exec(`window.__wbr.enter()`);
    await until(`!!document.querySelector('[data-wb-inplace-bar]')`);
    await exec(`(() => { const v=window.__wbr.editor(); v.dispatch({ selection: { anchor: v.state.doc.length } }); v.dispatch({ changes: { from: v.state.doc.length, insert: '保存前输入' } }); return true; })()`);
    await exec(`window.__wbr.save()`);
    await pause(400);
    await exec(`(() => { const v=window.__wbr.editor(); v.dispatch({ changes: { from: v.state.doc.length, insert: '保存后继续输入' } }); return true; })()`);
    await pause(5200); // 等 5s 状态轮询 + 重扫 + 重拉
    const stillEditing = await exec(`window.__wbr.editing()`);
    const buf = await exec(`window.__wbr.buffer()`);
    check('R2 Ctrl+S 后 5 秒编辑态仍在', stillEditing === true, stillEditing);
    check('R2 Ctrl+S 后继续输入未丢', buf.includes('保存前输入') && buf.includes('保存后继续输入'), JSON.stringify(buf.slice(-60)));
    // 收尾：退出编辑（保存）遇脏则保存，避免 beforeunload 拦后续导航
    await exec(`window.__wbr.finish()`);
    await pause(500);
  }

  // ---------- R3 切换文档不卸载 AI 侧栏 ----------
  {
    await exec(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.title && b.title.includes('AI 助手')); if(b){b.click();return true;} return false; })()`);
    await until(`!!document.querySelector('aside[data-wb-overlay]')`);
    const idBefore = await exec(`(() => { const a=document.querySelector('aside[data-wb-overlay]'); window.__aiNode=a; return a ? true : false; })()`);
    // 切换文档：经 SPA 路由（不整页加载），侧栏节点应保持同一引用
    await exec(`(() => { window.history.pushState({}, '', '/read/${enc('other.md')}'); window.dispatchEvent(new PopStateEvent('popstate', { state: {} })); return true; })()`);
    await until(`decodeURIComponent(window.location.pathname).includes('other.md')`);
    await pause(700);
    const stillSame = await exec(`(() => { const a=document.querySelector('aside[data-wb-overlay]'); return !!(a && window.__aiNode && a === window.__aiNode && a.isConnected); })()`);
    check('R3 切换文档后 AI 侧栏节点未被替换', !!idBefore && stillSame, { idBefore, stillSame });
  }

  // ---------- R4 划线笔记标记 ----------
  {
    await open('note-src.md');
    await until('!!window.__wbr && !!window.__wbr.editor()');
    const countBefore = await exec(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.title && b.title.includes('阅读笔记')); return b ? Number(b.textContent.trim())||0 : 0; })()`);
    // 选中一段文字（原生选区），再派发 mouseup 触发「记笔记」浮层
    // 选中一段文字并同步派发 mouseup（同一次 exec 内，避免选区被清）
    const selDiag = await exec(`(() => { try { const v=window.__wbr.editor(); const doc=v.state.doc.toString(); const from=doc.indexOf('这是一段需要划线记录的重要文字'); const to=from+'这是一段需要划线记录的重要文字'.length; const a=v.domAtPos(from); const b=v.domAtPos(to); const sel=window.getSelection(); sel.removeAllRanges(); const range=document.createRange(); range.setStart(a.node,a.offset); range.setEnd(b.node,b.offset); sel.addRange(range); const card=document.querySelector('[data-wb-content-card]'); card.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); return 'OK:'+sel.toString(); } catch(e){ return 'ERR:'+e.stack; } })()`);
    await pause(400);
    const clickDiag = await exec(`(() => { const btns=[...document.querySelectorAll('[data-wb-selbar] button')]; if(!btns.length) return 'NO-SELBAR'; const b=btns.find(b=>b.textContent.includes('记笔记')); if(!b) return 'NO-BTN:'+btns.map(x=>JSON.stringify(x.textContent)).join(','); b.click(); return 'CLICKED'; })()`);
    assert.equal(clickDiag, 'CLICKED', 'R4 记笔记按钮点击失败: ' + selDiag);
    try { await until(`!!document.querySelector('textarea[placeholder^="写下你的想法"]')`); } catch (e) { console.log('  (诊断) 渲染器错误:', renderErrors.slice(-5)); throw e; }
    await setNativeValue(`document.querySelector('textarea[placeholder^="写下你的想法"]')`, '我的划线笔记');
    await exec(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='保存笔记'); b.click(); return true; })()`);
    await pause(1200);
    const hasMark = await exec(`!!document.querySelector('.cm-note-mark, [data-note-href]')`);
    const countAfter = await exec(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.title && b.title.includes('阅读笔记')); return b ? Number(b.textContent.trim())||0 : 0; })()`);
    check('R4 记笔记后出现下划线', hasMark);
    check('R4 笔记计数 +1', Number(countAfter) === Number(countBefore) + 1, { countBefore, countAfter });
  }

  // ---------- R5 TXT ?h= 高亮在链接数据到达后仍存在 ----------
  {
    // 高亮词选非链接文本（第二段）：链接数据晚到重渲后，非重叠区的高亮与链接应同时存在
    await open('txt.txt', '?h=' + encodeURIComponent('第二段'));
    await pause(300);
    const hlEarly = await exec(`!!document.querySelector('[data-wb-content-card] mark')`);
    await until(`!!document.querySelector('.wb-autolink, .wb-wikilink')`, 8000);
    const hasHl = await exec(`!!document.querySelector('[data-wb-content-card] mark')`);
    const hasLink = await exec(`!!document.querySelector('.wb-autolink')`);
    check('R5 TXT 高亮在链接到达后仍存在', hasHl && hasLink && hlEarly, { hlEarly, hasHl, hasLink });
  }

  // ---------- R7 分栏预览内链数量不变（改末尾） ----------
  {
    await win.loadURL(base + '/edit/' + enc('long.md'));
    await until('!!(window.__wb && __wb.editor())');
    // 切到分栏模式
    await exec(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='分栏'); if(b){b.click();return true;} return false; })()`);
    await pause(700);
    const countPreview = (await exec(`document.querySelectorAll('.ro-doc .wb-autolink').length`));
    await exec(`(() => { const v=window.__wb.editor(); v.dispatch({ changes: { from: v.state.doc.length, insert: 'X' } }); return true; })()`);
    await pause(500);
    const countAfter = await exec(`document.querySelectorAll('.ro-doc .wb-autolink').length`);
    check('R7 预览末尾输入后内链数量不变', countAfter === countPreview, { countPreview, countAfter });
    // 撤销输入，退出 dirty 状态（beforeunload 拦截器否则会阻断后续导航）
    await exec(`(() => { const v=window.__wb.editor(); const n=v.state.doc.length; v.dispatch({ changes: { from: n-1, to: n } }); return true; })()`);
    await pause(300);
  }

  // ---------- R8 检索框尾随空格不被 URL 回写清掉 ----------
  {
    // Search 挂载会 replace URL，可能与新导航竞争导致 ERR_ABORTED：重试一次
    const goto = async (url) => { try { await win.loadURL(url); } catch { await pause(600); await win.loadURL(url); } };
    await goto(base + '/search?q=' + encodeURIComponent('孔子'));
    await until(`!!document.querySelector('input[placeholder^="用自然语言提问"]') || !!document.querySelector('input[placeholder^="多个关键词"]')`);
    await pause(800); // 等挂载期的 setParams 消停
    const inputSel = `document.querySelector('input[placeholder^="用自然语言提问"], input[placeholder^="多个关键词"]')`;
    await setNativeValue(inputSel, '孔子 ');
    await pause(700);
    const val = await exec(`(${inputSel}).value`);
    check('R8 输入框值仍以空格结尾', val === '孔子 ', JSON.stringify(val));
  }

  // ---------- R6 助手消息编辑保存 ----------
  {
    // URL 参数 c 是应用自身的对话定位入口（与侧栏点击同一 openConv 路径）
    await win.loadURL(base + '/agent?c=conv1');
    await until(`!!document.querySelector('button[title="编辑"]')`, 8000);
    const editBtns = await exec(`document.querySelectorAll('button[title="编辑"]').length`);
    // 助手消息是第二条（最后一个编辑按钮）
    await exec(`(() => { const bs=[...document.querySelectorAll('button[title="编辑"]')]; bs[bs.length-1].click(); return true; })()`);
    await until(`!!document.querySelector('textarea.font-mono')`);
    await setNativeValue(`document.querySelector('textarea.font-mono')`, '新的回答内容R6');
    await exec(`(() => { const t=document.querySelector('textarea.font-mono'); const box=t.parentElement; const b=[...box.querySelectorAll('button')].find(b=>b.textContent.trim()==='保存'); if(b){b.click();return true;} return false; })()`);
    await pause(800);
    const jsonl = fs.readFileSync(path.join(dataDir, 'knowledge', dsId, 'conversations', 'default', 'conv1.jsonl'), 'utf8');
    check('R6 编辑助手消息保存新内容', jsonl.includes('新的回答内容R6') && !jsonl.includes('"text":"旧回答内容"'), jsonl.slice(-200));
    check('R6 编辑按钮存在', editBtns >= 2, editBtns);
  }

  console.log(`${passed} reader regression checks passed.`);
}
main().then(() => finish(0), (e) => { console.error(e); return finish(1); });
async function finish(code) {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r)); }
  win?.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(code);
}
