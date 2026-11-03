// Electron 端到端安全测试：Word 预览净化（WordReader 实际调用的 DOMPurify 路径）。
// 构造含 javascript: 超链接与内嵌图片的恶意 docx，打开阅读页断言净化结果，并真实点击超链接验证无副作用。
// 用法：先 npm run build，再 ./node_modules/.bin/electron scripts/e2e-security.mjs
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.E2E_PORT) || 7602;
const BASE = `http://127.0.0.1:${PORT}`;

app.on('window-all-closed', () => {}); // 窗口销毁不退出，由脚本自己收尾

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 手写最小 docx zip：一段正文 + 一个 TargetMode=External 的 javascript: 超链接 + 一张内嵌 PNG。
function makeMaliciousDocx() {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
<w:p><w:r><w:t>恶意文档</w:t></w:r></w:p>
<w:p><w:hyperlink r:id="rIdLink"><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t>点我领奖</w:t></w:r></w:hyperlink></w:p>
<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="图1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="图1"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
</w:body>
</w:document>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:fetch('/api/file/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dir:'',kind:'md',name:'xss-proof'})})" TargetMode="External"/>
<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`;
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(contentTypes));
  zip.addFile('_rels/.rels', Buffer.from(rels));
  zip.addFile('word/document.xml', Buffer.from(documentXml));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(docRels));
  zip.addFile('word/media/image1.png', png);
  return zip.toBuffer();
}

let win = null;
let server = null;
atExit(() => server?.kill('SIGKILL'));
const tmpObj = makeTmpDir('wb-e2e-security-');
const tmpData = path.join(tmpObj, 'data');
const corpus = path.join(tmpObj, 'corpus');
fs.mkdirSync(corpus, { recursive: true });
fs.writeFileSync(path.join(corpus, 'evil.docx'), makeMaliciousDocx());

const j = async (url, init) => {
  const r = await fetch(BASE + url, init);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = (url, body) => j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function waitApi() {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(BASE + '/api/config'); if (r.ok) return; } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 30000) throw new Error('服务等待超时');
    await sleep(200);
  }
}

const exec = async (js) => win.webContents.executeJavaScript(js, true);
async function waitFor(js, label, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await exec(js); } catch { /* 页面切换瞬间可失败 */ }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('等待超时: ' + label);
    await sleep(120);
  }
}

async function main() {
  app.on('web-contents-created', (_e, wc) => {
    wc.on('console-message', (_ev, level, message) => {
      if (level >= 2 && /content security policy/i.test(String(message))) {
        console.log('CSP违规:', String(message).slice(0, 300));
      }
    });
    wc.on('render-process-gone', (_ev, details) => console.log('GONE:', details.reason));
  });

  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WORKBENCH_PORT: String(PORT),
      WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_DATA_DIR: tmpData,
      WORKBENCH_STATIC_DIR: path.join(ROOT, 'dist'),
      WORKBENCH_RAG_EMBED: 'mock',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  await waitApi();
  await app.whenReady();
  win = new BrowserWindow({
    width: 1200, height: 800, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  const cfg = await post('/api/config', { baseDir: corpus });
  if (!cfg.body.ok) throw new Error('配置资料库失败: ' + JSON.stringify(cfg.body));

  await win.loadURL(BASE + '/read/' + encodeURIComponent('evil.docx'));
  await waitFor(`(() => [...document.querySelectorAll('a')].some((x) => x.textContent.includes('点我领奖')))()`, '恶意链接渲染');

  // ① 页面里没有 javascript: 链接、没有 on* 属性
  const jsLinks = await exec(`document.querySelectorAll('a[href^="javascript:"]').length`);
  check('无 href 以 javascript: 开头的 a', jsLinks === 0, String(jsLinks));
  const onAttrs = await exec(`(() => { const bad = []; for (const el of document.querySelectorAll('*')) { for (const a of el.attributes) { if (/^on/i.test(a.name)) bad.push(a.name); } } return bad; })()`);
  check('无 on* 属性的元素', onAttrs.length === 0, JSON.stringify(onAttrs));

  // ② 内嵌图片保留且已加载：P3 后图片外置为 /api/word/asset（HTML 引用接口而非内嵌 data URI），
  //    同时 /api/file 响应不含 data:image。等待图片真正加载完成再断言。
  await waitFor(`(() => [...document.querySelectorAll('img')].some((i) => (i.getAttribute('src') || '').startsWith('/api/word/asset?') && i.complete === true && i.naturalWidth > 0))()`, '内嵌图片经资产接口加载');
  const imgOk = await exec(`(() => [...document.querySelectorAll('img')].some((i) => (i.getAttribute('src') || '').startsWith('/api/word/asset?') && i.complete === true && i.naturalWidth > 0))()`);
  check('内嵌图片保留且已加载（外置为 /api/word/asset）', imgOk === true, String(imgOk));
  const fileJson = JSON.stringify(await (await fetch(BASE + '/api/file?path=' + encodeURIComponent('evil.docx'))).json());
  check('/api/file 响应不含 data:image', !fileJson.includes('data:image'), '');

  // ③ 真实点击超链接，等待后库中不应出现 xss-proof.md
  const rect = await exec(`(() => { const a = [...document.querySelectorAll('a')].find((x) => x.textContent.includes('点我领奖')); if (!a) return null; const r = a.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (rect) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 });
  }
  await sleep(1000);
  check('点击后库中无 xss-proof.md', !fs.existsSync(path.join(corpus, 'xss-proof.md')), '');

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  server.kill('SIGTERM');
  app.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E 执行异常:', e);
  try { server?.kill('SIGTERM'); } catch { /* ignore */ }
  app.exit(1);
});
