// 第 2 批 P1 缺陷回归（R1、R9–R15）：临时数据目录 + mock 嵌入 + 假 soffice，
// 不读写真实数据目录。运行：node scripts/test-batch2.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-batch2-'));
process.env.WORKBENCH_DATA_DIR = path.join(tmp, 'data');
process.env.WORKBENCH_RAG_EMBED = 'mock';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ---------- R9 isWithin ----------
console.log('R9 isWithin');
{
  const { isWithin } = await import('../server/paths.js');
  const win = await import('node:path');
  const p = win.default.win32 ?? win.win32;
  check('win32 盘符根内为真', isWithin('E:\\a.md', 'E:\\', p));
  check('win32 根上 .. 越界为假', !isWithin('E:\\..\\x', 'E:\\', p));
  check('posix 常规内', isWithin('/a/b', '/a'));
  check('posix 常规外', !isWithin('/ab', '/a'));
  check('posix .. 越界', !isWithin('/a/../b', '/a'));
  check('posix 内层 .. 回退仍在', isWithin('/a/x/../b', '/a'));
}

// ---------- R13 renameWithRetry ----------
console.log('R13 renameWithRetry');
{
  const storeMod = await import('../server/store.js');
  {
    const dir = fs.mkdtempSync(path.join(tmp, 'rename-'));
    const real = fs.renameSync;
    let calls = 0;
    fs.renameSync = (from, to) => {
      calls++;
      if (calls <= 2) { const e = new Error('占用'); e.code = 'EPERM'; throw e; }
      return real(from, to);
    };
    try {
      const src = path.join(dir, 'a');
      const dst = path.join(dir, 'b');
      fs.writeFileSync(src, 'x');
      storeMod.renameWithRetry(src, dst);
      check('前两次 EPERM 后成功', calls === 3 && fs.existsSync(dst) && !fs.existsSync(src), `calls=${calls}`);
    } finally { fs.renameSync = real; }
  }
  {
    const dir = fs.mkdtempSync(path.join(tmp, 'rename2-'));
    const real = fs.renameSync;
    fs.renameSync = () => { const e = new Error('占用'); e.code = 'EACCES'; throw e; };
    try {
      const src = path.join(dir, 'a');
      const dst = path.join(dir, 'b');
      fs.writeFileSync(src, 'x');
      let threw = false;
      try { storeMod.renameWithRetry(src, dst); } catch { threw = true; }
      check('全部失败抛错', threw);
    } finally { fs.renameSync = real; }
  }
  {
    const dir = fs.mkdtempSync(path.join(tmp, 'wja-'));
    const real = fs.renameSync;
    fs.renameSync = () => { const e = new Error('占用'); e.code = 'EBUSY'; throw e; };
    try {
      const f = path.join(dir, 'cfg.json');
      let threw = false;
      try { storeMod.writeJsonAtomic(f, { a: 1 }); } catch { threw = true; }
      check('writeJsonAtomic 失败抛错', threw);
      check('临时文件被删除', fs.readdirSync(dir).every((n) => !n.includes('.tmp-')), fs.readdirSync(dir).join(','));
    } finally { fs.renameSync = real; }
  }
}

// ---------- R14 toEditorText / 内链偏移 ----------
console.log('R14 换行混用内链偏移');
{
  const { toEditorText, detectLineSeparator } = await import('../server/editorText.js');
  const { extractLinks, buildAutoIndex } = await import('../server/linkMatch.js');
  check('纯 CRLF 归一为 LF', toEditorText('a\r\nb') === 'a\nb');
  check('孤立 CR 保留', toEditorText('a\rb') === 'a\rb');
  check('混用原样保留', toEditorText('a\r\nb\nc\rd') === 'a\r\nb\nc\rd');
  check('BOM 剥离', toEditorText('\uFEFFabc') === 'abc');
  check('detect CRLF', detectLineSeparator('a\r\nb') === '\r\n');
  check('detect 混用为 LF', detectLineSeparator('a\r\nb\nc') === '\n');
  const raw = '标题\n\n正文提到孔子家语\r\n换行后提到孟子讲稿\n末行\r';
  const text = toEditorText(raw);
  const auto = buildAutoIndex([
    { term: '孔子家语', path: 'x.md', kind: 'title' },
    { term: '孟子讲稿', path: 'y.md', kind: 'title' },
  ]);
  const links = extractLinks(text, auto, { selfPath: null });
  check('两个词条各命中一次', links.length >= 2, JSON.stringify(links));
  const allMatch = links.every((l) => text.slice(l.from, l.to) === l.term);
  check('每个链接 from/to 截取子串等于词条', allMatch, links.map((l) => text.slice(l.from, l.to) + ' vs ' + l.term).join(' | '));
}

