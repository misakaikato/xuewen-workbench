// 字形演变（specs/2026-11-04-ziyi.md「追加：查字时按需显示字形演变」验收）：起一个假 zi.tools 服务，
// 后端经 WORKBENCH_ZITOOLS_API 指向它。断言：首次取并转 data URI；二次走缓存不联网；同字并发只请求一次；
// 不同字相邻请求间隔 ≥ 550ms；未收录缓存为空列表；上游 500 → 502 且不缓存、下次重试；refresh 重取；
// 非单字 400；关闭开关 409 且不联网；重启后缓存仍在；非 PNG 行被丢弃。
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
// 1×1 PNG（base64 以 iVBORw0KGgo 开头）；一行假 GIF 用来验证非 PNG 被丢弃
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const row = (style, period, label, png = PNG) => ['k', 'id', '甲', '甲', png, style, period, label, '', 1];
const hits = []; // [字, 时间]
let failNext = 0;
const fake = http.createServer((req, res) => {
  const m = decodeURIComponent(req.url).match(/^\/api\/zi\/(.+)$/);
  const ch = m?.[1];
  hits.push([ch, Date.now(), req.headers['user-agent']]);
  if (failNext > 0) {
    failNext--;
    res.writeHead(500).end('boom');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (ch === '无') return res.end(JSON.stringify({ font: {} })); // 未收录：没有 yi
  if (ch === '慢') return setTimeout(() => res.end(JSON.stringify({ yi: { tubrief: [row('楷', '唐', '慢')] } })), 300);
  res.end(JSON.stringify({ yi: { tubrief: [row('甲骨', '商', '𠂤組'), row('金', '西周', '大盂鼎'), row('篆', '秦', '說文', 'R0lGODlh')] } }));
});
const fakePort = await freePort();
await new Promise((r) => fake.listen(fakePort, '127.0.0.1', r));
atExit(() => fake.close());
const hitsOf = (ch) => hits.filter((h) => h[0] === ch).length;

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
const glyphs = (ch, q = '') => get('/api/ziyi/glyphs?han=' + encodeURIComponent(ch) + q);

await startServer();

check('缺省开启（ui-settings.ziyiGlyphs）', (await get('/api/ui-settings')).json.ziyiGlyphs === true);

{
  const r = await glyphs('甲');
  check('首次取字形成功', r.status === 200 && r.json.char === '甲', r);
  check('非 PNG 行被丢弃', r.json.items.length === 2, r.json.items.map((x) => x.style));
  check('转成 data URI 并带书体名称', r.json.items[0].src === 'data:image/png;base64,' + PNG && r.json.items[0].styleName === '甲骨文' && r.json.items[1].styleName === '金文', r.json.items[0]);
  check('带时代、出处与 zi.tools 链接', r.json.items[1].period === '西周' && r.json.items[1].label === '大盂鼎' && r.json.url === 'https://zi.tools/zi/' + encodeURIComponent('甲'), r.json);
  check('请求带个人用途的 User-Agent', /personal use; on-demand/.test(hits.at(-1)[2]), hits.at(-1)[2]);
  const n = hitsOf('甲');
  const again = await glyphs('甲');
  check('二次走缓存不联网', again.status === 200 && hitsOf('甲') === n && again.json.items.length === 2);
  const cacheFile = path.join(dataDir, 'ziglyphs', '7532.json');
  check('缓存文件按码点命名、只存字形', fs.existsSync(cacheFile) && JSON.parse(fs.readFileSync(cacheFile, 'utf8')).items.length === 2);
}

{
  const before = hitsOf('慢');
  const rs = await Promise.all([glyphs('慢'), glyphs('慢'), glyphs('慢')]);
  check('同字并发只请求一次', rs.every((r) => r.status === 200) && hitsOf('慢') - before === 1, hitsOf('慢') - before);
}

{
  const t0 = hits.length;
  await Promise.all([glyphs('乙'), glyphs('丙'), glyphs('丁')]);
  const ts = hits.slice(t0).map((h) => h[1]);
  const gaps = ts.slice(1).map((t, i) => t - ts[i]);
  check('不同字的真实请求串行且间隔 ≥ 550ms', ts.length === 3 && gaps.every((g) => g >= 550), gaps);
}

{
  const r = await glyphs('无');
  check('未收录返回空列表', r.status === 200 && r.json.items.length === 0, r.json);
  const n = hitsOf('无');
  await glyphs('无');
  check('未收录也缓存', hitsOf('无') === n);
}

{
  failNext = 1;
  const r = await glyphs('戊');
  check('上游 500 → 502', r.status === 502 && /zi\.tools/.test(r.json.error), r);
  check('失败不写缓存', !fs.existsSync(path.join(dataDir, 'ziglyphs', '620a.json')));
  const again = await glyphs('戊');
  check('下次请求重试成功', again.status === 200 && hitsOf('戊') === 2, again.status);
}

{
  const n = hitsOf('甲');
  const r = await glyphs('甲', '&refresh=1');
  check('refresh=1 重新联网', r.status === 200 && hitsOf('甲') === n + 1);
}

for (const bad of ['', '甲乙', 'a', '，', '々']) {
  check(`非单个汉字「${bad}」400`, (await glyphs(bad)).status === 400);
}

{
  const off = await get('/api/ui-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ziyiGlyphs: false }) });
  check('关闭开关', off.status === 200 && off.json.ziyiGlyphs === false, off);
  check('非布尔值 400', (await get('/api/ui-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ziyiGlyphs: 'no' }) })).status === 400);
  const n = hits.length;
  const r = await glyphs('己');
  check('关闭后 409 glyphs-disabled 且不联网', r.status === 409 && r.json.code === 'glyphs-disabled' && hits.length === n, r);
  await get('/api/ui-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ziyiGlyphs: true }) });
}

await stopServer();
await startServer();
{
  const n = hitsOf('甲');
  const r = await glyphs('甲');
  check('重启后缓存仍在、不联网', r.status === 200 && hitsOf('甲') === n && r.json.items.length === 2);
}

await stopServer();
console.log(`\n全部通过：${passed} 项`);
process.exit(0);
