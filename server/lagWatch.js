// 事件循环卡顿看门狗：tick 间隔超过阈值记 WARN。
// 活动是一个集合（Map<token, label>），并发 withActivity 以任意顺序结束都不会留下过期标签；
// recent 兜底记录自上次 tick 以来登记过的标签（去重、最多 5 个），因此「先 setActivity
// 紧接着同步重活、期间没有 tick」也能报出正确标签。
let active = new Map(); // token -> label
let recent = new Set(); // 自上次 tick 以来登记过的标签（去重，最多 5 个）
let prevActive = []; // 上次 tick 时 active 的标签快照（去重）
let timer = null;

// 慢文件操作诊断阈值：扫描的单次 stat/readdir、建索引的单个文件读取或解析超过它记 WARN
export const SLOW_FS_OP_MS = 500;

export function startLagWatch({ tag, intervalMs = 250, thresholdMs }) {
  if (timer) return; // 同一进程只启动一个看门狗
  const threshold = (thresholdMs ?? Number(process.env.WORKBENCH_LAG_THRESHOLD_MS)) || 1000;
  let lastTick = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastTick;
    lastTick = now;
    const lag = elapsed - intervalMs;
    if (lag >= threshold) {
      console.warn('[lag] 事件循环阻塞 ' + lag + 'ms（进行中：' + reportLabels() + '）');
    }
    prevActive = [...new Set(active.values())];
    recent.clear();
  }, intervalMs);
  if (timer.unref) timer.unref();
}

// 报告标签 = 去重后的「上次 tick 时 active 的标签」+「recent」，最多列 3 个，多余追加“等 N 项”
function reportLabels() {
  const seen = new Set();
  const list = [];
  for (const label of [...prevActive, ...recent]) {
    if (seen.has(label)) continue;
    seen.add(label);
    list.push(label);
  }
  if (!list.length) return '无记录';
  const shown = list.slice(0, 3).join('、');
  return list.length > 3 ? shown + ' 等 ' + list.length + ' 项' : shown;
}

export function setActivity(label) {
  const token = {};
  active.set(token, label);
  if (!recent.has(label)) {
    recent.add(label);
    if (recent.size > 5) recent.delete(recent.values().next().value);
  }
  return () => { active.delete(token); };
}

export async function withActivity(label, fn) {
  const done = setActivity(label);
  try {
    return await fn();
  } finally {
    done();
  }
}
