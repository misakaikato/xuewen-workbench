// 性能端到端测量（E1–E8，规格 specs/2026-11-02-batch3-performance.md）。
// 夹具全部由脚本生成到临时目录，不入库；帧间隔用 16ms 定时器漂移法测量。
// 用法：先 npm run build，再 ./node_modules/.bin/electron scripts/e2e-perf.mjs
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

// 测试窗口被其他窗口完全遮挡时，Chromium 会把它当作不可见并把定时器限流到每秒一次，
// 帧间隔恒约 1000ms、与应用性能无关；测量期间关掉这类后台化（须在 app ready 之前设置）
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 7499;
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- 夹具 ----------

// 确定性伪随机 PNG（truecolor，stored deflate：噪声不可压缩，模拟真实照片体积）
function makePng(w, h, seed) {
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) & 0x7fffffff);
  for (let y = 0; y < h; y++) {
    raw[y * row] = 0;
    for (let x = 1; x < row; x++) raw[y * row + x] = rnd() & 0xff;
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const b = Buffer.alloc(4 + body.length + 4);
    b.writeUInt32BE(data.length, 0);
    body.copy(b, 4);
    b.writeUInt32BE(zlib.crc32(body) >>> 0, 4 + body.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 手写最小 docx（mammoth 可读）：30 段文字 + 5 张内联图片
function makeDocx() {
  const IMG = 5;
  const pngs = [];
  for (let i = 0; i < IMG; i++) pngs.push(makePng(480, 320, 0x9e37 + i));
  const paras = [];
  for (let i = 0; i < 30; i++) {
    paras.push(
      `<w:p><w:r><w:t xml:space="preserve">第${i}段：学问之道无他，求其放心而已矣。博学之，审问之，慎思之，明辨之，笃行之。</w:t></w:r></w:p>`
    );
  }
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
  const img = (i) =>
    `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="4572000" cy="3048000"/><wp:docPr id="${i}" name="img${i}"/><a:graphic xmlns:a="${A}"><a:graphicData uri="${PIC}"><pic:pic xmlns:pic="${PIC}"><pic:nvPicPr><pic:cNvPr id="${i}" name="img${i}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId${i}"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="3048000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<w:body>${paras.join('')}${pngs.map((_, i) => img(i + 1)).join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    pngs.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.png"/>`).join('') +
    `</Relationships>`;
  // 最小 zip（stored）：本地头 + 中央目录 + EOCD
  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(docRels, 'utf8') },
    ...pngs.map((p, i) => ({ name: `word/media/image${i + 1}.png`, data: p })),
  ];
  return zipStore(entries);
}

// 最小 zip 写入器（仅 stored，不压缩）：docx 夹具用
function zipStore(entries) {
  const u16 = (n) => Buffer.from([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n) => Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    locals.push(Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), nameBuf, data,
    ]));
    centrals.push(Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]));
    offset += 30 + nameBuf.length + data.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([
    ...locals, central,
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0)]),
  ]);
}

const CHARS = '的了一是了我在有和人这中大为上国他说个到就来时们去能对你里那也么出会可下过子想度事并行者道之与其学问思辨笃行'.repeat(20);

