// 面板挂载/卸载过渡的统一做法（DESIGN.md §7/§8，配合 tailwindcss-animate 的
// data-[state=open/closed] 类）：open 时立即挂载并播放入场，关闭时等 med 档
// 离场动画播完才真正移除，避免瞬时挂载/卸载。
// 时长读 CSS 变量 --dur-med（token 单一真相源），不写死毫秒；reduced-motion 下
// 动画本身由 index.css 的全局规则压到 ~0，这里只是多等一拍再卸载。
import { useEffect, useState } from 'react';

function medMs(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-med'));
  return Number.isFinite(v) && v > 0 ? v : 200;
}

export function usePresence(open: boolean): { mounted: boolean; state: 'open' | 'closed' } {
  const [mounted, setMounted] = useState(open);
  // 打开时在渲染期对账立即挂载；关闭时由 effect 等离场动画播完再移除
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open || !mounted) return;
    // 60ms 为调度余量，不是动画时长；动画时长始终等于 var(--dur-med)
    const t = setTimeout(() => setMounted(false), medMs() + 60);
    return () => clearTimeout(t);
  }, [open, mounted]);
  return { mounted, state: open ? 'open' : 'closed' };
}
