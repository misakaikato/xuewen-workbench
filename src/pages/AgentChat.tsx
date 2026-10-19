// 智能助手聊天页（M2）：markdown 渲染、@-mention、斜杠命令、模型快切、工具卡时序。
// 子组件在 src/components/agent/ 下（MarkdownMsg / ChatInput / ToolCard）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '@/lib/api';
import type { AgentStatus } from '@/lib/api';
import { useApp } from '@/store/app';
import { MarkdownMsg } from '@/components/agent/MarkdownMsg';
import { ChatInput } from '@/components/agent/ChatInput';
import { ToolCard, type ToolItem } from '@/components/agent/ToolCard';
import { Plus, Trash2, Bot, Sparkles, Copy, Check, RotateCcw, FileText, Zap } from 'lucide-react';

interface Conv { id: string; title: string; updatedAt: string; busy?: boolean }
interface Msg { role: 'user' | 'assistant'; text: string; tools?: ToolItem[]; streaming?: boolean; error?: boolean }

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

const SLASH_COMMANDS = [
  { cmd: '/clear', desc: '开始新对话' },
  { cmd: '/skills', desc: '列出可用 skills' },
  { cmd: '/mcp', desc: 'MCP 服务器状态' },
  { cmd: '/model', desc: '当前模型与端点' },
  { cmd: '/status', desc: '语料库与索引状态（发给 agent）' },
  { cmd: '/help', desc: '显示所有命令' },
];

