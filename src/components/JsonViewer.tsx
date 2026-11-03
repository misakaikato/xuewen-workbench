// JSON 只读结构视图：折叠、键值查找、复制、源码切换。
// 大文件优化：JsonNode memo；默认展开「层级 < 2 且子项数 ≤ 100」；
// 超过 200 子项分页显示；过滤 200ms 防抖 + useDeferredValue；容器按后代匹配过滤。
// 大文件先显示加载态，JSON.parse 推迟到加载态首帧绘制之后（useAfterPaint），完成后回调 onContentReady。
import { memo, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Copy, Check, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageLoading } from '@/components/ui-states';
import { LARGE_DOC_CHARS, useAfterPaint } from '@/hooks/useAfterPaint';
import { errorMessage, notify } from '@/lib/notify';

// 子项分页步长
const PAGE = 200;

type Entries = [string, unknown][];

function entriesOf(value: object): Entries {
  return Array.isArray(value) ? value.map((v, i) => [String(i), v] as [string, unknown]) : Object.entries(value);
}

// 按后代过滤的命中表：value(容器) → 自身键或任一后代是否匹配 filter。
// 后序单趟计算，O(节点数)；filter 为空返回 null（不过滤）。
function buildHitMap(data: unknown, f: string): WeakMap<object, boolean> | null {
  if (!f) return null;
  const map = new WeakMap<object, boolean>();
  const walk = (v: unknown, k?: string): boolean => {
    const keyHit = k !== undefined && k.toLowerCase().includes(f);
    if (v !== null && typeof v === 'object') {
      let any = keyHit;
      const isArr = Array.isArray(v);
      for (const [ck, cv] of entriesOf(v)) if (walk(cv, isArr ? undefined : ck)) any = true;
      map.set(v, any);
      return any;
    }
    return keyHit || String(v).toLowerCase().includes(f);
  };
  walk(data);
  return map;
}

interface JsonNodeProps {
  k?: string;
  value: unknown;
  depth: number;
  /** 已归一化（trim + 小写）的过滤词，空串表示不过滤 */
  filter: string;
  hits: WeakMap<object, boolean> | null;
}

const JsonNode = memo(function JsonNode({ k, value, depth, filter, hits }: JsonNodeProps) {
  const isObj = value !== null && typeof value === 'object';
  const count = isObj ? (Array.isArray(value) ? value.length : Object.keys(value as object).length) : 0;
  // 默认展开：层级 < 2 且子项数 ≤ 100
  const [open, setOpen] = useState(() => depth < 2 && count <= 100);
  const [shown, setShown] = useState(PAGE);

  // 键值查找：叶子按自身键/值匹配；容器只在自身键或任一后代匹配时显示
  if (filter) {
    if (isObj) {
      if (!hits?.get(value as object)) return null;
    } else {
      const selfHit = (k ?? '').toLowerCase().includes(filter) || String(value).toLowerCase().includes(filter);
      if (!selfHit) return null;
    }
  }

  if (!isObj) {
    const cls = value === null ? 'json-bool' : typeof value === 'string' ? 'json-str' : typeof value === 'number' ? 'json-num' : 'json-bool';
    const shownText = typeof value === 'string' ? JSON.stringify(value) : String(value);
    return (
      <div style={{ paddingLeft: depth * 18 }}>
        {k !== undefined && <span className="json-key">"{k}"</span>}
        {k !== undefined && <span>: </span>}
        <span className={cls}>{shownText}</span>
      </div>
    );
  }

  const label = Array.isArray(value) ? `Array(${count})` : `Object(${count})`;
  const filtering = !!filter;
  const isArr = Array.isArray(value);
  const entries = open ? entriesOf(value as object) : null;
  // 过滤态先按命中表/叶子自匹配筛出可见子项，再与非过滤态一样分页（命中很多时不一次全流染）
  const visibleEntries = filtering && entries
    ? entries.filter(([ck, cv]) => {
        if (cv !== null && typeof cv === 'object') return !!hits?.get(cv);
        const key = isArr ? '' : (ck ?? '');
        return key.toLowerCase().includes(filter) || String(cv).toLowerCase().includes(filter);
      })
    : entries;
  const shownEntries = visibleEntries ? visibleEntries.slice(0, shown) : null;
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
      {open && shownEntries?.map(([ck, cv]) => (
        <JsonNode key={ck} k={isArr ? undefined : ck} value={cv} depth={depth + 1} filter={filter} hits={hits} />
      ))}
      {open && visibleEntries && visibleEntries.length > shown && (
        <button
          className="text-xs text-primary hover:underline py-0.5"
          style={{ paddingLeft: (depth + 1) * 18 }}
          onClick={() => setShown((n) => n + PAGE)}
        >
          显示更多 {PAGE}（已显示 {shown} / 共 {visibleEntries.length}）
        </button>
      )}
    </div>
  );
});

export function JsonViewer({
  content,
  highlightTerm,
  onContentReady,
}: {
  content: string;
  highlightTerm?: string;
  /** 推迟解析的大文件渲染完成后回调（阅读页据此重跑高亮与定位） */
  onContentReady?: () => void;
}) {
  // 带搜索命中词进入时默认原始源码视图：折叠结构里可能藏有命中，源码视图让高亮与定位可达
  const [raw, setRaw] = useState(!!highlightTerm);
  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');
  const showRaw = raw || !!highlightTerm;
  const [copied, setCopied] = useState(false);

  // 过滤输入 200ms 防抖 + deferred：键入不阻塞渲染
  useEffect(() => {
    const t = setTimeout(() => setFilter(filterInput), 200);
    return () => clearTimeout(t);
  }, [filterInput]);
  const deferredFilter = useDeferredValue(filter);

  const deferred = content.length > LARGE_DOC_CHARS;
  const ready = useAfterPaint(content, deferred);
  useEffect(() => {
    if (deferred && ready) onContentReady?.();
  }, [deferred, ready, onContentReady]);
  const parsed = useMemo(() => {
    if (!ready) return { data: null, error: null };
    try {
      return { data: JSON.parse(content), error: null };
    } catch (e) {
      return { data: null, error: (e as Error).message };
    }
  }, [ready, content]);

  const normFilter = deferredFilter.trim().toLowerCase();
  const hits = useMemo(() => buildHitMap(parsed.data, normFilter), [parsed.data, normFilter]);

  if (!ready) return <PageLoading text="正在解析 JSON…" />;
  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          onClick={() => setRaw(!raw)}
        >
          {showRaw ? '结构视图' : '原始源码'}
        </Button>
        {!showRaw && !parsed.error && (
          <input
            value={filterInput}
            onChange={(e) => setFilterInput(e.target.value)}
            placeholder="查找键或值…"
            className="text-xs px-2 py-1 rounded border border-input bg-background w-48"
          />
        )}
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          onClick={() => {
            navigator.clipboard.writeText(content).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              (e) => notify('复制失败：' + errorMessage(e), { kind: 'error' })
            );
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
      {showRaw || parsed.error ? (
        <div className="reader">
          <pre className="whitespace-pre-wrap break-all">{content}</pre>
        </div>
      ) : (
        <div className="json-view bg-card border border-border rounded-lg p-3 overflow-auto max-w-4xl">
          {normFilter && hits && parsed.data !== null && typeof parsed.data === 'object' && !hits.get(parsed.data) ? (
            <div className="text-xs text-muted-foreground py-2">没有匹配的键或值</div>
          ) : (
            <JsonNode value={parsed.data} depth={0} filter={normFilter} hits={hits} />
          )}
        </div>
      )}
    </div>
  );
}
