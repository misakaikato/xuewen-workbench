// 工具调用卡片：可折叠、显示时序、参数/结果预览
// 运行中：转圈 + 实时计时（不再显示「0ms」）；流中断/停止时仍在运行的标记「已中断」
import { useState } from 'react';
import { Wrench, ChevronRight, ChevronDown, Clock, Loader2, AlertTriangle } from 'lucide-react';
import type { AgentToolItem } from '@/lib/agentReducer';
import { useNow } from '@/hooks/useNow';

export type ToolItem = AgentToolItem;

// 运行中计时：每 200ms 刷新
function RunningTime({ startedAt }: { startedAt: number }) {
  const now = useNow(true, 200);
  const s = now ? (now - startedAt) / 1000 : 0;
  const text = s >= 60
    ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    : s.toFixed(1) + 's';
  return (
    <span className="text-primary flex items-center gap-0.5 shrink-0 tabular-nums" data-tool-running>
      <Loader2 className="w-2.5 h-2.5 animate-spin" />{text}
    </span>
  );
}

export function ToolCard({ t }: { t: ToolItem }) {
  const [open, setOpen] = useState(false);
  const err = t.isError;
  return (
    <div className={`text-xs border rounded ${err ? 'border-destructive/40 bg-destructive/10' : 'border-border bg-muted/40'} my-1`}>
      <button className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left" onClick={() => setOpen((v) => !v)}>
        <Wrench className={`w-3 h-3 shrink-0 ${err ? 'text-destructive' : 'text-muted-foreground'}`} />
        <span className="font-medium font-mono">{t.name}</span>
        {t.summary && <span className="text-muted-foreground truncate flex-1">{t.summary}</span>}
        {t.running && t.startedAt != null && <RunningTime startedAt={t.startedAt} />}
        {t.interrupted && (
          <span className="text-warning flex items-center gap-0.5 shrink-0" data-tool-interrupted>
            <AlertTriangle className="w-2.5 h-2.5" />已中断
          </span>
        )}
        {!t.running && !t.interrupted && t.durationMs != null && (
          <span className="text-muted-foreground flex items-center gap-0.5 shrink-0">
            <Clock className="w-2.5 h-2.5" />{t.durationMs < 1000 ? t.durationMs + 'ms' : (t.durationMs / 1000).toFixed(1) + 's'}
          </span>
        )}
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1">
          {t.args !== undefined && Object.keys(t.args as object).length > 0 && (
            <div>
              <div className="text-muted-foreground mb-0.5">参数</div>
              <pre className="text-xs whitespace-pre-wrap break-all bg-card border border-border rounded p-1.5 max-h-40 overflow-auto">{JSON.stringify(t.args, null, 2)}</pre>
            </div>
          )}
          {t.summary && (
            <div>
              <div className="text-muted-foreground mb-0.5">结果</div>
              <pre className="text-xs whitespace-pre-wrap break-all bg-card border border-border rounded p-1.5 max-h-40 overflow-auto">{t.summary}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
