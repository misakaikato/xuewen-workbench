// R1：跨重启「已更新」提示的判定单测（electron/updateOutcome.js 纯函数）。
import assert from 'node:assert/strict';
import { consumeInstallOutcome, humanizeInstallFailure } from '../electron/updateOutcome.js';

let checks = 0;
function test(name, fn) { return Promise.resolve(fn()).then(() => { checks++; console.log('PASS', name); }); }

try {
  await test('成功：当前版本已是 toVersion → updated，清理文件', () => {
    const r = consumeInstallOutcome({
      currentVersion: '0.2.0',
      pending: { fromVersion: '0.1.7', toVersion: '0.2.0', at: '2026-11-03T00:00:00Z' },
      result: { ok: true, reason: '', detail: '', at: '2026-11-03T00:00:05Z' },
    });
    assert.deepEqual(r.lastInstall, { result: 'updated', fromVersion: '0.1.7', toVersion: '0.2.0' });
    assert.equal(r.clear, true);
    assert.equal(r.keep, false);
  });

  await test('失败：版本未变且有失败 result → failed，带人话与安装包路径，清理文件', () => {
    const r = consumeInstallOutcome({
      currentVersion: '0.1.7',
      pending: { fromVersion: '0.1.7', toVersion: '0.2.0', dmgPath: '/tmp/x.dmg', at: '2026-11-03T00:00:00Z' },
      result: { ok: false, reason: 'move-old-failed', detail: 'Operation not permitted', at: '2026-11-03T00:00:05Z' },
    });
    assert.equal(r.lastInstall.result, 'failed');
    assert.equal(r.lastInstall.dmgPath, '/tmp/x.dmg');
    assert.ok(r.lastInstall.error.includes('App 管理'), '人话应包含 App 管理指引：' + r.lastInstall.error);
    assert.equal(r.clear, true);
  });

  await test('取消：版本未变且无 result → 保留 pending，不提示', () => {
    const r = consumeInstallOutcome({
      currentVersion: '0.1.7',
      pending: { fromVersion: '0.1.7', toVersion: '0.2.0', at: '2026-11-03T00:00:00Z' },
      result: null,
    });
    assert.equal(r.lastInstall, null);
    assert.equal(r.clear, false);
    assert.equal(r.keep, true);
  });

  await test('跨版本手动安装过（当前版本既非 from 也非 to）→ 清理，不提示', () => {
    const r = consumeInstallOutcome({
      currentVersion: '0.3.0',
      pending: { fromVersion: '0.1.7', toVersion: '0.2.0', at: '2026-11-03T00:00:00Z' },
      result: null,
    });
    assert.equal(r.lastInstall, null);
    assert.equal(r.clear, true);
  });

  await test('无 pending → 忽略', () => {
    const r = consumeInstallOutcome({ currentVersion: '0.1.7', pending: null, result: { ok: true } });
    assert.equal(r.lastInstall, null);
    assert.equal(r.clear, false);
  });

  await test('pending 结构不合法 → 忽略（不抛错）', () => {
    const r = consumeInstallOutcome({ currentVersion: '0.1.7', pending: { foo: 1 }, result: null });
    assert.equal(r.lastInstall, null);
    assert.equal(r.clear, false);
  });

  await test('成功路径不受 dmgPath 影响；失败时 result.ok 非 false 视为未安装', () => {
    const r = consumeInstallOutcome({
      currentVersion: '0.1.7',
      pending: { fromVersion: '0.1.7', toVersion: '0.2.0', at: '2026-11-03T00:00:00Z' },
      result: { ok: true },
    });
    assert.equal(r.lastInstall, null);
    assert.equal(r.keep, true);
  });

  await test('move-old-failed 的人话含手动安装指引', () => {
    const msg = humanizeInstallFailure('move-old-failed', '');
    assert.ok(msg.includes('系统设置 → 隐私与安全性 → App 管理'), msg);
    assert.ok(msg.includes('拖到 Applications'), msg);
  });

  await test('各 reason 都有人话，未知 reason 透传', () => {
    assert.ok(humanizeInstallFailure('move-new-failed', '').includes('还原为旧版本'));
    assert.ok(humanizeInstallFailure('restore-failed', '/tmp/bak').includes('/tmp/bak'));
    assert.ok(humanizeInstallFailure('wait-exit-timeout', '').includes('超时'));
    assert.equal(humanizeInstallFailure('whatever', 'boom'), 'whatever：boom');
  });

  console.log('\n' + checks + ' checks passed');
} catch (e) {
  console.error(e);
  process.exit(1);
}
