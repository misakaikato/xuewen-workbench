// 阅读页内嵌 AI 面板：不离开文档就能问 AI，自动带上当前文档上下文
// 复用主 agent 的会话（当前库最近一次对话），保证上下文连续
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { AgentMessage } from '@/lib/api';
import { MarkdownMsg } from '@/components/agent/MarkdownMsg';
import { ToolCard, type ToolItem } from '@/components/agent/ToolCard';
import { readAgentStream } from '@/lib/agentStream';
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
  const aiRef = useRef(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 打开面板：取当前库最近一次对话（没有就新建），保证与主界面上下文连续
  useEffect(() => {
    let dead = false;
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
    setMsgs((m) => {
      const next = [...m, { role: 'user' as const, text: body }, { role: 'assistant' as const, text: '', tools: [], streaming: true }];
      aiRef.current = next.length - 1;
      return next;
    });
    const patch = (fn: (msg: Msg) => Msg) =>
      setMsgs((m) => { const n = [...m]; const i = aiRef.current; if (i >= 0 && n[i]) n[i] = fn(n[i]); return n; });

    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const resp = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: convId, text: body, images: pending.length ? pending.map((im) => ({ data: im.data, mimeType: im.mimeType })) : undefined }),
        signal: ctl.signal,
      });
      await readAgentStream(resp, (d) => {
        if (d.t === 'delta') patch((msg) => ({ ...msg, text: msg.text + String(d.v || '') }));
        else if (d.t === 'usage') setUsage(d.usage as AgentMessage['usage']);
        else if (d.t === 'thinking') patch((msg) => ({ ...msg, thinking: (msg.thinking || '') + String(d.v || '') }));
        else if (d.t === 'tool_start') patch((msg) => ({ ...msg, tools: [...(msg.tools || []), { name: String(d.name || ''), args: d.args, durationMs: 0 }] }));
        else if (d.t === 'tool_end') patch((msg) => ({ ...msg, tools: (msg.tools || []).map((t) => ((t as ToolItem).name === d.name && !(t as ToolItem).summary ? { ...t, summary: String(d.summary || ''), isError: !!d.isError, durationMs: d.durationMs as number } : t)) }));
        else if (d.t === 'open_doc') onOpenDoc(String(d.path || ''), d.term ? String(d.term) : undefined);
        else if (d.t === 'error') patch((msg) => ({ ...msg, text: msg.text + `\n\n**错误**：${d.message}`, error: true }));
      });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') patch((msg) => ({ ...msg, text: msg.text + `\n\n**连接失败**：${(e as Error).message}`, error: true }));
    } finally {
      patch((msg) => ({ ...msg, streaming: false }));
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
        {!msgs.length && !err && (
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
                {(m.tools || []).map((t, j) => <ToolCard key={j} t={t as ToolItem} />)}
                {m.text
                  ? <div className="text-xs"><MarkdownMsg text={m.text} /></div>
                  : m.streaming && <div className="flex items-center gap-1.5 py-1">
                      <span className="w-1 h-1 rounded-full bg-primary animate-pulse" />
                      <span className="w-1 h-1 rounded-full bg-primary animate-pulse [animation-delay:200ms]" />
                      <span className="w-1 h-1 rounded-full bg-primary animate-pulse [animation-delay:400ms]" />
                    </div>}
              </div>
            )}
          </div>
        ))}
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
    </div>
  );
}