function buildCorpus(corpus) {
  fs.mkdirSync(path.join(corpus, 'word'), { recursive: true });
  fs.mkdirSync(path.join(corpus, 'docs'), { recursive: true });

  // 1.5MB md（按字节）：分章结构（真实书籍密度），每章正文铺量 + 各一个 wikilink 与相对链接
  let md = '# 大学问\n\n';
  const para = '学问勤中得，萤窗万卷书。三冬今足用，谁笑腹空虚。所谓诚其意者，毋自欺也。如恶恶臭，如好好色，此之谓自谦。故君子必慎其独也。\n\n';
  for (let i = 0; Buffer.byteLength(md) < 1.5 * 1024 * 1024; i++) {
    md += `## 集${i} 句读\n\n`;
    md += para.repeat(25);
    md += `参见 [[论语|论语序说]] 与 [参考篇目](docs/f${i % 1000}.md) 的相关论述。\n\n`;
  }
  fs.writeFileSync(path.join(corpus, 'big.md'), md);

  // 3MB txt（按字节）：约 1.9 万行
  const lines = [];
  let txtBytes = 0;
  for (let i = 0; txtBytes < 3 * 1024 * 1024; i++) {
    const line = `第${i}行 ${CHARS.slice((i * 37) % 800, (i * 37) % 800 + 48)}`;
    lines.push(line);
    txtBytes += Buffer.byteLength(line) + 1;
  }
  fs.writeFileSync(path.join(corpus, 'big.txt'), lines.join('\n'));

  // 无链接、1000 行、第 200/400 行为空行的 txt（E5 分块回归夹具）
  {
    const bl = [];
    for (let i = 1; i <= 1000; i++) bl.push(i === 200 || i === 400 ? '' : `第${i}行 ${CHARS.slice((i * 13) % 800, (i * 13) % 800 + 24)}`);
    fs.writeFileSync(path.join(corpus, 'blocks.txt'), bl.join('\n'));
  }

  // 2 万条记录 json
  const recs = [];
  for (let i = 0; i < 20000; i++) {
    recs.push({ id: i, title: `条目${i}`, body: CHARS.slice((i * 53) % 900, (i * 53) % 900 + 60), tags: ['学问', `t${i % 50}`] });
  }
  fs.writeFileSync(path.join(corpus, 'big.json'), JSON.stringify({ records: recs }));

  // 1000 个含常用字的小 md（检索结果分批渲染夹具）
  for (let i = 0; i < 1000; i++) {
    fs.writeFileSync(
      path.join(corpus, 'docs', `f${String(i).padStart(4, '0')}.md`),
      `# 文档${i}\n\n学问之道，在明明德。此篇讨论学与问的关系，提及论语与中庸。\n\n${CHARS.slice((i * 31) % 1000, (i * 31) % 1000 + 200)}\n`
    );
  }

  // 含 5 图的 docx
  fs.writeFileSync(path.join(corpus, 'word', '带图讲义.docx'), makeDocx());
}

// ---------- 测量辅助 ----------

let pass = 0, fail = 0;
const results = [];
const check = (id, name, value, ok) => {
  results.push({ id, name, value, ok });
  if (ok) { pass++; console.log(`  ✓ ${name}: ${value}`); }
  else { fail++; console.log(`  ✗ ${name}: ${value}`); }
};
const info = (s) => console.log('  ·', s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null, server = null, server8 = null;
atExit(() => { server?.kill('SIGKILL'); server8?.kill('SIGKILL'); });
const exec = async (js) => win.webContents.executeJavaScript(js, true);
const until = async (js, ms = 20000) => {
  for (let i = 0; i < ms / 100; i++) {
    if (await exec(js).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
};
const j = async (url, init) => (await fetch(BASE + url, init)).json();
const post = (url, body) => j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// 页内帧间隔采集：16ms 定时器漂移，记录最大间隔与超阈值次数
const FX = `(() => {
  let last = performance.now(), max = 0, over50 = 0, over80 = 0, on = true;
  setInterval(() => {
    if (!on) return;
    const now = performance.now(), d = now - last; last = now;
    if (d > max) max = d;
    if (d > 50) over50++;
    if (d > 80) over80++;
  }, 16);
  window.__fx = {
    reset() { max = 0; over50 = 0; over80 = 0; last = performance.now(); on = true; },
    pause() { on = false; },
    get() { return { max: Math.round(max), over50, over80 }; },
  };
  return true;
})()`;

// /api/* 请求计数（包装 window.fetch），附 URL 清单供诊断
const API = `(() => {
  let n = 0; let log = []; const orig = window.fetch.bind(window);
  window.fetch = (...a) => { const u = String(a[0]); if (u.includes('/api/')) { n++; log.push(u); } return orig(...a); };
  window.__api = { reset() { n = 0; log = []; }, get() { return n; }, urls() { return log.slice(); } };
  return true;
})()`;

const installFx = async () => { await exec(FX); await exec(API); };
const fxReset = () => exec('window.__fx.reset(), true');
const fxGet = async () => exec('window.__fx.get()');
const domCount = () => exec('document.querySelectorAll("body *").length');

// 拖选走 CDP Input.dispatchMouseEvent：Electron 的 sendInputEvent mouseMove 不带
// buttons 位，CodeMirror 的拖选逻辑会因 event.buttons == 0 立即放弃；CDP 可携带 buttons。
async function dragSelect(x, y, steps, dx, dy) {
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(80);
  for (let i = 1; i <= steps; i++) {
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx * i, y: y + dy * i, button: 'left', buttons: 1 });
    if (i % 10 === 0) await sleep(40);
  }
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx * steps, y: y + dy * steps, button: 'left', buttons: 1 });
  await sleep(200);
  dbg.detach();
}

