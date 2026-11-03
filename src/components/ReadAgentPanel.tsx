// 阅读页内嵌 AI 面板：不离开文档就能问 AI，自动带上当前文档上下文
// 复用主 agent 的会话（当前库最近一次对话），保证上下文连续
// 事件处理走共用逻辑（src/lib/agentReducer.ts + useAgentTurn），只保留 open_doc 跳转这一界面特有分支
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, X, AlertCircle } from 'lucide-react';
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
import { ChatInput } from '@/components/agent/ChatInput';
import { type Block, initialBlocks, blocksToPrompt, hasUserText, appendQuote } from '@/components/agent/blocks';
import { ContextBar } from '@/components/agent/Extras';

interface Msg extends AgentMessage { streaming?: boolean }

export function ReadAgentPanel({
  docPath,
  docName,
  pendingQuote,
  onQuoteConsumed,
  onClose,
  onOpenDoc,
}: {
  docPath: string;
  docName: string;
  /** 从阅读页选区带来的引用（消费后回调清空） */
  pendingQuote: string | null;
  onQuoteConsumed: () => void;
  onClose: () => void;
  onOpenDoc: (path: string, term?: string) => void;
}) {
  const [convId, setConvId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [blocks, setBlocks] = useState<Block[]>(initialBlocks());
  const [images, setImages] = useState<{ data: string; mimeType: string; name: string }[]>([]);
  const [usage, setUsage] = useState<AgentMessage['usage'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const showLoading = useDelayedFlag(loading);
  const turn = useAgentTurn();
  const aiRef = useRef(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 卸载时中断流式 fetch（切换文档/关面板不残留连接与补丁）
  useEffect(() => () => abortRef.current?.abort(), []);

  // 打开面板：取当前库最近一次对话（没有就新建），保证与主界面上下文连续
  useEffect(() => {
    let dead = false;
    setLoading(true);
    (async () => {
      try {
        const st = await api.agentStatus();
        const recent = st.conversations?.[0];
        if (recent) {
          if (dead) return;
          setConvId(recent.id);
          const s = await api.agentSession(recent.id);
          if (!dead) setMsgs(s.messages || []);
        } else {
          const c = await api.agentNewSession();
          if (!dead) setConvId(c.id);
        }
      } catch (e) {
        if (!dead) setErr((e as Error).message);
      } finally {
        if (!dead) setLoading(false);
      }
    })();
    return () => { dead = true; };
  }, []);

  // 消费从阅读页带来的引用（作为引用 chip 进入输入框）
  useEffect(() => {
    if (!pendingQuote) return;
    setBlocks((prev) => appendQuote(prev, pendingQuote, '阅读页引用'));
    onQuoteConsumed();
  }, [pendingQuote, onQuoteConsumed]);

  const scroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(scroll, [msgs, scroll]);

  const send = async () => {
    let body = blocksToPrompt(blocks);
    if (body && !hasUserText(blocks)) body += '\n\n请基于以上引用的内容回答。';
    if ((!body && !images.length) || !convId) return;
    const pending = images;

    setBlocks(initialBlocks());
    setImages([]);
    setBusy(true);
    setErr(null);
    turn.begin();
    setMsgs((m) => {
      const next = [...m, { role: 'user' as const, text: body }, { role: 'assistant' as const, text: '', tools: [], streaming: true, thinking: '' }];
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
        body: JSON.stringify({ sessionId: convId, text: body, images: pending.length ? pending.map((im) => ({ data: im.data, mimeType: im.mimeType })) : undefined, docContext: { path: docPath, name: docName } }),
        signal: ctl.signal,
      });
      const fallback = await readAgentStream(resp, (d) => {
        // 界面特有分支：open_doc 交给阅读页自己跳转
        if (d.t === 'open_doc') { onOpenDoc(String(d.path || ''), d.term ? String(d.term) : undefined); return; }
        const t = turn.consume(d);
        sync(t);
        if (t.usage) setUsage(t.usage);
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
  };

  const stop = () => { abortRef.current?.abort(); if (convId) api.agentAbort(convId).catch(() => {}); };

  return (
    <div className="h-full w-full min-w-0 flex flex-col bg-card border-l border-border">
      {/* 头部 */}
      <div className="shrink-0 px-3 py-2 border-b border-border flex items-center gap-2 min-w-0">
        <Sparkles className="w-3.5 h-3.5 text-primary shrink-0" />
        <span className="text-xs font-medium shrink-0">AI 助手</span>
        <span className="text-[10px] text-muted-foreground truncate min-w-0 flex-1" title={docPath}>· {docName}</span>
        <button className="ml-auto p-1 rounded hover:bg-accent text-muted-foreground" onClick={onClose} title="关闭">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 消息 */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-3 py-3 space-y-3">
        {err && <div className="text-xs text-destructive">{err}</div>}
        {showLoading && <InlineLoading text="正在打开对话…" />}
        {!msgs.length && !err && !showLoading && (
          <div className="text-xs text-muted-foreground leading-relaxed">
            可以就这篇文档提问。选中正文后点「问 AI」会把内容带进来。
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
            {m.role === 'user' ? (
              <div className="max-w-[90%] rounded-xl rounded-br-sm px-3 py-2 text-xs whitespace-pre-wrap break-words bg-primary text-primary-foreground">
                {m.text}
              </div>
            ) : (
              <div>
                {m.thinking && <ThinkingBlock text={m.thinking} streaming={m.streaming && !m.text} />}
                {(m.tools || []).map((t, j) => <ToolCard key={j} t={t} />)}
                {m.text && <div className="text-xs"><MarkdownMsg text={m.text} /></div>}
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

      {/* 输入区：完整 ChatInput（引用 chip / 附件 / @文件 / 命令） */}
      <div className="shrink-0 border-t border-border p-2 min-w-0">
        {usage && <div className="mb-1.5"><ContextBar usage={usage} contextWindow={128000} /></div>}
        <ChatInput
          blocks={blocks}
          onBlocksChange={setBlocks}
          onSend={() => void send()}
          onStop={stop}
          busy={busy}
          disabled={!convId}
          placeholder="就这篇文档提问…"
          onCommand={(cmd) => {
            if (cmd === '/clear') {
              api.agentNewSession().then((c) => { setConvId(c.id); setMsgs([]); }).catch(() => {});
            }
          }}
          images={images}
          onImagesChange={setImages}
        />
      </div>
      {/* 确认弹窗：关面板（本组件卸载）时由弹窗兜底拒绝 */}
      <ConfirmToolDialog req={turn.confirmReq} onResolve={turn.answer} />
    </div>
  );
}
