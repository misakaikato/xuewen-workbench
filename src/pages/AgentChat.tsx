// 智能助手聊天页（M4 全量）：Kimi/Claude 风格 UI + token 追踪 + thinking + 分叉 + 导出 + 搜索 + 模型快切
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '@/lib/api';
import type { AgentStatus, AgentMessage } from '@/lib/api';
import { useApp } from '@/store/app';
import { MarkdownMsg } from '@/components/agent/MarkdownMsg';
import { ChatInput } from '@/components/agent/ChatInput';
import { ToolCard, type ToolItem } from '@/components/agent/ToolCard';
import { ThinkingBlock, ContextBar } from '@/components/agent/Extras';
import {
  Plus, Trash2, Bot, Sparkles, Copy, Check, FileText, Zap,
  GitBranch, Download, Search, X, ChevronDown, MessageSquareQuote,
  Brain, Gauge, ListChecks,
} from 'lucide-react';

interface Conv { id: string; title: string; updatedAt: string; busy?: boolean }
interface Msg extends AgentMessage { streaming?: boolean; error?: boolean }

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const CTX_WINDOW = 128000;

const SLASH_COMMANDS = [
  { cmd: '/clear', desc: '开始新对话' },
  { cmd: '/skills', desc: '列出可用 skills' },
  { cmd: '/mcp', desc: 'MCP 服务器状态' },
  { cmd: '/model', desc: '当前模型与端点' },
  { cmd: '/status', desc: '语料库与索引状态' },
  { cmd: '/export', desc: '导出为 Markdown' },
  { cmd: '/help', desc: '显示所有命令' },
];

