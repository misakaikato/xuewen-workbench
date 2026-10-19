// JSON 只读结构视图：折叠、键值查找、复制、源码切换
import { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Copy, Check, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

function JsonNode({ k, value, depth, filter }: { k?: string; value: unknown; depth: number; filter: string }) {
  const [open, setOpen] = useState(depth < 2);
  const isObj = value !== null && typeof value === 'object';
  const entries = isObj ? (Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value as object)) : [];

  // 键值查找：不匹配时隐藏叶子；容器有后代匹配则保留
  const f = filter.trim().toLowerCase();
  const selfHit = !f || (k ?? '').toLowerCase().includes(f) || (!isObj && String(value).toLowerCase().includes(f));
  if (f && !isObj && !selfHit) return null;

  if (!isObj) {
    const cls = value === null ? 'json-bool' : typeof value === 'string' ? 'json-str' : typeof value === 'number' ? 'json-num' : 'json-bool';
    const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
    return (
      <div style={{ paddingLeft: depth * 18 }}>
        {k !== undefined && <span className="json-key">"{k}"</span>}
        {k !== undefined && <span>: </span>}
        <span className={cls}>{shown}</span>
      </div>
    );
  }

  const label = Array.isArray(value) ? `Array(${(value as unknown[]).length})` : `Object(${(entries as [string, unknown][]).length})`;
  return (
    <div>
      <div
        style={{ paddingLeft: depth * 18 }}
        className="cursor-pointer select-none hover:bg-accent/60 rounded flex items-center gap-1"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
        {k !== undefined && <span className="json-key">"{k}"</span>}
        {k !== undefined && <span>: </span>}
        <span className="text-muted-foreground text-xs">{label}</span>
      </div>
      {open &&
        (entries as [string, unknown][]).map(([ck, cv]) => (
          <JsonNode key={ck} k={Array.isArray(value) ? undefined : ck} value={cv} depth={depth + 1} filter={filter} />
        ))}
    </div>
  );
}

export function JsonViewer({ content }: { content: string }) {
  const [raw, setRaw] = useState(false);
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => {
    try {
      return { data: JSON.parse(content), error: null };
    } catch (e) {
      return { data: null, error: (e as Error).message };
    }
  }, [content]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          onClick={() => setRaw(!raw)}
        >
          {raw ? '结构视图' : '原始源码'}
        </Button>
        {!raw && !parsed.error && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="查找键或值…"
            className="text-xs px-2 py-1 rounded border border-input bg-background w-48"
          />
        )}
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          onClick={() => {
            navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} 复制
        </Button>
      </div>
      {parsed.error ? (
        <div className="flex items-start gap-2 text-sm text-warning-foreground bg-warning-soft border border-warning/40 rounded p-3 mb-3">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>JSON 解析失败：{parsed.error}。以下为原始内容。</span>
        </div>
      ) : null}
      {raw || parsed.error ? (
        <div className="reader">
          <pre className="whitespace-pre-wrap break-all">{content}</pre>
        </div>
      ) : (
        <div className="json-view bg-card border border-border rounded-lg p-3 overflow-auto max-w-4xl">
          <JsonNode value={parsed.data} depth={0} filter={filter} />
        </div>
      )}
    </div>
  );
}
