// 慢磁盘下后端不卡死（规格 specs/2026-11-03-slow-fs-no-block.md 的 G2）。
// 后端用 node --import <注入模块> 拉起，注入只作用于本测试临时目录（语料与 WORKBENCH_DATA_DIR）：
// - 同步 statSync / lstatSync / readdirSync / readFileSync / realpathSync 各阻塞 40ms（Atomics.wait）；
// - fs.promises 的 stat / lstat / readdir / readFile / realpath 与回调版 fs.realpath 各延迟 40ms（setTimeout）；
// - 「慢文件.md」的 stat 改为 600ms（单次 stat 超过 500ms 的情形）；
// - Word 缓存（word-<sha1>.json）与内链缓存（links/<dsId>.json）的 renameSync / promises.rename 一律抛 EPERM。
// 语料：约 300 个文本文件 + 5 个 Word（docx 3、doc 2；doc 复用仓库夹具 旧文档.doc）。
// 断言：扫描加建索引期间每 100ms 一次 /api/status，单次 ≤ 400ms；建索引 120 秒内完成；
// Word 正文可精确检索；后端日志有改名失败与慢操作的 WARN。
// 对照：--rev <git 版本> 改跑该版本的 server/（git show 落到临时目录），同一套断言。
// 用法：node scripts/test-slow-fs.mjs [--rev <git 版本>]
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const revAt = process.argv.indexOf('--rev');
const REV = revAt > 0 ? process.argv[revAt + 1] : null;
if (revAt > 0 && !REV) throw new Error('--rev 需要一个 git 版本');

const STATUS_LIMIT_MS = 400;
const OPEN_DOC = '卷0/册0/篇目000.md';
const HUGE_NAME = '超大文本.txt';
const INDEX_LIMIT_MS = 120000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('  ✓', name);
  } catch (e) {
    fail++;
    console.log('  ✗', name, '—', e.message);
  }
};
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