// ---------- R15 大小写重命名决策 ----------
console.log('R15 大小写重命名决策');
{
  const { caseRenameAction } = await import('../server/renamePlan.js');
  check('非仅大小写 → direct', caseRenameAction({ caseOnly: false, targetExists: false, sameInode: false }) === 'direct');
  check('目标存在不同 inode → conflict', caseRenameAction({ caseOnly: true, targetExists: true, sameInode: false }) === 'conflict');
  check('同一 inode → two-step', caseRenameAction({ caseOnly: true, targetExists: true, sameInode: true }) === 'two-step');
  check('目标不存在 → two-step', caseRenameAction({ caseOnly: true, targetExists: false, sameInode: false }) === 'two-step');
}

// ---------- R1 RAG 一致性（in-process + mock 嵌入） ----------
console.log('R1 RAG 一致性');
{
  const { RagManager } = await import('../server/rag/manager.js');
  const { DIM } = await import('../server/rag/embed.js');
  const { Indexer } = await import('../server/indexer.js');

  const corpus = path.join(tmp, 'corpus');
  fs.mkdirSync(corpus, { recursive: true });
  fs.writeFileSync(path.join(corpus, 'a.md'), '# 甲\n\n孔子');
  fs.writeFileSync(path.join(corpus, 'b.md'), '# 乙\n\n孟子');
  const snapshotFiles = () => fs.readdirSync(corpus)
    .filter((n) => n.endsWith('.md'))
    .map((n) => {
      const abs = path.join(corpus, n);
      const st = fs.statSync(abs);
      return { path: n, name: n, base: n.slice(0, -3), ext: '.md', mtimeMs: st.mtimeMs, size: st.size, dir: '' };
    });
  const indexer = new Indexer();
  indexer.reset('r1', corpus);
  await indexer.build({ files: snapshotFiles() });
  const getLib = (id) => (id === 'r1' ? {
    snapshot: { files: snapshotFiles() },
    getText: (p) => indexer.texts.get(p) ?? null,
    whenIndexed: () => Promise.resolve(),
  } : null);
  const mkManager = () => new RagManager({ dataDir: tmp, knowledgeDir: path.join(tmp, 'knowledge'), getLib });
  const mgr = mkManager();
  const vector = (x) => { const v = new Float32Array(DIM); v[0] = x; return v; };
  mgr.embed.embed = async () => [vector(1)];

  // R1a：构建中新建文件 → 构建结束后 files 表含该文件且有向量
  {
    let release;
    const gate = new Promise((r) => { release = r; });
    let gated = true;
    mgr.embed.embed = async () => { if (gated) { gated = false; await gate; } return [vector(1)]; };
    const buildP = mgr.build('r1', { rebuild: true });
    await sleep(20);
    fs.writeFileSync(path.join(corpus, 'c.md'), '# 丙\n\n老子');
    indexer.texts.set('c.md', '# 丙\n\n老子');
    mgr.onScanComplete('r1'); // 构建中：记 pendingRescan
    release();
    await buildP;
    await sleep(300); // 等 finally 触发的增量续建完成
    const ix = mgr.index('r1');
    const row = ix.store.db.prepare('SELECT chunk_count, done FROM files WHERE path=?').get('c.md');
    const vecN = ix.store.db.prepare('SELECT COUNT(*) n FROM vecs v JOIN chunks c ON c.id=v.chunk_id WHERE c.path=?').get('c.md').n;
    check('R1a 构建中新建文件进入 files 表且有向量', !!row && row.done === 1 && vecN > 0, JSON.stringify({ row, vecN }));
    mgr.embed.embed = async () => [vector(1)];
  }

  // R1b：嵌入在某文件上抛错 → done=0，下次增量补上
  {
    let calls = 0;
    mgr.embed.embed = async () => { calls++; if (calls === 2) throw new Error('embed boom'); return [vector(1)]; };
    const r = await mgr.build('r1', { rebuild: true });
    check('R1b 构建失败返回 ok=false', r.ok === false, JSON.stringify(r));
    const ix = mgr.index('r1');
    const b = ix.store.db.prepare('SELECT done FROM files WHERE path=?').get('b.md');
    check('R1b 抛错文件 done=0', !!b && b.done === 0, JSON.stringify(b));
    mgr.embed.embed = async () => [vector(1)];
    await mgr.build('r1', {});
    const b2 = ix.store.db.prepare('SELECT done FROM files WHERE path=?').get('b.md');
    const vecN = ix.store.db.prepare('SELECT COUNT(*) n FROM vecs v JOIN chunks c ON c.id=v.chunk_id WHERE c.path=?').get('b.md').n;
    check('R1b 下次增量补上（done=1 且有向量）', !!b2 && b2.done === 1 && vecN > 0, JSON.stringify({ b2, vecN }));
  }

  // R1c：构建到一半中断（暂停后重建 manager）→ status 不为 ready
  {
    let release;
    const gate = new Promise((r) => { release = r; });
    let gated = true;
    mgr.embed.embed = async () => { if (gated) { gated = false; await gate; } return [vector(1)]; };
    const buildP = mgr.build('r1', { rebuild: true });
    await sleep(20);
    mgr.pause('r1');
    release();
    await buildP;
    const mgr2 = mkManager();
    const st = mgr2.status('r1').index;
    check('R1c 中断后重建实例 status 不为 ready', st.state !== 'ready' && st.files > 0, JSON.stringify(st));
    mgr.embed.embed = async () => [vector(1)];
  }

  // R1e：改切块参数后暂停再续建，第二次不清库（chunks 不回到 0）
  {
    await mgr.build('r1', { rebuild: true });
    const before = mgr.index('r1')._ensureStore().stats().chunks;
    check('R1e 预置：全量后有 chunks', before > 0, String(before));
    mgr.saveConfig('r1', { chunk: { maxChars: 4000 } }); // 改参数 → 指纹变化
    let release;
    const gate = new Promise((r) => { release = r; });
    let gated = true;
    mgr.embed.embed = async () => { if (gated) { gated = false; await gate; } return [vector(1)]; };
    const buildP = mgr.build('r1', {});
    await sleep(20);
    mgr.pause('r1');
    release();
    await buildP;
    const afterPause = mgr.index('r1')._ensureStore().stats().chunks;
    check('R1e 暂停后 chunks>0（已写入新指纹）', afterPause > 0, String(afterPause));
    mgr.embed.embed = async () => [vector(1)];
    await mgr.build('r1', {});
    const final = mgr.index('r1')._ensureStore().stats().chunks;
    check('R1e 第二次不清库（chunks 未回到 0）', final >= afterPause && final > 0, `afterPause=${afterPause} final=${final}`);
  }
  for (const ix of mgr.indices.values()) ix.store?.close();
}

