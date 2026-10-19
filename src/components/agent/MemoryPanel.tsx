// 记忆管理面板：三层记忆（全局 / Agent / 库）的查看、增删改、固定、整理
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { MemoryFact, MemoryPayload } from '@/lib/api';
import {
  Brain, Globe, User, Library, Plus, Trash, Pin, PinOff, Sparkles,
  RefreshCw, Check, Pencil, X,
} from 'lucide-react';

const SCOPES = [
  { id: 'global', label: '全局', icon: Globe, hint: '用户偏好，跨库有效 · 全量注入' },
  { id: 'agent', label: 'Agent', icon: User, hint: '这个 Agent 的习性 · 全量注入' },
  { id: 'library', label: '本库', icon: Library, hint: '当前资料库的知识 · 摘要+固定项注入，其余需检索' },
] as const;

export function MemoryPanel() {
  const [scope, setScope] = useState<(typeof SCOPES)[number]['id']>('library');
  const [data, setData] = useState<MemoryPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [newFact, setNewFact] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async (s = scope) => {
    setLoading(true);
    try {
      setData(await api.memoryGet(s));
      setMsg('');
    } catch (e) {
      setMsg('加载失败：' + (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => { load(scope); }, [scope, load]);

  const add = async () => {
    const text = newFact.trim();
    if (!text) return;
    try {
      await api.memoryAdd({ scope, fact: text });
      setNewFact('');
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const togglePin = async (f: MemoryFact) => {
    try {
      await api.memoryUpdate(f.id, { scope, pinned: !f.pinned });
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const saveEdit = async (f: MemoryFact) => {
    try {
      await api.memoryUpdate(f.id, { scope, fact: editingText });
      setEditingId(null);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const del = async (f: MemoryFact) => {
    if (!window.confirm('删除这条记忆？')) return;
    await api.memoryDelete(f.id, scope).catch(() => {});
    await load();
  };

  const consolidate = async () => {
    setMsg('整理中…');
    try {
      const r = await api.memoryConsolidate(scope);
      setMsg(`已整理：摘要 ${r.summaryChars} 字，保留 ${r.kept} 条${r.dropped ? `，归档 ${r.dropped} 条` : ''}`);
      await load();
    } catch (e) {
      setMsg('整理失败：' + (e as Error).message);
    }
  };

  const cur = SCOPES.find((s) => s.id === scope)!;
  const stats = data?.stats?.[scope];

  return (
    <div>
      {/* 作用域切换 */}
      <div className="flex items-center gap-1 mb-3">
        {SCOPES.map((s) => (
          <button
            key={s.id}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${scope === s.id ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted'}`}
            onClick={() => setScope(s.id)}
          >
            <s.icon className="w-3.5 h-3.5" />{s.label}
            {data?.stats?.[s.id] && <span className="tabular-nums opacity-60">{data.stats[s.id].facts}</span>}
          </button>
        ))}
        <span className="flex-1" />
        <button className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground" onClick={() => load()} title="刷新">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
        <button className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-accent" onClick={consolidate}>
          <Sparkles className="w-3.5 h-3.5" />整理
        </button>
      </div>

      <p className="text-[11px] text-muted-foreground mb-3">{cur.hint}</p>

      {/* 统计 */}
      {stats && (
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground mb-3">
          <span><span className="text-primary font-medium tabular-nums">{stats.facts}</span> 条记忆</span>
          <span><Pin className="w-3 h-3 inline" /> <span className="tabular-nums">{stats.pinned}</span>/20 固定</span>
          <span>摘要 {stats.summaryChars} 字</span>
        </div>
      )}

      {msg && <div className="text-xs text-muted-foreground mb-2">{msg}</div>}

      {/* 新增 */}
      <div className="flex items-center gap-2 mb-3">
        <input
          value={newFact}
          onChange={(e) => setNewFact(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder="手动添加一条记忆…"
          className="flex-1 px-2.5 py-1.5 rounded-lg border border-input bg-background text-sm"
        />
        <button className="px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs flex items-center gap-1" onClick={add} disabled={!newFact.trim()}>
          <Plus className="w-3.5 h-3.5" />添加
        </button>
      </div>

      {/* 摘要 */}
      {data?.summary && (
        <div className="mb-3 p-3 rounded-lg bg-muted/40 border border-border">
          <div className="text-[11px] text-muted-foreground mb-1 flex items-center gap-1"><Brain className="w-3 h-3" />摘要（会注入对话）</div>
          <div className="text-xs whitespace-pre-wrap leading-relaxed">{data.summary}</div>
        </div>
      )}

      {/* 记忆列表 */}
      {(data?.facts || []).length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          <Brain className="w-8 h-8 mx-auto mb-2 opacity-40" />
          暂无记忆。对话中 Agent 会自动记录，也可手动添加。
        </div>
      ) : (
        <div className="space-y-1">
          {[...(data!.facts)].reverse().map((f) => (
            <div key={f.id} className="group flex items-start gap-2 px-2.5 py-2 rounded-lg border border-border hover:border-primary/30 text-sm">
              <span className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${f.pinned ? 'bg-amber-500' : 'bg-muted-foreground/40'}`} />
              <div className="flex-1 min-w-0">
                {editingId === f.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(f); if (e.key === 'Escape') setEditingId(null); }}
                      className="flex-1 px-2 py-1 rounded border border-primary/40 bg-background text-sm"
                    />
                    <button className="p-1 rounded hover:bg-accent" onClick={() => saveEdit(f)}><Check className="w-3.5 h-3.5 text-green-600" /></button>
                    <button className="p-1 rounded hover:bg-accent" onClick={() => setEditingId(null)}><X className="w-3.5 h-3.5" /></button>
                  </div>
                ) : (
                  <div className="leading-relaxed">{f.fact}</div>
                )}
                <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2">
                  <span>{f.kind}</span>
                  <span>{f.at ? new Date(f.at).toLocaleDateString('zh-CN') : ''}</span>
                  {f.source && f.source !== 'user' && <span>来自对话</span>}
                  {f.pinned && <span className="text-amber-600">固定</span>}
                </div>
              </div>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
                <button className="p-1 rounded hover:bg-accent text-muted-foreground" title={f.pinned ? '取消固定' : '固定（永不淘汰且总是注入）'} onClick={() => togglePin(f)}>
                  {f.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
                </button>
                <button className="p-1 rounded hover:bg-accent text-muted-foreground" title="编辑" onClick={() => { setEditingId(f.id); setEditingText(f.fact); }}>
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive" title="删除" onClick={() => del(f)}>
                  <Trash className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground mt-3">
        记忆改动在下一次新建对话时生效（当前对话的系统提示词已固定）
      </p>
    </div>
  );
}
