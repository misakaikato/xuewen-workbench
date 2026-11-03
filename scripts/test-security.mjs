// 安全与数据修复回归测试（S1–S10）。自起临时后端 + 假 LLM 端点，不读写真实数据目录。
// 运行：node scripts/test-security.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let pass = 0, fail = 0;
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

// 本进程内的纯函数单测：先隔离数据目录并禁用自动迁移，再 import 服务端模块（与后端同一份源码）
const IN_PROC_DATA = makeTmpDir('wb-sec-import-');
process.env.WORKBENCH_HOSTED = '1';
process.env.WORKBENCH_DATA_DIR = IN_PROC_DATA;
const { migrateLegacyUserData } = await import(path.join(ROOT, 'server', 'store.js'));

// ---------- S10 旧数据迁移（直接调用 store 导出的迁移函数） ----------
console.log('S10 旧数据迁移');
{
  const legacy = makeTmpDir('wb-sec-legacy-');
  const newData = makeTmpDir('wb-sec-newdata-');
  fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ version: 2, libraries: [{ id: 'x', baseDir: '/tmp/c', name: 'c' }], activeId: 'x' }));
  fs.mkdirSync(path.join(legacy, 'models'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'models', 'm.bin'), 'x');
  const r1 = migrateLegacyUserData(legacy, newData);
  check('旧目录含 config.json 时迁移', r1.migrated === true, JSON.stringify(r1));
  check('config.json 迁入新目录', fs.existsSync(path.join(newData, 'config.json')));
  check('models/ 迁入新目录', fs.existsSync(path.join(newData, 'models', 'm.bin')));
  check('legacy 写入 MIGRATED.txt', fs.existsSync(path.join(legacy, 'MIGRATED.txt')));

  const legacy2 = makeTmpDir('wb-sec-legacy2-');
  const newData2 = makeTmpDir('wb-sec-newdata2-');
  fs.writeFileSync(path.join(legacy2, 'config.json'), JSON.stringify({ version: 2, libraries: [{ id: 'old', baseDir: '/tmp/old', name: 'old' }], activeId: 'old' }));
  fs.mkdirSync(path.join(legacy2, 'models'), { recursive: true });
  fs.writeFileSync(path.join(legacy2, 'models', 'm.bin'), 'y');
  fs.writeFileSync(path.join(newData2, 'config.json'), JSON.stringify({ version: 2, libraries: [{ id: 'new', baseDir: '/tmp/new', name: 'new' }], activeId: 'new' }));
  const r2 = migrateLegacyUserData(legacy2, newData2);
  check('新目录已有库时不迁移', r2.migrated === false, JSON.stringify(r2));
  check('legacy config 保留', fs.existsSync(path.join(legacy2, 'config.json')));
  check('legacy models 保留', fs.existsSync(path.join(legacy2, 'models', 'm.bin')));
  check('新目录 config 未被覆盖', JSON.parse(fs.readFileSync(path.join(newData2, 'config.json'), 'utf8')).activeId === 'new');
}

