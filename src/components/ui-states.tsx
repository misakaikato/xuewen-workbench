// 统一页面状态组件（DESIGN.md §8）：加载 / 空 / 错误三态，替代裸文字"加载中…""暂无数据"
import type { ReactNode } from 'react';
import { Loader2, Inbox, AlertCircle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';

/** 页面骨架：懒加载 chunk 就位前的 Suspense fallback（无文字，纯骨架） */
export function PageSkeleton() {
  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6" role="status" aria-label="加载中">
      <Skeleton className="h-7 w-44" />
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-2/3" />
      </div>
    </div>
  );
}

/** 页面级加载态：spin + 一句人话；给了 slowText 时，加载超过 slowAfterMs 换成它（说明为什么慢） */
export function PageLoading({
  text = '加载中…',
  slowText,
  slowAfterMs = 1500,
}: {
  text?: string;
  slowText?: string;
  slowAfterMs?: number;
}) {
  const slow = useDelayedFlag(!!slowText, slowAfterMs);
  return (
    <div className="py-20 flex flex-col items-center gap-3 text-sm text-muted-foreground" role="status">
      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground/70" />
      {slow ? slowText : text}
    </div>
  );
}

/** 行内加载态（面板/区块内） */
export function InlineLoading({ text = '加载中…' }: { text?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground" role="status">
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
      {text}
    </div>
  );
}

/** 空状态：图标 + 标题 + 可选提示与动作 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  compact = false,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'py-6 gap-1.5' : 'py-16 gap-2'}`}>
      <span className="text-muted-foreground/60">{icon ?? <Inbox className={compact ? 'w-5 h-5' : 'w-8 h-8'} />}</span>
      <div className={compact ? 'text-xs text-muted-foreground' : 'text-sm text-muted-foreground'}>{title}</div>
      {hint && <div className="text-xs text-muted-foreground/70 max-w-sm">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** 页面级错误态：图标 + 标题 + 明细 + 动作区 */
export function PageError({ title, detail, children }: { title: string; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="max-w-xl mx-auto py-16 px-4 text-center">
      <AlertCircle className="w-10 h-10 mx-auto text-warning mb-3" />
      <h1 className="text-lg font-semibold mb-2">{title}</h1>
      {detail && <div className="text-sm text-muted-foreground mb-6 space-y-1">{detail}</div>}
      {children && <div className="flex gap-2 justify-center">{children}</div>}
    </div>
  );
}
