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

// 长卡顿自剖析：出现 ≥ PROFILE_TRIGGER_MS 的阻塞后，在进程内录 PROFILE_MS 的 CPU 剖析，
// 把自身耗时最多的函数与模块写进日志（只有函数名与代码位置，不含任何数据），每 PROFILE_COOLDOWN_MS 最多一次。
// 活动标签只能说明「当时有哪些活动」，剖析才说明主线程实际在执行什么。
const PROFILE_TRIGGER_MS = 3000;
const PROFILE_MS = 30000;
const PROFILE_COOLDOWN_MS = 10 * 60 * 1000;
let profiling = false;
let lastProfileAt = 0;

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
      const heapMB = Math.round(process.memoryUsage().heapUsed / 1048576);
      console.warn('[lag] 事件循环阻塞 ' + lag + 'ms，堆 ' + heapMB + 'MB（进行中：' + reportLabels() + '）');
      if (lag >= PROFILE_TRIGGER_MS) void profileAfterLag();
    }
    prevActive = [...new Set(active.values())];
    recent.clear();
  }, intervalMs);
  if (timer.unref) timer.unref();
}

// 报告标签 = 去重后的「recent」+「上次 tick 时 active 的标签」，最多列 3 个，多余追加“等 N 项”。
// recent 在前：阻塞期间才登记的活动最可能就是阻塞者，长期挂着的活动（如整轮建索引）排在后面
function reportLabels() {
  const seen = new Set();
  const list = [];
  for (const label of [...recent, ...prevActive]) {
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

// 时间片让出：返回的 maybeYield 自上次让出起超过 budgetMs 才 setImmediate 一次（结果与顺序不变）。
// 长循环每步调一次，既不阻塞事件循环，也不在每步都付出让出的开销。
export function sliceYielder(budgetMs = 30) {
  let sliceStart = Date.now();
  return async () => {
    if (Date.now() - sliceStart > budgetMs) {
      await new Promise((r) => setImmediate(r));
      sliceStart = Date.now();
    }
  };
}

export async function withActivity(label, fn) {
  const done = setActivity(label);
  try {
    return await fn();
  } finally {
    done();
  }
}

async function profileAfterLag() {
  if (profiling || Date.now() - lastProfileAt < PROFILE_COOLDOWN_MS) return;
  profiling = true;
  lastProfileAt = Date.now();
  let session = null;
  try {
    const { Session } = await import('node:inspector');
    session = new Session();
    session.connect();
    const post = (method, params) =>
      new Promise((resolve, reject) => session.post(method, params || {}, (e, r) => (e ? reject(e) : resolve(r))));
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 1000 });
    await post('Profiler.start');
    await new Promise((r) => {
      const t = setTimeout(r, PROFILE_MS);
      if (t.unref) t.unref();
    });
    const { profile } = await post('Profiler.stop');
    console.warn('[lag] 卡顿后 CPU 剖析 ' + PROFILE_MS / 1000 + 's：' + summarizeProfile(profile));
  } catch (e) {
    console.warn('[lag] CPU 剖析失败：' + String(e?.message || e));
  } finally {
    try { session?.disconnect(); } catch { /* 已断开 */ }
    profiling = false;
  }
}

// 代码位置只留应用内的相对路径（app.asar/ 或 server/ 之后）或内置模块名，不带本机目录
function shortUrl(url) {
  if (!url) return '';
  if (url.startsWith('node:')) return url;
  const u = url.replace(/\\/g, '/');
  const i = u.lastIndexOf('app.asar/');
  if (i >= 0) return u.slice(i + 'app.asar/'.length);
  const j = u.lastIndexOf('/server/');
  if (j >= 0) return u.slice(j + 1);
  return u.split('/').slice(-2).join('/');
}

// 自身耗时汇总：前 10 个函数、前 6 个模块，外加垃圾回收/空闲/程序所占比例
function summarizeProfile(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const selfUs = new Map();
  profile.samples.forEach((id, i) => selfUs.set(id, (selfUs.get(id) || 0) + (profile.timeDeltas[i] || 0)));
  const byFn = new Map();
  const byModule = new Map();
  let total = 0;
  for (const [id, us] of selfUs) {
    const f = byId.get(id).callFrame;
    const mod = shortUrl(f.url) || f.functionName || '(native)';
    const fn = (f.functionName || '(anonymous)') + (f.url ? ' ' + shortUrl(f.url) + ':' + (f.lineNumber + 1) : '');
    byFn.set(fn, (byFn.get(fn) || 0) + us);
    byModule.set(mod, (byModule.get(mod) || 0) + us);
    total += us;
  }
  const pct = (us) => (total ? Math.round((us / total) * 100) : 0) + '%';
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => k + ' ' + pct(us)).join('；');
  return '函数 ' + top(byFn, 10) + ' ｜ 模块 ' + top(byModule, 6);
}
