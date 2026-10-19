// 智能助手 M4.1：可折叠侧栏 + 上下文指示在输入框上方 + 可编辑消息 + 设置面板 + 模型快切
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import type { AgentStatus, AgentMessage } from '@/lib/api';
import { useApp } from '@/store/app';
import { MarkdownMsg } from '@/components/agent/MarkdownMsg';
import { ChatInput } from '@/components/agent/ChatInput';
import { ToolCard, type ToolItem } from '@/components/agent/ToolCard';
import { ThinkingBlock, ContextBar } from '@/components/agent/Extras';
import { AgentSettingsPanel } from '@/components/agent/AgentSettingsPanel';
import {
  Plus, Trash2, Bot, Sparkles, Copy, Check, FileText, Zap,
  GitBranch, Download, Search, X, MessageSquareQuote, Brain, Gauge, ListChecks,
  PanelLeftClose, PanelLeftOpen, Settings2, Pencil, Trash, RotateCcw, ChevronDown, ShieldCheck, ShieldAlert, Eye,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Conv { id: string; title: string; updatedAt: string; busy?: boolean }
interface Msg extends AgentMessage { streaming?: boolean; error?: boolean; editing?: boolean }

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const CTX_WINDOW = 128000;
const SLASH_COMMANDS = [
  { cmd: '/clear', desc: '开始新对话' },
  { cmd: '/skills', desc: '列出 skills' },
  { cmd: '/mcp', desc: 'MCP 状态' },
  { cmd: '/model', desc: '打开设置面板' },
  { cmd: '/status', desc: '语料库状态' },
  { cmd: '/export', desc: '导出 Markdown' },
  { cmd: '/help', desc: '所有命令' },
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
  
  const [active, setActive] = useState<string | null>(() => new URLSearchParams(window.location.search).get('c'));
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [usage, setUsage] = useState<Msg['usage'] | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelList, setModelList] = useState<string[]>([]);
  const [confirmReq, setConfirmReq] = useState<{ id: string; tool: string; args: unknown } | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarW, setSidebarW] = useState(() => {
    const n = Number(localStorage.getItem('wb.agent.sidebar.w'));
    return Number.isFinite(n) && n >= 200 && n <= 480 ? n : 240;
  });
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef(false);
  const aiRef = useRef(-1);

  const refresh = useCallback(async () => {
    try { const st = await api.agentStatus(); setStatus(st); setConversations(st.conversations || []); } catch { /* */ }
  }, []);
  const [conversations, setConversations] = useState<Conv[]>([]);
  const prevBusyRef = useRef<Map<string, boolean>>(new Map());
  const [toast, setToast] = useState<string | null>(null);
  const checkBgDone = useCallback((convs: Conv[]) => {
    for (const c of convs) {
      const was = prevBusyRef.current.get(c.id) || false;
      if (was && !c.busy && c.id !== active) {
        setToast(`「${c.title || '对话'}」已完成生成`);
        setTimeout(() => setToast(null), 5000);
      }
      prevBusyRef.current.set(c.id, !!c.busy);
    }
  }, [active]);
  useEffect(() => { checkBgDone(conversations); }, [conversations, checkBgDone]);
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

  // 侧栏拖拽调宽：delta 式（记录按下点与初始宽度，与主侧栏同一手感），拖拽中禁文字选择
  const dragRef = useRef<{ startX: number; w0: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (d) setSidebarW(Math.max(200, Math.min(480, d.w0 + (e.clientX - d.startX))));
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);
  // 宽度持久化（防抖落盘）
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem('wb.agent.sidebar.w', String(Math.round(sidebarW))); } catch { /* 忽略 */ }
    }, 200);
    return () => clearTimeout(t);
  }, [sidebarW]);

  const openConv = (id: string | null) => {
    setActive(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('c', id); else url.searchParams.delete('c');
    window.history.replaceState(null, '', url);
  };
  const open = (id: string) => { openConv(id); };
  const newConv = async () => { const c = await api.agentNewSession(); await refresh(); openConv(c.id); setInput(''); };
  const del = async (id: string) => { if (!window.confirm('删除这个对话？')) return; await api.agentDeleteSession(id); if (active === id) openConv(null); refresh(); };
  const fork = async (msgIndex: number) => { const c = await api.agentFork(active!, msgIndex); await refresh(); openConv(c.id); };
  const doExport = () => { if (active) window.open(api.agentExport(active), '_blank'); };

  // 消息编辑/删除
  const editMsg = async (idx: number, text: string) => {
    setMsgs((m) => m.map((x, i) => (i === idx ? { ...x, text, editing: false } : x)));
    if (active) await api.agentEditMessage(active, idx, text).catch(() => {});
  };
  const deleteMsg = async (idx: number) => {
    setMsgs((m) => m.filter((_, i) => i !== idx));
    if (active) await api.agentDeleteMessage(active, idx).catch(() => {});
  };

  // 刷新（重新生成）：截断消息到 fromIndex，重发用户输入（利用 pi 分支语义）
  const regenerate = async (fromIndex: number) => {
    if (!active || busy) return;
    // 找到 fromIndex 之前最近的用户消息（含 fromIndex 自身如果是用户消息）
    let userIdx = -1;
    if (msgs[fromIndex]?.role === 'user') userIdx = fromIndex;
    else {
      for (let i = fromIndex; i >= 0; i--) {
        if (msgs[i].role === 'user') { userIdx = i; break; }
      }
    }
    if (userIdx < 0) return;
    const userText = msgs[userIdx].text;
    // 截断：保留到 userIdx（不含），后续全部丢弃
    const kept = msgs.slice(0, userIdx);
    setMsgs(kept);
    // 删掉投影中后续消息（服务端）
    for (let i = msgs.length - 1; i > userIdx - 1; i--) {
      await api.agentDeleteMessage(active, i).catch(() => {});
    }
    // 重新发送
    setInput(userText);
    requestAnimationFrame(() => send());
  };

  const doCommand = (cmd: string) => {
    if (cmd === '/clear') { newConv(); return; }
    if (cmd === '/help') { setMsgs((m) => [...m, { role: 'user', text: cmd }, { role: 'assistant', text: SLASH_COMMANDS.map((c: { cmd: string; desc: string }) => `- \`${c.cmd}\` — ${c.desc}`).join('\n') }]); return; }
    if (cmd === '/model') { setSettingsOpen(true); return; }
    if (cmd === '/skills') { const sk = status?.skills || []; setMsgs((m) => [...m, { role: 'user', text: cmd }, { role: 'assistant', text: sk.length ? `可用 skills：\n${sk.map((s) => `- \`${s}\``).join('\n')}` : '暂无。放 SKILL.md 到应用数据 agent/skills/<名称>/ 即可。' }]); return; }
    if (cmd === '/mcp') { const mcp = status?.mcp || []; setMsgs((m) => [...m, { role: 'user', text: cmd }, { role: 'assistant', text: mcp.length ? `MCP：\n${mcp.map((s) => `- \`${s.name}\` (${s.type}) ${s.enabled ? '✅' : '⏸'}`).join('\n')}` : '暂无。配置 agent/mcp.json 即可。' }]); return; }
    if (cmd === '/status') { setInput('用 corpus_status 查看资料库状态并简要报告'); return; }
    if (cmd === '/export') { doExport(); return; }
  };

  // 流式输出时自动滚动到底部（用户没有手动向上滚时才跟随）
  const autoScrollRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [msgs]);

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    // 无活跃对话时自动新建
    let convId = active;
    if (!convId) {
      const c = await api.agentNewSession();
      convId = c.id;
      openConv(c.id);
      await refresh();
    }
    setInput('');
    autoScrollRef.current = true;
    setBusy(true); streamRef.current = true; aiRef.current = -1;
    setMsgs((m) => { const next = [...m, { role: 'user' as const, text }, { role: 'assistant' as const, text: '', tools: [], streaming: true, thinking: '' }]; aiRef.current = next.length - 1; return next; });
    const patch = (fn: (msg: Msg) => Msg) => setMsgs((m) => { const next = [...m]; const i = aiRef.current; if (i >= 0 && next[i]) next[i] = fn(next[i]); return next; });
    const ctl = new AbortController(); abortRef.current = ctl;
    try {
      const resp = await fetch('/api/agent/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: convId, text }), signal: ctl.signal });
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
          else if (d.t === 'usage') setUsage(d.usage as Msg['usage']);
          else if (d.t === 'tool_start') patch((msg) => ({ ...msg, tools: [...(msg.tools || []), { name: d.name as string, args: d.args, durationMs: 0 }] }));
          else if (d.t === 'tool_end') patch((msg) => ({ ...msg, tools: (msg.tools || []).map((t) => ((t as ToolItem).name === d.name && !(t as ToolItem).summary ? { ...t, summary: d.summary as string, isError: d.isError as boolean, durationMs: d.durationMs as number } : t)) }));
          else if (d.t === 'open_doc') navigate('/read/' + encPath(d.path as string) + ((d.term as string) ? '?h=' + encodeURIComponent(d.term as string) : ''));
          else if (d.t === 'confirm') { setConfirmReq({ id: d.id as string, tool: d.tool as string, args: d.args }); }
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && active) { e.preventDefault(); setSearchOpen(true); }
      if (e.key === 'Escape' && searchOpen) setSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, searchOpen]);

  const richRefs = (text: string) => {
    // 同时识别 @文件名.ext 和 [文件名.ext]（模型输出的引用格式）
    const parts = text.split(/(@[^\s@[]+\.(?:md|txt|json|docx?)|\[[^[\]]+\.(?:md|txt|json|docx?)\])/gi);
    return parts.map((p, i) => {
      const at = /^@(.+)$/.exec(p);
      if (at) return <FileRef key={i} name={at[1]} />;
      // eslint-disable-next-line no-useless-escape -- 字符类内 [ 需转义以避免歧义
      const br = /^\[([^\[\]]+)\]$/.exec(p);
      if (br) return <FileRef key={i} name={br[1]} bracket />;
      return <span key={i}>{p}</span>;
    });
  };

  const ep = status?.endpoint;
  const searchHits = searchQ ? msgs.filter((m) => m.text?.toLowerCase().includes(searchQ.toLowerCase())).length : 0;

  return (
    <div className="h-full flex min-h-0 bg-background">
      {/* 可折叠可调宽侧栏 */}
      {sidebarOpen ? (
        <>
          <aside className="shrink-0 border-r border-border flex flex-col min-h-0 bg-sidebar" style={{ width: sidebarW }}>
            <div className="p-3 border-b border-sidebar-border flex items-center gap-2">
              <Button className="flex-1 text-xs rounded-lg font-medium" onClick={newConv}>
                <Plus className="w-4 h-4" />新对话
              </Button>

            </div>
            <div className="flex-1 overflow-auto p-2 space-y-0.5">
              {conversations.map((c) => (
                <div key={c.id} className={`group flex items-center gap-1.5 px-3 py-2 rounded-lg cursor-pointer text-sm transition-colors ${active === c.id ? 'bg-sidebar-accent text-primary font-medium' : 'hover:bg-sidebar-accent'}`} onClick={() => open(c.id)}>
                  <div className="truncate flex-1">{c.title || '新对话'}</div>
                  <button className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-background shrink-0" onClick={(e) => { e.stopPropagation(); del(c.id); }}>
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
              {!conversations.length && <div className="text-xs text-muted-foreground p-3 text-center">还没有对话</div>}
            </div>
            <div className="p-3 border-t border-sidebar-border text-[11px] text-muted-foreground space-y-0.5">
              {(status?.skills || []).length > 0 && <div><span className="text-primary font-medium">{status!.skills.length}</span> skills</div>}
              {(status?.mcp || []).length > 0 && <div><span className="text-primary font-medium">{status!.mcp!.filter((m) => m.enabled).length}/{status!.mcp!.length}</span> MCP</div>}
            </div>
          </aside>
          {/* 拖拽条：delta 式调宽，拖拽中高亮 */}
          <div
            className={`w-1.5 cursor-col-resize transition-colors shrink-0 ${dragRef.current ? 'bg-primary/40' : 'hover:bg-primary/30'}`}
            onMouseDown={(e) => {
              e.preventDefault();
              dragRef.current = { startX: e.clientX, w0: sidebarW };
              document.body.style.cursor = 'col-resize';
              document.body.style.userSelect = 'none';
            }}
            title="拖拽调整列表宽度"
          />
        </>
      ) : null}

      {/* 主区域 */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* 顶栏 */}
        <div className="shrink-0 px-4 py-2.5 border-b border-border flex items-center gap-2.5 flex-wrap bg-card">
          <button className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground shrink-0" onClick={() => setSidebarOpen((v) => !v)} title={sidebarOpen ? '折叠对话列表' : '展开对话列表'}>
            {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
          </button>
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold">智能助手</span>
          </div>
          {!ep?.ready && <button className="text-xs text-warning underline" onClick={() => setSettingsOpen(true)}>去配置</button>}
          <span className="flex-1" />
          {active && (
            <>
              <button className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground" title="搜索 (Ctrl+F)" onClick={() => setSearchOpen(true)}><Search className="w-3.5 h-3.5" /></button>
              <button className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground" title="导出" onClick={doExport}><Download className="w-3.5 h-3.5" /></button>
            </>
          )}
          <button className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground" title="Agent 设置" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 搜索 */}
        {searchOpen && (
          <div className="shrink-0 border-b border-border px-4 py-2 flex items-center gap-2 bg-muted/30">
            <Search className="w-3.5 h-3.5 text-muted-foreground" />
            <input autoFocus value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="搜索…" className="flex-1 bg-transparent text-sm outline-none" />
            <span className="text-xs text-muted-foreground">{searchHits} 条</span>
            <button onClick={() => { setSearchOpen(false); setSearchQ(''); }} className="p-1 rounded hover:bg-accent transition-colors"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        {/* 消息 */}
        <div ref={scrollRef} className="flex-1 overflow-auto px-4 py-6 wb-selectable">
          {!active && (
            <div className="h-full flex flex-col items-center justify-center gap-6">
              <div className="flex items-center gap-2 text-muted-foreground"><Bot className="w-8 h-8" /><span className="text-lg font-medium">智能助手</span></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-w-2xl">
                {TEMPLATES.map((t, i) => (
                  <button key={i} className="flex flex-col gap-2 border rounded-xl p-4 text-left hover:border-primary/50 hover:shadow-sm transition-all group" onClick={() => { setInput(t.prompt); }}>
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
              const isHit = searchQ && m.text?.toLowerCase().includes(searchQ.toLowerCase());
              return (
                <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
                  {m.role === 'user' ? (
                    <div className={`max-w-[80%] group/msg ${isHit ? 'ring-2 ring-warning/60 rounded-2xl' : ''}`}>
                      {m.editing ? (
                        <div className="rounded-2xl border border-primary/40 bg-card p-3">
                          <textarea autoFocus defaultValue={m.text} rows={3} className="w-full text-sm bg-transparent outline-none resize-none" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editMsg(i, (e.target as HTMLTextAreaElement).value); } if (e.key === 'Escape') setMsgs((ms) => ms.map((x, j) => (j === i ? { ...x, editing: false } : x))); }} />
                          <div className="flex gap-1.5 justify-end mt-1">
                            <Button variant="outline" size="sm" className="text-xs" onClick={() => setMsgs((ms) => ms.map((x, j) => (j === i ? { ...x, editing: false } : x)))}>取消</Button>
                            <Button size="sm" className="text-xs" onClick={(e) => editMsg(i, (e.target as HTMLElement).parentElement?.previousElementSibling?.textContent || '')}>保存</Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="rounded-2xl rounded-br-md px-4 py-2.5 text-sm whitespace-pre-wrap break-words bg-primary text-primary-foreground leading-relaxed">{m.text}</div>
                          <div className="opacity-0 group-hover/msg:opacity-100 flex justify-end gap-0.5 mt-0.5 transition-opacity">
                            <button className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground" title="重新生成此后内容" onClick={() => regenerate(i)}><RotateCcw className="w-3 h-3" /></button>
                            <button className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground" title="编辑" onClick={() => setMsgs((ms) => ms.map((x, j) => (j === i ? { ...x, editing: true } : x)))}><Pencil className="w-3 h-3" /></button>
                            <button className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground" title="删除" onClick={() => deleteMsg(i)}><Trash className="w-3 h-3" /></button>
                          </div>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className={`max-w-full group/msg rounded-lg ${isHit ? 'ring-2 ring-warning/60 ring-offset-2' : ''}`}>
                      {m.thinking && <ThinkingBlock text={m.thinking} streaming={m.streaming && !m.text} />}
                      {(m.tools || []).map((t, j) => <ToolCard key={j} t={t as ToolItem} />)}
                      {m.text && <div className={m.error ? 'text-destructive' : ''}><MarkdownMsg text={m.text} richRefs={richRefs} /></div>}
                      {m.streaming && !m.text && !m.thinking && !(m.tools || []).length && (
                        <div className="flex items-center gap-1.5 py-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse [animation-delay:200ms]" />
                          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse [animation-delay:400ms]" />
                        </div>
                      )}
                      {!m.streaming && m.text && (
                        <div className="opacity-0 group-hover/msg:opacity-100 flex items-center gap-0.5 mt-1 transition-opacity">
                          <button className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground" title="复制" onClick={() => copyMsg(i)}>
                            {copied === i ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                          <button className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground" title="分叉" onClick={() => fork(i)}><GitBranch className="w-3.5 h-3.5" /></button>
                          <button className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground" title="重新生成此回复" onClick={() => regenerate(i)}><RotateCcw className="w-3.5 h-3.5" /></button>
                          <button className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground" title="编辑" onClick={() => setMsgs((ms) => ms.map((x, j) => (j === i ? { ...x, editing: true } : x)))}><Pencil className="w-3.5 h-3.5" /></button>
                          <button className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground" title="删除" onClick={() => deleteMsg(i)}><Trash className="w-3.5 h-3.5" /></button>
                        </div>
                      )}
                      {m.editing && (
                        <div className="mt-2 rounded-lg border border-primary/40 bg-card p-3">
                          <textarea autoFocus defaultValue={m.text} rows={6} className="w-full text-sm bg-transparent outline-none resize-none font-mono" onKeyDown={(e) => { if (e.key === 'Escape') setMsgs((ms) => ms.map((x, j) => (j === i ? { ...x, editing: false } : x))); }} />
                          <div className="flex gap-1.5 justify-end mt-1">
                            <Button variant="outline" size="sm" className="text-xs" onClick={() => setMsgs((ms) => ms.map((x, j) => (j === i ? { ...x, editing: false } : x)))}>取消</Button>
                            <Button size="sm" className="text-xs" onClick={(e) => editMsg(i, (e.target as HTMLElement).parentElement?.previousElementSibling?.textContent || '')}>保存</Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 输入区（含上下文指示） */}
        <div className="shrink-0 border-t border-border bg-card">
          <div className="max-w-3xl mx-auto px-3 pt-2.5 pb-1.5">
            <ChatInput value={input} onChange={setInput} onSend={send} onStop={stop} busy={busy} disabled={!ep?.ready} placeholder={ep?.ready ? '提问 · / 命令 · @ 文件 · Enter 发送' : '去设置面板配置端点'} onCommand={doCommand} />
          </div>
          {/* 模型/思考/模式选择器 */}
          <div className="max-w-3xl mx-auto px-4 pb-2.5 flex items-center gap-2 text-xs flex-wrap">
            {/* 模型选择 */}
            <div className="relative">
              <button className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border hover:border-primary/40 text-muted-foreground font-mono" onClick={async () => {
                const r = await api.agentModels().catch(() => ({ models: [] }));
                setModelList(r.models || []);
                setModelOpen((v) => !v);
              }}>
                {ep?.model || '选择模型'} <ChevronDown className="w-3 h-3" />
              </button>
              {modelOpen && (
                <div className="absolute bottom-full left-0 mb-1 bg-card border rounded-lg shadow-lg p-1 z-30 min-w-44 max-w-[90vw] max-h-56 overflow-auto">
                  {modelList.map((m) => (
                    <button key={m} className={`w-full text-left px-2.5 py-1.5 rounded text-xs font-mono ${m === ep?.model ? 'bg-accent text-primary' : 'hover:bg-accent transition-colors'}`}
                      onClick={async () => { await api.agentSettings({ model: m }); setModelOpen(false); refresh(); }}>
                      {m}
                    </button>
                  ))}
                  {!modelList.length && <div className="px-2.5 py-2 text-xs text-muted-foreground">未拉到列表</div>}
                </div>
              )}
            </div>
            {/* 思考强度 */}
            <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
              {(['off', 'low', 'medium', 'high'] as const).map((lv) => (
                <button key={lv}
                  className={`px-1.5 py-0.5 rounded text-[11px] transition-colors ${ep?.thinkingLevel === lv ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={async () => { await api.agentSettings({ thinkingLevel: lv }); refresh(); }}>
                  {lv === 'off' ? '思考关' : lv === 'low' ? '低' : lv === 'medium' ? '中' : '高'}
                </button>
              ))}
            </div>
            {/* 运行模式 */}
            <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
              {([
                { v: 'auto', icon: ShieldCheck, label: '自动' },
                { v: 'confirm', icon: ShieldAlert, label: '确认' },
                { v: 'readonly', icon: Eye, label: '只读' },
              ] as const).map(({ v, icon: Icon, label }) => (
                <button key={v}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${(status?.mode || 'auto') === v ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={async () => { await api.agentSettings({ mode: v }); refresh(); }}>
                  <Icon className="w-3 h-3" />{label}
                </button>
              ))}
            </div>
            {/* 模式说明 */}
            {usage && <div className="ml-auto"><ContextBar usage={usage} contextWindow={CTX_WINDOW} /></div>}
          </div>
        </div>

        {/* 确认对话框 */}
        {confirmReq && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div className="bg-card border border-warning/50 rounded-2xl shadow-2xl p-5 w-96 max-w-[90vw]">
              <h3 className="text-sm font-semibold flex items-center gap-2 mb-2">
                <ShieldAlert className="w-4 h-4 text-warning" />
                确认执行：{confirmReq.tool}
              </h3>
              <pre className="text-xs bg-muted rounded-lg p-2.5 max-h-40 overflow-auto mb-3">{JSON.stringify(confirmReq.args, null, 2)}</pre>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={async () => { await api.agentConfirm(confirmReq.id, false); setConfirmReq(null); }}>
                  取消
                </Button>
                <Button size="sm" onClick={async () => { await api.agentConfirm(confirmReq.id, true); setConfirmReq(null); }}>
                  确认执行
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 后台完成 toast */}
      {toast && (
        <div className="fixed bottom-24 right-4 z-50 bg-card border border-primary/30 rounded-xl shadow-lg px-4 py-2.5 text-sm flex items-center gap-2">
          <Check className="w-4 h-4 text-success" />
          {toast}
          <button className="ml-2 text-xs text-primary underline" onClick={() => {
            const c = conversations.find((x) => toast.includes(x.title || ''));
            if (c) setActive(c.id);
            setToast(null);
          }}>查看</button>
        </div>
      )}

      {/* 设置面板 */}
      {settingsOpen && status && (
        <AgentSettingsPanel status={status} onClose={() => setSettingsOpen(false)} onSaved={() => { refresh(); }} />
      )}
    </div>
  );
}

function FileRef({ name, bracket }: { name: string; bracket?: boolean }) {
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
  const label = bracket ? `[${name}]` : `@${name}`;
  if (hit === undefined) return <span className="text-primary/50">{label}</span>;
  if (hit === null) return <span className="text-muted-foreground">{label}</span>;
  return (
    <button
      className="text-primary underline underline-offset-2 hover:text-primary/80"
      title={`打开 ${hit}`}
      onClick={() => navigate('/read/' + encPath(hit))}
    >
      {label}
    </button>
  );
}
