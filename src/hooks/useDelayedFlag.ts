// 延迟指示：active 持续超过 delayMs 才返回 true，active 变 false 立即回落。
// 用于「快操作不闪提示、慢操作才出现」的场景（反馈分级：<300ms 不额外提示）。
import { useEffect, useState } from 'react';

export function useDelayedFlag(active: boolean, delayMs = 150): boolean {
  const [shown, setShown] = useState(false);
  const [prev, setPrev] = useState(active);
  if (prev !== active) {
    setPrev(active);
    if (!active) setShown(false); // 回落在渲染期对账完成，不等 effect
  }
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(t);
  }, [active, delayMs]);
  return shown;
}
