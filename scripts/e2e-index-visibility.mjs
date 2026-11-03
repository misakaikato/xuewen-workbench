// 索引可见性 e2e（验收 G5，反馈第 4 批·上）：
// - 顶栏全局指示：重扫后出现「正在建立索引 / 正在更新链接」，结束后消失；
// - 精确检索：text 阶段显示「结果可能不完整」，text 结束后提示消失并自动重查；
// - 反链面板：索引未就绪时显示「正在建立链接索引」，绝不出现假的「还没有其他文档提到本篇」，
//   就绪后显示正确的反链。
// 语料：30000 md（约 20KB）+ 1500 docx（mammoth 解析慢，把 text 阶段拉长到数秒）。
// 用法：先 npm run build，再 ./node_modules/.bin/electron scripts/e2e-index-visibility.mjs
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.E2E_INDEX_PORT) || 7495;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-index-vis-'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail); }
};

app.on('window-all-closed', () => {});
const exec = (js) => win.webContents.executeJavaScript(js, true);
async function until(label, js, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await exec(js)) return;
    await pause(100);
  }
  const text = (await exec('document.body.innerText')).slice(0, 1500);
  throw new Error('等待超时：' + label + '\n页面文本：' + text);
}

// ---------- 夹具 ----------

// 最小 docx（stored zip，100 段文字）：mammoth 解析约 12ms/个，用于拉长 text 阶段
function makeDocx() {
  const paras = [];
  for (let i = 0; i < 100; i++) {
    paras.push('<w:p><w:r><w:t xml:space="preserve">第' + i + '段：学问之道无他，求其放心而已矣。博学之，审问之，慎思之，明辨之，笃行之，不亦说乎。</w:t></w:r></w:p>');
  }
  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paras.join('') + '</w:body></w:document>';
  const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/vnd.openxmlformats-package.xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const files = [['[Content_Types].xml', ct], ['_rels/.rels', rels], ['word/document.xml', doc]];
  const parts = [];
  const central = [];
  let off = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    parts.push(lh, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(off, 42);
    central.push(cd, nameBuf);
    off += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

// 语料：30000 md + 1500 docx + 甲/乙（反链样例）；正文都含「不亦说乎」供精确检索
const corpus = path.join(tmp, 'corpus');
fs.mkdirSync(corpus, { recursive: true });
const MD_COUNT = 30000;
const DOCX_COUNT = 1500;
{
  const line = '学问之道无他，求其放心而已矣。博学之，审问之，慎思之，不亦说乎。\n';
  const body = '# 文档\n\n' + line.repeat(300);
  const t0 = Date.now();
  for (let i = 0; i < MD_COUNT; i++) {
    const sub = path.join(corpus, `卷${i % 30}`);
    if (i < 30) fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `d${String(i).padStart(6, '0')}.md`), body.replace('# 文档', '# 文档' + i));
  }
  const docx = makeDocx();
  const wsub = path.join(corpus, '讲义');
  fs.mkdirSync(wsub, { recursive: true });
  for (let i = 0; i < DOCX_COUNT; i++) fs.writeFileSync(path.join(wsub, `w${String(i).padStart(5, '0')}.docx`), docx);
  fs.writeFileSync(path.join(corpus, '甲.md'), '# 甲文\n\n不亦说乎。有朋自远方来。\n');
  fs.writeFileSync(path.join(corpus, '乙.md'), '# 乙文\n\n这里提到甲文，作为反向链接的来源。不亦说乎。\n');
  console.log(`语料生成完成：${MD_COUNT} md + ${DOCX_COUNT} docx（${Date.now() - t0}ms）`);
}
const TOTAL_FILES = MD_COUNT + DOCX_COUNT + 2;

// ---------- 后端与窗口 ----------

let server = null;
let win = null;

