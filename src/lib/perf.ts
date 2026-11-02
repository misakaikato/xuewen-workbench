// 性能计数器：仅开发构建或 wb:e2e=1 测试钩子下计数，生产环境为无操作。
// 读取入口：window.__wbPerf（按 key 递增）。
const active = import.meta.env.DEV || localStorage.getItem('wb:e2e') === '1';

export function perfInc(key: string): void {
  if (!active) return;
  const w = window as unknown as { __wbPerf?: Record<string, number> };
  const store = (w.__wbPerf ??= {});
  store[key] = (store[key] ?? 0) + 1;
}
