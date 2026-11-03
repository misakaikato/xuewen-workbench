// 破坏性工具确认弹窗（三个对话界面共用）：倒计时与后端 30s 超时一致，
// 超时自动拒绝并提示；弹窗被卸载（如关闭浮层）视同拒绝，不留悬空的确认。
// 浮层投影用 --wb-pvshadow，进出场走 usePresence（DESIGN.md §6/§7）。
import { useEffect, useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { notify } from '@/lib/notify';
import { usePresence } from '@/lib/presence';
import { useNow } from '@/hooks/useNow';
import { CONFIRM_TIMEOUT_MS, type PendingConfirm } from '@/lib/agentReducer';

export function ConfirmToolDialog({
  req,
  onResolve,
}: {
  req: PendingConfirm | null;
  onResolve: (req: PendingConfirm, approved: boolean) => void;
}) {
  const { mounted, state } = usePresence(!!req);
  // 离场动画期间保留最后一个请求用于渲染（对账写法与 useDelayedFlag 一致）
  const [prev, setPrev] = useState<PendingConfirm | null>(null);
  const [shown, setShown] = useState<PendingConfirm | null>(null);
  if (req !== prev) {
    setPrev(req);
    if (req) setShown(req);
  }
  const settledRef = useRef(false);
  const shownRef = useRef<PendingConfirm | null>(null);
  const resolveRef = useRef(onResolve);
  useEffect(() => {
    shownRef.current = shown;
    resolveRef.current = onResolve;
  });
  const now = useNow(!!req, 250);
  // 每个新请求重置应答状态
  useEffect(() => { settledRef.current = false; }, [req?.id]);
  // 卸载视同拒绝（浮层被关闭等情况）
  useEffect(() => () => {
    if (!settledRef.current && shownRef.current) resolveRef.current(shownRef.current, false);
  }, []);

  const cur = shown;
  const remaining = cur ? (now ? Math.max(0, Math.ceil((cur.deadline - now) / 1000)) : Math.ceil(CONFIRM_TIMEOUT_MS / 1000)) : 0;
  // 超时：自动拒绝，提示「已超时，操作被拒绝」
  useEffect(() => {
    if (!req || remaining > 0 || settledRef.current || !now) return;
    settledRef.current = true;
    notify('确认已超时，操作被拒绝', { kind: 'error' });
    resolveRef.current(shownRef.current ?? req, false);
  }, [req, remaining, now]);
  if (!mounted || !cur) return null;
  const settle = (ok: boolean) => {
    if (settledRef.current || !req) return; // 已超时/离场中：按钮无效
    settledRef.current = true;
    resolveRef.current(cur, ok);
  };
  return (
    <div
      data-state={state}
      className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4 duration-slow ease-signature data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out"
      onClick={() => settle(false)}
    >
      <div
        data-confirm-dialog
        className="bg-card border border-warning/50 rounded-2xl shadow-[var(--wb-pvshadow)] p-5 w-96 max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold flex items-center gap-2 mb-2">
          <ShieldAlert className="w-4 h-4 text-warning" />
          确认执行：{cur.tool}
        </h3>
        <pre className="text-xs bg-muted rounded-lg p-2.5 max-h-40 overflow-auto mb-3">{JSON.stringify(cur.args, null, 2)}</pre>
        <div className="flex items-center gap-2 justify-end">
          <span className="mr-auto text-xs text-muted-foreground tabular-nums" data-confirm-countdown>
            {remaining}s 后自动拒绝
          </span>
          <Button variant="outline" size="sm" disabled={!req} onClick={() => settle(false)}>拒绝</Button>
          <Button size="sm" disabled={!req} onClick={() => settle(true)}>确认执行</Button>
        </div>
      </div>
    </div>
  );
}
