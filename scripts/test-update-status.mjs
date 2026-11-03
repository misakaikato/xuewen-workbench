// 更新状态随 /api/status 下发的回归测试：打包版的更新桥经 RPC 到主进程，state() 返回 Promise。
// /api/status 必须等到结果再序列化，否则 update 变成 {}，前端判定为「开发模式」，横幅与检查更新都不出现。
// 用法：node scripts/test-update-status.mjs
import net from 'node:net';
import { makeTmpDir } from './tmpdirs.mjs';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + ': ' + JSON.stringify(detail)); }
}

const port = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
process.env.WORKBENCH_DATA_DIR = makeTmpDir('wb-updstatus-');
process.env.WORKBENCH_PORT = String(port);

// 模拟打包版：state() 经 RPC 异步返回
const snapshot = {
  enabled: true, status: 'available', currentVersion: '9.9.8',
  info: { version: '9.9.9', releaseDate: null, notes: null },
  progress: null, error: null, phase: null, canCancel: false,
  installMode: null, installModeReason: null, lastInstall: null,
};
let failNext = false;
const { setUpdateBridge } = await import('../server/update.js');
setUpdateBridge({
  state: async () => {
    await new Promise((r) => setTimeout(r, 5));
    if (failNext) { failNext = false; throw new Error('rpc timeout'); }
    return snapshot;
  },
  check: async () => snapshot,
  download: async () => snapshot,
  cancel: async () => snapshot,
  install: async () => ({ ok: true }),
  openInstaller: async () => {},
  openRelease: async () => {},
});
await import('../server/index.js');

const base = `http://127.0.0.1:${port}`;
const get = async (p) => (await fetch(base + p)).json();
for (let i = 0; ; i++) {
  try { await get('/api/config'); break; } catch { if (i > 100) throw new Error('后端未就绪'); await new Promise((r) => setTimeout(r, 100)); }
}

console.log('\n/api/status 带回异步更新桥的完整状态');
const st = await get('/api/status');
check('update.enabled 为 true', st.update?.enabled === true, st.update);
check('update.currentVersion 为桥返回的版本', st.update?.currentVersion === '9.9.8', st.update);
check('update.status 为 available', st.update?.status === 'available', st.update);
check('update.info.version 正确', st.update?.info?.version === '9.9.9', st.update);

console.log('\n与专用接口一致');
const direct = await get('/api/update/state');
check('/api/status.update 与 /api/update/state 相同', JSON.stringify(st.update) === JSON.stringify(direct), { st: st.update, direct });

console.log('\n单次 RPC 失败时沿用上一次快照');
failNext = true;
const st2 = await get('/api/status');
check('失败那次仍返回上一次的完整状态', st2.update?.enabled === true && st2.update?.currentVersion === '9.9.8', st2.update);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
