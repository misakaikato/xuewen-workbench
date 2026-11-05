// 渲染进程诊断上报：window error / unhandledrejection / 长任务（≥1000ms），以及界面主动报告的失败（reportDiagnostic），批量 POST /api/log。
// 直接用 fetch 不经 api.req；上报失败静默丢弃，不重试，不产生新的错误上报。
let installed = false;

const MAX_BATCH = 50;
const MAX_QUEUE = 200;

type ReportLevel = 'ERROR' | 'WARN' | 'INFO';

function truncate(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) : s;
}

const queue: { level: ReportLevel; message: string; at: string }[] = [];
let timer: number | null = null;

const schedule = () => {
  if (timer !== null) return;
  timer = window.setTimeout(flush, 2000);
};

const flush = () => {
  timer = null;
  const batch = queue.splice(0, MAX_BATCH);
  if (!batch.length) return;
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: batch }),
    keepalive: true,
  }).catch(() => {});
};

/** 记一条到 renderer.log（诊断包里能看到）：界面上捕获并已提示用户、但事后排查需要的失败 */
export function reportDiagnostic(level: ReportLevel, message: string) {
  if (queue.length >= MAX_QUEUE) queue.shift(); // 超限丢最旧
  queue.push({ level, message: truncate(message), at: new Date().toISOString() });
  schedule();
}

export function installRendererDiagnostics() {
  if (installed) return;
  installed = true;
  const push = reportDiagnostic;

  window.addEventListener('error', (e) => {
    const stack = e.error instanceof Error ? e.error.stack : null;
    push('ERROR', e.message + (stack ? ' ' + stack : ''));
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    if (reason instanceof Error) {
      push('ERROR', reason.message + (reason.stack ? ' ' + reason.stack : ''));
    } else {
      push('ERROR', String(reason));
    }
  });

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= 1000) {
          push('WARN', `[longtask] ${Math.round(entry.duration)}ms 页面 ${location.pathname}`);
        }
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch { /* 环境不支持 longtask 时忽略 */ }
}
