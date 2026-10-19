// 智能助手设置面板（模型/端点/思考强度/skills/MCP）
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import type { AgentStatus, AgentSettingsPatch } from '@/lib/api';
import { X, RefreshCw, Brain, Plug, Wrench, BookOpen } from 'lucide-react';

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

  useEffect(() => {
    api.agentModels().then((r) => setModels(r.models || [])).catch(() => {});
  }, [baseUrl]);

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
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground w-16 shrink-0">模型</span>
              {models.length > 0 ? (
                <select value={model} onChange={(e) => setModel(e.target.value)} className="flex-1 px-2.5 py-1.5 rounded-lg border border-input bg-background">
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : (
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="qwen2.5:7b" className="flex-1 px-2.5 py-1.5 rounded-lg border border-input bg-background" />
              )}
            </label>
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
          <h3 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1"><BookOpen className="w-3 h-3" />Skills</h3>
          {(status.skills || []).length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {status.skills.map((sk) => <span key={sk} className="px-2 py-1 rounded-full bg-primary/10 text-primary text-xs">{sk}</span>)}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">暂无。放置 SKILL.md 到应用数据 agent/skills/&lt;名称&gt;/ 即可。</p>
          )}
        </section>

        {/* MCP */}
        <section className="mb-5">
          <h3 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1"><Plug className="w-3 h-3" />MCP 服务器</h3>
          {(status.mcp || []).length > 0 ? (
            <div className="space-y-1 text-xs">
              {status.mcp!.map((m) => (
                <div key={m.name} className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${m.enabled ? 'bg-green-500' : 'bg-muted-foreground'}`} />
                  <span className="font-mono">{m.name}</span>
                  <span className="text-muted-foreground">{m.type}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">暂无。配置 agent/mcp.json 即可。</p>
          )}
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
