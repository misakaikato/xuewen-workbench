// 智能助手设置面板（多 tab）：模型端点 / Skills / MCP
import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import type { AgentStatus, AgentSettingsPatch } from '@/lib/api';
import {
  X, RefreshCw, Brain, Plug, Wrench, BookOpen, Plus, Trash,
  Cpu, Check,
} from 'lucide-react';

const THINKING_LEVELS = [
  { v: 'off', label: '关' }, { v: 'low', label: '低' },
  { v: 'medium', label: '中' }, { v: 'high', label: '高' },
];

const TABS = [
  { id: 'model', label: '模型端点', icon: Cpu },
  { id: 'skills', label: 'Skills', icon: BookOpen },
  { id: 'mcp', label: 'MCP', icon: Plug },
] as const;

export function AgentSettingsPanel({ status, onClose, onSaved }: { status: AgentStatus; onClose: () => void; onSaved: () => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('model');
  const [baseUrl, setBaseUrl] = useState(status.endpoint.baseUrl);
  const [model, setModel] = useState(status.endpoint.model);
  const [apiKey, setApiKey] = useState('');
  const [thinking, setThinking] = useState(status.endpoint.thinkingLevel || 'off');
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  // 模型拉取：优先走服务端（无 CORS 问题），手动刷新
  const loadModels = useCallback(async (url?: string) => {
    setModelsLoading(true);
    setModels([]);
    try {
      // 如果用户改了 baseUrl 但还没保存，先保存再拉
      if (url && url !== status.endpoint.baseUrl) {
        await api.agentSettings({ baseUrl: url });
      }
      const r = await api.agentModels();
      setModels(r.models || []);
      if (!(r.models || []).length) setMsg('端点未返回模型列表（检查 baseUrl 是否正确）');
      else setMsg('');
    } catch (e) {
      setMsg('拉取失败：' + (e as Error).message);
    } finally {
      setModelsLoading(false);
    }
  }, [status.endpoint.baseUrl]);

  useEffect(() => { loadModels(baseUrl); }, []); // 首次打开即拉

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      const patch: AgentSettingsPatch = { baseUrl, model, thinkingLevel: thinking as AgentSettingsPatch['thinkingLevel'] };
      if (apiKey) patch.apiKey = apiKey;
      await api.agentSettings(patch);
      setMsg('已保存' + (baseUrl !== status.endpoint.baseUrl ? '（端点变更，现有对话将重建上下文）' : ''));
      onSaved();
    } catch (e) { setMsg('保存失败：' + (e as Error).message);
    } finally { setSaving(false); }
  };

  const testConn = async () => {
    setMsg('测试中…');
    try {
      const r = await api.ragLlmTest();
      setMsg(r.ok ? `连通 OK${r.models?.length ? '（${r.models.length} 个模型）' : ''}` : '失败：' + r.error);
    } catch (e) { setMsg('失败：' + (e as Error).message); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-[560px] max-w-[94vw] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* 标题 */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <h2 className="text-base font-semibold flex items-center gap-2"><Brain className="w-5 h-5 text-primary" />Agent 设置</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-accent"><X className="w-4 h-4" /></button>
        </div>

        {/* Tab 导航 */}
        <div className="flex items-center gap-1 px-5 py-2 border-b border-border shrink-0">
          {TABS.map((t) => (
            <button key={t.id}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${tab === t.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
              onClick={() => setTab(t.id)}>
              <t.icon className="w-3.5 h-3.5" />{t.label}
            </button>
          ))}
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-auto p-5">

        {/* ===== 模型端点 Tab ===== */}
        {tab === 'model' && (
          <>
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-16 shrink-0 text-xs">baseURL</span>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} onBlur={() => loadModels(baseUrl)}
                  placeholder="http://localhost:11434/v1" className="flex-1 px-2.5 py-1.5 rounded-lg border border-input bg-background" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-16 shrink-0 text-xs">模型</span>
                {models.length > 0 ? (
                  <select value={model} onChange={(e) => setModel(e.target.value)} className="flex-1 px-2.5 py-1.5 rounded-lg border border-input bg-background">
                    {!models.includes(model) && <option value={model}>{model}（当前）</option>}
                    {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型名" className="flex-1 px-2.5 py-1.5 rounded-lg border border-input bg-background" />
                )}
                <button className="p-1.5 rounded-lg border border-border hover:bg-accent text-muted-foreground shrink-0" title="刷新模型列表" onClick={() => loadModels(baseUrl)} disabled={modelsLoading}>
                  <RefreshCw className={`w-3.5 h-3.5 ${modelsLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
              {models.length > 0 && <p className="text-[11px] text-muted-foreground pl-[72px] flex items-center gap-1"><Check className="w-3 h-3 text-green-600" />从端点拉到 {models.length} 个模型</p>}
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-16 shrink-0 text-xs">apiKey</span>
                <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="本地服务通常留空" type="password" className="flex-1 px-2.5 py-1.5 rounded-lg border border-input bg-background" />
              </div>
            </div>

            <div className="mt-4">
              <h3 className="text-xs font-medium text-muted-foreground mb-2">思考强度</h3>
              <div className="flex items-center gap-1.5">
                {THINKING_LEVELS.map((t) => (
                  <button key={t.v} className={`px-3 py-1.5 rounded-lg text-xs border ${thinking === t.v ? 'border-violet-500 text-violet-600 font-medium bg-violet-500/5' : 'border-border hover:border-violet-500/40'}`} onClick={() => setThinking(t.v)}>
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">需要模型支持扩展思考（qwen3 / o1 等）</p>
            </div>

            <div className="mt-4">
              <h3 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1"><Wrench className="w-3 h-3" />可用工具（{status.tools?.length || 0}）</h3>
              <div className="flex flex-wrap gap-1">{(status.tools || []).map((t) => <code key={t} className="px-1.5 py-0.5 rounded bg-muted text-[11px]">{t}</code>)}</div>
            </div>
          </>
        )}

        {/* ===== Skills Tab ===== */}
        {tab === 'skills' && (
          <>
            <p className="text-xs text-muted-foreground mb-3">目录：<code className="text-primary">{status.agentDir}/skills/</code></p>
            {(status.skills || []).length > 0 ? (
              <div className="space-y-1.5">
                {status.skills.map((sk) => (
                  <div key={sk} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm group hover:border-primary/30">
                    <BookOpen className="w-4 h-4 text-primary shrink-0" />
                    <span className="font-medium flex-1">{sk}</span>
                    <button className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive" title="删除"
                      onClick={async () => { if (!window.confirm(`删除 skill "${sk}"？`)) return; await fetch(`/api/agent/skill/${encodeURIComponent(sk)}`, { method: 'DELETE' }); onSaved(); }}>
                      <Trash className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <BookOpen className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">暂无 skills</p>
              </div>
            )}
            <label className="mt-3 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-primary/40 text-primary hover:bg-primary/5 cursor-pointer">
              <Plus className="w-3.5 h-3.5" />上传 SKILL.md
              <input type="file" accept=".md" className="hidden" onChange={async (e) => {
                const f = e.target.files?.[0]; if (!f) return;
                const name = f.name.replace(/\.md$/i, '');
                const content = await f.text();
                await fetch('/api/agent/skill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content }) });
                onSaved();
              }} />
            </label>
          </>
        )}

        {/* ===== MCP Tab ===== */}
        {tab === 'mcp' && (
          <>
            <p className="text-xs text-muted-foreground mb-3">配置：<code className="text-primary">{status.agentDir}/mcp.json</code></p>
            {(status.mcp || []).length > 0 ? (
              <div className="space-y-1.5">
                {status.mcp!.map((m) => (
                  <div key={m.name} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm group hover:border-primary/30">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${m.enabled ? 'bg-green-500' : 'bg-muted-foreground'}`} />
                    <span className="font-mono">{m.name}</span>
                    <span className="text-muted-foreground text-xs">{m.type}</span>
                    {m.url && <span className="text-muted-foreground text-xs truncate flex-1">{m.url}</span>}
                    <button className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive" title="删除"
                      onClick={async () => { if (!window.confirm(`删除 MCP "${m.name}"？`)) return; await fetch(`/api/agent/mcp-server/${encodeURIComponent(m.name)}`, { method: 'DELETE' }); onSaved(); }}>
                      <Trash className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Plug className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">暂无 MCP 服务器</p>
              </div>
            )}
            <details className="mt-3">
              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-primary">添加 MCP 服务器</summary>
              <div className="mt-2 space-y-2 border border-border rounded-xl p-3 text-sm">
                <input data-mcp="name" placeholder="名称" className="w-full px-2.5 py-1.5 rounded-lg border border-input bg-background" />
                <select data-mcp="type" className="w-full px-2.5 py-1.5 rounded-lg border border-input bg-background">
                  <option value="http">HTTP</option><option value="stdio">stdio（本地命令）</option>
                </select>
                <input data-mcp="url" placeholder="URL 或命令" className="w-full px-2.5 py-1.5 rounded-lg border border-input bg-background" />
                <button className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs" onClick={async (e) => {
                  const root = (e.target as HTMLElement).closest('details')!;
                  const q = (s: string) => root.querySelector(`[data-mcp="${s}"]`) as HTMLInputElement;
                  const name = q('name')?.value?.trim(); const type = q('type')?.value; const url = q('url')?.value?.trim();
                  if (!name || !url) return;
                  const cfg = type === 'http' ? { url } : { command: url.split(' ')[0], args: url.split(' ').slice(1) };
                  await fetch('/api/agent/mcp-server', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, config: cfg }) });
                  onSaved();
                }}>添加</button>
              </div>
            </details>
          </>
        )}
        </div>

        {/* 底部操作（仅模型 tab） */}
        {tab === 'model' && (
          <div className="flex items-center gap-2 px-5 py-3 border-t border-border shrink-0">
            <button className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90 disabled:opacity-40" disabled={saving || !baseUrl || !model} onClick={save}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent" onClick={testConn}>测试连通</button>
            {msg && <span className="text-xs text-muted-foreground flex-1 truncate">{msg}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
