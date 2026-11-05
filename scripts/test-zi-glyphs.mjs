// 字形演变（specs/2026-11-04-ziyi.md「追加：查字时按需显示字形演变」验收）：起一个假 zi.tools 服务，
// 后端经 WORKBENCH_ZITOOLS_API 指向它。断言：没缓存时立即 202 pending、轮询到取到；二次走缓存不联网；
// 同字并发只请求一次；不同字真实请求串行且间隔 ≥ 550ms；最近问到的优先；撤销的字与过期没人再问的字都不请求；
// 未收录缓存为空列表；上游 500 / 无法识别的 200 → 502 且不缓存、重试成功；刷新失败保留旧缓存；
// 非单字 400；关闭开关 409、排队中的也不再发；重启后缓存仍在；非 PNG 行丢弃；书体名不受原型链键影响；
// 取字形失败的原因写进 backend.log；卡住 10s 还没结束的请求也记一条。
// 运行：node scripts/test-zi-glyphs.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = makeTmpDir('wb-zi-glyphs-');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const check = (name, ok, detail) => {
  assert.ok(ok, name + (detail === undefined ? '' : ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
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

// ---------- 假 zi.tools：/api/zi/<字> ----------
// 1×1 PNG（base64 以 iVBORw0KGgo 开头）；一行 GIF 用来验证非 PNG 被丢弃
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const row = (style, period, label, png = PNG) => ['k', 'id', '甲', '甲', png, style, period, label, '', 1];
const hits = []; // [字, 时间, UA]
let failNext = 0;
let garbleNext = 0;
const fake = http.createServer((req, res) => {
  const ch = decodeURIComponent(req.url).replace(/^\/api\/zi\//, '');
  hits.push([ch, Date.now(), req.headers['user-agent']]);
  if (failNext > 0) {
    failNext--;
    res.writeHead(500).end('boom');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (garbleNext > 0) {
    garbleNext--;
    return res.end(JSON.stringify({ error: 'rate limited' }));
  }
  if (ch === '无') return res.end(JSON.stringify({ font: {} })); // 未收录：没有 yi
  if (ch === '迟') return setTimeout(() => res.end(JSON.stringify({ yi: { tubrief: [] } })), 5000);
  if (ch === '慢') return setTimeout(() => res.end(JSON.stringify({ yi: { tubrief: [row('楷', '唐', '慢')] } })), 300);
  if (ch === '怪') return res.end(JSON.stringify({ yi: { tubrief: [row('__proto__', '唐', 'x'), row('constructor', '唐', 'y')] } }));
  res.end(JSON.stringify({ yi: { tubrief: [row('甲骨', '商', '𠂤組'), row('金', '西周', '大盂鼎'), row('篆', '秦', '說文', 'R0lGODlh')] } }));
});
const fakePort = await freePort();
await new Promise((r) => fake.listen(fakePort, '127.0.0.1', r));
atExit(() => fake.close());
const hitsOf = (ch) => hits.filter((h) => h[0] === ch).length;
const backendLog = () => { try { return fs.readFileSync(path.join(dataDir, 'logs', 'backend.log'), 'utf8'); } catch { return ''; } };

// ---------- 后端 ----------
let server = null;
let base = '';
async function startServer() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1', WORKBENCH_DATA_DIR: dataDir,
      WORKBENCH_RAG_EMBED: 'mock', WORKBENCH_ZITOOLS_API: `http://127.0.0.1:${fakePort}/api` },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  for (let i = 0; ; i++) {
    try {
      await fetch(base + '/api/ziyi/status');
      return;
    } catch { /* 还没起来 */ }
    if (i > 300) throw new Error('后端启动超时');
    await sleep(50);
  }
}
async function stopServer() {
  const s = server;
  server = null;
  if (!s) return;
  const gone = new Promise((r) => s.once('exit', r));
  s.kill('SIGKILL');
  await gone;
}
atExit(() => server?.kill('SIGKILL'));
const get = async (url, init) => {
  const r = await fetch(base + url, init);
  let json = null;
  try { json = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json };
};
const ask = (ch, refresh = false) => get('/api/ziyi/glyphs?han=' + encodeURIComponent(ch) + (refresh ? '&refresh=1' : ''));
/** 像前端那样：第一问可带 refresh，之后每 200ms 再问，直到不是 202 */
async function poll(ch, refresh = false, ms = 10000) {
  const t0 = Date.now();
  let first = true;
  let pendings = 0;
  for (;;) {
    const r = await ask(ch, first && refresh);
    first = false;
    if (r.status !== 202) return { ...r, pendings };
    pendings++;
    if (Date.now() - t0 > ms) throw new Error('轮询超时 ' + ch);
    await sleep(200);
  }
}
const putSettings = (body) => get('/api/ui-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

await startServer();

check('缺省开启（ui-settings.ziyiGlyphs）', (await get('/api/ui-settings')).json.ziyiGlyphs === true);

{
  const first = await ask('甲');
  check('没缓存时立即 202 pending（不占住连接）', first.status === 202 && first.json.status === 'pending', first);
  const r = await poll('甲');
  check('轮询到取到', r.status === 200 && r.json.status === 'ok' && r.json.char === '甲', r);
  check('非 PNG 行被丢弃', r.json.items.length === 2, r.json.items.map((x) => x.style));
  check('转成 data URI 并带书体名称', r.json.items[0].src === 'data:image/png;base64,' + PNG && r.json.items[0].styleName === '甲骨文' && r.json.items[1].styleName === '金文', r.json.items[0]);
  check('带时代、出处与 zi.tools 链接', r.json.items[1].period === '西周' && r.json.items[1].label === '大盂鼎' && r.json.url === 'https://zi.tools/zi/' + encodeURIComponent('甲'), r.json);
  check('请求带个人用途的 User-Agent', /personal use; on-demand/.test(hits.at(-1)[2]), hits.at(-1)[2]);
  const n = hitsOf('甲');
  const again = await ask('甲');
  check('二次直接 200、走缓存不联网', again.status === 200 && hitsOf('甲') === n && again.json.items.length === 2);
  const cacheFile = path.join(dataDir, 'ziglyphs', '7532.json');
  check('缓存文件按码点命名、只存字形', fs.existsSync(cacheFile) && JSON.parse(fs.readFileSync(cacheFile, 'utf8')).items.length === 2);
}

{
  const before = hitsOf('慢');
  const rs = await Promise.all([poll('慢'), poll('慢'), poll('慢')]);
  check('同字并发只请求一次', rs.every((r) => r.status === 200) && hitsOf('慢') - before === 1, hitsOf('慢') - before);
}

{
  const t0 = hits.length;
  await Promise.all([poll('乙'), poll('丙'), poll('丁')]);
  const ts = hits.slice(t0).map((h) => h[1]);
  const gaps = ts.slice(1).map((t, i) => t - ts[i]);
  check('不同字的真实请求串行且间隔 ≥ 550ms', ts.length === 3 && gaps.every((g) => g >= 550), gaps);
}

{
  // 刚发过一次请求（队列须等 600ms），这时连问三个字，前两个随即撤销（前端卸载 / 换字），只继续轮询最后一个
  await poll('戊', false);
  await ask('子');
  await ask('丑');
  await get('/api/ziyi/glyphs?han=' + encodeURIComponent('子'), { method: 'DELETE' });
  await get('/api/ziyi/glyphs?han=' + encodeURIComponent('丑'), { method: 'DELETE' });
  const r = await poll('寅');
  check('最近问到的字优先', r.status === 200 && hits.at(-1)[0] === '寅', hits.slice(-3).map((h) => h[0]));
  await sleep(1500);
  check('撤销的字不请求 zi.tools', hitsOf('子') === 0 && hitsOf('丑') === 0, { 子: hitsOf('子'), 丑: hitsOf('丑') });
}

{
  // 上游很慢（5 秒）时问一次「亥」就不再问：等慢请求结束，「亥」已超过 4 秒没人问，被丢掉
  const slow = poll('迟', false, 15000);
  await sleep(300);
  await ask('亥');
  await slow;
  await sleep(1500);
  check('过期没人再问的字不请求 zi.tools', hitsOf('亥') === 0, hitsOf('亥'));
}

{
  const r = await poll('无');
  check('未收录返回空列表', r.status === 200 && r.json.items.length === 0, r.json);
  const n = hitsOf('无');
  await ask('无');
  check('未收录也缓存', hitsOf('无') === n);
}

{
  failNext = 1;
  const r = await poll('辰');
  check('上游 500 → 502', r.status === 502 && /zi\.tools/.test(r.json.error), r);
  check('失败不写缓存', !fs.existsSync(path.join(dataDir, 'ziglyphs', '8fb0.json')));
  check('失败原因写进 backend.log', backendLog().includes('[ziyi] 取「辰」的字形失败：zi.tools 返回 500'), backendLog().slice(-500));
  const n = hitsOf('辰');
  const quick = await ask('辰');
  check('刚失败过的字短时间内直接报失败、不反复请求', quick.status === 502 && hitsOf('辰') === n);
  const again = await poll('辰', true);
  check('重试（refresh）成功', again.status === 200 && hitsOf('辰') === n + 1, again.status);
}

{
  garbleNext = 1;
  const r = await poll('巳');
  check('200 但内容无法识别 → 502 且不缓存', r.status === 502 && /无法识别/.test(r.json.error) && !fs.existsSync(path.join(dataDir, 'ziglyphs', '5df3.json')), r);
}

{
  const n = hitsOf('甲');
  const r = await poll('甲', true);
  check('refresh 重新联网', r.status === 200 && hitsOf('甲') === n + 1 && r.pendings >= 1);
  failNext = 1;
  const bad = await poll('甲', true);
  check('刷新失败：502 并附上旧缓存的字形', bad.status === 502 && bad.json.items?.length === 2, bad.json);
  check('刷新失败不删旧缓存', fs.existsSync(path.join(dataDir, 'ziglyphs', '7532.json')));
}

{
  const r = await poll('怪');
  check('书体名不受原型链键影响', r.status === 200 && r.json.items.map((x) => x.styleName).join(',') === '__proto__,constructor', r.json.items.map((x) => x.styleName));
}

for (const bad of ['', '甲乙', 'a', '，', '々']) {
  check(`非单个汉字「${bad}」400`, (await ask(bad)).status === 400);
}

{
  // 排队中途关掉开关：已登记的字也不再请求
  await poll('午');
  await ask('未'); // 须等 600ms 才会发
  const off = await putSettings({ ziyiGlyphs: false });
  check('关闭开关', off.status === 200 && off.json.ziyiGlyphs === false, off);
  await sleep(1200);
  check('关闭前已排队的字不再请求', hitsOf('未') === 0);
  check('非布尔值 400', (await putSettings({ ziyiGlyphs: 'no' })).status === 400);
  const n = hits.length;
  const r = await ask('申');
  check('关闭后 409 glyphs-disabled 且不联网', r.status === 409 && r.json.code === 'glyphs-disabled' && hits.length === n, r);
  await putSettings({ ziyiGlyphs: true });
}

await stopServer();
await startServer();
{
  const n = hitsOf('甲');
  const r = await ask('甲');
  check('重启后缓存仍在、不联网', r.status === 200 && hitsOf('甲') === n && r.json.items.length === 2);
}

// 卡住的请求：只发一半请求体，请求一直不结束、也就永远不会 finish
{
  const u = new URL(base);
  const sock = net.connect(Number(u.port), u.hostname);
  await new Promise((r) => sock.once('connect', r));
  sock.write('POST /api/ziyi/import HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/octet-stream\r\nContent-Length: 100\r\n\r\nabc');
  await sleep(9000);
  check('卡住不满 10s 不记', !backendLog().includes('/api/ziyi/import 已 10s 仍未结束'));
  await sleep(2000);
  check('卡住 10s 还没结束记一条', backendLog().includes('[http] POST /api/ziyi/import 已 10s 仍未结束'), backendLog().slice(-500));
  sock.destroy();
}

await stopServer();
console.log(`\n全部通过：${passed} 项`);
process.exit(0);
