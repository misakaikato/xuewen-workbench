// 诊断基础设施回归：日志轮转、行格式、卡顿看门狗、异常事件记录与诊断包导出。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-diag-'));
let checks = 0;
function test(name, fn) {
  return Promise.resolve(fn()).then(() => { checks++; console.log('PASS', name); });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = (ms) => { const t = Date.now(); while (Date.now() - t < ms) {} };

// 捕获 console.warn：看门狗输出据此断言，同时避免测试期间看门狗噪声污染 stdout
const warns = [];
console.warn = (...a) => warns.push(a.join(' '));

const { createLogWriter } = await import('../server/logger.js');
const { startLagWatch, withActivity } = await import('../server/lagWatch.js');
const {
  markSessionStart, markSessionEnd, pendingIncident, ackIncidents, exportDiagnostics,
} = await import('../server/diagnostics.js');

try {
  // 轮转：写入 12MB、maxBytes=5MB、keep=3 → 存在 x.log/x.log.1/x.log.2，无 x.log.3，每个不超上限
  await test('日志轮转保留 3 份且不超上限', () => {
    const dir = path.join(tmp, 'rotate');
    const w = createLogWriter({ dir, name: 'x', maxBytes: 5 * 1024 * 1024, keep: 3 });
    const chunk = 'y'.repeat(8000); // 单行上限内，累加写入约 12.8MB
    for (let i = 0; i < 1600; i++) w.write('INFO', 'test', chunk);
    for (const n of ['x.log', 'x.log.1', 'x.log.2']) {
      assert.ok(fs.existsSync(path.join(dir, n)), n + ' 应存在');
      assert.ok(fs.statSync(path.join(dir, n)).size <= 5 * 1024 * 1024 + 1024 * 1024 + 100, n + ' 超过上限');
    }
    assert.ok(!fs.existsSync(path.join(dir, 'x.log.3')), 'x.log.3 不应存在');
  });

  // 行格式：ISO 时间 + 5 位级别 + [tag] 前缀
  await test('日志行格式', () => {
    const dir = path.join(tmp, 'fmt');
    const w = createLogWriter({ dir, name: 'y', maxBytes: 1024 * 1024 });
    w.write('INFO', 'backend', 'hello');
    w.write('WARN', 'main', 'warn');
    const content = fs.readFileSync(path.join(dir, 'y.log'), 'utf8');
    assert.match(content, /^\d{4}-\d\d-\d\dT[\d:.]+Z (INFO |WARN |ERROR|DEBUG|FATAL) \[\w+\] /m);
  });

  // 看门狗①：withActivity('甲', 同步忙等 400ms) 立即执行、中间无 tick，[lag] 行仍应含「甲」
  await test('卡顿看门狗①：无 tick 时同步重活仍报标签', async () => {
    warns.length = 0;
    startLagWatch({ intervalMs: 50, thresholdMs: 100 });
    await withActivity('甲', () => busy(400));
    await sleep(120); // 等 tick 检测
    assert.ok(warns.some((s) => s.includes('[lag] 事件循环阻塞') && s.includes('甲')), '未记录卡顿或缺少标签「甲」');
  });

  // 看门狗②：乙先开始后结束、丙后开始先结束；结束后不登记活动再忙等，该条应为「无记录」
  await test('卡顿看门狗②：并发结束不留过期标签', async () => {
    warns.length = 0;
    const p乙 = withActivity('乙', async () => { await sleep(100); });
    const p丙 = withActivity('丙', async () => { await sleep(50); });
    await Promise.all([p乙, p丙]);
    await sleep(300); // 保证中间至少一次 tick，让 recent 清空、prevActive 归零
    busy(400); // 不登记活动
    await sleep(120); // 等 tick 检测
    const lagLines = warns.filter((s) => s.includes('[lag] 事件循环阻塞'));
    assert.ok(lagLines.length > 0, '应记录一条卡顿');
    const last = lagLines[lagLines.length - 1];
    assert.ok(last.includes('无记录'), '应为「无记录」，实际：' + last);
    assert.ok(!last.includes('乙') && !last.includes('丙'), '不应含乙/丙，实际：' + last);
  });

  const dataDir = path.join(tmp, 'data');

  // 两次 markSessionStart（中间不 end）→ pending 为 unclean-exit；ack 后为空；end 删除标记
  await test('两次 markSessionStart 记录 unclean-exit', () => {
    markSessionStart(dataDir, { pid: 1, version: '0.1.6', startedAt: new Date().toISOString() });
    markSessionStart(dataDir, { pid: 2, version: '0.1.6', startedAt: new Date().toISOString() });
    const p = pendingIncident(dataDir);
    assert.equal(p && p.kind, 'unclean-exit');
  });

  await test('ackIncidents 后 pending 为空', () => {
    ackIncidents(dataDir);
    assert.equal(pendingIncident(dataDir), null);
  });

  await test('markSessionEnd 删除 session.json', () => {
    markSessionEnd(dataDir);
    assert.ok(!fs.existsSync(path.join(dataDir, 'logs', 'session.json')));
  });

  // 诊断包：zip 可被 unzip 校验，列出 summary.json / 说明.txt / logs/…，summary 无 apiKey/baseUrl
  await test('诊断包导出', async () => {
    const w = createLogWriter({ dir: path.join(dataDir, 'logs'), name: 'backend', maxBytes: 5 * 1024 * 1024 });
    w.write('INFO', 'backend', 'diagnostic probe');
    const outDir = path.join(tmp, 'desktop');
    const { file } = await exportDiagnostics({
      dataDir,
      outDir,
      summary: { app: { version: '0.1.6' }, safe: true },
    });
    assert.ok(fs.existsSync(file), 'zip 应存在');
    execFileSync('unzip', ['-t', file], { stdio: 'pipe' });
    const names = execFileSync('python3', ['-c', 'import zipfile,sys;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', file], { encoding: 'utf8' });
    assert.ok(names.split('\n').includes('summary.json'), '应含 summary.json');
    assert.ok(names.split('\n').includes('说明.txt'), '应含 说明.txt');
    assert.ok(names.split('\n').some((n) => n.startsWith('logs/')), '应含 logs/ 条目');
    const summaryJson = execFileSync('unzip', ['-p', file, 'summary.json'], { encoding: 'utf8' });
    const summary = JSON.parse(summaryJson);
    assert.ok(!('apiKey' in summary), 'summary 不应含 apiKey');
    assert.ok(!('baseUrl' in summary), 'summary 不应含 baseUrl');
  });

  console.log('\n' + checks + ' checks passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
