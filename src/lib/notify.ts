// 全局 toast 的单一真相源：模块内订阅表，不引入依赖。
// Toaster（src/components/Toaster.tsx）订阅渲染；node 侧可直接驱动订阅表做测试。
export type ToastKind = 'info' | 'success' | 'error';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  text: string;
  kind: ToastKind;
  action: ToastAction | null;
  durationMs: number; // 0 = 常驻，直到手动关闭
}

interface ToastEntry {
  toast: Toast;
  timer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, ToastEntry>(); // 插入序即显示序
const listeners = new Set<(toasts: Toast[]) => void>();
let seq = 1;

function snapshot(): Toast[] {
  return [...entries.values()].map((e) => e.toast);
}

function emit(): void {
  const list = snapshot();
  for (const fn of listeners) fn(list);
}

export function subscribeToasts(fn: (toasts: Toast[]) => void): () => void {
  listeners.add(fn);
  fn(snapshot());
  return () => {
    listeners.delete(fn);
  };
}

export function notify(
  text: string,
  opts?: { kind?: ToastKind; action?: ToastAction; durationMs?: number; id?: string }
): string {
  const kind = opts?.kind ?? 'info';
  const durationMs = opts?.durationMs ?? (kind === 'error' ? 8000 : 5000);
  const id = opts?.id ?? `t-${Date.now().toString(36)}-${seq++}`;
  const prev = entries.get(id);
  if (prev?.timer) clearTimeout(prev.timer); // 同 id：更新内容并重置计时，不堆叠
  const timer = durationMs > 0 ? setTimeout(() => dismissToast(id), durationMs) : null;
  entries.set(id, { toast: { id, text, kind, action: opts?.action ?? null, durationMs }, timer });
  emit();
  return id;
}

export function dismissToast(id: string): void {
  const e = entries.get(id);
  if (!e) return;
  if (e.timer) clearTimeout(e.timer);
  entries.delete(id);
  emit();
}
