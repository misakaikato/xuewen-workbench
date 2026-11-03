// 渲染期不读时钟（react-hooks/purity）：需要实时时间的地方由本 hook 提供，
// active 时先把当前时间写进 state，再周期刷新。
import { useEffect, useState } from 'react';

export function useNow(active: boolean, intervalMs: number): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    // 首个值在一个周期后才到位：活动指示的秒数本就要 ≥2s 才显示；倒计时先按满额展示
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}
