// 阅读页字义侧栏：查选中文字或 Alt 点击的字（逐字列出，最多 12 个），可在栏内直接编辑或新建。
// 顶部输入框可改查别的字；query.n 变化（又一次选字 / 点字）时以 query.text 覆盖输入框。
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookA, X } from 'lucide-react';
import { api, type ZiyiLookupItem } from '@/lib/api';
import { errorMessage } from '@/lib/notify';
import { isHanChar, ziyiHref } from '@/lib/ziyi';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { Input } from '@/components/ui/input';
import { EmptyState, InlineLoading } from '@/components/ui-states';
import { ZiyiEntryView } from '@/components/ZiyiEntryView';

export interface ZiyiQuery {
  text: string;
  /** 每次发起查询递增，同一段文字再查一次也会刷新 */
  n: number;
}

export function ZiyiPanel({ query, onClose }: { query: ZiyiQuery | null; onClose: () => void }) {
  const [input, setInput] = useState(query?.text ?? '');
  const [seen, setSeen] = useState(query?.n ?? 0);
  if (query && query.n !== seen) {
    setSeen(query.n);
    setInput(query.text);
  }
  const [items, setItems] = useState<ZiyiLookupItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slow = useDelayedFlag(loading);
  const reqId = useRef(0);
  const text = input.trim();
  const hasHan = Array.from(text).some(isHanChar);

  useEffect(() => {
    if (!hasHan) return;
    const id = ++reqId.current;
    // 选字/点字后立即查；手动输入时等 150ms 停顿
    const t = setTimeout(() => {
      setLoading(true);
      api.ziyiLookup(text)
        .then((r) => { if (id === reqId.current) { setItems(r.items); setError(null); } })
        .catch((e) => { if (id === reqId.current) setError(errorMessage(e)); })
        .finally(() => { if (id === reqId.current) setLoading(false); });
    }, query && text === query.text.trim() ? 0 : 150);
    return () => clearTimeout(t);
  }, [text, hasHan, query]);

  const shown = hasHan ? items : [];

  return (
    <div className="flex flex-col h-full w-full min-w-0 border-l border-border bg-background" data-wb-ziyi-panel>
      <div className="flex items-center gap-2 p-3 border-b border-border">
        <BookA className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-semibold">字义</span>
        {slow && <InlineLoading text="" />}
        <button className="ml-auto p-1 rounded hover:bg-accent transition-colors text-muted-foreground" title="关闭字义侧栏" onClick={onClose}>
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="p-3 border-b border-border">
        <Input
          data-wb-ziyi-panel-input
          className="h-8"
          placeholder="输入要查的字"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-6">
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
        {!hasHan ? (
          <EmptyState compact icon={<BookA className="w-5 h-5" />} title="选中文字或按住 Alt（⌥）点击字" hint="也可以在上面直接输入" />
        ) : (
          shown.map((it) => (
            <ZiyiEntryView
              key={it.char}
              compact
              char={it.char}
              entry={it.entry}
              resolvedFrom={it.resolvedFrom}
              onChange={(entry) => setItems((prev) => prev.map((x) => (x.char === it.char ? { ...x, entry } : x)))}
            />
          ))
        )}
      </div>
      <div className="p-3 border-t border-border text-xs flex items-center gap-3">
        <Link to={ziyiHref(shown[0]?.entry?.han)} className="text-primary hover:underline">在字义库中打开</Link>
        {text && <Link to={'/ziyi?q=' + encodeURIComponent(text)} className="text-muted-foreground hover:text-foreground transition-colors">检索「{text.length > 8 ? text.slice(0, 8) + '…' : text}」</Link>}
      </div>
    </div>
  );
}
