// mac 安装包下载（electron/updater.js + electron/dmgDownload.js）：续传、重试、校验、取消、
// 退出保留 .part 与跨次续传、下载记录与清理。仅 darwin（download() 走 mac 分支）。
// 打桩 electron（net.fetch 指向全局 fetch，下载目录指向临时目录）与 electron-updater，
// 本地 HTTP 服务模拟 generic 发布源（latest-mac.yml 带正确的 sha512）。全程只在临时目录进行。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire, register } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeTmpDir } from './tmpdirs.mjs';

if (process.platform !== 'darwin') {
  console.log(`SKIP: 仅在 darwin 运行（当前 ${process.platform}）`);
  process.exit(0);
}

let checks = 0;
function test(name, fn) { return Promise.resolve(fn()).then(() => { checks++; console.log('PASS', name); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = makeTmpDir('wb-dmgdl-');
const VERSION = '9.9.9';
const DMG_NAME = `Fake App-${VERSION}-${process.arch}.dmg`;
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n` +
  `<key>CFBundleIdentifier</key><string>local.mayu.testapp</string>\n` +
  `<key>CFBundleShortVersionString</key><string>0.1.7</string>\n</dict></plist>\n`;
const payload = crypto.randomBytes(3 * 1024 * 1024);
const sha512 = (b) => crypto.createHash('sha512').update(b).digest('base64');
const HALF = payload.length >> 1;

// ---------- 日志捕获（主进程日志就是 console） ----------
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(' ')); origWarn(...a); };

// ---------- 本地发布源 ----------
let manifestSha = sha512(payload);
let dmgHandler = null; // (req, res, n, rec)：n 为本用例第几次 DMG 请求
let dmgReqs = []; // { range, status }
const openRes = new Set();
const server = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  openRes.add(res);
  res.on('close', () => openRes.delete(res));
  if (req.url === '/latest-mac.yml') {
    res.end(`version: ${VERSION}\nfiles:\n  - url: ${DMG_NAME}\n    sha512: ${manifestSha}\n    size: ${payload.length}\n` +
      `path: ${DMG_NAME}\nsha512: ${manifestSha}\nreleaseDate: '2026-11-03T00:00:00.000Z'\n`);
    return;
  }
  const rec = { range: req.headers.range || null, status: null };
  dmgReqs.push(rec);
  dmgHandler(req, res, dmgReqs.length, rec);
});

function sendFull(res, rec, body = payload) {
  rec.status = 200;
  res.writeHead(200, { 'Content-Length': body.length });
  res.end(body);
}

function sendRange(req, res, rec, body = payload) {
  const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
  if (!m) return sendFull(res, rec, body);
  const start = Number(m[1]);
  if (start >= body.length) {
    rec.status = 416;
    res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
    res.end();
    return;
  }
  rec.status = 206;
  res.writeHead(206, { 'Content-Length': body.length - start, 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` });
  res.end(body.subarray(start));
}

// 发一半后断开连接（等客户端收下这一半再断）
function sendHalfThenDrop(res, rec) {
  rec.status = 200;
  res.writeHead(200, { 'Content-Length': payload.length });
  res.write(payload.subarray(0, HALF), () => setTimeout(() => res.socket?.destroy(), 150));
}

// 发一半后不再发送，也不断开
function sendHalfThenStall(res, rec) {
  rec.status = 200;
  res.writeHead(200, { 'Content-Length': payload.length });
  res.write(payload.subarray(0, HALF));
}

function send500(res, rec) {
  rec.status = 500;
  res.writeHead(500, { 'Content-Length': 4 });
  res.end('oops');
}

// ---------- 打桩 electron / electron-updater ----------
globalThis.__wbDmgDir = tmp;
fs.writeFileSync(path.join(tmp, 'hooks.mjs'),
  `export async function resolve(specifier, context, next) {\n` +
  `  if (specifier === 'electron') return { url: new URL('./stub-electron.mjs', import.meta.url).href, shortCircuit: true };\n` +
  `  return next(specifier, context);\n` +
  `}\n`);