async function main() {
  const onlyE8 = process.env.WB_ONLY_E8 === '1';
  const tmpObj = makeTmpDir('wb-e2e-perf-');
  const tmpData = path.join(tmpObj, 'data');
  const corpus = path.join(tmpObj, 'corpus');
  const corpusBig = path.join(tmpObj, 'corpus-big');
  console.log('夹具目录:', tmpObj);
  console.log('生成夹具（1.5MB md / 3MB txt / 2 万条 json / 1000 小 md / 5 图 docx）…');
  buildCorpus(corpus);

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
    try { await j('/api/config'); break; } catch { if (i > 150) throw new Error('服务端未就绪'); await sleep(100); }
  }
  await post('/api/config', { baseDir: corpus });
  await app.whenReady();
  win = new BrowserWindow({
    width: 1360, height: 900, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.webContents.focus();
  try { app.focus({ steal: true }); } catch { /* 平台不支持则忽略 */ }
  // 首次加载只为设置 wb:e2e（性能计数器按 localStorage 惯例在下次加载生效）
  await win.loadURL(BASE + '/');
  await exec("localStorage.setItem('wb:e2e','1'); true");
  const open = async (p) => { await win.loadURL(BASE + p); win.webContents.focus(); await installFx(); };
  const perfCounter = (key) => exec(`(window.__wbPerf && window.__wbPerf[${JSON.stringify(key)}]) ?? null`);
  const perfReset = (key) => exec(`(() => { if (window.__wbPerf) window.__wbPerf[${JSON.stringify(key)}] = 0; return true; })()`);

  if (!onlyE8) {
  // ---------- E1：2 万条 json 打开后空闲 12 秒 ----------
  console.log('== E1 打开 2 万条 json 空闲 12s ==');
  await open('/read/big.json');
  await until(`!!document.querySelector('.json-view, .reader pre')`, 30000);
  await sleep(1500);
  await fxReset();
  await sleep(12000);
  {
    const fx = await fxGet();
    check('E1', '空闲 12s 最大帧间隔 < 50ms', `${fx.max}ms（>50ms 次数 ${fx.over50}）`, fx.max < 50);
  }

  // ---------- E2：1.5MB md 阅读态拖选 60 步 ----------
  console.log('== E2 1.5MB md 拖选 60 步 ==');
  await open('/read/big.md');
  await until(`!!document.querySelector('.ro-doc .cm-content') && document.querySelectorAll('.ro-doc .cm-content [data-al-kind]').length >= 0`, 30000);
  await sleep(2500); // 等内链/引用数据注入与首次装饰稳定
  const anchor = await exec(`(() => {
    const lines = [...document.querySelectorAll('.ro-doc .cm-content .cm-line')];
    const el = lines.find((l) => l.textContent.length > 10) || lines[0];
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
  })()`);
  await exec('window.__wbr && window.__wbr.editor() && window.__wbr.editor().focus(), true');
  await perfReset('scanHits');
  await fxReset();
  await dragSelect(anchor.x, anchor.y, 60, 6, 2);
  await exec('window.__fx.pause(), true');
  {
    const selLen = await exec(`(() => { const v = window.__wbr && window.__wbr.editor(); const s = v && v.state.selection.main; const dom = window.getSelection().toString().length; return s ? (s.to - s.from) + '/' + dom : 'none'; })()`);
    info(`拖选选中（CM 区间/DOM 字符）: ${selLen}`);
    const fx = await fxGet();
    const scans = await perfCounter('scanHits');
    check('E2', '拖选 60 步最大帧间隔 < 50ms', `${fx.max}ms（>50ms 次数 ${fx.over50}）`, fx.max < 50);
    check('E2', 'scanHits 调用次数 ≤ 1', scans == null ? 'n/a（无计数器）' : String(scans), scans == null || scans <= 1);
  }

  // ---------- E3：docx 图片外置 ----------
  console.log('== E3 docx 图片外置 ==');
  {
    const docxBytes = fs.statSync(path.join(corpus, 'word', '带图讲义.docx')).size;
    const res = await fetch(BASE + '/api/file?path=' + encodeURIComponent('word/带图讲义.docx'));
    const body = await res.text();
    const hasDataUri = body.includes('data:image');
    const ratio = (body.length / docxBytes).toFixed(2);
    check('E3', '/api/file 响应不含 data:image', String(hasDataUri), !hasDataUri);
    check('E3', '响应体积 < docx 的 1/5', `${(body.length / 1024).toFixed(0)}KB / docx ${(docxBytes / 1024).toFixed(0)}KB = ${ratio}`, body.length < docxBytes / 5);
    await open('/read/' + encodeURIComponent('word/带图讲义.docx'));
    const imgsOk = await until(`(() => {
      const imgs = [...document.querySelectorAll('[data-wb-content-card] img')];
      return imgs.length >= 5 && imgs.every((i) => i.complete && i.naturalWidth > 0);
    })()`, 20000);
    const imgCount = await exec(`document.querySelectorAll('[data-wb-content-card] img').length`);
    check('E3', '页面 5 张图片可见（naturalWidth > 0）', `${imgCount} 张`, imgsOk);
  }

  // ---------- E4：1000 小 md 检索高频字，首屏 DOM 与分批加载 ----------
  console.log('== E4 检索结果分批渲染 ==');
  await open('/search?q=%E5%AD%A6&mode=exact');
  await until(`[...document.querySelectorAll('main ul li')].length >= 50`, 30000);
  await until(`document.body.textContent.includes('个文件命中')`, 30000);
  await sleep(800);
  {
    const totalMatch = /(\d+) 个文件命中/.exec(await exec('document.body.textContent')) || [];
    const total = Number(totalMatch[1] || 0);
    const li0 = await exec(`document.querySelectorAll('main ul li').length`);
    const dom0 = await domCount();
    check('E4', '首屏 DOM 节点数 < 2500', `${dom0}（结果卡片 ${li0} / 命中 ${total}）`, dom0 < 2500);
    await exec(`(() => { const m = document.querySelector('main'); if (m) m.scrollTop = m.scrollHeight; return true; })()`);
    await sleep(1200);
    const li1 = await exec(`document.querySelectorAll('main ul li').length`);
    const grew = li1 > li0;
    const loadedAll = li1 >= Math.min(total, 200);
    check('E4', '滚动到底能继续加载', `${li0} → ${li1}`, grew || loadedAll);
  }

  // ---------- E5：3MB txt 折叠/展开侧栏 3 次；json 首屏 DOM ----------
  console.log('== E5 大 TXT / JSON 渲染 ==');
  await open('/read/big.txt');
  await until(`!!document.querySelector('[data-wb-content-card]') && document.querySelector('[data-wb-content-card]').innerText.length > 1000`, 30000);
  await sleep(1200);
  await fxReset();
  for (let i = 0; i < 3; i++) {
    await exec(`document.querySelector('button[aria-label="折叠侧栏"]').click(); true`);
    await sleep(500);
    await exec(`document.querySelector('button[aria-label="折叠侧栏"]').click(); true`);
    await sleep(500);
  }
  await exec('window.__fx.pause(), true');
  {
    const fx = await fxGet();
    check('E5', '3MB txt 折叠/展开侧栏 3 次最大帧间隔 < 80ms', `${fx.max}ms（>80ms 次数 ${fx.over80}）`, fx.max < 80);
  }

  // 无链接 txt 的分块回归：块数与原文逐字相等（块尾换行不吞、空行不丢）
  await open('/read/blocks.txt');
  await until(`!!document.querySelector('[data-wb-content-card] .whitespace-pre-wrap') && document.querySelector('[data-wb-content-card] .whitespace-pre-wrap').textContent.length > 1000`, 15000);
  await sleep(300);
  {
    const nBlocks = await exec(`document.querySelectorAll('[data-wb-content-card] .whitespace-pre-wrap > div[style*="content-visibility"]').length`);
    check('E5', '无链接 1000 行 txt 分成 5 个 content-visibility 块', String(nBlocks), nBlocks === 5);
    const expected = (await j('/api/file?path=' + encodeURIComponent('blocks.txt'))).content;
    const actual = await exec(`document.querySelector('[data-wb-content-card] .whitespace-pre-wrap').textContent`);
    check('E5', '分块渲染的 textContent 与原文逐字相等', `${actual.length}/${expected.length}`, actual === expected);
  }
  await open('/read/big.json');
  await until(`!!document.querySelector('.json-view, .reader pre')`, 30000);
  await sleep(800);
  {
    const dom = await domCount();
    check('E5', '2 万条 json 首屏 DOM 节点 < 3000', String(dom), dom < 3000);
  }

  // ---------- E6：1.5MB md 原位编辑连续输入 40 字 ----------
  console.log('== E6 原位编辑输入 40 字 ==');
  await open('/read/big.md');
  await until(`!!window.__wbr && !!window.__wbr.editor()`, 30000);
  await sleep(2500);
  await exec('window.__wbr.enter(); true');
  await until(`!!document.querySelector('[data-wb-inplace-bar]')`, 10000);
  await sleep(600);
  const len0 = await exec('window.__wbr.editor().state.doc.length');
  await exec('window.__wbr.editor().focus(), true');
  info('输入前焦点: ' + (await exec('document.activeElement && document.activeElement.className')));
  await perfReset('readRenders');
  await fxReset();
  const text = '大学之道在明明德在亲民在止于至善知止而后有定'.repeat(2).slice(0, 40);
  for (const ch of text) {
    // execCommand insertText 走真实 beforeinput 路径（CM 据此产生文档事务）
    await exec(`document.execCommand('insertText', false, ${JSON.stringify(ch)}), true`);
    await sleep(40);
  }
  await sleep(400);
  await exec('window.__fx.pause(), true');
  {
    const len1 = await exec('window.__wbr.editor().state.doc.length');
    const typed = len1 - len0;
    const fx = await fxGet();
    const renders = await perfCounter('readRenders');
    check('E6', '连续输入 40 字生效', `+${typed} 字符`, typed === 40);
    check('E6', '输入期间最大帧间隔 < 50ms', `${fx.max}ms（>50ms 次数 ${fx.over50}）`, fx.max < 50);
    check('E6', 'Read 组件渲染次数 ≤ 3', renders == null ? 'n/a（无计数器）' : String(renders), renders == null || renders <= 3);
  }
  await exec('window.__wbr.finish && window.__wbr.finish(); true').catch(() => {});
  await sleep(600);

  // ---------- E7：概览页空闲与隐藏时的 /api 请求 ----------
  console.log('== E7 空闲与隐藏请求量 ==');
  await open('/');
  await until(`!!document.querySelector('main')`, 15000);
  // 等前序测试（E6 保存）引发的扫库余波完全落定：scannedAt 两次轮询不变才算空闲起点
  for (;;) {
    const a = await exec('window.__api.get()');
    const st1 = await j('/api/status');
    await sleep(5500);
    const st2 = await j('/api/status');
    if (st1.scannedAt === st2.scannedAt && !st2.scanning) break;
    void a;
  }
  await sleep(1000);
  await exec('window.__api.reset(), true');
  await sleep(15000);
  {
    const n = await exec('window.__api.get()');
    const urls = await exec('window.__api.urls()');
    if (n > 4) info('空闲期请求: ' + urls.map((u) => u.replace(/^https?:\/\/[^/]+/, '')).join(' | '));
    check('E7', '概览页空闲 15s 的 /api 请求 ≤ 4', String(n), n <= 4);
  }
  await exec('window.__api.reset(), true');
  // 模拟页面隐藏：本测试环境下 Electron 的 hide/minimize 不改变 visibilityState（macOS 未报遮挡），
  // 直接驱动 visibilitychange 路径——这正是 usePolling 监听的机制。
  await exec(`(() => {
    let vs = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => vs, configurable: true });
    window.__setVis = (v) => { vs = v; document.dispatchEvent(new Event('visibilitychange')); };
    return true;
  })()`);
  win.hide();
  await exec(`window.__setVis('hidden'), true`);
  await sleep(15000);
  {
    const n = await exec('window.__api.get()');
    const urls = await exec('window.__api.urls()');
    if (n > 0) info('隐藏期请求: ' + urls.map((u) => u.replace(/^https?:\/\/[^/]+/, '')).join(' | '));
    check('E7', '窗口隐藏 15s 的 /api 请求 = 0', String(n), n === 0);
  }
  await exec('window.__api.reset(), true');
  win.show();
  await exec(`window.__setVis('visible'), true`);
  await sleep(6000);
  {
    const n = await exec('window.__api.get()');
    check('E7', '回到可见后立即补拉（请求恢复）', String(n), n >= 1);
  }

  // ---------- E9：折叠/展开侧栏，主区容器 ResizeObserver 回调次数 ----------
  console.log('== E9 侧栏折叠的主区重排 ==');
  await open('/read/blocks.txt');
  await until(`!!document.querySelector('[data-wb-content-card]') && document.querySelector('[data-wb-content-card]').innerText.length > 1000`, 15000);
  await sleep(800);
  await exec(`(() => {
    const m = document.querySelector('main');
    window.__ro = { n: 0 };
    new ResizeObserver(() => { window.__ro.n++; }).observe(m);
    return true;
  })()`);
  await sleep(500); // 观察器初始回调落定
  await exec('window.__ro.n = 0, true');
  await exec(`document.querySelector('button[aria-label="折叠侧栏"]').click(); true`);
  await sleep(600);
  await exec(`document.querySelector('button[aria-label="折叠侧栏"]').click(); true`);
  await sleep(600);
  {
    const n = await exec('window.__ro.n');
    check('E9', '折叠+展开侧栏主区 ResizeObserver 回调 ≤ 2', String(n), n <= 2);
  }

  // ---------- E10：查找条/阅读偏好面板开阖不推挤正文 ----------
  console.log('== E10 浮层不推挤正文 ==');
  {
    const topOf = `(() => {
      const card = document.querySelector('[data-wb-content-card]');
      const el = card && card.firstElementChild;
      return el ? Math.round(el.getBoundingClientRect().top) : null;
    })()`;
    const t0 = await exec(topOf);
    await exec(`[...document.querySelectorAll('button')].find((b) => (b.title || '').startsWith('文内查找')).click(); true`);
    await sleep(500);
    const t1 = await exec(topOf);
    check('E10', '打开查找条后正文第一行 top 不变', `${t0} → ${t1}`, t0 != null && t0 === t1);
    await exec(`[...document.querySelectorAll('button')].find((b) => b.title === '阅读设置').click(); true`);
    await sleep(500);
    const t2 = await exec(topOf);
    check('E10', '打开阅读偏好面板后正文第一行 top 不变', `${t0} → ${t2}`, t0 === t2);
  }

  }

  // ---------- E8：约 5000 文件冷启动，建索引 [lag] 行数为 0 ----------
  console.log('== E8 后端建索引让出（约 5000 文件冷启动）==');
  {
    console.log('  复制 5 份夹具…');
    fs.mkdirSync(corpusBig, { recursive: true });
    for (let k = 0; k < 5; k++) {
      const dst = path.join(corpusBig, 'copy' + k);
      fs.cpSync(corpus, dst, { recursive: true });
    }
    const tmpData8 = path.join(tmpObj, 'data-big');
    server8 = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        WORKBENCH_PORT: '7503',
        WORKBENCH_HOST: '127.0.0.1',
        WORKBENCH_DATA_DIR: tmpData8,
        WORKBENCH_STATIC_DIR: path.join(ROOT, 'dist'),
        WORKBENCH_LAG_THRESHOLD_MS: '150',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    server8.stderr.on('data', (d) => process.stderr.write('[srv8] ' + d));
    const B8 = 'http://127.0.0.1:7503';
    for (let i = 0; ; i++) {
      try { await (await fetch(B8 + '/api/config')).json(); break; } catch { if (i > 150) throw new Error('E8 服务端未就绪'); await sleep(100); }
    }
    await fetch(B8 + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseDir: corpusBig }) });
    const t0 = Date.now();
    let ready = false;
    for (let i = 0; i < 1800; i++) {
      try {
        const st = await (await fetch(B8 + '/api/status')).json();
        const ls = await (await fetch(B8 + '/api/links/status')).json().catch(() => null);
        if (st.counts && st.counts.files >= 5000 && ls && ls.ready && !ls.building) { ready = true; break; }
      } catch { /* 构建中 */ }
      await sleep(1000);
    }
    const took = ((Date.now() - t0) / 1000).toFixed(1);
    const logFile = path.join(tmpData8, 'logs', 'backend.log');
    let lagLines = [];
    try {
      lagLines = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('[lag]') && (l.includes('建文本索引') || l.includes('算内链')));
    } catch { /* 无日志 */ }
    check('E8', '索引构建完成', ready ? `就绪（${took}s）` : '超时', ready);
    check('E8', '建文本索引/算内链 [lag] 行数 = 0', String(lagLines.length), lagLines.length === 0);
    for (const l of lagLines.slice(0, 5)) info(l.slice(0, 160));
    server8.kill();
  }

  console.log('\n== 汇总 ==');
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.id} ${r.name}: ${r.value}`);
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  return fail;
}

// 统一清理：无论成功失败都杀后端子进程并退出
let exitCode = 1;
main()
  .then((f) => { exitCode = f > 0 ? 1 : 0; })
  .catch((e) => { console.error(e); exitCode = 1; })
  .finally(() => {
    try { server?.kill(); } catch { /* 忽略 */ }
    try { server8?.kill(); } catch { /* 忽略 */ }
    app.exit(exitCode);
  });
