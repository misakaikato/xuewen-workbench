// 智能助手设置面板（模型/端点/思考强度/skills/MCP）
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import type { AgentStatus, AgentSettingsPatch } from '@/lib/api';
import { X, RefreshCw, Brain, Plug, Wrench, BookOpen, Plus, Trash } from 'lucide-react';

const THINKING_LEVELS = [
  { v: 'off', label: '关闭' },
  { v: 'low', label: '低' },
  { v: 'medium', label: '中' },
  { v: 'high', label: '高' },
];

export function AgentSettingsPanel({ status, onClose, onSaved }: { status: AgentStatus; onClose: () => void; onSaved: () => void }) {
  const [baseUrl, setBaseUrl] = useState(status.endpoint.baseUrl);
  const [model, setModel] = useState(status.endpoint.model);
  const [apiKey, setApiKey] = useState('');
  const [thinking, setThinking] = useState(status.endpoint.thinkingLevel || 'off');
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const loadModels = async () => {
    setModels([]);
    // 先用当前输入的 baseUrl 试拉
    try {
      const r = await fetch(baseUrl.replace(/\/$/, '') + '/models', {
        headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
        signal: AbortSignal.timeout(5000),
      }).then((r) => r.json());
      setModels((r.data || []).map((m: { id: string }) => m.id).slice(0, 50));
    } catch {
      // 回退到服务端代理拉取
      api.agentModels().then((r) => setModels(r.models || [])).catch(() => {});
    }
  };

  useEffect(() => {
    const t = setTimeout(loadModels, 600); // 防抖
    return () => clearTimeout(t);
  }, [baseUrl, apiKey]);

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      const patch: AgentSettingsPatch = { baseUrl, model, thinkingLevel: thinking as AgentSettingsPatch['thinkingLevel'] };
      if (apiKey) patch.apiKey = apiKey;
      await api.agentSettings(patch);
      setMsg('已保存（模型变更后现有对话将使用新模型重启上下文）');
      onSaved();
    } catch (e) {
      setMsg('保存失败：' + (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const testConn = async () => {
    setMsg('测试中…');
    try {
      const r = await api.ragLlmTest();
      setMsg(r.ok ? `连通 OK${r.models?.length ? '：' + r.models.slice(0, 5).join('、') : ''}` : '失败：' + r.error);
    } catch (e) {
      setMsg('失败：' + (e as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl shadow-2xl p-6 w-[480px] max-w-[92vw] max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Brain className="w-5 h-5 text-primary" />Agent 设置
          </h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-accent"><X className="w-4 h-4" /></button>
        </div>

        {/* 模型端点 */}
        <section className="mb-5">
          <h3 className="text-xs font-medium text-muted-foreground mb-2">模型端点（OpenAI 兼容）</h3>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground w-16 shrink-0">baseURL</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" className="flex-1 px-2.5 py-1.5 rounded-lg border border-input bg-background" />
            </label>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground w-16 shrink-0">模型</span>
              {models.length > 0 ? (
                <select value={model} onChange={(e) => setModel(e.target.value)} className="flex-1 px-2.5 py-1.5 rounded-lg border border-input bg-background">
                  {models.includes(model) || <option value={model}>{model}</option>}
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : (
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="qwen2.5:7b" className="flex-1 px-2.5 py-1.5 rounded-lg border border-input bg-background" />
              )}
              <button className="p-1.5 rounded-lg border border-border hover:bg-accent text-muted-foreground shrink-0" title="从端点拉取模型列表" onClick={loadModels}>
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
            {models.length > 0 && <p className="text-[11px] text-muted-foreground pl-[72px]">从端点拉到 {models.length} 个模型</p>}
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground w-16 shrink-0">apiKey</span>
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="（本地通常留空）" type="password" className="flex-1 px-2.5 py-1.5 rounded-lg border border-input bg-background" />
            </label>
          </div>
        </section>

        {/* 思考强度 */}
        <section className="mb-5">
          <h3 className="text-xs font-medium text-muted-foreground mb-2">思考强度</h3>
          <div className="flex items-center gap-1.5">
            {THINKING_LEVELS.map((t) => (
              <button key={t.v} className={`px-3 py-1.5 rounded-lg text-xs border ${thinking === t.v ? 'border-primary text-primary font-medium bg-primary/5' : 'border-border hover:border-primary/40'}`} onClick={() => setThinking(t.v)}>
                {t.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">需要模型支持扩展思考（如 qwen3、o1 系列）</p>
        </section>

        {/* Skills */}
        <section className="mb-5">
          <h3 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
            <BookOpen className="w-3 h-3" />Skills
            <span className="ml-auto text-[10px]">{status.agentDir}/skills/</span>
          </h3>
          {(status.skills || []).length > 0 ? (
            <div className="space-y-1">
              {status.skills.map((sk) => (
                <div key={sk} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-border text-xs group hover:border-primary/30">
                  <BookOpen className="w-3 h-3 text-primary shrink-0" />
                  <span className="font-medium flex-1">{sk}</span>
                  <button className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive" title="删除"
                    onClick={async () => { if (!window.confirm(`删除 skill "${sk}"？`)) return; await fetch(`/api/agent/skill/${encodeURIComponent(sk)}`, { method: 'DELETE' }); onSaved(); }}>
                    <Trash className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">暂无 skills</p>
          )}
          <label className="mt-2 inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-border hover:bg-accent cursor-pointer">
            <Plus className="w-3 h-3" />上传 SKILL.md
            <input type="file" accept=".md" className="hidden" onChange={async (e) => {
              const f = e.target.files?.[0]; if (!f) return;
              const name = f.name.replace(/\.md$/i, '');
              const content = await f.text();
              await fetch('/api/agent/skill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content }) });
              onSaved();
            }} />
          </label>
        </section>

        {/* MCP */}
        <section className="mb-5">
          <h3 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
            <Plug className="w-3 h-3" />MCP 服务器
            <span className="ml-auto text-[10px]">{status.agentDir}/mcp.json</span>
          </h3>
          {(status.mcp || []).length > 0 ? (
            <div className="space-y-1">
              {status.mcp!.map((m) => (
                <div key={m.name} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-border text-xs group hover:border-primary/30">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${m.enabled ? 'bg-green-500' : 'bg-muted-foreground'}`} />
                  <span className="font-mono">{m.name}</span>
                  <span className="text-muted-foreground">{m.type}</span>
                  {m.url && <span className="text-muted-foreground truncate flex-1 text-[10px]">{m.url}</span>}
                  <button className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive" title="删除"
                    onClick={async () => { if (!window.confirm(`删除 MCP "${m.name}"？`)) return; await fetch(`/api/agent/mcp-server/${encodeURIComponent(m.name)}`, { method: 'DELETE' }); onSaved(); }}>
                    <Trash className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">暂无 MCP 服务器</p>
          )}
          <details className="mt-2">
            <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-primary">添加 MCP 服务器</summary>
            <div className="mt-1.5 space-y-1.5 text-xs border border-border rounded-lg p-2">
              <input data-mcp="name" placeholder="名称" className="w-full px-2 py-1 rounded border border-input bg-background" />
              <select data-mcp="type" className="w-full px-2 py-1 rounded border border-input bg-background">
                <option value="http">HTTP</option><option value="stdio">stdio</option>
              </select>
              <input data-mcp="url" placeholder="URL 或命令" className="w-full px-2 py-1 rounded border border-input bg-background" />
              <button className="px-2.5 py-1 rounded bg-primary text-primary-foreground" onClick={async (e) => {
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
        </section>

        {/* 工具 */}
        <section className="mb-5">
          <h3 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1"><Wrench className="w-3 h-3" />工具（{status.tools?.length || 0} 个）</h3>
          <div className="flex flex-wrap gap-1">
            {(status.tools || []).map((t) => <code key={t} className="px-1.5 py-0.5 rounded bg-muted text-[11px]">{t}</code>)}
          </div>
        </section>

        <div className="flex items-center gap-2 pt-3 border-t border-border">
          <button className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90 disabled:opacity-40" disabled={saving || !baseUrl || !model} onClick={save}>
            {saving ? '保存中…' : '保存设置'}
          </button>
          <button className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent" onClick={testConn}>
            <RefreshCw className="w-3.5 h-3.5 inline mr-1" />测试连通
          </button>
          {msg && <span className="text-xs text-muted-foreground flex-1">{msg}</span>}
        </div>
      </div>
    </div>
  );
}
