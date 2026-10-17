// 回收站策略（可插拔）：默认移入数据源内的 .trash/；宿主（如 Electron）可注册系统回收站处理函数。
// 处理函数签名：async (absPath) => void，失败时抛错（调用方保留 .trash/ 中的副本）。
let handler = null;

export function setTrashHandler(fn) {
  handler = typeof fn === 'function' ? fn : null;
}

export function getTrashHandler() {
  return process.env.WORKBENCH_TRASH === 'local' ? null : handler;
}
