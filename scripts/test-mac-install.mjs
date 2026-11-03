// M1–M4：mac 自动安装的脚本级测试（仅 darwin；其他平台跳过并说明原因）。
// 全程只在临时目录进行，且始终设置 WB_MAC_INSTALL_NO_OPEN=1，不会真的 open 任何东西。
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { makeTmpDir } from './tmpdirs.mjs';

const execFileP = promisify(execFile);

if (process.platform !== 'darwin') {
  console.log(`SKIP: 仅在 darwin 运行（当前 ${process.platform}）`);
  process.exit(0);
}

const { macInstallTarget, prepareMacUpdate } = await import('../electron/macInstall.js');
const SCRIPT = path.resolve('electron/mac-install.sh');

let checks = 0;
function test(name, fn) { return Promise.resolve(fn()).then(() => { checks++; console.log('PASS', name); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = makeTmpDir('wb-macinst-');
const BUNDLE_ID = 'local.mayu.testapp';
const VERSION = '9.9.9';
let dmgPath = null;

function plistXml(bundleId, version) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n` +
    `<key>CFBundleIdentifier</key><string>${bundleId}</string>\n` +
    `<key>CFBundleShortVersionString</key><string>${version}</string>\n</dict></plist>\n`;
}

// 造假 .app：Info.plist + 几 MB 文件 + 一个符号链接，再 ad-hoc 签名（prepareMacUpdate 要验签）。
// 名字带空格：真实产品名是「Xuewen Workbench.app」
function buildFakeApp(root) {
  const contents = path.join(root, 'Fake App.app', 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), plistXml(BUNDLE_ID, VERSION));
  fs.writeFileSync(path.join(contents, 'MacOS', 'Fake App'), '#!/bin/sh\necho fake\n');
  fs.writeFileSync(path.join(contents, 'Resources', 'data.bin'), Buffer.alloc(5 * 1024 * 1024, 7));
  fs.writeFileSync(path.join(contents, 'Resources', 'note.txt'), 'hello\n');
  fs.symlinkSync('../MacOS/Fake App', path.join(contents, 'Resources', 'bin-link'));
  return path.join(root, 'Fake App.app');
}

// 跑替换脚本：日志与产物都留在临时目录；NO_OPEN=1 保证不会真的打开任何东西
let runSeq = 0;
async function runSwapScript(pid, staged, target, resultFile, dmg) {
  const logFile = path.join(tmp, `swap-${++runSeq}.log`);
  const fd = fs.openSync(logFile, 'a');
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const p = spawn('/bin/sh', [SCRIPT, String(pid), staged, target, resultFile, dmg], {
      stdio: ['ignore', fd, fd],
      env: { ...process.env, WB_MAC_INSTALL_NO_OPEN: '1' },
    });
    p.on('close', resolve);
    p.on('error', (e) => { console.error(e); resolve(-1); });
  });
  const ms = Date.now() - t0;
  fs.closeSync(fd);
  return { code, ms, log: fs.readFileSync(logFile, 'utf8'), result: JSON.parse(fs.readFileSync(resultFile, 'utf8')) };
}

// 短命进程：脚本等它退出才开始替换
function spawnSleep(sec) {
  const p = spawn('sleep', [String(sec)], { stdio: 'ignore' });
  return p;
}

const appsDirMode = []; // 需要恢复权限的目录（chmod 555 测试后还原）
try {
  const srcApp = buildFakeApp(path.join(tmp, 'src'));
  await execFileP('codesign', ['--force', '--deep', '--sign', '-', srcApp]);
  dmgPath = path.join(tmp, 'Fake App.dmg');
  await execFileP('hdiutil', ['create', '-volname', 'Fake App', '-srcfolder', path.join(tmp, 'src'), dmgPath]);

  // ---------- M1 准备成功 ----------
  await test('M1 准备成功：进度单调到 100，staged 与源一致（含符号链接），挂载点已卸载', async () => {
    const stagingDir = path.join(tmp, 'updates', 'staging');
    const percents = [];
    const phases = [];
    const { staged } = await prepareMacUpdate({
      dmgPath,
      expectedVersion: VERSION,
      expectedBundleId: BUNDLE_ID,
      stagingDir,
      onPhase: (p) => phases.push(p),
      onProgress: (p) => percents.push(p.percent),
    });
    assert.deepEqual(phases, ['preparing', 'copying', 'verifying'], '阶段顺序');
    assert.ok(percents.length >= 2, '至少有起点与终点两次进度');
    for (let i = 1; i < percents.length; i++) assert.ok(percents[i] >= percents[i - 1], `进度应单调不减：${percents}`);
    assert.equal(percents[percents.length - 1], 100, '结束时应为 100');
    const diff = await execFileP('diff', ['-r', srcApp, staged]);
    assert.equal(diff.stdout, '', 'diff -r 应无输出');
    assert.equal(diff.stderr, '', 'diff -r 不应有错误输出');
    assert.ok(fs.lstatSync(path.join(staged, 'Contents', 'Resources', 'bin-link')).isSymbolicLink(), '符号链接应保留');
    const info = await execFileP('hdiutil', ['info']);
    assert.ok(!info.stdout.includes('wb-dmg-'), '临时挂载点应已全部卸载');
  });

  // ---------- M2 校验失败 ----------
  await test('M2 版本不符：报「安装包与当前应用不匹配」，staging 清理、挂载点卸载', async () => {
    const stagingDir = path.join(tmp, 'updates', 'staging-bad-ver');
    let err = null;
    try {
      await prepareMacUpdate({ dmgPath, expectedVersion: '0.0.1', expectedBundleId: BUNDLE_ID, stagingDir });
    } catch (e) { err = e; }
    assert.ok(err && /不匹配/.test(err.message), '应报不匹配：' + err);
    assert.ok(!fs.existsSync(stagingDir), 'staging 应已清理');
    const info = await execFileP('hdiutil', ['info']);
    assert.ok(!info.stdout.includes('wb-dmg-'), '挂载点应已卸载');
  });

  await test('M2 bundle id 不符：同样报不匹配并清理', async () => {
    const stagingDir = path.join(tmp, 'updates', 'staging-bad-id');
    let err = null;
    try {
      await prepareMacUpdate({ dmgPath, expectedVersion: VERSION, expectedBundleId: 'other.app', stagingDir });
    } catch (e) { err = e; }
    assert.ok(err && /不匹配/.test(err.message), '应报不匹配：' + err);
    assert.ok(!fs.existsSync(stagingDir), 'staging 应已清理');
  });

  await test('M2 未签名 bundle（真实产品形态）：跳过验签，字节对账 + 版本复核通过', async () => {
    const unsignedSrc = path.join(tmp, 'src-unsigned');
    const unsignedApp = buildFakeApp(unsignedSrc); // 不执行 ad-hoc 签名
    const unsignedDmg = path.join(tmp, 'Unsigned.dmg');
    await execFileP('hdiutil', ['create', '-volname', 'Unsigned', '-srcfolder', unsignedSrc, unsignedDmg]);
    assert.ok(!fs.existsSync(path.join(unsignedApp, 'Contents', '_CodeSignature')), '夹具应未签名');
    const stagingDir = path.join(tmp, 'updates', 'staging-unsigned');
    const { staged } = await prepareMacUpdate({
      dmgPath: unsignedDmg,
      expectedVersion: VERSION,
      expectedBundleId: BUNDLE_ID,
      stagingDir,
    });
    const diff = await execFileP('diff', ['-r', unsignedApp, staged]);
    assert.equal(diff.stdout, '', 'diff -r 应无输出');
  });

  // ---------- M3 替换脚本（target / staged / 所在目录名都带空格） ----------
  await test('M3 成功路径：target 被替换、backup 删除、result ok、日志记 would open --updated', async () => {
    const appsDir = path.join(tmp, 'm3a dir');
    const target = path.join(appsDir, 'Target App.app');
    fs.mkdirSync(path.join(target, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(target, 'Contents', 'MacOS', 'x'), 'old');
    const staged = path.join(tmp, 'm3a dir staging', 'Staged App.app');
    fs.mkdirSync(path.join(staged, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(staged, 'Contents', 'MacOS', 'x'), 'new');
    const dmg = path.join(tmp, 'fake-installer.dmg');
    fs.writeFileSync(dmg, 'pretend dmg');
    const resultFile = path.join(tmp, 'm3a-updates', 'install-result.json');

    const pidP = spawnSleep(1);
    const r = await runSwapScript(pidP.pid, staged, target, resultFile, dmg);
    assert.equal(r.code, 0, '退出码 0');
    assert.equal(r.result.ok, true, 'result ok:true');
    assert.equal(fs.readFileSync(path.join(target, 'Contents', 'MacOS', 'x'), 'utf8'), 'new', 'target 应为新内容');
    assert.ok(r.log.includes('would open'), '日志应记 would open');
    assert.ok(r.log.includes('--args --updated'), '日志应记 --updated 参数');
    assert.ok(r.log.includes(`would open ${target} --args --updated`), '日志应记完整打开命令');
    // backup 的删除在后台执行，轮询等待
    let backupGone = false;
    for (let i = 0; i < 50; i++) {
      const left = fs.readdirSync(appsDir).filter((n) => n.includes('.old-'));
      if (!left.length) { backupGone = true; break; }
      await sleep(100);
    }
    assert.ok(backupGone, 'backup 最终应被删除');
    // staging 的删除同样在后台执行，轮询等待
    let stagingGone = false;
    for (let i = 0; i < 50; i++) {
      if (!fs.existsSync(path.dirname(staged))) { stagingGone = true; break; }
      await sleep(100);
    }
    assert.ok(stagingGone, 'staging 目录应被清理');
  });

  await test('M3 父目录不可写：move-old-failed，target 未变，日志记 would open dmg', async () => {
    const appsDir = path.join(tmp, 'm3b dir');
    appsDirMode.push(appsDir);
    const target = path.join(appsDir, 'Target App.app');
    fs.mkdirSync(path.join(target, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(target, 'Contents', 'MacOS', 'x'), 'old');
    const staged = path.join(tmp, 'm3b dir staging', 'Staged App.app');
    fs.mkdirSync(path.join(staged, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(staged, 'Contents', 'MacOS', 'x'), 'new');
    const dmg = path.join(tmp, 'fake-installer.dmg');
    const resultFile = path.join(tmp, 'm3b-updates', 'install-result.json');

    fs.chmodSync(appsDir, 0o555);
    const pidP = spawnSleep(1);
    const r = await runSwapScript(pidP.pid, staged, target, resultFile, dmg);
    assert.equal(r.code, 1, '失败退出码 1');
    assert.equal(r.result.ok, false);
    assert.equal(r.result.reason, 'move-old-failed');
    assert.equal(fs.readFileSync(path.join(target, 'Contents', 'MacOS', 'x'), 'utf8'), 'old', 'target 应保持不变');
    assert.ok(r.log.includes(`would open ${dmg}`), '日志应记 would open dmg：' + r.log);
  });

  await test('M3 等待 pid：脚本在原进程退出后才开始替换（日志顺序 + 用时）', async () => {
    const appsDir = path.join(tmp, 'm3c dir');
    const target = path.join(appsDir, 'Target App.app');
    fs.mkdirSync(path.join(target, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(target, 'Contents', 'MacOS', 'x'), 'old');
    const staged = path.join(tmp, 'm3c dir staging', 'Staged App.app');
    fs.mkdirSync(path.join(staged, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(staged, 'Contents', 'MacOS', 'x'), 'new');
    const dmg = path.join(tmp, 'fake-installer.dmg');
    const resultFile = path.join(tmp, 'm3c-updates', 'install-result.json');

    const pidP = spawnSleep(2);
    const r = await runSwapScript(pidP.pid, staged, target, resultFile, dmg);
    assert.equal(r.code, 0);
    assert.ok(r.ms >= 1800, `脚本应等满约 2 秒（实际 ${r.ms}ms）`);
    const startIdx = r.log.indexOf('mac-install 开始');
    const waitDoneIdx = r.log.indexOf('原进程已退出');
    const replacedIdx = r.log.indexOf('新版本已就位');
    assert.ok(startIdx >= 0 && waitDoneIdx > startIdx && replacedIdx > waitDoneIdx, '日志顺序：开始 → 等待退出 → 替换');
    assert.equal(fs.readFileSync(path.join(target, 'Contents', 'MacOS', 'x'), 'utf8'), 'new');
  });

  // ---------- M5 重复安装并发防护（updater.js 集成：打桩 electron / electron-updater + 本地 generic 源） ----------
  await test('M5 连续两次 install()：只准备一次，第二次立即被拒绝', async () => {
    const dir = path.join(tmp, 'm5 env'); // 目录名带空格
    fs.mkdirSync(dir, { recursive: true });
    // execPath 伪装成可写 .app（预检返回 auto），并写入当前应用的 bundle id
    const fakeApp = path.join(dir, 'Fake App.app');
    fs.mkdirSync(path.join(fakeApp, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(fakeApp, 'Contents', 'Info.plist'), plistXml(BUNDLE_ID, VERSION));
    fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });

    // loader hooks：ESM 的 import 'electron' 重定向到打桩模块；
    // electron-updater 走 createRequire，hooks 拦不住，改用 require.cache 预注入（见下）
    fs.writeFileSync(path.join(dir, 'hooks.mjs'),
      `export async function resolve(specifier, context, next) {\n` +
      `  if (specifier === 'electron') return { url: new URL('./stub-electron.mjs', import.meta.url).href, shortCircuit: true };\n` +
      `  return next(specifier, context);\n` +
      `}\n`);
    fs.writeFileSync(path.join(dir, 'stub-electron.mjs'),
      `import path from 'node:path';\n` +
      `const DIR = process.env.WB_M5_DIR;\n` +
      `Object.defineProperty(process, 'resourcesPath', { value: path.join(DIR, 'resources'), configurable: true });\n` +
      `Object.defineProperty(process, 'execPath', { value: path.join(DIR, 'Fake App.app', 'Contents', 'MacOS', 'Fake App'), configurable: true });\n` +
      `export const app = {\n` +
      `  getVersion: () => '0.1.7',\n` +
      `  getPath: (name) => path.join(DIR, name === 'downloads' ? 'downloads' : 'userData'),\n` +
      `  quit: () => { globalThis.__wbQuit = (globalThis.__wbQuit || 0) + 1; },\n` +
      `};\n` +
      `export const shell = { openPath: async () => '', openExternal: async () => {} };\n`);

    // hdiutil 计数包装：统计 prepare 的 attach 次数
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const hdilog = path.join(dir, 'hdiutil.log');
    fs.writeFileSync(path.join(binDir, 'hdiutil'),
      `#!/bin/sh\necho "$@" >> "${hdilog}"\nexec /usr/bin/hdiutil "$@"\n`);
    fs.chmodSync(path.join(binDir, 'hdiutil'), 0o755);

    // 本地 HTTP 源（generic provider）：任意路径都返回 M1 造好的 DMG
    const dmgBytes = fs.readFileSync(dmgPath);
    const server = http.createServer((req, res) => {
      req.on('error', () => {});
      res.writeHead(200, { 'Content-Length': dmgBytes.length });
      res.end(dmgBytes);
    });
    const savedEnv = { PATH: process.env.PATH, WB_M5_DIR: process.env.WB_M5_DIR, WB_M5_VERSION: process.env.WB_M5_VERSION, WB_M5_DMG_NAME: process.env.WB_M5_DMG_NAME };
    try {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      fs.writeFileSync(path.join(dir, 'resources', 'app-update.yml'),
        `provider: generic\nurl: http://127.0.0.1:${server.address().port}\n`);
      process.env.PATH = `${binDir}:${process.env.PATH}`;
      process.env.WB_M5_DIR = dir;
      process.env.WB_M5_VERSION = VERSION;
      process.env.WB_M5_DMG_NAME = 'Fake App-9.9.9.dmg';

      register(pathToFileURL(path.join(dir, 'hooks.mjs')));
      // createRequire('electron-updater') 不经 hooks：预注入 require.cache 让它拿到打桩
      const { createRequire } = await import('node:module');
      const { EventEmitter } = await import('node:events');
      const req = createRequire(import.meta.url);
      const updaterPath = req.resolve('electron-updater');
      const fakeUpdater = new EventEmitter();
      fakeUpdater.checkForUpdates = () => {
        setImmediate(() => fakeUpdater.emit('update-available', { version: VERSION, files: [{ url: 'Fake App-9.9.9.dmg' }] }));
        return Promise.resolve();
      };
      fakeUpdater.downloadUpdate = () => Promise.resolve();
      fakeUpdater.quitAndInstall = () => {};
      class FakeToken { constructor() { this.cancelled = false; } cancel() { this.cancelled = true; } }
      req.cache[updaterPath] = { id: updaterPath, filename: updaterPath, loaded: true, exports: { autoUpdater: fakeUpdater, CancellationToken: FakeToken } };

      const { createUpdaterBridge } = await import('../electron/updater.js');
      const bridge = await createUpdaterBridge({ getUiSettings: () => ({ autoUpdate: false }), logsDir: path.join(dir, 'logs') });

      await bridge.check();
      assert.equal(bridge.state().status, 'available', '打桩检查应进入 available');
      await bridge.download();
      let ready = bridge.state();
      for (let i = 0; i < 100 && ready.status !== 'ready'; i++) {
        await sleep(100);
        ready = bridge.state();
      }
      assert.equal(ready.status, 'ready', '下载应完成进入 ready：' + JSON.stringify(ready));
      assert.equal(ready.installMode, 'auto', '预检应为 auto');

      // 同步连点两次 install：修复后第一次已在同步阶段离开 ready，第二次应立即被 notReady 拒绝
      const [s1, s2] = await Promise.allSettled([bridge.install(), bridge.install()]);
      assert.equal(s1.status, 'fulfilled', '第一次 install 应成功走完准备与派发');
      assert.equal(s1.value.ok, true, '第一次 install 应返回 ok');
      assert.equal(s2.status, 'rejected', '第二次 install 应立即被拒绝');
      assert.ok(s2.reason?.notReady, '拒绝原因应为 notReady：' + s2.reason);
      const attachCount = (fs.readFileSync(hdilog, 'utf8').match(/^attach /gm) || []).length;
      assert.equal(attachCount, 1, 'prepare 应只执行一次（hdiutil attach 计数）');
      assert.equal(globalThis.__wbQuit, 1, '应完成派发并调用 app.quit（桩计数）');
      const pending = JSON.parse(fs.readFileSync(path.join(dir, 'userData', 'updates', 'pending.json'), 'utf8'));
      assert.equal(pending.toVersion, VERSION, '应写入待完成记录');
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      process.env.PATH = savedEnv.PATH;
      for (const k of ['WB_M5_DIR', 'WB_M5_VERSION', 'WB_M5_DMG_NAME']) {
        if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
      }
      // 替换脚本会等本进程退出（pid 是测试进程）：杀掉，避免残留 60 秒
      await execFileP('pkill', ['-f', path.join(dir, 'userData', 'updates', 'mac-install.sh')]).catch(() => {});
    }
  });

  // ---------- M4 预检 ----------
  await test('M4 预检：AppTranslocation / DMG 卷内路径返回 manual', async () => {
    const t1 = await macInstallTarget('/private/var/folders/x/AppTranslocation/y/A.app/Contents/MacOS/A');
    assert.equal(t1.mode, 'manual');
    assert.equal(t1.reason, 'app-translocation');
    const t2 = await macInstallTarget('/Volumes/X/A.app/Contents/MacOS/A');
    assert.equal(t2.mode, 'manual');
    assert.equal(t2.reason, 'on-dmg-volume');
  });

  await test('M4 预检：可写目录中的 .app 返回 auto 与目标路径', async () => {
    const appRoot = path.join(tmp, 'apps-ok');
    const bundle = path.join(appRoot, 'Ok.app');
    fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    const t = await macInstallTarget(path.join(bundle, 'Contents', 'MacOS', 'Ok'));
    assert.equal(t.mode, 'auto');
    assert.equal(t.target, bundle);
  });

  console.log('\n' + checks + ' checks passed');
} finally {
  for (const d of appsDirMode) { try { fs.chmodSync(d, 0o755); } catch { /* 已不存在 */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
}