// 预置 config：后端启动即开始首扫 + 索引，窗口在 ready=false 期间进入
async function seedConfig() {
  const { dsIdFor } = await import(path.join(ROOT, 'server', 'store.js'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const id = dsIdFor(corpus);
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    version: 2,
    libraries: [{ id, baseDir: corpus, name: '索引可见', addedAt: new Date().toISOString() }],
    activeId: id,
  }));
  return dataDir;
}

function spawnServer(dataDir) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_PORT: String(PORT), WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_DATA_DIR: dataDir, WORKBENCH_STATIC_DIR: path.join(ROOT, 'dist'), WORKBENCH_RAG_EMBED: 'mock',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  return proc;
}

// 服务器状态直读（脚本侧 50ms 轮询，不经过页面）
async function serverStatus() {
  const r = await fetch(BASE + '/api/status');
  return r.json();
}
async function waitPhase(pred, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    const s = await serverStatus().catch(() => null);
    if (s && pred(s)) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待服务器状态超时');
    await pause(50);
  }
}

// 页面侧：可见性覆写（show:false 窗口下轮询被暂停）+ 强制补拉一次状态
function pageSetupJs() {
  return `(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    true;
  })()`;
}
const forceTick = () => exec(`document.dispatchEvent(new Event('visibilitychange')); true`);
// 自动 tick：每 300ms 触发一次页面可见性事件，让 usePolling 立即补拉 ——
// 后台窗口（show:false）下默认轮询被暂停/不立即首拉，关键窗口需要确定性
let autoTickTimer = null;
function startAutoTick() {
  if (autoTickTimer == null) autoTickTimer = setInterval(() => { void forceTick().catch(() => {}); }, 300);
}
function stopAutoTick() {
  if (autoTickTimer != null) {
    clearInterval(autoTickTimer);
    autoTickTimer = null;
  }
}

const bodyHas = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;

// ---------- 阶段 A：反链面板在索引未就绪时的表现 ----------

async function phaseA() {
  console.log('== A. 反链面板：索引未就绪时的表现 ==');
  await win.loadURL(BASE + '/read/' + encodeURIComponent('甲.md'));
  await exec(pageSetupJs());
  await until('阅读页就绪', bodyHas('甲文'));
  await exec(`[...document.querySelectorAll('button')].find((b) => b.title === '反向引用').click(); true`);
  await until('索引未就绪：显示「正在建立链接索引…」', bodyHas('正在建立链接索引'), 200);
  check('未就绪时不显示假的空结果', !(await exec(bodyHas('还没有其他文档提到本篇'))));
  // 就绪前反复抽查：绝不出现「还没有其他文档提到本篇」
  let fakeEmptySeen = false;
  for (let i = 0; i < 10; i++) {
    if (await exec(bodyHas('还没有其他文档提到本篇'))) fakeEmptySeen = true;
    await pause(500);
  }
  check('等待期间从未出现「还没有其他文档提到本篇」', !fakeEmptySeen);
  await waitPhase((s) => s.linksReady === true && s.indexing?.phase == null, 120000);
  await until('就绪后显示反链（乙）', `[...document.querySelectorAll('[data-wb-backlinks] button')].some((b) => b.textContent.includes('乙'))`, 300);
  check('就绪后反链计数为 1', (await exec(`document.querySelector('[data-wb-backlinks]').innerText.includes('提到本篇的文档（1）')`)));
  check('就绪后不再显示加载提示', !(await exec(bodyHas('正在建立链接索引'))));
}

// ---------- 阶段 B：全局指示 + 精确检索不完整标注 ----------

