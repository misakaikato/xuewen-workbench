// 索引就绪回调：订阅全局索引就绪信号（store 轮询发出），信号到达时执行一次 cb。
// 用于「索引未就绪就等就绪后再取一次」的场景（引用计数等），cb 经 ref 持有。
import { useEffect, useRef } from 'react';
import { INDEX_SETTLED_EVENT } from '@/lib/indexReady';

export function useWhenIndexReady(cb: () => void): void {
  const ref = useRef(cb);
  useEffect(() => {
    ref.current = cb;
  });
  useEffect(() => {
    const handler = () => ref.current();
    window.addEventListener(INDEX_SETTLED_EVENT, handler);
    return () => window.removeEventListener(INDEX_SETTLED_EVENT, handler);
  }, []);
}
