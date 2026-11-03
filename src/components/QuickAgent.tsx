// 全局浮层助手：任意页面 ⌘J 唤出，不离开当前页面即可提问
// 复用当前库最近一次对话（与主界面/阅读页面板上下文连续）
// 事件处理走共用逻辑（src/lib/agentReducer.ts + useAgentTurn），只保留 open_doc 跳转这一界面特有分支
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Sparkles, Send, X, Square, ChevronRight, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import type { AgentMessage } from '@/lib/api';
import { MarkdownMsg } from '@/components/agent/MarkdownMsg';
import { ToolCard } from '@/components/agent/ToolCard';
import { ThinkingBlock } from '@/components/agent/Extras';
import { AgentActivity } from '@/components/agent/AgentActivity';
import { ConfirmToolDialog } from '@/components/agent/ConfirmToolDialog';
import { InlineLoading } from '@/components/ui-states';
import { readAgentStream, streamFailure } from '@/lib/agentStream';
import type { AgentTurnState, SettleReason } from '@/lib/agentReducer';
import { useAgentTurn } from '@/hooks/useAgentTurn';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';

interface Msg extends AgentMessage { streaming?: boolean }
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export function QuickAgent({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  // 当前若在阅读页，把文档路径/名字作为上下文带给 Agent
  const docContext = useMemo(() => {
    const m2 = /^\/read\/(.+)$/.exec(location.pathname);
    if (!m2) return null;
    const path = m2[1].split('/').map(decodeURIComponent).join('/');
    return { path, name: path.split('/').pop() || path };
  }, [location.pathname]);
  const [convId, setConvId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [models, setModels] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const showLoading = useDelayedFlag(loading);
  const turn = useAgentTurn();
  const aiRef = useRef(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 打开：加载当前库最近对话；聚焦输入框
  useEffect(() => {
    if (!open) return;
    let dead = false;
    setErr(null);
    setLoading(true);
    (async () => {
      try {
        const st = await api.agentStatus();
        setModels(st.endpoint?.model || '');
        if (!st.endpoint?.ready) { setErr('生成端点未配置（去设置面板配置）'); return; }
        const recent = st.conversations?.[0];
        if (recent) {
          if (dead) return;
          setConvId(recent.id);
          const s = await api.agentSession(recent.id);
          if (!dead) setMsgs(s.messages || []);
        } else {
          const c = await api.agentNewSession();
          if (!dead) { setConvId(c.id); setMsgs([]); }
        }
      } catch (e) {
        if (!dead) setErr((e as Error).message);
      } finally {
        if (!dead) setLoading(false);
      }
    })();
    setTimeout(() => inputRef.current?.focus(), 60);
    return () => { dead = true; };
  }, [open]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !convId || busy) return;
    setInput('');
    setBusy(true);
    turn.begin();
    setMsgs((m) => {
      const next = [...m, { role: 'user' as const, text }, { role: 'assistant' as const, text: '', tools: [], streaming: true, thinking: '' }];
      aiRef.current = next.length - 1;
      return next;
    });
    const patch = (fn: (msg: Msg) => Msg) =>
      setMsgs((m) => { const n = [...m]; const i = aiRef.current; if (i >= 0 && n[i]) n[i] = fn(n[i]); return n; });
    // 共用事件处理：轮次状态同步进当前助手消息
    const sync = (t: AgentTurnState) => patch((msg) => ({
      ...msg, text: t.text, thinking: t.thinking, tools: t.tools,
      compactions: t.compactions, failure: t.failure ?? msg.failure,
    }));

    const ctl = new AbortController();
    abortRef.current = ctl;
    let outcome: SettleReason = 'finished';
    try {
      const resp = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: convId, text, docContext }),
        signal: ctl.signal,
      });
      const fallback = await readAgentStream(resp, (d) => {
        // 界面特有分支：open_doc 关浮层再跳阅读页
        if (d.t === 'open_doc') {
          const p = String(d.path || '');
          const term = d.term ? String(d.term) : '';
          onClose();
          navigate('/read/' + encPath(p) + (term ? '?h=' + encodeURIComponent(term) : ''));
          return;
        }
        sync(turn.consume(d));
      });
      if (fallback) { outcome = 'disconnected'; sync(turn.consume({ t: 'error', failure: fallback })); }
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      outcome = aborted ? 'stopped' : 'disconnected';
      sync(turn.consume({ t: 'error', failure: aborted ? streamFailure('cancelled') : streamFailure('connection', (e as Error).message) }));
    } finally {
      const t = turn.settle(outcome);
      patch((msg) => ({ ...msg, streaming: false, tools: t.tools }));
      setBusy(false);
      abortRef.current = null;
    }
  }, [input, convId, busy, navigate, onClose, docContext, turn]);

  const stop = () => { abortRef.current?.abort(); if (convId) api.agentAbort(convId).catch(() => {}); };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] bg-black/30 flex items-start justify-center pt-[10vh] px-4" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-2xl shadow-[var(--wb-pvshadow)] w-[640px] max-w-[94vw] h-[520px] max-h-[76vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="shrink-0 px-4 py-2.5 border-b border-border flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium">智能助手</span>
          {models && <span className="text-[11px] text-muted-foreground font-mono">{models}</span>}
          <span className="flex-1" />
          <button
            className="text-[11px] text-muted-foreground hover:text-primary flex items-center gap-0.5 px-1.5 py-1 rounded hover:bg-accent"
            onClick={() => { onClose(); navigate('/agent'); }}
            title="打开完整对话页"
          >
            完整界面<ChevronRight className="w-3 h-3" />
          </button>
          <button className="p-1 rounded hover:bg-accent text-muted-foreground" onClick={onClose}><X className="w-4 h-4" /></button>
        </div>

        {/* 消息 */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-3">
          {err && <div className="text-xs text-destructive">{err}</div>}
          {showLoading && <InlineLoading text="正在打开对话…" />}
          {!msgs.length && !err && !showLoading && (
            <div className="text-xs text-muted-foreground leading-relaxed">
              可以问语料、改设置、整理文件。<br />
              例：「这套语料讲了什么」「把主题换成夜读」「把第 3 章移到新文件夹」
            </div>
          )}
          {msgs.slice(-12).map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
              {m.role === 'user' ? (
                <div className="max-w-[85%] rounded-xl rounded-br-sm px-3 py-2 text-xs whitespace-pre-wrap break-words bg-primary text-primary-foreground">
                  {m.text}
                </div>
              ) : (
                <div>
                  {m.thinking && <ThinkingBlock text={m.thinking} streaming={m.streaming && !m.text} />}
                  {(m.tools || []).map((t, j) => <ToolCard key={j} t={t} />)}
                  {m.text && <div className="text-xs"><MarkdownMsg text={m.text} /></div>}
                  {m.interrupted && <div className="mt-0.5 text-[11px] text-muted-foreground">（已中断）</div>}
                  {m.failure && (
                    <div role={m.failure.kind === 'cancelled' ? 'status' : 'alert'} data-agent-failure
                      className="my-1.5 rounded-lg border border-warning/40 bg-warning-soft p-2.5 text-xs text-warning-foreground">
                      <div className="flex items-center gap-1.5 font-medium"><AlertCircle className="w-3.5 h-3.5 shrink-0" />{m.failure.title}</div>
                      <p className="mt-0.5 leading-relaxed">{m.failure.message}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {/* 活动指示：连接/思考/工具/压缩/确认/生成全程可见 */}
          <AgentActivity activity={turn.activity} />
        </div>

        {/* 输入 */}
        <div className="shrink-0 p-3 border-t border-border">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  if ((e.nativeEvent as KeyboardEvent).isComposing) return;
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder="问点什么…（Enter 发送，Esc 关闭）"
              className="flex-1 resize-none px-3 py-2 rounded-lg border border-input bg-background text-sm"
            />
            {busy ? (
              <button className="p-2 rounded-lg border border-border hover:bg-accent" onClick={stop} title="停止">
                <Square className="w-4 h-4" />
              </button>
            ) : (
              <button className="p-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-40" disabled={!input.trim()} onClick={() => void send()} title="发送">
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
      {/* 确认弹窗：关闭浮层（本组件卸载）时由弹窗兜底拒绝 */}
      <ConfirmToolDialog req={turn.confirmReq} onResolve={turn.answer} />
    </div>
  );
}
