// 助手 SSE 事件 → 一轮生成状态的唯一处理逻辑（反馈第 3 批，三个对话界面共用）。
// 纯函数，不碰 React/DOM；界面特有副作用（open_doc 跳转、settings_changed 应用）
// 不进这里，由各界面在 consume 调用点自行处理。steered 等无界面状态的事件原样忽略。
import type { AgentFailure } from './api';
import type { AgentStreamEvent } from './agentStream';

export interface AgentToolItem {
  callId?: string;
  name: string;
  args?: unknown;
  summary?: string;
  isError?: boolean;
  durationMs?: number;
  running?: boolean; // 运行中：转圈 + 实时计时
  startedAt?: number; // 运行开始时间（ms）
  interrupted?: boolean; // 流中断/停止时仍在运行 → 标记中断，不能一直转圈
}

export type AgentActivity =
  | { kind: 'connecting'; startedAt: number } // 已发送，还没收到任何事件
  | { kind: 'thinking'; startedAt: number } // 收到 start/thinking，还没有正文（含工具间隙）
  | { kind: 'tool'; name: string; startedAt: number }
  | { kind: 'compacting'; startedAt: number }
  | { kind: 'confirm'; tool: string; startedAt: number }
  | { kind: 'generating'; startedAt: number };

export interface PendingConfirm {
  id: string;
  tool: string;
  args: unknown;
  deadline: number; // 到点后端自动拒绝（manager.js _confirm 的 30s）
}

export interface AgentCompaction {
  reason: string;
  tokensBefore: number | null;
  tokensAfter: number | null;
  aborted: boolean;
  error: string | null;
  at: string;
}

export interface AgentTurnState {
  text: string;
  thinking: string;
  tools: AgentToolItem[];
  failure: AgentFailure | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  compactions: AgentCompaction[];
  activity: AgentActivity | null;
  pendingConfirm: PendingConfirm | null;
}

// 与后端确认超时时长一致（server/agent/manager.js _confirm，30s）
export const CONFIRM_TIMEOUT_MS = 30000;

export type SettleReason = 'finished' | 'stopped' | 'disconnected';

export function initialAgentTurn(now = Date.now()): AgentTurnState {
  return {
    text: '', thinking: '', tools: [], failure: null, usage: null, compactions: [],
    activity: { kind: 'connecting', startedAt: now }, pendingConfirm: null,
  };
}

// 工具间隙/压缩结束/确认应答后的回落态：模型还在跑，只是没有正事件
const idle = (now: number): AgentActivity => ({ kind: 'thinking', startedAt: now });

// 打断还在运行的工具：流结束/中断/出错时不能留下一直转圈的工具卡
const interruptRunning = (tools: AgentToolItem[]): AgentToolItem[] =>
  tools.map((t) => (t.running ? { ...t, running: false, interrupted: true } : t));

export function applyAgentEvent(s: AgentTurnState, ev: AgentStreamEvent, now = Date.now()): AgentTurnState {
  switch (ev.t) {
    case 'open':
    case 'start':
      return { ...s, activity: idle(now) };
    case 'delta': {
      const keep = s.activity && ['tool', 'confirm', 'compacting'].includes(s.activity.kind);
      return { ...s, text: s.text + String(ev.v ?? ''), activity: keep ? s.activity : { kind: 'generating', startedAt: now } };
    }
    case 'thinking': {
      const keep = s.activity && ['tool', 'confirm', 'compacting', 'generating'].includes(s.activity.kind);
      return { ...s, thinking: s.thinking + String(ev.v ?? ''), activity: keep ? s.activity : idle(now) };
    }
    case 'usage':
      return { ...s, usage: (ev.usage as AgentTurnState['usage']) ?? s.usage };
    case 'tool_start': {
      const tool: AgentToolItem = {
        callId: ev.callId ? String(ev.callId) : undefined,
        name: String(ev.name || ''), args: ev.args, running: true, startedAt: now,
      };
      return { ...s, tools: [...s.tools, tool], activity: { kind: 'tool', name: tool.name, startedAt: now } };
    }
    case 'tool_end': {
      const tools = s.tools.slice();
      // 配对：优先 callId；否则取最早一个仍在运行的同名项（同名并发/连续调用不错位）
      let i = ev.callId ? tools.findIndex((t) => t.running && t.callId === ev.callId) : -1;
      if (i < 0) i = tools.findIndex((t) => t.running && t.name === ev.name);
      if (i >= 0) {
        tools[i] = {
          ...tools[i], running: false,
          summary: String(ev.summary ?? ''), isError: !!ev.isError,
          durationMs: typeof ev.durationMs === 'number' ? ev.durationMs : now - (tools[i].startedAt ?? now),
        };
      }
      const next = tools.find((t) => t.running);
      return {
        ...s, tools,
        activity: next ? { kind: 'tool', name: next.name, startedAt: next.startedAt ?? now } : idle(now),
      };
    }
    case 'compaction':
      if (ev.phase === 'start') return { ...s, activity: { kind: 'compacting', startedAt: now } };
      return {
        ...s,
        compactions: [...s.compactions, {
          reason: String(ev.reason || ''),
          tokensBefore: (ev.tokensBefore as number | null) ?? null,
          tokensAfter: (ev.tokensAfter as number | null) ?? null,
          aborted: !!ev.aborted, error: null, at: new Date(now).toISOString(),
        }],
        activity: idle(now),
      };
    case 'confirm': {
      const tool = String(ev.tool || '');
      return {
        ...s,
        pendingConfirm: { id: String(ev.id || ''), tool, args: ev.args, deadline: now + CONFIRM_TIMEOUT_MS },
        activity: { kind: 'confirm', tool, startedAt: now },
      };
    }
    case 'error': {
      const failure = (ev.failure as AgentFailure) || {
        kind: 'model', title: '模型未能完成回答',
        message: String(ev.message || '模型或端点返回错误，请检查 Agent 设置后重试。'),
      };
      return { ...s, failure, activity: null, tools: interruptRunning(s.tools) };
    }
    case 'done':
      return { ...s, activity: null };
    default:
      return s; // open_doc / settings_changed / steered 等由界面处理或无需状态
  }
}

// 用户点了确认/拒绝（或弹窗超时、被关闭）：清掉待确认，活动态回落
export function resolveConfirm(s: AgentTurnState, now = Date.now()): AgentTurnState {
  return {
    ...s,
    pendingConfirm: null,
    activity: s.activity?.kind === 'confirm' ? idle(now) : s.activity,
  };
}

// 流收尾：活动态清零；非正常运行中工具标记中断
export function settleAgentTurn(s: AgentTurnState, reason: SettleReason): AgentTurnState {
  return {
    ...s,
    activity: null,
    tools: reason === 'finished' ? s.tools : interruptRunning(s.tools),
  };
}
