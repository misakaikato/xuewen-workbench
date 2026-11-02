// 统一轮询：页面隐藏（document.visibilityState === 'hidden'）时暂停计时器，
// 回到可见时立即补拉一次再恢复周期。fn 经 ref 持有，周期变化才重建计时器。
import { useEffect, useRef } from 'react';

export function usePolling(fn: () => void, ms: number, opts?: { enabled?: boolean }): void {
  const enabled = opts?.enabled ?? true;
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn; // 提交后同步最新回调，避免渲染期访问 ref
  });
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => fnRef.current();
    const start = () => {
      stop();
      timer = setInterval(tick, ms);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        stop();
      } else {
        tick(); // 补拉一次，保证隐藏期间的状态变化不滞后一个周期
        start();
      }
    };
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ms, enabled]);
}
