// 思考过程块：可折叠、微妙样式（参考 Claude 的 thinking display）
import { useState } from 'react';
import { Brain, ChevronRight, ChevronDown } from 'lucide-react';

export function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text?.trim()) return null;
  return (
    <div className="my-1.5">
      <button
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <Brain className={`w-3.5 h-3.5 ${streaming ? 'animate-pulse text-primary' : ''}`} />
        <span>{streaming ? '思考中…' : '思考过程'}</span>
        <span className="text-[10px] tabular-nums">({text.length} 字)</span>
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {open && (
        <div className="mt-1 pl-4 border-l-2 border-primary/20 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap max-h-64 overflow-auto">
          {text}
        </div>
      )}
    </div>
  );
}

// Token/上下文指示条
export function ContextBar({ usage, contextWindow }: { usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null; contextWindow: number }) {
  if (!usage) return null;
  const total = usage.input + usage.output + usage.cacheWrite;
  const pct = Math.min(100, (total / contextWindow) * 100);
  const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  const color = pct > 80 ? 'bg-destructive' : pct > 60 ? 'bg-warning' : 'bg-primary';
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <div className="w-24 h-1 rounded-full bg-muted overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: pct + '%' }} />
      </div>
      <span className="tabular-nums">{fmt(total)} / {(contextWindow / 1000).toFixed(0)}k</span>
      <span className="text-muted-foreground/60">({pct.toFixed(0)}%)</span>
    </div>
  );
}