// ---------- 被测后端：当前工作区，或 --rev 指定版本的 server/ 与 schema/ ----------
let serverDir = path.join(ROOT, 'server');
if (REV) {
  const appDir = makeTmpDir('wb-slow-fs-app-');
  const list = execFileSync('git', ['-C', ROOT, 'ls-tree', '-r', '-z', '--name-only', REV, 'server', 'schema'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  for (const f of list) {
    fs.mkdirSync(path.join(appDir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(appDir, f), execFileSync('git', ['-C', ROOT, 'show', `${REV}:${f}`]));
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(appDir, 'node_modules'), 'dir');
  serverDir = path.join(appDir, 'server');
}
console.log(`== 被测后端：${REV ? `${REV}（git show 落到临时目录）` : '当前工作区'} ==`);

// ---------- 注入模块与慢目录 ----------
const slowRoot = makeTmpDir('wb-slow-fs-');
const SLOW_NAME = '慢文件.md';
const injectFile = path.join(makeTmpDir('wb-slow-fs-inject-'), 'slow-fs-inject.mjs');
fs.writeFileSync(injectFile, `// 慢磁盘注入（test-slow-fs.mjs 生成）：只作用于 SLOWFS_ROOTS 下的路径
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const roots = JSON.parse(process.env.SLOWFS_ROOTS);
const DELAY = Number(process.env.SLOWFS_DELAY_MS);
const SLOW_NAME = process.env.SLOWFS_SLOW_NAME;
const SLOW_MS = Number(process.env.SLOWFS_SLOW_MS);
const toStr = (p) => (typeof p === 'string' ? p : p instanceof URL ? fileURLToPath(p) : Buffer.isBuffer(p) ? p.toString() : '');
const inScope = (s) => roots.some((r) => s === r || s.startsWith(r + path.sep));
const delayOf = (p, isStat) => {
  const s = toStr(p);
  if (!s || !inScope(s)) return 0;
  return isStat && path.basename(s) === SLOW_NAME ? SLOW_MS : DELAY;
};
const cell = new Int32Array(new SharedArrayBuffer(4));

for (const name of ['statSync', 'lstatSync', 'readdirSync', 'readFileSync', 'realpathSync']) {
  const orig = fs[name];
  const isStat = name === 'statSync' || name === 'lstatSync';
  const wrapped = function (p, ...rest) {
    const ms = delayOf(p, isStat);
    if (ms) Atomics.wait(cell, 0, 0, ms); // 真阻塞：模拟系统调用本身很慢
    return orig.call(this, p, ...rest);
  };
  Object.assign(wrapped, orig); // realpathSync.native 等附属属性
  fs[name] = wrapped;
}
for (const name of ['stat', 'lstat', 'readdir', 'readFile', 'realpath']) {
  const orig = fs.promises[name];
  const isStat = name === 'stat' || name === 'lstat';
  fs.promises[name] = async function (p, ...rest) {
    const ms = delayOf(p, isStat);
    if (ms) await new Promise((r) => setTimeout(r, ms));
    return orig.call(this, p, ...rest);
  };
}
{
  const orig = fs.realpath;
  const wrapped = function (p, ...rest) {
    const ms = delayOf(p, false);
    if (!ms) return orig.call(this, p, ...rest);
    setTimeout(() => orig.call(this, p, ...rest), ms);
  };
  Object.assign(wrapped, orig);
  fs.realpath = wrapped;
}

// Word 缓存与内链缓存的改名一律 EPERM（Windows 上目标被占用）
const denied = (to) => {
  const s = toStr(to);
  const b = path.basename(s);
  return /^word-[0-9a-f]{40}\\.json$/.test(b) || (path.basename(path.dirname(s)) === 'links' && b.endsWith('.json'));
};
const eperm = (from, to) =>
  Object.assign(new Error("EPERM: operation not permitted, rename '" + from + "' -> '" + to + "'"), {
    code: 'EPERM', syscall: 'rename', path: String(from), dest: String(to),
  });
const renameSync = fs.renameSync;
fs.renameSync = function (from, to) {
  if (denied(to)) throw eperm(from, to);
  return renameSync.call(this, from, to);
};
const rename = fs.promises.rename;
fs.promises.rename = async function (from, to) {
  if (denied(to)) throw eperm(from, to);
  return rename.call(this, from, to);
};
syncBuiltinESMExports();
`);

// ---------- 语料：约 300 个文本文件 + 5 个 Word ----------
const corpus = path.join(slowRoot, 'corpus');
const dataDir = path.join(slowRoot, 'data');
const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function makeDocx(text, withImage = false) {
  const zip = new AdmZip();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  const image = withImage
    ? '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="图1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="图1"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
    : '';
  zip.addFile('word/document.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>' + escapeXml(text) + '</w:t></w:r></w:p>' + image + '</w:body></w:document>'));
  if (withImage) {
    zip.addFile('word/_rels/document.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>'));
    zip.addFile('word/media/image1.png', png);
  }
  return zip.toBuffer();
}
const TEXT_COUNT = 300;
{
  const exts = ['.md', '.md', '.md', '.txt', '.json', '.html'];
  for (let i = 0; i < TEXT_COUNT; i++) {
    const sub = path.join(corpus, `卷${i % 10}`, `册${i % 3}`);
    fs.mkdirSync(sub, { recursive: true });
    const ext = exts[i % exts.length];
    const title = `篇目${String(i).padStart(3, '0')}`;
    const ref = `篇目${String((i + 7) % TEXT_COUNT).padStart(3, '0')}`;
    const body =
      ext === '.json' ? JSON.stringify({ title, text: `学而时习之，参见${ref}。` })
        : ext === '.html' ? `<h1>${title}</h1><p>学而时习之，参见${ref}。</p>`
          : `# ${title}\n\n学而时习之，不亦说乎。参见${ref}。\n`;
    fs.writeFileSync(path.join(sub, title + ext), body);
  }
  fs.mkdirSync(path.join(corpus, '慢盘'), { recursive: true });
  fs.writeFileSync(path.join(corpus, '慢盘', SLOW_NAME), '# 慢文件\n\n这个文件的 stat 要 600ms。\n');
  const word = path.join(corpus, '讲义');
  fs.mkdirSync(word, { recursive: true });
  const fixtures = path.join(ROOT, 'test-data', 'ds-a', 'word');
  fs.copyFileSync(path.join(fixtures, '报告 2024.docx'), path.join(word, '报告 2024.docx'));
  fs.copyFileSync(path.join(fixtures, '旧文档.doc'), path.join(word, '旧文档.doc'));
  fs.copyFileSync(path.join(fixtures, '旧文档.doc'), path.join(word, '旧文档-副本.doc'));
  fs.writeFileSync(path.join(word, '甲讲义.docx'), makeDocx('慢盘检索标记甲一：温故而知新。'));
  fs.writeFileSync(path.join(word, '乙讲义.docx'), makeDocx('慢盘检索标记乙二：可以为师矣。', true));
  // 旁注（带标签）、阅读笔记与划线记录：标签、元数据问题、笔记反查等接口逐个读这些文件
  for (let i = 0; i < 60; i += 6) {
    const rel = `卷${i % 10}/册${i % 3}/篇目${String(i).padStart(3, '0')}.md`;
    fs.writeFileSync(path.join(corpus, rel + '.meta.json'), JSON.stringify({ id: 'doc_' + i, title: '篇目' + i, tags: ['慢盘标签'] }));
  }
  const notes = path.join(corpus, '阅读笔记');
  fs.mkdirSync(notes, { recursive: true });
  for (let n = 0; n < 30; n++) {
    fs.writeFileSync(path.join(notes, `.笔记${n}.annotations.json`), JSON.stringify([{ source: OPEN_DOC, quote: '学而时习之', at: '2026-11-04T00:00:00Z' }]));
    fs.writeFileSync(path.join(notes, `笔记${n}.md`), '# 笔记\n\n## 学而时习之\n');
  }
  // 超过应用内打开上限的文本（建索引按大小上限跳过正文，打开时返回 413）
  fs.writeFileSync(path.join(corpus, HUGE_NAME), Buffer.alloc(33 * 1024 * 1024, 'a'));
}
// 精确检索的期望：词 -> 必须命中的 Word 文件
const WORD_MARKERS = [
  ['月落乌啼霜满天', ['讲义/报告 2024.docx']],
  ['江枫渔火对愁眠', ['讲义/旧文档.doc', '讲义/旧文档-副本.doc']],
  ['慢盘检索标记甲一', ['讲义/甲讲义.docx']],
  ['慢盘检索标记乙二', ['讲义/乙讲义.docx']],
];

// ---------- 拉起后端 ----------
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const roots = [...new Set([slowRoot, fs.realpathSync(slowRoot)])];
const proc = spawn(process.execPath, ['--import', pathToFileURL(injectFile).href, path.join(serverDir, 'index.js')], {
  env: {
    ...process.env,
    WORKBENCH_PORT: String(port),
    WORKBENCH_HOST: '127.0.0.1',
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_RAG_EMBED: 'mock',
    SLOWFS_ROOTS: JSON.stringify(roots),
    SLOWFS_DELAY_MS: '40',
    SLOWFS_SLOW_NAME: SLOW_NAME,
    SLOWFS_SLOW_MS: '600',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const stderr = [];
proc.stderr.on('data', (d) => stderr.push(d));
let exited = null;
proc.on('exit', (code, sig) => { exited = sig || code; });
atExit(() => proc.kill('SIGKILL'));

try {
  for (let i = 0; ; i++) {
    if (exited !== null) throw new Error('后端提前退出：' + exited + '\n' + Buffer.concat(stderr).toString());
    try {
      const r = await fetch(base + '/api/config');
      if (r.ok) break;
    } catch { /* 启动中 */ }
    if (i > 600) throw new Error('后端 60 秒内未就绪');
    await sleep(100);
  }

  // ---------- 添加资料库：扫描与建索引期间每 100ms 一次 /api/status ----------
  const samples = []; // { at, ms, ok, s }
  let polling = true;
  const addStart = Date.now();
  const poller = (async () => {
    while (polling) {
      const t0 = performance.now();
      let s = null;
      let okRes = false;
      try {
        const r = await fetch(base + '/api/status');
        s = await r.json();
        okRes = r.ok;
      } catch { /* 记为失败样本 */ }
      const ms = performance.now() - t0;
      samples.push({ at: Date.now() - addStart, ms, ok: okRes, s });
      if (ms < 100) await sleep(100 - ms);
    }
  })();
  const add = await fetch(base + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseDir: corpus }),
  });
  const addMs = Date.now() - addStart;
  let indexDoneAt = null;
  while (Date.now() - addStart < INDEX_LIMIT_MS + 5000) {
    const last = samples[samples.length - 1]?.s;
    if (last && last.dsId && !last.scanning && last.indexing?.phase == null && last.linksReady) {
      indexDoneAt = samples[samples.length - 1].at;
      break;
    }
    await sleep(50);
  }
  polling = false;
  await poller;

  const lat = samples.map((x) => x.ms).sort((a, b) => a - b);
  const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] || 0;
  const maxMs = lat[lat.length - 1] || 0;
  const over = samples.filter((x) => x.ms > STATUS_LIMIT_MS);
  console.log(`  （添加资料库返回 ${addMs}ms（含首扫）；索引完成于 ${indexDoneAt ?? '未完成'}ms）`);
  console.log(`  （/api/status 采样 ${samples.length} 次：最大 ${maxMs.toFixed(0)}ms，p50 ${pct(0.5).toFixed(0)}ms，p95 ${pct(0.95).toFixed(0)}ms，超过 ${STATUS_LIMIT_MS}ms ${over.length} 次）`);
  if (over.length) console.log('  （超限样本：' + over.slice(0, 10).map((x) => `${x.at}ms 处 ${x.ms.toFixed(0)}ms`).join('，') + (over.length > 10 ? ' …' : '') + '）');

  check('添加资料库成功', () => ok(add.status === 200, `POST /api/config 返回 ${add.status}`));
  check(`扫描与建索引期间 /api/status 单次响应 ≤ ${STATUS_LIMIT_MS}ms`, () => {
    ok(samples.length >= 10, `采样过少（${samples.length}）`);
    ok(samples.every((x) => x.ok), `有 ${samples.filter((x) => !x.ok).length} 次请求失败`);
    ok(over.length === 0, `最大 ${maxMs.toFixed(0)}ms，超限 ${over.length} 次`);
  });
  check(`建索引 ${INDEX_LIMIT_MS / 1000} 秒内完成（indexing.phase 回到 null）`, () => {
    ok(indexDoneAt !== null && indexDoneAt <= INDEX_LIMIT_MS, `完成于 ${indexDoneAt ?? '未完成'}`);
    const last = samples[samples.length - 1].s;
    ok(last.indexError == null, 'indexError=' + last.indexError);
  });

  // ---------- Word 正文可精确检索（缓存写失败时解析结果没有被丢弃） ----------
  const hits = {};
  for (const [q] of WORD_MARKERS) {
    const r = await (await fetch(base + '/api/search?q=' + encodeURIComponent(q))).json();
    hits[q] = (r.results || []).filter((x) => x.matches.some((m) => m.field === 'content')).map((x) => x.file.path);
  }
  for (const [q, want] of WORD_MARKERS) {
    check(`精确检索「${q}」命中 ${want.join('、')}`, () => {
      for (const p of want) ok(hits[q].includes(p), `实际命中：${JSON.stringify(hits[q])}`);
    });
  }
  check('Word 缓存与内链缓存确实没有写成（改名注入生效），也没有遗留临时文件', () => {
    const left = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/^word-[0-9a-f]{40}\.json/.test(e.name) || (path.basename(d) === 'links' && e.name.includes('.json'))) left.push(path.relative(dataDir, p));
      }
    };
    walk(dataDir);
    ok(left.length === 0, '存在：' + left.join('，'));
  });

  // ---------- 读接口不阻塞：标签、元数据问题、笔记反查、打开文件（每个都要逐个读多份文件） ----------
  {
    const samples = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        const t0 = performance.now();
        let okRes = false;
        try { okRes = (await fetch(base + '/api/status')).ok; } catch { /* 记为失败样本 */ }
        const ms = performance.now() - t0;
        samples.push({ ms, ok: okRes });
        if (ms < 100) await sleep(100 - ms);
      }
    })();
    const q = encodeURIComponent(OPEN_DOC);
    const urls = ['/api/tags', '/api/meta/issues', '/api/notes/for?path=' + q, '/api/file?path=' + q, '/api/tags/doc?path=' + q];
    const results = {};
    for (let round = 0; round < 3; round++) {
      await Promise.all(urls.map(async (u) => {
        const r = await fetch(base + u);
        results[u] = { status: r.status, body: await r.json() };
      }));
    }
    polling = false;
    await poller;
    const max = Math.max(...samples.map((x) => x.ms));
    console.log(`  （读接口并发 3 轮期间 /api/status 采样 ${samples.length} 次，最大 ${max.toFixed(0)}ms）`);
    check(`读接口进行中 /api/status 单次 ≤ ${STATUS_LIMIT_MS}ms`, () => {
      ok(samples.length >= 3 && samples.every((x) => x.ok), '采样失败');
      ok(max <= STATUS_LIMIT_MS, `最大 ${max.toFixed(0)}ms`);
    });
    check('读接口结果正确（标签、笔记反查、打开文件）', () => {
      const tag = results['/api/tags'].body.tags?.find((t) => t.tag === '慢盘标签');
      ok(tag && tag.count === 10, '标签：' + JSON.stringify(tag));
      ok(results['/api/notes/for?path=' + q].body.notes?.length === 30, '笔记反查：' + results['/api/notes/for?path=' + q].body.notes?.length);
      ok(results['/api/file?path=' + q].body.content?.includes('学而时习之'), '打开文件失败');
    });
    const huge = await fetch(base + '/api/file?path=' + encodeURIComponent(HUGE_NAME));
    const hugeBody = await huge.json();
    check('超过打开上限的文本返回 413 与中文原因', () => ok(huge.status === 413 && hugeBody.tooLarge && /文件过大/.test(hugeBody.error), `${huge.status} ${hugeBody.error}`));
  }

  // ---------- 后端日志 ----------
  const log = fs.readFileSync(path.join(dataDir, 'logs', 'backend.log'), 'utf8');
  const lines = (re) => log.split('\n').filter((l) => re.test(l));
  const renameWarn = lines(/ WARN .*改名失败/);
  const scanSlow = lines(/ WARN .*\[scan\] 慢文件操作/);
  const indexSlow = lines(/ WARN .*\[index\] 慢文件/);
  const lagLines = lines(/\[lag\] 事件循环阻塞/);
  console.log(`  （backend.log：改名失败 WARN ${renameWarn.length} 行，扫描慢操作 WARN ${scanSlow.length} 行，建索引慢文件 WARN ${indexSlow.length} 行，[lag] ${lagLines.length} 行）`);
  for (const l of [...renameWarn.slice(0, 1), ...scanSlow.slice(0, 1), ...indexSlow.slice(0, 1), ...lagLines.slice(0, 3)]) {
    console.log('    ' + l.slice(25, 220));
  }
  check('后端日志有改名失败的 WARN', () => ok(renameWarn.length > 0, '没有'));
  check('后端日志有扫描慢操作的 WARN（慢文件.md 的 stat）', () => {
    ok(scanSlow.length > 0, '没有');
    ok(scanSlow.some((l) => l.includes(SLOW_NAME)), '最慢一次不是 ' + SLOW_NAME);
  });
  check('后端日志有建索引慢文件的 WARN', () => ok(indexSlow.length > 0, '没有'));
} finally {
  proc.kill('SIGKILL');
}

console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
