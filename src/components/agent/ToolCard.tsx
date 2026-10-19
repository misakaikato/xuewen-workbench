// 工具调用卡片：可折叠、显示时序、参数/结果预览
import { useState } from 'react';
import { Wrench, ChevronRight, ChevronDown, Clock } from 'lucide-react';

export interface ToolItem {
  callId?: string;
  name: string;
  args?: unknown;
  summary?: string;
  isError?: boolean;
  durationMs?: number;
}

export function ToolCard({ t }: { t: ToolItem }) {
  const [open, setOpen] = useState(false);
  const err = t.isError;
  return (
    <div className={`text-xs border rounded ${err ? 'border-red-300 bg-red-50 dark:bg-red-950/20' : 'border-border bg-muted/40'} my-1`}>
      <button className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left" onClick={() => setOpen((v) => !v)}>
        <Wrench className={`w-3 h-3 shrink-0 ${err ? 'text-red-500' : 'text-muted-foreground'}`} />
        <span className="font-medium font-mono">{t.name}</span>
        {t.summary && <span className="text-muted-foreground truncate flex-1">{t.summary}</span>}
        {t.durationMs != null && (
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
              <pre className="text-[11px] whitespace-pre-wrap break-all bg-card border border-border rounded p-1.5 max-h-40 overflow-auto">{JSON.stringify(t.args, null, 2)}</pre>
            </div>
          )}
          {t.summary && (
            <div>
              <div className="text-muted-foreground mb-0.5">结果</div>
              <pre className="text-[11px] whitespace-pre-wrap break-all bg-card border border-border rounded p-1.5 max-h-40 overflow-auto">{t.summary}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
