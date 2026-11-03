// 助手一轮生成的 React 容器：applyAgentEvent（src/lib/agentReducer.ts）的封装。
// 三个对话界面共用：consume() 返回最新轮次状态供界面同步进消息，
// activity / confirmReq 直接渲染（AgentActivity / ConfirmToolDialog）。
import { useCallback, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import type { AgentStreamEvent } from '@/lib/agentStream';
import {
  applyAgentEvent, initialAgentTurn, resolveConfirm, settleAgentTurn,
  type AgentActivity, type AgentTurnState, type PendingConfirm, type SettleReason,
} from '@/lib/agentReducer';

export function useAgentTurn() {
  const ref = useRef<AgentTurnState>(initialAgentTurn());
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  const [confirmReq, setConfirmReq] = useState<PendingConfirm | null>(null);

  // 发送即进入 connecting（含「重新生成」：点击即调用）
  const begin = useCallback(() => {
    ref.current = initialAgentTurn();
    setActivity(ref.current.activity);
    setConfirmReq(null);
  }, []);

  const consume = useCallback((ev: AgentStreamEvent): AgentTurnState => {
    ref.current = applyAgentEvent(ref.current, ev);
    setActivity(ref.current.activity);
    if (ref.current.pendingConfirm) setConfirmReq(ref.current.pendingConfirm);
    return ref.current;
  }, []);

  const settle = useCallback((reason: SettleReason): AgentTurnState => {
    ref.current = settleAgentTurn(ref.current, reason);
    setActivity(null);
    return ref.current;
  }, []);

  // 确认弹窗的唯一应答路径：确认/拒绝/超时/弹窗被关闭都走这里
  const answer = useCallback((req: PendingConfirm, approved: boolean) => {
    setConfirmReq((cur) => (cur && cur.id === req.id ? null : cur));
    if (ref.current.pendingConfirm?.id === req.id) {
      ref.current = resolveConfirm(ref.current);
      setActivity(ref.current.activity);
    }
    api.agentConfirm(req.id, approved).catch((e) => {
      notify('确认结果发送失败：' + (e as Error).message, { kind: 'error' });
    });
  }, []);

  return { activity, confirmReq, begin, consume, settle, answer };
}
