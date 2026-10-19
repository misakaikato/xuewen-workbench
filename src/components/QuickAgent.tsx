// 全局浮层助手：任意页面 ⌘J 唤出，不离开当前页面即可提问
// 复用当前库最近一次对话（与主界面/阅读页面板上下文连续）
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Send, X, Loader2, Square, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import type { AgentMessage } from '@/lib/api';
import { MarkdownMsg } from '@/components/agent/MarkdownMsg';
import { ToolCard, type ToolItem } from '@/components/agent/ToolCard';
import { readAgentStream } from '@/lib/agentStream';

interface Msg extends AgentMessage { streaming?: boolean }
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export function QuickAgent({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [convId, setConvId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [models, setModels] = useState<string>('');
  const aiRef = useRef(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 打开：加载当前库最近对话；聚焦输入框
  useEffect(() => {
    if (!open) return;
    let dead = false;
    setErr(null);
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
    setMsgs((m) => {
      const next = [...m, { role: 'user' as const, text }, { role: 'assistant' as const, text: '', tools: [], streaming: true }];
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
        body: JSON.stringify({ sessionId: convId, text }),
        signal: ctl.signal,
      });
      await readAgentStream(resp, (d) => {
        if (d.t === 'delta') patch((msg) => ({ ...msg, text: msg.text + String(d.v || '') }));
        else if (d.t === 'thinking') patch((msg) => ({ ...msg, thinking: (msg.thinking || '') + String(d.v || '') }));
        else if (d.t === 'tool_start') patch((msg) => ({ ...msg, tools: [...(msg.tools || []), { name: String(d.name || ''), args: d.args, durationMs: 0 }] }));
        else if (d.t === 'tool_end') patch((msg) => ({ ...msg, tools: (msg.tools || []).map((t) => ((t as ToolItem).name === d.name && !(t as ToolItem).summary ? { ...t, summary: String(d.summary || ''), isError: !!d.isError, durationMs: d.durationMs as number } : t)) }));
        else if (d.t === 'open_doc') {
          const p = String(d.path || '');
          const term = d.term ? String(d.term) : '';
          onClose();
          navigate('/read/' + encPath(p) + (term ? '?h=' + encodeURIComponent(term) : ''));
        } else if (d.t === 'error') patch((msg) => ({ ...msg, text: msg.text + `\n\n**错误**：${d.message}`, error: true }));
      });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') patch((msg) => ({ ...msg, text: msg.text + `\n\n**连接失败**：${(e as Error).message}`, error: true }));
    } finally {
      patch((msg) => ({ ...msg, streaming: false }));
      setBusy(false);
      abortRef.current = null;
    }
  }, [input, convId, busy, navigate, onClose]);

  const stop = () => { abortRef.current?.abort(); if (convId) api.agentAbort(convId).catch(() => {}); };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] bg-black/30 flex items-start justify-center pt-[10vh] px-4" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl w-[640px] max-w-[94vw] h-[520px] max-h-[76vh] flex flex-col overflow-hidden"
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
          {!msgs.length && !err && (
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
          {busy && <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1"><Loader2 className="w-2.5 h-2.5 animate-spin" />生成中…</div>}
        </div>
      </div>
    </div>
  );
}
