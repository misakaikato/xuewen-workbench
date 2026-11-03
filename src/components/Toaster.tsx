// 全局 toast 渲染：右下角，最多同时 3 条；数据全部来自 src/lib/notify.ts 的订阅表。
// 已 dismiss 的条目保留到离场动画播完（usePresence），时长/缓动只用 token（DESIGN.md §7）。
// 进行中的条目（busy）带转圈，持续超过 slowAfterMs 后在正文下追加次要文字。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { subscribeToasts, dismissToast, type Toast } from '@/lib/notify';
import { usePresence } from '@/lib/presence';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { cn } from '@/lib/utils';

const MAX_VISIBLE = 3;

function ToastItem({ toast, open, onExited }: { toast: Toast; open: boolean; onExited: (id: string) => void }) {
  const { mounted, state } = usePresence(open);
  const slow = useDelayedFlag(!!toast.busy?.slowText, toast.busy?.slowAfterMs ?? 0);
  useEffect(() => {
    if (!open && !mounted) onExited(toast.id);
  }, [open, mounted, onExited, toast.id]);
  if (!mounted) return null;
  return (
    <div
      data-state={state}
      role={toast.kind === 'error' ? 'alert' : undefined}
      aria-busy={toast.busy ? true : undefined}
      data-toast-kind={toast.kind}
      className={cn(
        'pointer-events-auto flex items-center gap-2 rounded-lg border bg-card px-4 py-2.5 text-sm shadow-[var(--wb-pvshadow)]',
        'duration-med ease-signature',
        'data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:slide-in-from-bottom-2',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:slide-out-to-bottom-2',
        toast.kind === 'error' ? 'border-destructive/50' : 'border-border'
      )}
    >
      {toast.busy && <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-muted-foreground" />}
      <span className="min-w-0">
        {toast.text}
        {slow && toast.busy?.slowText && <span className="block text-xs text-muted-foreground">{toast.busy.slowText}</span>}
      </span>
      {toast.action && (
        <button
          className="shrink-0 text-xs text-primary underline underline-offset-4"
          onClick={() => {
            toast.action?.run();
            dismissToast(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        aria-label="关闭"
        onClick={() => dismissToast(toast.id)}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export function Toaster() {
  const [live, setLive] = useState<Toast[]>([]);
  const [exiting, setExiting] = useState<Toast[]>([]);
  const liveRef = useRef<Toast[]>([]);
  useEffect(
    () =>
      subscribeToasts((list) => {
        const gone = liveRef.current.filter((t) => !list.some((x) => x.id === t.id));
        liveRef.current = list;
        setLive(list);
        if (gone.length) setExiting((ex) => [...ex, ...gone.filter((g) => !ex.some((e) => e.id === g.id))]);
      }),
    []
  );
  const removeExiting = useCallback((id: string) => setExiting((ex) => ex.filter((t) => t.id !== id)), []);
  const liveIds = new Set(live.map((t) => t.id));
  const shown = [...live.slice(-MAX_VISIBLE), ...exiting.filter((t) => !liveIds.has(t.id))];
  if (!shown.length) return null;
  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 pointer-events-none"
      role="status"
      aria-live="polite"
    >
      {shown.map((t) => (
        <ToastItem key={t.id} toast={t} open={liveIds.has(t.id)} onExited={removeExiting} />
      ))}
    </div>
  );
}