async function phaseB() {
  console.log('== B. 全局指示与检索不完整标注 ==');
  await win.loadURL(BASE + '/').catch(async (e) => {
    throw new Error('loadURL 失败: ' + e.message);
  });
  await exec(pageSetupJs());
  await until('回到概览（顶栏就绪）', `!!document.querySelector('button[title="重新扫描知识库"]')`, 200);
  startAutoTick();
  // 第一次重扫：点击后立即拨快 docx 的 mtime → chokidar 触发第二次重扫 →
  // 新链的 text 阶段重新解析 docx（数秒），旧链仍在算 links：indexState 由新链接管（链守卫）
  await exec(`(() => {
    const btn = document.querySelector('button[title="重新扫描知识库"]');
    if (!btn) throw new Error('找不到重扫按钮');
    btn.click();
    return true;
  })()`);
  const wsub = path.join(corpus, '讲义');
  const now = new Date();
  for (let i = 0; i < DOCX_COUNT; i++) {
    fs.utimesSync(path.join(wsub, `w${String(i).padStart(5, '0')}.docx`), now, now);
  }

  // 新链的 text 阶段：docx 重新解析拉长到数秒；顶栏指示出现「正在建立索引」，重扫图标转圈
  await waitPhase((s) => s.indexing?.phase === 'text', 60000);
  await until('顶栏出现「正在建立索引」', `!!document.querySelector('[data-testid="background-indicator"]') && document.querySelector('[data-testid="background-indicator"]').innerText.includes('正在建立索引')`, 40);
  check('索引期间重扫图标保持转圈', await exec(`!!document.querySelector('button[title="重新扫描知识库"] svg.animate-spin')`));

  // text 阶段内执行精确检索：出现「结果可能不完整」
  await win.loadURL(BASE + '/search?mode=exact&q=' + encodeURIComponent('不亦说乎'));
  await exec(pageSetupJs());
  await until('检索页显示「结果可能不完整」', bodyHas('结果可能不完整'), 40);
  check('提示带索引进度', await exec(bodyHas('索引更新中（')));

  // text 结束：提示消失并自动重查（结果补全到全部文件）
  await waitPhase((s) => s.indexing?.phase !== 'text', 60000);
  await until('索引完成后提示消失', `!document.body.innerText.includes('结果可能不完整')`, 60);
  await until(`自动重查后结果补全（${TOTAL_FILES} 个文件命中）`, bodyHas(`${TOTAL_FILES} 个文件命中`), 300);

  // links 阶段：指示切到「正在更新链接」
  const s2 = await waitPhase((s) => s.indexing?.phase === 'links', 60000).catch(() => null);
  if (s2) {
    await until('顶栏显示「正在更新链接」', `document.querySelector('[data-testid="background-indicator"]') && document.querySelector('[data-testid="background-indicator"]').innerText.includes('正在更新链接')`, 40);
  } else {
    check('观察到 links 阶段', false, '未捕捉到 links 阶段');
  }

  // 索引结束：指示消失
  await waitPhase((s) => s.indexing?.phase == null && s.linksReady, 120000);
  stopAutoTick();
  await forceTick();
  await until('索引结束后指示消失', `!document.querySelector('[data-testid="background-indicator"]')`, 40);
}

// ---------- 主流程 ----------

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('缺少 dist/index.html，先 npm run build');
  const dataDir = await seedConfig();
  server = spawnServer(dataDir);
  // 后端 listen 在首扫之后：这里等到能响应即扫描已结束、索引正在进行
  let up = false;
  for (let i = 0; i < 600; i++) {
    try { if ((await fetch(BASE + '/api/config')).ok) { up = true; break; } } catch { /* 启动中 */ }
    await pause(100);
  }
  if (!up) throw new Error('后端 60 秒内未就绪');

  await app.whenReady();
  win = new BrowserWindow({
    width: 1280, height: 860, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  win.webContents.on('console-message', (_e, _lvl, msg) => {
    if (/error|Error|Uncaught|dbg-phase/i.test(msg)) console.log('[renderer]', String(msg).slice(0, 300));
  });
  await win.loadURL(BASE + '/');
  await exec(pageSetupJs());
  await until('应用就绪', `document.body.innerText.length > 0`, 200);

  await phaseA();
  await phaseB();
}

main().then(
  () => { stopAutoTick(); return finish(fail ? 1 : 0); },
  async (e) => { console.error(e); stopAutoTick(); await finish(1); }
);

async function finish(code) {
  console.log(`结果：${pass} 通过，${fail} 失败`);
  stopAutoTick();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  win?.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(code);
}
