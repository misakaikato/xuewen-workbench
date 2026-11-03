// 宿主 RPC 桥（utilityProcess 托管模式）：后端经 parentPort 与 Electron 主进程通信，
// 借宿主能力（回收站、系统打开、更新、定位）与启动进度上报。
// 独立 dev:server 无 parentPort → hosted=false，所有桥接为空操作，行为与原内嵌后端一致。
import { setTrashHandler } from './trash.js';
import { setOpenHandler } from './hostOpen.js';
import { setUpdateBridge } from './update.js';

export const hosted = !!process.parentPort && process.env.WORKBENCH_HOSTED === '1';

const pending = new Map(); // id -> { resolve, reject, timer }
let seq = 1;

function settle(id, ok, value) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (p.timer) clearTimeout(p.timer);
  if (ok) p.resolve(value);
  else p.reject(new Error(value || 'rpc 失败'));
}

if (hosted) {
  process.parentPort.on('message', (e) => {
    const msg = e && e.data;
    if (!msg || msg.t !== 'rpc-result') return;
    settle(msg.id, msg.ok, msg.ok ? msg.value : msg.error);
  });
}

// 调用宿主能力；shell.* 与 host.* 30 秒超时，update.* 不设超时（下载可长跑）。
export function rpc(method, ...args) {
  if (!hosted) return Promise.reject(new Error('非托管模式'));
  const id = seq++;
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    pending.set(id, entry);
    if (/^(shell|host)\./.test(method)) {
      entry.timer = setTimeout(() => settle(id, false, '宿主调用超时: ' + method), 30000);
      entry.timer.unref?.();
    }
    process.parentPort.postMessage({ t: 'rpc', id, method, args });
  });
}

export function postBoot(step) {
  if (!hosted) return;
  process.parentPort.postMessage({ t: 'boot', step });
}

export function postReady(port) {
  if (!hosted) return;
  process.parentPort.postMessage({ t: 'ready', port });
}

export function installHostBridges() {
  if (!hosted) return;
  setTrashHandler((p) => rpc('shell.trashItem', p));
  setOpenHandler((p) => rpc('shell.openPath', p));
  setUpdateBridge({
    state: () => rpc('update.state'),
    check: () => rpc('update.check'),
    download: () => rpc('update.download'),
    install: () => rpc('update.install'),
    cancel: () => rpc('update.cancel'),
    openInstaller: () => rpc('update.openInstaller'),
    openRelease: () => rpc('update.openRelease'),
  });
}