fs.writeFileSync(path.join(tmp, 'stub-electron.mjs'),
  `import path from 'node:path';\n` +
  `const dir = () => globalThis.__wbDmgDir;\n` +
  `Object.defineProperty(process, 'resourcesPath', { get: () => path.join(dir(), 'resources'), configurable: true });\n` +
  `Object.defineProperty(process, 'execPath', { get: () => path.join(dir(), 'Fake App.app', 'Contents', 'MacOS', 'Fake App'), configurable: true });\n` +
  `export const app = {\n` +
  `  getVersion: () => globalThis.__wbAppVersion || '0.1.7',\n` +
  `  getPath: (name) => path.join(dir(), name === 'downloads' ? 'downloads' : 'userData'),\n` +
  `  quit: () => {},\n` +
  `};\n` +
  `export const shell = { openPath: async () => '', openExternal: async () => {} };\n` +
  `export const net = { fetch: (...args) => globalThis.fetch(...args) };\n`);
register(pathToFileURL(path.join(tmp, 'hooks.mjs')));

const fakeUpdater = new EventEmitter();
let base = '';
// 与 electron-updater 一样从发布源读 latest-mac.yml，交出 version 与 files（url / sha512 / size）
fakeUpdater.checkForUpdates = async () => {
  const text = await (await fetch(`${base}/latest-mac.yml`)).text();
  const version = /^version:\s*(.+)$/m.exec(text)[1].trim();
  const files = [...text.matchAll(/^\s+- url:\s*(.+)\n\s+sha512:\s*(.+)\n\s+size:\s*(\d+)$/gm)]
    .map((m) => ({ url: m[1].trim(), sha512: m[2].trim(), size: Number(m[3]) }));
  setImmediate(() => fakeUpdater.emit('update-available', { version, files }));
};
fakeUpdater.downloadUpdate = () => Promise.resolve();
fakeUpdater.quitAndInstall = () => {};
const req = createRequire(import.meta.url);
const updaterPath = req.resolve('electron-updater');
req.cache[updaterPath] = {
  id: updaterPath, filename: updaterPath, loaded: true,
  exports: { autoUpdater: fakeUpdater, CancellationToken: class { cancel() {} } },
};

const { createUpdaterBridge } = await import('../electron/updater.js');
const { setDmgDownloadTiming } = await import('../electron/dmgDownload.js');

// 每个用例独立目录：伪 .app（预检返回 auto）、发布配置、下载目录、userData
function newEnv(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'Fake App.app', 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Fake App.app', 'Contents', 'Info.plist'), PLIST);
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'resources', 'app-update.yml'), `provider: generic\nurl: ${base}\n`);
  fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true });
  const updates = path.join(dir, 'userData', 'updates');
  fs.mkdirSync(updates, { recursive: true });
  globalThis.__wbDmgDir = dir;
  dmgReqs = [];
  warns.length = 0;
  return { dir, downloads: path.join(dir, 'downloads'), updates, dmg: path.join(dir, 'downloads', DMG_NAME) };
}

function makeBridge() {
  fakeUpdater.removeAllListeners();
  return createUpdaterBridge({ getUiSettings: () => ({ autoUpdate: false }), logsDir: path.join(globalThis.__wbDmgDir, 'logs') });
}

async function startDownload(bridge) {
  await bridge.check();
  assert.equal(bridge.state().status, 'available', '检查应进入 available：' + JSON.stringify(bridge.state()));
  await bridge.download();
}

async function waitFor(pred, ms = 15000, what = '条件') {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + what);
    await sleep(20);
  }
}

const waitSettled = (bridge) => waitFor(() => (bridge.state().status !== 'downloading' ? bridge.state() : null), 20000, '下载结束');
const size = (p) => { try { return fs.statSync(p).size; } catch { return -1; } };
const readRecords = (env) => JSON.parse(fs.readFileSync(path.join(env.updates, 'downloads.json'), 'utf8'));
const retryWarns = () => warns.filter((w) => w.includes('次尝试失败'));
const FAST = { backoffMs: [20, 20, 20, 20], idleTimeoutMs: 60_000 };