// ---------- 准备临时数据目录与语料 ----------
const tmpObj = makeTmpDir('wb-sec-');
const tmpData = path.join(tmpObj, 'data');
const corpus = path.join(tmpObj, 'corpus');
const outside = path.join(tmpObj, 'outside');
const staticDir = path.join(tmpObj, 'static');
fs.mkdirSync(corpus, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.mkdirSync(staticDir, { recursive: true });

// 最小 index.html（模拟构建产物：内联防闪烁脚本 + 外链模块脚本），用于 S2 CSP 断言
fs.writeFileSync(path.join(staticDir, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>t</title>' +
  '<script>/*wb-theme*/(function(){})();</script></head><body><div id="root"></div>' +
  '<script type="module" src="/assets/main.js"></script></body></html>\n');

// 非 UTF-8 语料：GBK「中文论语」与 UTF-16LE(BOM)「论语讲稿」
fs.writeFileSync(path.join(corpus, 'gbk.md'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xc2, 0xdb, 0xd3, 0xef]));
fs.writeFileSync(path.join(corpus, 'utf16.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('论语讲稿', 'utf16le')]));
fs.writeFileSync(path.join(corpus, 'normal.md'), '# 论语讲稿\n正文\n');

// S7 符号链接：库内 link -> 库外目录
fs.symlinkSync(outside, path.join(corpus, 'link'));

// S9 库根 .pi/extensions/x.js：若被 pi 当作可信代码加载，会写标记文件
const extMarker = path.join(tmpObj, 'ext-loaded');
fs.mkdirSync(path.join(corpus, '.pi', 'extensions'), { recursive: true });
fs.writeFileSync(path.join(corpus, '.pi', 'extensions', 'x.js'),
  `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(extMarker)}, 'loaded');\nexport default () => ({});\n`);

// ---------- 假 OpenAI 兼容端点（仅监听 127.0.0.1） ----------
const fake = { plan: [], requests: [], tools: [] };
function sseBody(deltaChunks, finishReason) {
  const base = { id: 'chatcmpl-t', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'test-model' };
  const parts = [];
  for (const delta of deltaChunks) parts.push(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  parts.push(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
  parts.push('data: [DONE]\n\n');
  return parts.join('');
}
const fakeServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      fake.requests.push(parsed);
      if (!fake.tools.length && Array.isArray(parsed.tools)) {
        fake.tools = parsed.tools.map((t) => t.function?.name).filter(Boolean);
      }
      const step = fake.plan.shift() || { text: '完成' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      if (step.toolCall) {
        const tc = step.toolCall;
        res.end(sseBody([
          { role: 'assistant', content: '' },
          { tool_calls: [{ index: 0, id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }] },
        ], 'tool_calls'));
      } else {
        res.end(sseBody([{ role: 'assistant', content: '' }, { content: step.text || '完成' }], 'stop'));
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});
const fakePort = await freePort();
await new Promise((resolve) => fakeServer.listen(fakePort, '127.0.0.1', resolve));

// ---------- 后端进程管理 ----------
let server = null;
function spawnBackend(dataDir, port) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      WORKBENCH_PORT: String(port),
      WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_DATA_DIR: dataDir,
      WORKBENCH_RAG_EMBED: 'mock',
      WORKBENCH_STATIC_DIR: staticDir,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  atExit(() => proc.kill('SIGKILL'));
  return proc;
}
async function waitReady(base) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(base + '/api/config'); if (r.status < 500) return; } catch { /* not ready */ }
    if (i > 120) throw new Error('后端未就绪: ' + base);
    await sleep(100);
  }
}
async function kill(proc) {
  if (proc && !proc.killed) { proc.kill('SIGTERM'); await sleep(300); }
}

let PORT = await freePort();
let BASE = `http://127.0.0.1:${PORT}`;
server = spawnBackend(tmpData, PORT);
await waitReady(BASE);

// ---------- 请求助手 ----------
const j = async (url, init) => {
  const r = await fetch(BASE + url, init);
  let body = {};
  try { body = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body, text: body };
};
const post = (url, body) => j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
// 原生 http 请求：可精确控制 Host / Origin 头（fetch 会拒绝设置这些被禁头）
function rawReq({ method = 'GET', path: p, host = '127.0.0.1:' + PORT, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { ...headers, Host: host } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ---------- S2 CSP ----------
console.log('S2 CSP');
{
  const home = await fetch(BASE + '/');
  const csp = home.headers.get('content-security-policy') || '';
  check('响应含 CSP 头', !!csp, csp);
  const nonceM = /script-src 'self' 'nonce-([^']+)'/.exec(csp);
  check('CSP 含 nonce', !!nonceM, csp);
  const nonce = nonceM ? nonceM[1] : '';
  const html = await home.text();
  check('页面脚本带相同 nonce', !!nonce && html.includes('nonce="' + nonce + '"'), '');
  check('无缺 nonce 的 script', !/<script\b(?![^>]*\snonce=)[^>]*>/i.test(html), '');
  check('script-src 禁 inline', csp.includes("script-src 'self' 'nonce-") && !csp.includes("script-src 'self' 'unsafe-inline'"), csp);
  check('img-src 允许 data/blob/http', /img-src [^;]*data:/.test(csp) && csp.includes('https:'), csp);
}

// ---------- 添加资料库（后续测试的基础） ----------
const addLib = await post('/api/config', { baseDir: corpus });
check('正常添加资料库成功', addLib.status === 200 && addLib.body.ok === true, JSON.stringify(addLib.body));
const dsId = addLib.body.dsId;
// 助手默认关闭：准备阶段打开总开关（S6 skill、S9 助手要用；持久化在 tmpData，重启后仍开）
await fetch(BASE + '/api/ui-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentEnabled: true }) });

// ---------- S3 Host / Origin ----------
console.log('S3 Host / Origin');
{
  const configBefore = fs.readFileSync(path.join(tmpData, 'config.json'), 'utf8');

  const evilHost = await rawReq({ path: '/api/config', host: 'evil.example:' + PORT });
  check('Host: evil → 403 forbidden-host', evilHost.status === 403 && evilHost.body.includes('forbidden-host'), evilHost.status + ' ' + evilHost.body);

  const evilOrigin = await rawReq({ method: 'POST', path: '/api/config', host: '127.0.0.1:' + PORT, headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' }, body: '{}' });
  check('Origin: evil → 403 forbidden-origin', evilOrigin.status === 403 && evilOrigin.body.includes('forbidden-origin'), evilOrigin.status + ' ' + evilOrigin.body);

  const nullOrigin = await rawReq({ method: 'POST', path: '/api/config', host: '127.0.0.1:' + PORT, headers: { 'Content-Type': 'text/plain', Origin: 'null' }, body: '{}' });
  check('Origin: null → 403', nullOrigin.status === 403 && nullOrigin.body.includes('forbidden-origin'), nullOrigin.status + ' ' + nullOrigin.body);

  const localOrigin = await rawReq({ path: '/api/config', host: '127.0.0.1:' + PORT, headers: { Origin: 'http://localhost:3000' } });
  check('Origin: localhost:3000 → 放行', localOrigin.status === 200, localOrigin.status + ' ' + localOrigin.body);

  const noOrigin = await rawReq({ path: '/api/config', host: '127.0.0.1:' + PORT });
  check('无 Origin → 放行', noOrigin.status === 200, noOrigin.status + ' ' + noOrigin.body);

  const configAfter = fs.readFileSync(path.join(tmpData, 'config.json'), 'utf8');
  check('config.json 未被越权请求改动', configBefore === configAfter, '');
}

// ---------- S4 空 baseDir ----------
console.log('S4 空 baseDir');
{
  const empty = await post('/api/config', {});
  check('POST /api/config {} → 400', empty.status === 400, JSON.stringify(empty.body));
  const cfg = fs.readFileSync(path.join(tmpData, 'config.json'), 'utf8');
  check('config.json 无 "." 库', !cfg.includes('"."'), cfg);
}

// ---------- S5 非 UTF-8 文本只读 ----------
console.log('S5 非 UTF-8 文本只读');
{
  const gbk = await j('/api/file?path=' + encodeURIComponent('gbk.md'));
  check('GBK 解码正确', gbk.body.content === '中文论语', JSON.stringify(gbk.body.content));
  check('GBK readonly=true', gbk.body.readonly === true);
  check('GBK 有 readonlyReason(GBK)', /GBK/.test(gbk.body.readonlyReason || ''), gbk.body.readonlyReason);

  const utf16 = await j('/api/file?path=' + encodeURIComponent('utf16.md'));
  check('UTF-16 解码正确', utf16.body.content === '论语讲稿', JSON.stringify(utf16.body.content));
  check('UTF-16 readonly=true', utf16.body.readonly === true);
  check('UTF-16 有 readonlyReason(UTF-16)', /UTF-16/.test(utf16.body.readonlyReason || ''), utf16.body.readonlyReason);

  const normal = await j('/api/file?path=' + encodeURIComponent('normal.md'));
  check('UTF-8 无 readonlyReason', !normal.body.readonlyReason, JSON.stringify(normal.body.readonlyReason));

  const gbkBefore = fs.readFileSync(path.join(corpus, 'gbk.md'));
  const putGbk = await j('/api/file', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'gbk.md', content: '覆盖', dsId }) });
  check('PUT GBK → 409 non-utf8', putGbk.status === 409 && putGbk.body.error === 'non-utf8', JSON.stringify(putGbk.body));
  check('GBK 磁盘字节不变', Buffer.compare(gbkBefore, fs.readFileSync(path.join(corpus, 'gbk.md'))) === 0);

  const search = await j('/api/search?q=' + encodeURIComponent('中文'));
  check('检索命中 GBK 中文', search.body.results.some((x) => x.file.path === 'gbk.md'), JSON.stringify((search.body.results || []).map((x) => x.file.path)));
}

// ---------- S6 skill zip / 删除 ----------
console.log('S6 skill zip / 删除');
{
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip();
  zip.addFile('myskill/SKILL.md', Buffer.from('---\nname: 测试\n---\n# 测试\n'));
  zip.addFile('evil.txt', Buffer.from('evil'));
  zip.getEntries().find((e) => e.entryName === 'evil.txt').entryName = '../evil.txt';
  const badZip = await post('/api/agent/skill', { zipBase64: zip.toBuffer().toString('base64'), fileName: 'myskill.zip' });
  check('含 ../ 的 zip → 400', badZip.status === 400 && /越界/.test(badZip.body.error || ''), JSON.stringify(badZip.body));
  const skillsDir = path.join(tmpData, 'agents', 'default', 'skills');
  check('skills 内无 myskill 残留', !fs.existsSync(path.join(skillsDir, 'myskill')));
  const evilFiles = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.name === 'evil.txt') evilFiles.push(p);
      else if (e.isDirectory()) walk(p);
    }
  })(tmpData);
  check('无 evil.txt 残留', evilFiles.length === 0, evilFiles.join(','));

  const delTraverse = await fetch(BASE + '/api/agent/skill/..%2F..%2Fx', { method: 'DELETE' });
  check('DELETE ..%2F..%2Fx → 400', delTraverse.status === 400, String(delTraverse.status));
  check('skills 目录仍在', fs.existsSync(skillsDir));
}

