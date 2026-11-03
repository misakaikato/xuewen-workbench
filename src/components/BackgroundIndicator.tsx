// 全局后台指示（反馈第 4 批）：顶栏显示当前知识库的扫描/索引进度。
// 状态来自 store 的 /api/status 轮询；持续不到 1 秒不出现（useDelayedFlag），小库不闪。
import { useApp } from '@/store/app-context';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { Loader2 } from 'lucide-react';

export function BackgroundIndicator() {
  const { backend } = useApp();
  const phase = backend.indexing?.phase ?? null;
  const active = backend.scanning || phase !== null;
  const shown = useDelayedFlag(active, 1000);
  if (!shown) return null;
  const ix = backend.indexing;
  const text = backend.scanning
    ? '正在扫描 · 已扫 '
    : phase === 'text'
      ? '正在建立索引 '
      : '正在更新链接 ';
  const num = backend.scanning ? backend.scanned : `${ix?.done ?? 0}/${ix?.total ?? 0}`;
  return (
    <span
      className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted-foreground animate-fade-in"
      role="status"
      data-testid="background-indicator"
    >
      <Loader2 className="w-3 h-3 animate-spin" />
      {text}
      <span className="stat-num">{num}</span>
    </span>
  );
}