try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // ---------- 用例 1–5（specs/2026-11-03-mac-dmg-download.md G2） ----------
  await test('D1 断点续传：第 1 次传到一半断开，第 2 次带 Range 得 206，文件逐字节一致，1 行重试 WARN 带错误码', async () => {
    const env = newEnv('d1');
    setDmgDownloadTiming(FAST);
    dmgHandler = (rq, res, n, rec) => (n === 1 ? sendHalfThenDrop(res, rec) : sendRange(rq, res, rec));
    const bridge = await makeBridge();
    await startDownload(bridge);
    const s = await waitSettled(bridge);
    assert.equal(s.status, 'ready', JSON.stringify(s));
    assert.ok(fs.readFileSync(env.dmg).equals(payload), '文件应逐字节一致');
    assert.equal(dmgReqs.length, 2, '共 2 次请求');
    assert.equal(dmgReqs[0].range, null, '第 1 次不带 Range');
    const m = /^bytes=(\d+)-$/.exec(dmgReqs[1].range || '');
    assert.ok(m && Number(m[1]) > 0, '第 2 次应带 Range 续传：' + dmgReqs[1].range);
    assert.equal(dmgReqs[1].status, 206, '服务器返回 206');
    assert.equal(retryWarns().length, 1, '应有 1 行重试 WARN：\n' + warns.join('\n'));
    assert.match(retryWarns()[0], /错误码 (?!unknown)\S+/, 'WARN 应带错误码：' + retryWarns()[0]);
    assert.match(retryWarns()[0], /主机 127\.0\.0\.1:\d+/, 'WARN 应带主机名');
    assert.ok(!fs.existsSync(env.dmg + '.part'), '.part 应已改名为正式文件');
  });

  await test('D2 不支持续传：续传请求得到 200 全量，清空重写后文件正确', async () => {
    const env = newEnv('d2');
    setDmgDownloadTiming(FAST);
    dmgHandler = (rq, res, n, rec) => (n === 1 ? sendHalfThenDrop(res, rec) : sendFull(res, rec));
    const bridge = await makeBridge();
    await startDownload(bridge);
    const s = await waitSettled(bridge);
    assert.equal(s.status, 'ready', JSON.stringify(s));
    assert.ok(fs.readFileSync(env.dmg).equals(payload), '文件应逐字节一致');
    assert.ok(dmgReqs[1].range, '第 2 次带了 Range');
    assert.equal(dmgReqs[1].status, 200, '服务器忽略 Range 返回 200');
  });

  await test('D3 校验失败一次：首次内容被篡改（等长），自动从头重下后成功', async () => {
    const env = newEnv('d3a');
    setDmgDownloadTiming(FAST);
    const bad = Buffer.from(payload);
    bad[12345] ^= 0xff;
    dmgHandler = (rq, res, n, rec) => sendFull(res, rec, n === 1 ? bad : payload);
    const bridge = await makeBridge();
    await startDownload(bridge);
    const s = await waitSettled(bridge);
    assert.equal(s.status, 'ready', JSON.stringify(s));
    assert.ok(fs.readFileSync(env.dmg).equals(payload), '文件应为正确内容');
    assert.equal(dmgReqs.length, 2, '共 2 次请求');
    assert.equal(dmgReqs[1].range, null, '重下从头开始（不带 Range）');
    assert.ok(warns.some((w) => w.includes('sha512 与发布清单不符')), '应记录校验不符的 WARN');
  });

  await test('D3 校验两次都失败：报「安装包校验失败」，.part 已删除', async () => {
    const env = newEnv('d3b');
    setDmgDownloadTiming(FAST);
    const bad = Buffer.from(payload);
    bad[999] ^= 0xff;
    dmgHandler = (rq, res, n, rec) => sendFull(res, rec, bad);
    const bridge = await makeBridge();
    await startDownload(bridge);
    const s = await waitSettled(bridge);
    assert.equal(s.status, 'error', JSON.stringify(s));
    assert.ok(s.error.includes('安装包校验失败'), s.error);
    assert.equal(dmgReqs.length, 2, '只重下一次');
    assert.ok(!fs.existsSync(env.dmg + '.part'), '.part 应已删除');
    assert.ok(!fs.existsSync(env.dmg), '不应留下正式文件');
    assert.ok(!readRecords(env).some((r) => r.path.endsWith('.part')), '记录里不应再有 .part');
  });

  await test('D4 始终 500：共尝试 5 次，error 带错误码与次数，.part 已删除', async () => {
    const env = newEnv('d4');
    setDmgDownloadTiming(FAST);
    dmgHandler = (rq, res, n, rec) => send500(res, rec);
    const bridge = await makeBridge();
    await startDownload(bridge);
    const s = await waitSettled(bridge);
    assert.equal(s.status, 'error', JSON.stringify(s));
    assert.equal(dmgReqs.length, 5, '共尝试 5 次');
    assert.ok(s.error.includes('HTTP 500'), '应带错误码：' + s.error);
    assert.ok(s.error.includes('5 次'), '应带次数：' + s.error);
    assert.equal(retryWarns().length, 5, '每次失败一行 WARN');
    assert.ok(!fs.existsSync(env.dmg + '.part'), '.part 应已删除');
  });

  await test('D5 重试等待期间取消：立即回到 available，.part 删除，之后不再发请求', async () => {
    const env = newEnv('d5');
    setDmgDownloadTiming({ backoffMs: [3000, 3000, 3000, 3000], idleTimeoutMs: 60_000 });
    dmgHandler = (rq, res, n, rec) => (n === 1 ? sendHalfThenDrop(res, rec) : send500(res, rec));
    const bridge = await makeBridge();
    await startDownload(bridge);
    await waitFor(() => retryWarns().length === 1, 10000, '第 1 次失败');
    assert.ok(size(env.dmg + '.part') > 0, '取消前 .part 应有内容');
    const t0 = Date.now();
    await bridge.cancel();
    const s = await waitSettled(bridge);
    assert.ok(Date.now() - t0 < 1000, '应立即结束等待');
    assert.equal(s.status, 'available', JSON.stringify(s));
    assert.equal(s.error, null, '取消不记错误');
    assert.ok(!fs.existsSync(env.dmg + '.part'), '.part 应已删除');
    assert.ok(!readRecords(env).some((r) => r.path.endsWith('.part')), '记录里不应再有 .part');
    await sleep(3500);
    assert.equal(dmgReqs.length, 1, '取消后不应再发请求');
  });

  // ---------- 用例 6–7（specs/2026-11-03-interrupted-1-update.md G2） ----------
  await test('D6 跨次续传：退出时保留 .part，新建 updater 实例后第一个请求就带 Range，最终文件正确', async () => {
    const env = newEnv('d6');
    setDmgDownloadTiming(FAST);
    dmgHandler = (rq, res, n, rec) => (n === 1 ? sendHalfThenStall(res, rec) : sendRange(rq, res, rec));
    const b1 = await makeBridge();
    await startDownload(b1);
    const part = env.dmg + '.part';
    await waitFor(() => size(part) === HALF, 10000, '.part 写满前一半');
    b1.onBeforeQuit(); // main.js 的 before-quit
    await waitSettled(b1);
    assert.equal(size(part), HALF, '退出后 .part 应保留');
    assert.ok(readRecords(env).some((r) => r.path === part && r.version === VERSION), '.part 应在下载记录里');
    for (const r of openRes) r.destroy();

    const before = dmgReqs.length;
    const b2 = await makeBridge();
    await startDownload(b2);
    const s = await waitSettled(b2);
    assert.equal(s.status, 'ready', JSON.stringify(s));
    assert.equal(dmgReqs.length, before + 1, '新实例只发 1 次请求');
    assert.equal(dmgReqs[before].range, `bytes=${HALF}-`, '新实例第一个请求就带 Range');
    assert.equal(dmgReqs[before].status, 206);
    assert.ok(fs.readFileSync(env.dmg).equals(payload), '最终文件正确');
  });

  await test('D7 开始新版本下载时删除记录里旧版本的 .part，不在记录里的文件不动', async () => {
    const env = newEnv('d7a');
    setDmgDownloadTiming(FAST);
    const oldPart = path.join(env.downloads, `Fake App-9.9.8-${process.arch}.dmg.part`);
    const userPart = path.join(env.downloads, 'Other-9.9.8.dmg.part');
    fs.writeFileSync(oldPart, 'old');
    fs.writeFileSync(userPart, 'user');
    fs.writeFileSync(path.join(env.updates, 'downloads.json'), JSON.stringify([{ path: oldPart, version: '9.9.8', at: '2026-11-01T00:00:00Z' }]));
    dmgHandler = (rq, res, n, rec) => sendFull(res, rec);
    const bridge = await makeBridge();
    await startDownload(bridge);
    assert.equal((await waitSettled(bridge)).status, 'ready');
    assert.ok(!fs.existsSync(oldPart), '记录里旧版本的 .part 应已删除');
    assert.equal(fs.readFileSync(userPart, 'utf8'), 'user', '不在记录里的文件不动');
    const recs = readRecords(env);
    assert.ok(!recs.some((r) => r.path === oldPart), '旧 .part 的记录应去掉');
    assert.ok(recs.some((r) => r.path === env.dmg && r.version === VERSION), '新 DMG 应登记');
  });

  await test('D7 下载目录已有不在记录里的同名文件：不覆盖，换名为 -1 下载', async () => {
    const env = newEnv('d7b');
    setDmgDownloadTiming(FAST);
    fs.writeFileSync(env.dmg, 'mine');
    dmgHandler = (rq, res, n, rec) => sendFull(res, rec);
    const bridge = await makeBridge();
    await startDownload(bridge);
    assert.equal((await waitSettled(bridge)).status, 'ready');
    assert.equal(fs.readFileSync(env.dmg, 'utf8'), 'mine', '用户文件不应被覆盖');
    const alt = path.join(env.downloads, `Fake App-${VERSION}-${process.arch}-1.dmg`);
    assert.ok(fs.readFileSync(alt).equals(payload), '应下载到 -1 文件名');
    // ready 之后才写待完成记录（updater 的既有顺序）：等文件出现
    const pendingPath = path.join(env.updates, 'pending.json');
    await waitFor(() => fs.existsSync(pendingPath), 5000, '待完成记录');
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
    assert.equal(pending.dmgPath, alt, '待完成记录指向换名后的文件');
    const recs = readRecords(env);
    assert.ok(recs.some((r) => r.path === alt), '换名后的文件应登记');
    assert.ok(!recs.some((r) => r.path === env.dmg), '用户文件不应登记');
  });

  await test('D7 上次已更新成功后启动：删除记录里版本 ≤ 当前的 DMG 与 .part、补删替换备份，其余不动', async () => {
    const env = newEnv('d7c');
    globalThis.__wbAppVersion = VERSION;
    try {
      const at = '2026-11-01T00:00:00Z';
      const olderPart = path.join(env.downloads, `Fake App-9.9.8-${process.arch}.dmg.part`);
      const newer = path.join(env.downloads, `Fake App-10.0.0-${process.arch}.dmg`);
      const userDmg = path.join(env.downloads, `Fake App-9.9.7-${process.arch}.dmg`);
      for (const p of [env.dmg, olderPart, newer, userDmg]) fs.writeFileSync(p, 'x');
      fs.writeFileSync(path.join(env.updates, 'downloads.json'), JSON.stringify([
        { path: env.dmg, version: VERSION, at },
        { path: olderPart, version: '9.9.8', at },
        { path: newer, version: '10.0.0', at },
      ]));
      const backup = path.join(env.dir, `.Fake App.app.old-${Date.now()}`);
      fs.mkdirSync(path.join(backup, 'Contents'), { recursive: true });
      fs.writeFileSync(path.join(env.updates, 'pending.json'), JSON.stringify({ fromVersion: '9.9.8', toVersion: VERSION, dmgPath: env.dmg, backupPath: backup, at }));
      const bridge = await makeBridge();
      assert.equal(bridge.state().lastInstall?.result, 'updated', '应判定为刚更新成功');
      await waitFor(() => !fs.existsSync(env.dmg) && !fs.existsSync(backup), 10000, '启动清理');
      await waitFor(() => readRecords(env).length === 1, 5000, '记录同步更新');
      assert.ok(!fs.existsSync(olderPart), '旧版本 .part 应删除');
      assert.ok(fs.existsSync(newer), '比当前新的版本不删');
      assert.ok(fs.existsSync(userDmg), '不在记录里的文件不动');
      assert.deepEqual(readRecords(env).map((r) => r.path), [newer], '记录只剩更新的版本');
    } finally {
      delete globalThis.__wbAppVersion;
    }
  });

  await test('D7 上次更新失败后启动：DMG 保留供手动安装', async () => {
    const env = newEnv('d7d');
    const at = '2026-11-01T00:00:00Z';
    fs.writeFileSync(env.dmg, 'x');
    fs.writeFileSync(path.join(env.updates, 'downloads.json'), JSON.stringify([{ path: env.dmg, version: VERSION, at }]));
    fs.writeFileSync(path.join(env.updates, 'pending.json'), JSON.stringify({ fromVersion: '0.1.7', toVersion: VERSION, dmgPath: env.dmg, at }));
    fs.writeFileSync(path.join(env.updates, 'install-result.json'), JSON.stringify({ ok: false, reason: 'move-new-failed', detail: '', at }));
    const staging = path.join(env.updates, 'staging');
    fs.mkdirSync(path.join(staging, 'Half.app'), { recursive: true });
    const bridge = await makeBridge();
    assert.equal(bridge.state().lastInstall?.result, 'failed', '应判定为上次失败');
    assert.equal(bridge.state().lastInstall?.dmgPath, env.dmg);
    await waitFor(() => !fs.existsSync(staging), 10000, '启动清理删除 staging');
    await sleep(300);
    assert.ok(fs.existsSync(env.dmg), 'DMG 应保留');
    assert.ok(readRecords(env).some((r) => r.path === env.dmg), '记录应保留');
  });

  // ---------- 边界情况补充 ----------
  await test('D8 空闲超时：数据停发后中止本次尝试并续传完成', async () => {
    const env = newEnv('d8');
    setDmgDownloadTiming({ backoffMs: [20, 20, 20, 20], idleTimeoutMs: 400 });
    dmgHandler = (rq, res, n, rec) => (n === 1 ? sendHalfThenStall(res, rec) : sendRange(rq, res, rec));
    const bridge = await makeBridge();
    await startDownload(bridge);
    const s = await waitSettled(bridge);
    assert.equal(s.status, 'ready', JSON.stringify(s));
    assert.ok(fs.readFileSync(env.dmg).equals(payload), '文件应逐字节一致');
    assert.ok(retryWarns()[0]?.includes('idle-timeout'), '应记录空闲超时：' + warns.join('\n'));
    assert.equal(dmgReqs[1].status, 206, '超时后续传');
    for (const r of openRes) r.destroy();
  });

  await test('D9 下载目录不可写：立即报错且说明路径，不发请求', async () => {
    const env = newEnv('d9');
    setDmgDownloadTiming(FAST);
    dmgHandler = (rq, res, n, rec) => sendFull(res, rec);
    fs.chmodSync(env.downloads, 0o555);
    try {
      const bridge = await makeBridge();
      await startDownload(bridge);
      const s = await waitSettled(bridge);
      assert.equal(s.status, 'error', JSON.stringify(s));
      assert.ok(s.error.includes('不可写') && s.error.includes(env.downloads), s.error);
      assert.equal(dmgReqs.length, 0, '不应发出下载请求');
    } finally {
      fs.chmodSync(env.downloads, 0o755);
    }
  });

  console.log('\n' + checks + ' checks passed');
} finally {
  for (const r of openRes) r.destroy();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  console.warn = origWarn;
}