// ---------- S7 符号链接越界 ----------
console.log('S7 符号链接越界');
{
  const saveAs = await post('/api/file/save-as', { path: 'link/new.md', content: '# 越界', dsId });
  check('另存 link/new.md → 403', saveAs.status === 403 && /符号链接/.test(saveAs.body.error || ''), JSON.stringify(saveAs.body));
  check('库外无 new.md', !fs.existsSync(path.join(outside, 'new.md')));
}

// ---------- S8 open-external 可执行拦截 ----------
console.log('S8 open-external');
{
  for (const ext of ['.exe', '.sh', '.app']) {
    const r = await post('/api/open-external', { path: '/tmp/evil' + ext });
    check('打开 ' + ext + ' → 403', r.status === 403 && /安全/.test(r.body.error || ''), JSON.stringify(r.body));
  }
  const txt = await post('/api/open-external', { path: '/tmp/no-such-file.txt' });
  check('非可执行扩展名不拦截（404 因不存在）', txt.status === 404, JSON.stringify(txt.body));
}

// ---------- S9 助手 ----------
console.log('S9 助手');
const put = (url, body) => j(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function chatToDone(convId, text) {
  const res = await fetch(BASE + '/api/agent/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: convId, text }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.includes('"done"')) break;
  }
  return buf;
}
const FAKE_BASE = `http://127.0.0.1:${fakePort}/v1`;
const bashMarker = path.join(tmpObj, 'bash-ran');
const secretFile = path.join(tmpObj, 'secret.txt');
fs.writeFileSync(secretFile, 'SECRET-CONTENT-12345');

await put('/api/agent/settings', { baseUrl: FAKE_BASE, model: 'test-model', apiKey: 'x' });

{
  // ① 库根 .pi/extensions 不加载
  fake.plan = [{ text: '你好' }];
  const conv = await post('/api/agent/session', { title: 't1' });
  await chatToDone(conv.body.id, '测试');
  check('① 库根 .pi 扩展未加载（无标记文件）', !fs.existsSync(extMarker), extMarker);
}

{
  // ② readonly 模式：tools 不含 bash，强行 bash 被拒
  await put('/api/agent/settings', { mode: 'readonly' });
  fake.tools = []; fake.requests = [];
  fake.plan = [
    { toolCall: { id: 'call_bash', name: 'bash', arguments: JSON.stringify({ command: `node -e "require('fs').writeFileSync(${JSON.stringify(bashMarker)}, 'ran')"` }) } },
    { text: '完成' },
  ];
  const conv = await post('/api/agent/session', { title: 't2' });
  await chatToDone(conv.body.id, '跑一下');
  check('② readonly 会话 tools 不含 bash', !fake.tools.includes('bash'), JSON.stringify(fake.tools));
  check('② bash 被拒、无副作用', !fs.existsSync(bashMarker), bashMarker);
}

{
  // ③ 重启后 mode 持久化
  const st = await j('/api/agent/status');
  check('③ 设置后 status.mode=readonly', st.body.mode === 'readonly', JSON.stringify(st.body.mode));
  await kill(server);
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  server = spawnBackend(tmpData, PORT);
  await waitReady(BASE);
  const st2 = await j('/api/agent/status');
  check('③ 重启后 mode 仍为 readonly', st2.body.mode === 'readonly', JSON.stringify(st2.body.mode));
}

{
  // 新数据目录默认 confirm（独立后端）
  const tmpData2 = path.join(tmpObj, 'data2');
  await kill(server);
  const port3 = await freePort();
  const base3 = `http://127.0.0.1:${port3}`;
  server = spawnBackend(tmpData2, port3);
  await waitReady(base3);
  const st = await fetch(base3 + '/api/agent/status').then((r) => r.json());
  check('③ 新数据目录默认 confirm', st.mode === 'confirm', JSON.stringify(st.mode));
  await kill(server);
}

{
  // ④ confirm 模式 read 库外文件被拒（回到带库的 tmpData）
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  server = spawnBackend(tmpData, PORT);
  await waitReady(BASE);
  await put('/api/agent/settings', { mode: 'confirm', baseUrl: FAKE_BASE, model: 'test-model', apiKey: 'x' });
  fake.tools = []; fake.requests = [];
  fake.plan = [
    { toolCall: { id: 'call_read', name: 'read', arguments: JSON.stringify({ path: secretFile }) } },
    { text: '读完了' },
  ];
  const conv = await post('/api/agent/session', { title: 't3' });
  await chatToDone(conv.body.id, '读那个文件');
  const hist = await j('/api/agent/session/' + conv.body.id);
  check('④ confirm 模式 read 库外被拒（历史无秘密）', !JSON.stringify(hist.body).includes('SECRET-CONTENT-12345'), '');
}

// ---------- S11 Word 资产路由标识校验（P3） ----------
console.log('S11 Word 资产路由');
{
  const cases = ['..', '.', '../x'];
  for (const key of cases) {
    const r = await j('/api/word/asset?key=' + encodeURIComponent(key) + '&name=img-1.png');
    check(`S11 key=${key} → 400`, r.status === 400, String(r.status));
  }
  const bad = await j('/api/word/asset?key=' + encodeURIComponent('0123456789abcdef0123456789abcdef01234567-1') + '&name=img-1.svg');
  check('S11 非白名单扩展名 → 400/404', bad.status === 400 || bad.status === 404, String(bad.status));
}

// ---------- 收尾 ----------
await kill(server);
fakeServer.close();

console.log('\n通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