const TEMPLATES = [
  { icon: Zap, title: '语料概览', prompt: '这套语料主要讲了什么？检索后按主题分类概述' },
  { icon: FileText, title: '找段落', prompt: '帮我找到讲「安全边际」的段落并列出出处文件' },
  { icon: Gauge, title: '索引体检', prompt: '用 corpus_status 检查语料库和索引状态，报告是否需要重建' },
  { icon: ListChecks, title: '概念对比', prompt: '对比语料里几本主要书籍对「风险与收益」的不同观点，列出出处' },
  { icon: MessageSquareQuote, title: '读书笔记', prompt: '为语料中最重要的3本书各写一段读书摘要，保存为笔记' },
  { icon: Brain, title: '深度问答', prompt: '语料里关于「量化交易」的核心观点是什么？逐本书分析并标注出处' },
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
  const [usage, setUsage] = useState<Msg['usage'] | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef(false);
  const aiRef = useRef(-1);

  const refresh = useCallback(async () => {
    try {
      const st = await api.agentStatus();
      setStatus(st);
      setConvs(st.conversations || []);
    } catch { /* */ }
  }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [refresh, dsId]);

  useEffect(() => {
    if (!active) { setMsgs([]); setUsage(null); return; }
    api.agentSession(active).then((s) => {
      const mapped = (s.messages || []).map((m) => ({ ...m }));
      setMsgs(mapped);
      setUsage(mapped.filter((m) => m.usage).pop()?.usage || null);
      requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; });
    }).catch(() => setMsgs([]));
  }, [active]);

  const open = (id: string) => { if (!streamRef.current) setActive(id); };
  const newConv = async () => { const c = await api.agentNewSession(); await refresh(); setActive(c.id); setInput(''); };
  const del = async (id: string) => { if (!window.confirm('删除这个对话？')) return; await api.agentDeleteSession(id); if (active === id) setActive(null); refresh(); };
  const fork = async (msgIndex: number) => {
    const c = await api.agentFork(active!, msgIndex);
    await refresh();
    setActive(c.id);
  };
  const doExport = () => { if (active) window.open(api.agentExport(active), '_blank'); };

  const loadModels = async () => {
    if (!models.length) {
      const r = await api.agentModels().catch(() => ({ models: [] }));
      setModels(r.models || []);
    }
    setModelOpen((v) => !v);
  };
  const switchModel = async (m: string) => {
    await api.ragLlmSave({ model: m });
    setModelOpen(false);
    refresh();
  };

  const doCommand = (cmd: string) => {
    if (cmd === '/clear' || cmd === '/new') { newConv(); return; }
    if (cmd === '/help') {
      setMsgs((m) => [...m, { role: 'user', text: cmd }, { role: 'assistant', text: SLASH_COMMANDS.map((c: { cmd: string; desc: string }) => `- \`${c.cmd}\` — ${c.desc}`).join('\n') }]);
      return;
    }
    if (cmd === '/model') { loadModels(); return; }
    if (cmd === '/skills') {
      const sk = status?.skills || [];
      setMsgs((m) => [...m, { role: 'user', text: cmd }, { role: 'assistant', text: sk.length ? `可用 skills：\n${sk.map((s) => `- \`${s}\``).join('\n')}` : '暂无。放 SKILL.md 到应用数据 `agent/skills/<名称>/` 即可。' }]);
      return;
    }
    if (cmd === '/mcp') {
      const mcp = status?.mcp || [];
      setMsgs((m) => [...m, { role: 'user', text: cmd }, { role: 'assistant', text: mcp.length ? `MCP 服务器：\n${mcp.map((s) => `- \`${s.name}\` (${s.type}) ${s.enabled ? '✅' : '⏸'}`).join('\n')}` : '暂无。配置 `agent/mcp.json` 即可。' }]);
      return;
    }
    if (cmd === '/status') { setInput('用 corpus_status 查看资料库状态并简要报告'); return; }
    if (cmd === '/export') { doExport(); return; }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !active) return;
    setInput('');
    setBusy(true); streamRef.current = true; aiRef.current = -1;
    setMsgs((m) => { const next = [...m, { role: 'user' as const, text }, { role: 'assistant' as const, text: '', tools: [], streaming: true, thinking: '' }]; aiRef.current = next.length - 1; return next; });
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
          else if (d.t === 'thinking') patch((msg) => ({ ...msg, thinking: (msg.thinking || '') + (d.v as string) }));
          else if (d.t === 'usage') { setUsage(d.usage as Msg['usage']); }
          else if (d.t === 'tool_start') patch((msg) => ({ ...msg, tools: [...(msg.tools || []), { name: d.name as string, args: d.args, durationMs: 0 }] }));
          else if (d.t === 'tool_end') patch((msg) => ({ ...msg, tools: (msg.tools || []).map((t) => (t as ToolItem).name === d.name && !(t as ToolItem).summary ? { ...t, summary: d.summary as string, isError: d.isError as boolean, durationMs: d.durationMs as number } : t) }));
          else if (d.t === 'open_doc') { navigate('/read/' + encPath(d.path as string) + ((d.term as string) ? '?h=' + encodeURIComponent(d.term as string) : '')); }
          else if (d.t === 'error') patch((msg) => ({ ...msg, text: msg.text + `\n\n**错误**：${d.message}`, error: true }));
          else if (d.t === 'steered') patch((msg) => ({ ...msg, text: msg.text + '\n\n> 📎 已插入指令，当前轮结束后处理\n' }));
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && active) { e.preventDefault(); setSearchOpen(true); }
      if (e.key === 'Escape' && searchOpen) setSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, searchOpen]);

  const richRefs = (text: string) => {
    const parts = text.split(/(@[^\s@]+\.(?:md|txt|json|docx?))/gi);
    return parts.map((p, i) => {
      const m = /^@(.+)$/.exec(p);
      if (m) return <FileRef key={i} name={m[1]} />;
      return <span key={i}>{p}</span>;
    });
  };

  const searchHits = searchQ ? msgs.map((m, i) => ({ i, m })).filter(({ m }) => m.text.toLowerCase().includes(searchQ.toLowerCase())) : [];
  const ep = status?.endpoint;
  const sk = status?.skills || [];
  const mcp = status?.mcp || [];
  const tools = status?.tools || [];

  return (
    <div className="h-full flex min-h-0 bg-background">
      {/* 左侧：深色会话栏（Claude 风格） */}
      <aside className="w-60 shrink-0 border-r border-border flex flex-col min-h-0 bg-sidebar">
        <div className="p-3 border-b border-sidebar-border">
          <button className="w-full flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 font-medium" onClick={newConv}>
            <Plus className="w-4 h-4" />新对话
          </button>
        </div>
        <div className="flex-1 overflow-auto p-2 space-y-0.5">
          {convs.map((c) => (
            <div key={c.id} className={`group flex items-center gap-1.5 px-3 py-2 rounded-lg cursor-pointer text-sm transition-colors ${active === c.id ? 'bg-sidebar-accent text-primary font-medium' : 'hover:bg-sidebar-accent text-sidebar-foreground'}`} onClick={() => open(c.id)}>
              <div className="truncate flex-1">{c.title || '新对话'}</div>
              <button className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-background shrink-0" onClick={(e) => { e.stopPropagation(); del(c.id); }}>
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
          {!convs.length && <div className="text-xs text-muted-foreground p-3 text-center">还没有对话</div>}
        </div>
        <div className="p-3 border-t border-sidebar-border space-y-1.5 text-[11px] text-muted-foreground">
          {sk.length > 0 && <div><span className="text-primary font-medium">{sk.length}</span> 个 skills</div>}
          {mcp.length > 0 && <div><span className="text-primary font-medium">{mcp.filter((m) => m.enabled).length}/{mcp.length}</span> 个 MCP</div>}
          {tools.length > 0 && <div title={tools.join(' · ')}><span className="text-primary font-medium">{tools.length}</span> 个工具</div>}
          {usage && <ContextBar usage={usage} contextWindow={CTX_WINDOW} />}
        </div>
      </aside>

      {/* 主区域 */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* 顶栏：模型 + 上下文 + 操作 */}
        <div className="shrink-0 px-4 py-2.5 border-b border-border flex items-center gap-3 flex-wrap bg-card">
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold">智能助手</span>
          </div>
          {/* 模型快切 */}
          <div className="relative">
            <button className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-border hover:border-primary/50 text-muted-foreground font-mono" onClick={loadModels}>
              {ep?.model || '未配置'} <ChevronDown className="w-3 h-3" />
            </button>
            {modelOpen && (
              <div className="absolute top-full left-0 mt-1 bg-card border border-border rounded-lg shadow-lg p-1 z-30 min-w-48 max-h-64 overflow-auto">
                {models.length ? models.map((m) => (
                  <button key={m} className={`w-full text-left px-3 py-1.5 rounded text-xs font-mono ${m === ep?.model ? 'bg-accent text-primary' : 'hover:bg-accent'}`} onClick={() => switchModel(m)}>{m}</button>
                )) : <div className="px-3 py-2 text-xs text-muted-foreground">未获取到模型列表</div>}
              </div>
            )}
          </div>
          {!ep?.ready && <Link to="/rag" className="text-xs text-amber-600 underline">去配置</Link>}
          <span className="flex-1" />
          {active && (
            <>
              <button className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground" title="搜索对话 (Ctrl+F)" onClick={() => setSearchOpen(true)}>
                <Search className="w-3.5 h-3.5" />
              </button>
              <button className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground" title="导出为 Markdown" onClick={doExport}>
                <Download className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          <span className="text-[11px] text-muted-foreground hidden lg:inline">/ 命令 · @ 文件</span>
        </div>

        {/* 搜索浮层 */}
        {searchOpen && (
          <div className="shrink-0 border-b border-border px-4 py-2 flex items-center gap-2 bg-muted/30">
            <Search className="w-3.5 h-3.5 text-muted-foreground" />
            <input autoFocus value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="在对话中搜索…" className="flex-1 bg-transparent text-sm outline-none" />
            <span className="text-xs text-muted-foreground tabular-nums">{searchHits.length} 条命中</span>
            <button onClick={() => { setSearchOpen(false); setSearchQ(''); }} className="p-1 rounded hover:bg-accent"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        {/* 消息区 */}
        <div ref={scrollRef} className="flex-1 overflow-auto px-4 py-6">
          {!active && (
            <div className="h-full flex flex-col items-center justify-center gap-6">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Bot className="w-8 h-8" />
                <span className="text-lg font-medium">智能助手</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-w-2xl">
                {TEMPLATES.map((t, i) => (
                  <button key={i} className="flex flex-col gap-2 border border-border rounded-xl p-4 text-left hover:border-primary/50 hover:shadow-sm transition-all group" onClick={() => { newConv().then(() => setInput(t.prompt)); }}>
                    <t.icon className="w-5 h-5 text-primary/70 group-hover:text-primary" />
                    <div className="text-sm font-medium">{t.title}</div>
                    <div className="text-xs text-muted-foreground line-clamp-2">{t.prompt}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="max-w-3xl mx-auto space-y-5">
            {msgs.map((m, i) => {
              const isSearchHit = searchQ && m.text.toLowerCase().includes(searchQ.toLowerCase());
              return (
                <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
                  {m.role === 'user' ? (
                    <div className={`max-w-[80%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm whitespace-pre-wrap break-words ${isSearchHit ? 'bg-primary/80 ring-2 ring-amber-400' : 'bg-primary'} text-primary-foreground leading-relaxed`}>
                      {m.text}
                    </div>
                  ) : (
                    <div className={`max-w-full group/msg rounded-lg ${isSearchHit ? 'ring-2 ring-amber-400 ring-offset-2' : ''}`}>
                      {m.thinking && <ThinkingBlock text={m.thinking} streaming={m.streaming && !m.text} />}
                      {(m.tools || []).map((t, j) => <ToolCard key={j} t={t as ToolItem} />)}
                      {m.text && (
                        <div className={m.error ? 'text-red-600' : 'text-foreground'}>
                          <MarkdownMsg text={m.text} richRefs={richRefs} />
                        </div>
                      )}
                      {m.streaming && !m.text && !m.thinking && !(m.tools || []).length && (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse [animation-delay:200ms]" />
                          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse [animation-delay:400ms]" />
                        </div>
                      )}
                      {!m.streaming && m.text && (
                        <div className="opacity-0 group-hover/msg:opacity-100 flex items-center gap-0.5 mt-1 transition-opacity">
                          <button className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground" title="复制" onClick={() => copyMsg(i)}>
                            {copied === i ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                          <button className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground" title="从这里分叉" onClick={() => fork(i)}>
                            <GitBranch className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 输入区 */}
        <div className="shrink-0 border-t border-border p-4 bg-card">
          <div className="max-w-3xl mx-auto">
            <ChatInput value={input} onChange={setInput} onSend={send} onStop={stop} busy={busy} disabled={!active || !ep?.ready} placeholder={active ? '提问 / 命令 · @文件 · Enter 发送 · Ctrl+F 搜索' : '先新建对话'} onCommand={doCommand} />
          </div>
        </div>
      </div>
    </div>
  );
}

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
