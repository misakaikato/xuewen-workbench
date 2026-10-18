// 智能助手聊天页：会话栏 + 流式消息（文本增量/工具卡/引用跳转）+ 输入区。
// SSE 用 fetch + ReadableStream 手解析（POST 事件流）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { useApp } from '@/store/app';
import { Plus, Trash2, Send, Square, Bot, Wrench, ChevronRight, ChevronDown, Sparkles } from 'lucide-react';

interface Conv {
  id: string;
  title: string;
  updatedAt: string;
  busy?: boolean;
}
interface ToolItem {
  callId?: string;
  name: string;
  args?: unknown;
  summary?: string;
  isError?: boolean;
}
interface Msg {
  role: 'user' | 'assistant';
  text: string;
  tools?: ToolItem[];
  streaming?: boolean;
  error?: boolean;
}

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

function ToolCard({ t }: { t: ToolItem }) {
  const [open, setOpen] = useState(false);
  const err = t.isError;
  return (
    <div className={`text-xs border rounded ${err ? 'border-red-300 bg-red-50 dark:bg-red-950/20' : 'border-border bg-muted/40'} my-1`}>
      <button className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left" onClick={() => setOpen((v) => !v)}>
        <Wrench className={`w-3 h-3 shrink-0 ${err ? 'text-red-500' : 'text-muted-foreground'}`} />
        <span className="font-medium">{t.name}</span>
        {t.summary && <span className="text-muted-foreground truncate flex-1">{t.summary}</span>}
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1">
          {t.args !== undefined && (
            <div>
              <div className="text-muted-foreground">参数</div>
              <pre className="text-[11px] whitespace-pre-wrap break-all bg-card border border-border rounded p-1.5">{JSON.stringify(t.args, null, 2)}</pre>
            </div>
          )}
          {t.summary && (
            <div>
              <div className="text-muted-foreground">结果</div>
              <pre className="text-[11px] whitespace-pre-wrap break-all bg-card border border-border rounded p-1.5">{t.summary}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 文本里的 [文件名.xxx] 引用渲染为可点击跳转
function RichText({ text }: { text: string }) {
  const navigate = useNavigate();
  const parts = text.split(/(\[[^\][]+\.(?:md|txt|json|docx?|doc)\])/gi);
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\[([^[\]]+)+\]$/.exec(p);
        if (m) {
          const name = m[1];
          return (
            <button
              key={i}
              className="text-primary underline underline-offset-2 mx-0.5"
              onClick={async () => {
                try {
                  const r = await api.tree();
                  const hit = collectFiles(r.tree).find((f) => f.name === name);
                  if (hit) navigate('/read/' + encPath(hit.path));
                } catch { /* 忽略 */ }
              }}
            >
              {name}
            </button>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

function collectFiles(n: { name: string; path: string; files: { name: string; path: string }[]; dirs: unknown[] }): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  const walk = (node: typeof n) => {
    for (const f of node.files || []) out.push({ name: f.name, path: f.path });
    for (const d of (node.dirs || []) as typeof n[]) walk(d);
  };
  walk(n);
  return out;
}

export default function AgentChat() {
  const { dsId } = useApp();
  const navigate = useNavigate();
  const [convs, setConvs] = useState<Conv[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [endpoint, setEndpoint] = useState<{ ready: boolean; model?: string } | null>(null);
  const [skills, setSkills] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const st = await api.agentStatus();
      setConvs(st.conversations || []);
      setEndpoint(st.endpoint);
      setSkills(st.skills || []);
    } catch { /* 忽略 */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh, dsId]);

  useEffect(() => {
    if (!active) {
      setMsgs([]);
      return;
    }
    api.agentSession(active).then((s) => {
      setMsgs(
        (s.messages || []).map((m) => ({
          role: m.role,
          text: m.text,
          tools: (m.tools || []).map((t) => ({ name: t.name, args: t.args, summary: t.summary, isError: t.isError })),
        }))
      );
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      });
    }).catch(() => setMsgs([]));
  }, [active]);

  const open = async (id: string) => {
    if (streamRef.current) return;
    setActive(id);
  };

  const newConv = async () => {
    const c = await api.agentNewSession();
    await refresh();
    setActive(c.id);
    setInput('');
  };

  const del = async (id: string) => {
    if (!window.confirm('删除这个对话？')) return;
    await api.agentDeleteSession(id);
    if (active === id) setActive(null);
    refresh();
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy || !active) return;
    setInput('');
    setBusy(true);
    streamRef.current = true;
    setMsgs((m) => [...m, { role: 'user', text }, { role: 'assistant', text: '', tools: [], streaming: true }]);

    const ctl = new AbortController();
    abortRef.current = ctl;
    let ai = -1; // 当前流式 assistant 消息下标
    setMsgs((m) => {
      ai = m.length - 1;
      return m;
    });

    const patch = (fn: (msg: Msg) => Msg) =>
      setMsgs((m) => {
        const next = [...m];
        if (ai >= 0 && next[ai]) next[ai] = fn(next[ai]);
        return next;
      });

    try {
      const resp = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: active, text }),
        signal: ctl.signal,
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let d: { t: string; [k: string]: unknown };
          try { d = JSON.parse(line.slice(6)); } catch { continue; }
          if (d.t === 'delta') patch((msg) => ({ ...msg, text: msg.text + (d.v as string) }));
          else if (d.t === 'tool_start') patch((msg) => ({ ...msg, tools: [...(msg.tools || []), { callId: d.callId as string, name: d.name as string, args: d.args }] }));
          else if (d.t === 'tool_end') patch((msg) => ({ ...msg, tools: (msg.tools || []).map((t) => (t.callId === d.callId ? { ...t, summary: d.summary as string, isError: d.isError as boolean } : t)) }));
          else if (d.t === 'open_doc') {
            const p = d.path as string;
            const term = d.term as string;
            navigate('/read/' + encPath(p) + (term ? '?h=' + encodeURIComponent(term) : ''));
          } else if (d.t === 'error') patch((msg) => ({ ...msg, text: msg.text + `\n\n（${d.message}）`, error: true }));
          else if (d.t === 'done') { /* 流结束 */ }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') patch((msg) => ({ ...msg, text: msg.text + `\n\n（连接失败：${(e as Error).message}）`, error: true }));
    } finally {
      patch((msg) => ({ ...msg, streaming: false }));
      setBusy(false);
      streamRef.current = false;
      abortRef.current = null;
      refresh();
    }
  };

  const stop = async () => {
    abortRef.current?.abort();
    if (active) api.agentAbort(active).catch(() => {});
  };

  return (
    <div className="h-full flex min-h-0">
      {/* 会话栏 */}
      <aside className="w-56 shrink-0 border-r border-border flex flex-col min-h-0">
        <div className="p-2 flex items-center gap-2 border-b border-border">
          <button className="flex-1 flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90" onClick={newConv}>
            <Plus className="w-3.5 h-3.5" />新对话
          </button>
        </div>
        <div className="flex-1 overflow-auto p-1.5 space-y-0.5">
          {convs.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center gap-1 px-2 py-1.5 rounded cursor-pointer text-sm ${active === c.id ? 'bg-accent text-primary font-medium' : 'hover:bg-accent'}`}
              onClick={() => open(c.id)}
            >
              <span className="truncate flex-1">{c.title || '新对话'}</span>
              <button
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-background shrink-0"
                title="删除对话"
                onClick={(e) => { e.stopPropagation(); del(c.id); }}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
          {!convs.length && <div className="text-xs text-muted-foreground p-2">还没有对话</div>}
        </div>
        {skills.length > 0 && (
          <div className="p-2 border-t border-border text-[11px] text-muted-foreground">
            skills：{skills.join('、')}
          </div>
        )}
      </aside>

      {/* 消息区 */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-2 text-xs">
          <Sparkles className="w-3.5 h-3.5 text-primary" />
          <span className="font-medium">智能助手</span>
          {endpoint && (
            <span className={endpoint.ready ? 'text-muted-foreground' : 'text-amber-600'}>
              {endpoint.ready ? `· ${endpoint.model}` : '· 端点未配置'}
            </span>
          )}
          {!endpoint?.ready && <Link to="/rag" className="text-primary underline">去配置</Link>}
          <span className="flex-1" />
          <span className="text-muted-foreground hidden sm:inline">多轮 · 工具 · skills/MCP（应用数据 agent/ 目录）</span>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-auto px-4 py-4">
          {!active && (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
              <Bot className="w-10 h-10" />
              <p className="text-sm">新建对话开始提问，例如：</p>
              <div className="text-xs space-y-1 text-center">
                <p>「这套语料主要讲了什么？」</p>
                <p>「帮我找到讲 XX 概念的段落并列出出处」</p>
                <p>「重建语义索引并告诉我库里有几类文件」</p>
              </div>
            </div>
          )}
          <div className="max-w-3xl mx-auto space-y-4">
            {msgs.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
                {m.role === 'user' ? (
                  <div className="max-w-[85%] bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words">{m.text}</div>
                ) : (
                  <div className="max-w-full">
                    {(m.tools || []).map((t, j) => <ToolCard key={j} t={t} />)}
                    {m.text && (
                      <div className={`text-sm leading-relaxed whitespace-pre-wrap break-words ${m.error ? 'text-red-600' : ''}`}>
                        <RichText text={m.text} />
                      </div>
                    )}
                    {m.streaming && !m.text && !(m.tools || []).length && (
                      <div className="text-xs text-muted-foreground">思考中…</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 输入区 */}
        <div className="shrink-0 border-t border-border p-3">
          <div className="max-w-3xl mx-auto flex items-end gap-2">
            <textarea
              value={input}
              disabled={!active || !endpoint?.ready}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder={active ? '提问（Enter 发送，Shift+Enter 换行）' : '先新建对话'}
              className="flex-1 resize-none px-3 py-2 rounded-lg border border-input bg-card text-sm disabled:opacity-50"
            />
            {busy ? (
              <button className="px-3 py-2 rounded-lg border border-border hover:bg-accent flex items-center gap-1 text-sm" onClick={stop}>
                <Square className="w-3.5 h-3.5" />停止
              </button>
            ) : (
              <button className="px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 flex items-center gap-1 text-sm" disabled={!active || !input.trim()} onClick={send}>
                <Send className="w-3.5 h-3.5" />发送
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