// ---------- R11 .doc 转换隔离（in-process + 假 soffice） ----------
console.log('R11 .doc 转换隔离');
{
  const AdmZip = (await import('adm-zip')).default;
  const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const makeDocx = (text) => {
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
    zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
    zip.addFile('word/document.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + escapeXml(text) + '</w:t></w:r></w:p></w:body></w:document>'));
    return zip.toBuffer();
  };
  const binDir = fs.mkdtempSync(path.join(tmp, 'bin-'));
  const tplOne = path.join(tmp, 'tpl-one.docx');
  const tplTwo = path.join(tmp, 'tpl-two.docx');
  fs.writeFileSync(tplOne, makeDocx('ONE-CONTENT-甲乙丙'));
  fs.writeFileSync(tplTwo, makeDocx('TWO-CONTENT-丁戊己'));
  const sofficeScript = path.join(binDir, 'soffice');
  fs.writeFileSync(sofficeScript, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('LibreOffice fake'); process.exit(0); }
if (process.env.FAKE_SOFFICE_NO_OUTPUT === '1') { process.exit(0); }
const outIdx = args.indexOf('--outdir');
if (args.includes('--convert-to') && outIdx >= 0 && args[outIdx + 1]) {
  const outdir = args[outIdx + 1];
  const input = args[args.length - 1];
  let content = '';
  try { content = fs.readFileSync(input, 'utf8'); } catch {}
  let tpl = null;
  if (content.includes('ONE-MARKER')) tpl = process.env.FAKE_SOFFICE_TPL_ONE;
  else if (content.includes('TWO-MARKER')) tpl = process.env.FAKE_SOFFICE_TPL_TWO;
  if (tpl) {
    const out = path.join(outdir, path.basename(input, path.extname(input)) + '.docx');
    fs.copyFileSync(tpl, out);
  }
  process.exit(0);
}
process.exit(0);
`);
  fs.chmodSync(sofficeScript, 0o755);
  process.env.PATH = binDir + path.delimiter + (process.env.PATH || '');
  process.env.FAKE_SOFFICE_TPL_ONE = tplOne;
  process.env.FAKE_SOFFICE_TPL_TWO = tplTwo;

  const { parseWord } = await import('../server/word.js');
  const d1 = path.join(tmp, 'd1');
  const d2 = path.join(tmp, 'd2');
  fs.mkdirSync(d1);
  fs.mkdirSync(d2);
  fs.writeFileSync(path.join(d1, 'a.doc'), 'ONE-MARKER');
  fs.writeFileSync(path.join(d2, 'a.doc'), 'TWO-MARKER');
  const [r1, r2] = await Promise.all([
    parseWord('r11', path.join(d1, 'a.doc'), 'd1/a.doc', 1),
    parseWord('r11', path.join(d2, 'a.doc'), 'd2/a.doc', 1),
  ]);
  check('R11 并发同名 .doc 各自内容（一）', (r1.text || '').includes('ONE-CONTENT'), JSON.stringify(r1.engine));
  check('R11 并发同名 .doc 各自内容（二）', (r2.text || '').includes('TWO-CONTENT'), JSON.stringify(r2.engine));
  const cacheDir = path.join(process.env.WORKBENCH_DATA_DIR, 'knowledge', 'r11', 'cache');
  check('R11 临时目录用完即删', !fs.existsSync(cacheDir) || !fs.readdirSync(cacheDir).some((n) => n.startsWith('convert-')), '');

  // 假 soffice 不产出文件 → 回退 word-extractor，且不读到旧 word-convert 目录里的陈旧 docx
  const oldShared = path.join(cacheDir, 'word-convert');
  fs.mkdirSync(oldShared, { recursive: true });
  fs.writeFileSync(path.join(oldShared, 'a.docx'), makeDocx('STALE-MARKER'));
  process.env.FAKE_SOFFICE_NO_OUTPUT = '1';
  const realDoc = path.join(tmp, 'real.doc');
  fs.copyFileSync(path.join(ROOT, 'test-data', 'ds-a', 'word', '旧文档.doc'), realDoc);
  const r3 = await parseWord('r11', realDoc, 'real.doc', 2);
  check('R11 无产物回退 word-extractor', r3.engine === 'word-extractor', JSON.stringify(r3.engine));
  check('R11 不读到旧文件', !(r3.text || '').includes('STALE-MARKER'), '');
  delete process.env.FAKE_SOFFICE_NO_OUTPUT;
}

// ---------- P3 回归：Word 缓存格式版本（旧内嵌 data URI 缓存不命中） ----------
console.log('P3 Word 缓存版本失效');
{
  const AdmZip = (await import('adm-zip')).default;
  const { createHash } = await import('node:crypto');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.addFile('word/document.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>带图文档</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="图1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="图1"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>'));
  zip.addFile('word/media/image1.png', png);
  const dir = fs.mkdtempSync(path.join(tmp, 'p3-'));
  const docxPath = path.join(dir, '带图.docx');
  fs.writeFileSync(docxPath, zip.toBuffer());
  // 写入无版本号的旧格式缓存（mtime 与文件一致，仅缺 v 字段）：不应命中
  const rel = '带图.docx';
  const key = createHash('sha1').update(rel).digest('hex');
  const cacheFile = path.join(process.env.WORKBENCH_DATA_DIR, 'knowledge', 'p3word', 'cache', 'word-' + key + '.json');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const st = fs.statSync(docxPath);
  fs.writeFileSync(cacheFile, JSON.stringify({ mtimeMs: st.mtimeMs, result: { html: '<p>旧</p><img src="data:image/png;base64,' + png.toString('base64') + '">', text: '旧', engine: 'mammoth' } }));
  const { parseWord } = await import('../server/word.js');
  const r = await parseWord('p3word', docxPath, rel, st.mtimeMs);
  check('P3 旧格式缓存不命中（重新解析）', !r.html.includes('data:image'), (r.html || '').slice(0, 120));
  check('P3 图片外置引用资产接口', r.html.includes('/api/word/asset'), '');
}

// ---------- HTTP 侧（R10 / R12 / R1d） ----------
function spawnBackend(dataDir, port, extraEnv = {}) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1', WORKBENCH_DATA_DIR: dataDir, WORKBENCH_RAG_EMBED: 'mock', ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  return proc;
}
async function waitReady(base) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(base + '/api/config'); if (r.status < 500) return; } catch { /* 未就绪 */ }
    if (i > 120) throw new Error('后端未就绪: ' + base);
    await sleep(100);
  }
}
async function kill(proc) {
  if (proc && !proc.killed) { proc.kill('SIGTERM'); await sleep(300); }
}
const j = (base) => async (url, init) => {
  const r = await fetch(base + url, init);
  let body = {};
  try { body = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body };
};

// R12 清除忽略
console.log('R12 清除忽略');
{
  const dataDir = path.join(tmp, 'http-r12-data');
  const corpus = path.join(tmp, 'http-r12-corpus');
  fs.mkdirSync(corpus, { recursive: true });
  fs.writeFileSync(path.join(corpus, 'a.md'), '# 甲\n');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawnBackend(dataDir, port);
  await waitReady(base);
  const req = j(base);
  await req('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseDir: corpus }) });
  await sleep(800);
  const r = await req('/api/links/ignore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clearAll: true }) });
  check('R12 POST 清除忽略 → 200', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  await kill(proc);
}

// R10 启动时不可达的库恢复后可救回
console.log('R10 启动时不可达的库恢复');
{
  const { dsIdFor } = await import('../server/store.js');
  const dataDir = path.join(tmp, 'http-r10-data');
  const corpus = path.join(tmp, 'http-r10-corpus');
  const id = dsIdFor(corpus);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ version: 2, libraries: [{ id, baseDir: corpus, name: 'r10', addedAt: new Date().toISOString() }], activeId: id }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawnBackend(dataDir, port);
  await waitReady(base);
  const req = j(base);
  // 此时目录不存在：rescan 应 409；创建目录后 rescan 应 200 且树中有文件
  const before = await req('/api/rescan', { method: 'POST' });
  check('R10 目录不存在时 rescan → 409', before.status === 409, JSON.stringify(before.body));
  fs.mkdirSync(corpus, { recursive: true });
  fs.writeFileSync(path.join(corpus, 'x.md'), '# 恢复\n');
  await sleep(100);
  const after = await req('/api/rescan', { method: 'POST' });
  check('R10 目录恢复后 rescan → 200', after.status === 200 && after.body.ok === true, JSON.stringify(after.body));
  const tree = await req('/api/tree');
  const files = [];
  const walk = (n) => { for (const f of n.files || []) files.push(f.path); for (const d of n.dirs || []) walk(d); };
  walk(tree.body.tree || {});
  check('R10 恢复后树中有文件', files.includes('x.md'), files.join(','));
  await kill(proc);
}

// R1d 新起后端实例时已有索引的库自动续建完成
console.log('R1d 启动续建');
{
  const { dsIdFor } = await import('../server/store.js');
  const { RagStore } = await import('../server/rag/store.js');
  const dataDir = path.join(tmp, 'http-r1d-data');
  const corpus = path.join(tmp, 'http-r1d-corpus');
  fs.mkdirSync(corpus, { recursive: true });
  const rel = 'a.md';
  fs.writeFileSync(path.join(corpus, rel), '# 甲\n\n孔子');
  const st = fs.statSync(path.join(corpus, rel));
  const id = dsIdFor(corpus);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ version: 2, libraries: [{ id, baseDir: corpus, name: 'r1d', addedAt: new Date().toISOString() }], activeId: id }));
  const ragDb = path.join(dataDir, 'knowledge', id, 'rag.db');
  fs.mkdirSync(path.dirname(ragDb), { recursive: true });
  const rs = new RagStore(ragDb);
  rs.db.prepare('INSERT INTO files(path, content_hash, chunk_count, done, updated_at) VALUES(?,?,0,0,?)').run(rel, st.mtimeMs + ':' + st.size, Date.now());
  rs.close();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawnBackend(dataDir, port);
  await waitReady(base);
  const req = j(base);
  let done = false;
  for (let i = 0; i < 40; i++) {
    const stx = await req('/api/rag/status');
    const ix = stx.body?.index;
    if (ix && ix.files > 0 && ix.filesDone === ix.files && ix.chunks > 0) { done = true; break; }
    await sleep(250);
  }
  const final = await req('/api/rag/status');
  check('R1d 已有索引的库自动续建完成', done, JSON.stringify(final.body?.index));
  await kill(proc);
}

// ---------- 收尾 ----------
console.log('\n通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