export default function AgentChat() {
  const { dsId } = useApp();
  const navigate = useNavigate();
  const [convs, setConvs] = useState<Conv[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef(false);
  const aiRef = useRef(-1);

  const refresh = useCallback(async () => {
    try { setStatus(await api.agentStatus()); setConvs((await api.agentStatus()).conversations || []); } catch { /* */ }
  }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [refresh, dsId]);

  useEffect(() => {
    if (!active) { setMsgs([]); return; }
    api.agentSession(active).then((s) => {
      setMsgs((s.messages || []).map((m) => ({
        role: m.role, text: m.text,
        tools: (m.tools || []).map((t) => ({ name: t.name, args: t.args, summary: t.summary, isError: t.isError })),
      })));
      requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; });
    }).catch(() => setMsgs([]));
  }, [active]);

  const open = (id: string) => { if (!streamRef.current) setActive(id); };
  const newConv = async () => { const c = await api.agentNewSession(); await refresh(); setActive(c.id); setInput(''); };
  const del = async (id: string) => { if (!window.confirm('删除这个对话？')) return; await api.agentDeleteSession(id); if (active === id) setActive(null); refresh(); };

  const doCommand = (cmd: string) => {
    if (cmd === '/clear' || cmd === '/new') { newConv(); return; }
    if (cmd === '/help') {
      setMsgs((m) => [...m, { role: 'user', text: cmd }, { role: 'assistant', text: SLASH_COMMANDS.map((c) => `- \`${c.cmd}\` — ${c.desc}`).join('\n') }]);
      return;
    }
    if (cmd === '/model') {
      const e = status?.endpoint;
      setMsgs((m) => [...m, { role: 'user', text: cmd }, { role: 'assistant', text: e?.ready ? `当前模型：\`${e.model}\`\n端点：\`${e.baseUrl}\`\n\n在 RAG 管理页可修改。` : '端点未配置。去 RAG 管理页设置。' }]);
      return;
    }
    if (cmd === '/skills') {
      const sk = status?.skills || [];
      setMsgs((m) => [...m, { role: 'user', text: cmd }, { role: 'assistant', text: sk.length ? `可用 skills：\n${sk.map((s) => `- \`${s}\``).join('\n')}\n\n放置目录：应用数据 \`agent/skills/<名称>/SKILL.md\`` : '暂无 skills。放置 SKILL.md 到应用数据 `agent/skills/<名称>/` 即可被发现。' }]);
      return;
    }
    if (cmd === '/mcp') {
      setMsgs((m) => [...m, { role: 'user', text: cmd }, { role: 'assistant', text: 'MCP 配置文件：应用数据 `agent/mcp.json`\n\n格式见 pi mcp 文档。保存后重启应用生效。' }]);
      return;
    }
    if (cmd === '/status') {
      // 通过普通提问让 agent 自己调用 corpus_status
      setInput('用 corpus_status 工具查看当前资料库和索引状态，然后简要报告');
      return;
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !active) return;
    // busy 时仍可发送（steering：插入到当前生成）
    setInput('');
    setBusy(true); streamRef.current = true; aiRef.current = -1;
    setMsgs((m) => { const next = [...m, { role: 'user' as const, text }, { role: 'assistant' as const, text: '', tools: [], streaming: true }]; aiRef.current = next.length - 1; return next; });
    const patch = (fn: (msg: Msg) => Msg) => setMsgs((m) => { const next = [...m]; const i = aiRef.current; if (i >= 0 && next[i]) next[i] = fn(next[i]); return next; });
    const ctl = new AbortController(); abortRef.current = ctl;
    try {
      const resp = await fetch('/api/agent/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: active, text }), signal: ctl.signal });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
      const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, nl); buf = buf.slice(nl + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let d: { t: string; [k: string]: unknown };
          try { d = JSON.parse(line.slice(6)); } catch { continue; }
          if (d.t === 'delta') patch((msg) => ({ ...msg, text: msg.text + (d.v as string) }));
          else if (d.t === 'tool_start') patch((msg) => ({ ...msg, tools: [...(msg.tools || []), { callId: d.callId as string, name: d.name as string, args: d.args, durationMs: 0 }] }));
          else if (d.t === 'tool_end') patch((msg) => ({ ...msg, tools: (msg.tools || []).map((t) => (t.callId === d.callId ? { ...t, summary: d.summary as string, isError: d.isError as boolean, durationMs: d.durationMs as number } : t)) }));
          else if (d.t === 'open_doc') { navigate('/read/' + encPath(d.path as string) + ((d.term as string) ? '?h=' + encodeURIComponent(d.term as string) : '')); }
          else if (d.t === 'error') patch((msg) => ({ ...msg, text: msg.text + `\n\n**错误**：${d.message}`, error: true }));
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') patch((msg) => ({ ...msg, text: msg.text + `\n\n**连接失败**：${(e as Error).message}`, error: true }));
    } finally {
      patch((msg) => ({ ...msg, streaming: false }));
      setBusy(false); streamRef.current = false; abortRef.current = null; refresh();
    }
  };

  const stop = () => { abortRef.current?.abort(); if (active) api.agentAbort(active).catch(() => {}); };
  const copyMsg = (i: number) => { navigator.clipboard.writeText(msgs[i].text).then(() => { setCopied(i); setTimeout(() => setCopied(null), 1200); }); };
  const retry = async () => { const last = [...msgs].reverse().find((m) => m.role === 'user'); if (last) { setInput(last.text); } };
  const scroll = () => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; };
  useEffect(() => { const t = setTimeout(scroll, 100); return () => clearTimeout(t); }, [msgs.length]);

  // 文件引用：文本中的 @文件名 转为可点跳转
  const richRefs = (text: string) => {
    const parts = text.split(/(@[^\s@]+\.(?:md|txt|json|docx?))/gi);
    return parts.map((p, i) => {
      const m = /^@(.+)$/.exec(p);
      if (m) return <FileRef key={i} name={m[1]} />;
      return <span key={i}>{p}</span>;
    });
  };

  const ep = status?.endpoint;
  const sk = status?.skills || [];

  return (
    <div className="h-full flex min-h-0">
      <aside className="w-56 shrink-0 border-r border-border flex flex-col min-h-0">
        <div className="p-2 border-b border-border">
          <button className="w-full flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90" onClick={newConv}>
            <Plus className="w-3.5 h-3.5" />新对话
          </button>
        </div>
        <div className="flex-1 overflow-auto p-1.5 space-y-0.5">
          {convs.map((c) => (
            <div key={c.id} className={`group flex items-center gap-1 px-2 py-1.5 rounded cursor-pointer text-sm ${active === c.id ? 'bg-accent text-primary font-medium' : 'hover:bg-accent'}`} onClick={() => open(c.id)}>
              <span className="truncate flex-1">{c.title || '新对话'}</span>
              <button className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-background shrink-0" title="删除" onClick={(e) => { e.stopPropagation(); del(c.id); }}>
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
          {!convs.length && <div className="text-xs text-muted-foreground p-2">还没有对话</div>}
        </div>
        <div className="p-2 border-t border-border text-[11px] space-y-1">
          {sk.length > 0 && (
            <div className="text-muted-foreground truncate" title={sk.join('、')}>
              <span className="text-primary font-medium">skills</span> {sk.length} 个
            </div>
          )}
          {(status?.mcp || []).length > 0 && (
            <div className="text-muted-foreground truncate">
              <span className="text-primary font-medium">MCP</span> {(status?.mcp || []).filter((m) => m.enabled).length}/{(status?.mcp || []).length} 个
            </div>
          )}
          {(status?.tools || []).length > 0 && (
            <div className="text-muted-foreground truncate" title={(status?.tools || []).join(' · ')}>
              <span className="text-primary font-medium">工具</span> {(status?.tools || []).length} 个
            </div>
          )}
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-2 text-xs flex-wrap">
          <Sparkles className="w-3.5 h-3.5 text-primary" />
          <span className="font-medium">智能助手</span>
          {ep && <span className={ep.ready ? 'text-muted-foreground font-mono' : 'text-amber-600'}>{ep.ready ? ep.model : '端点未配置'}</span>}
          {!ep?.ready && <Link to="/rag" className="text-primary underline">去配置</Link>}
          <span className="flex-1" />
          <span className="text-muted-foreground hidden sm:inline">输入 / 查看命令 · @ 引用文件</span>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-auto px-4 py-4">
          {!active && (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-4">
              <Bot className="w-12 h-12" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg">
                {[
                  { icon: Zap, text: '语料主要讲了什么？' },
                  { icon: FileText, text: '帮我找到讲「安全边际」的段落并列出出处' },
                  { icon: RotateCcw, text: '重建语义索引并报告状态' },
                  { icon: Bot, text: '对比这几本书对风险的不同看法' },
                ].map((s, i) => (
                  <button key={i} className="flex items-center gap-2 border border-border rounded-lg p-3 text-sm text-left hover:border-primary/50 hover:text-primary" onClick={() => { newConv().then(() => setInput(s.text)); }}>
                    <s.icon className="w-4 h-4 shrink-0" />{s.text}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="max-w-3xl mx-auto space-y-4">
            {msgs.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
                {m.role === 'user' ? (
                  <div className="max-w-[85%] bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words">{m.text}</div>
                ) : (
                  <div className="max-w-full group/msg">
                    {(m.tools || []).map((t, j) => <ToolCard key={j} t={t} />)}
                    {m.text && <div className={m.error ? 'text-red-600 text-sm' : ''}><MarkdownMsg text={m.text} richRefs={richRefs} /></div>}
                    {m.streaming && !m.text && !(m.tools || []).length && <div className="text-xs text-muted-foreground animate-pulse">思考中…</div>}
                    {!m.streaming && m.text && (
                      <div className="opacity-0 group-hover/msg:opacity-100 flex items-center gap-1 mt-0.5">
                        <button className="p-1 rounded hover:bg-accent text-muted-foreground" title="复制" onClick={() => copyMsg(i)}>
                          {copied === i ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
                        </button>
                        {i === msgs.length - 1 && (
                          <button className="p-1 rounded hover:bg-accent text-muted-foreground" title="重试" onClick={retry}>
                            <RotateCcw className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="shrink-0 border-t border-border p-3">
          <div className="max-w-3xl mx-auto">
            <ChatInput value={input} onChange={setInput} onSend={send} onStop={stop} busy={busy} disabled={!active || !ep?.ready} placeholder={active ? '提问 / 命令 · @文件引用 · Enter 发送' : '先新建对话'} onCommand={doCommand} />
          </div>
        </div>
      </div>
    </div>
  );
}

// @文件名 引用按钮
function FileRef({ name }: { name: string }) {
  const navigate = useNavigate();
  const [hit, setHit] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    api.tree().then((r) => {
      const flat: { name: string; path: string }[] = [];
      const walk = (n: { files: { name: string; path: string }[]; dirs: unknown[] }) => { for (const f of n.files) flat.push(f); for (const d of n.dirs as typeof n[]) walk(d); };
      walk(r.tree);
      setHit(flat.find((f) => f.name === name)?.path ?? null);
    }).catch(() => setHit(null));
  }, [name]);
  if (hit === undefined) return <span className="text-primary/50">@{name}</span>;
  if (hit === null) return <span className="text-muted-foreground">@{name}</span>;
  return <button className="text-primary underline underline-offset-2" onClick={() => navigate('/read/' + encPath(hit))}>@{name}</button>;
}
