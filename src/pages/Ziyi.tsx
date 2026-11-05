// 字义库页：左栏检索（字头 / 释义 / 出处，繁简互通，空格分隔多词，可按来源筛选），右栏查看与编辑选中的字；URL 同步 ?q=&origin=&han=。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BookA, Plus, Search as SearchIcon } from 'lucide-react';
import { api, type ZiyiEntry, type ZiyiHit } from '@/lib/api';
import { errorMessage } from '@/lib/notify';
import { reportDiagnostic } from '@/lib/diagnostics';
import { displayZiyiText, useZiyiStatus, ZIYI_ORIGIN_FILTERS } from '@/lib/ziyi';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState, InlineLoading } from '@/components/ui-states';
import { Highlight } from '@/components/Highlight';
import { ZiyiEntryView, ZiyiOriginTag } from '@/components/ZiyiEntryView';

const PAGE = 100;
// 查一个字通常几毫秒；超过这么久没响应就在右栏报错（可重试），不无限停在载入中
const DETAIL_TIMEOUT_MS = 15000;

export default function Ziyi() {
  const status = useZiyiStatus();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const han = params.get('han') || '';
  const origin = ZIYI_ORIGIN_FILTERS.find(([o]) => o === params.get('origin'))?.[0] ?? null;
  const [input, setInput] = useState(q);
  // URL 的 q 被外部改变（顶栏再点「字义」、前进后退）时同步回输入框；自己防抖写入的不回写，免得吃掉正在输入的空格
  const [syncedQ, setSyncedQ] = useState(q);
  if (q !== syncedQ) {
    setSyncedQ(q);
    if (q !== input.trim()) setInput(q);
  }
  const [hits, setHits] = useState<ZiyiHit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);
  const hanRef = useRef(han);
  hanRef.current = han;
  const slow = useDelayedFlag(loading);
  const [detail, setDetail] = useState<{ han: string; entry: ZiyiEntry | null; resolvedFrom: string | null; error?: string } | null>(null);
  const [newHan, setNewHan] = useState('');
  const installed = status?.installed === true;

  const setParam = useCallback((patch: Record<string, string>) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
      return next;
    }, { replace: true });
  }, [setParams]);

  // 输入防抖 200ms 后写入 URL，检索由 URL 驱动
  useEffect(() => {
    if (input === q) return;
    const t = setTimeout(() => setParam({ q: input.trim() }), 200);
    return () => clearTimeout(t);
  }, [input, q, setParam]);

  const load = useCallback(async (offset: number) => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const r = await api.ziyiSearch(q, offset, PAGE, origin);
      if (id !== reqId.current) return;
      setHits((prev) => (offset ? [...prev, ...r.items] : r.items));
      setTotal(r.total);
      setError(null);
    } catch (e) {
      if (id === reqId.current) setError(errorMessage(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [q, origin]);

  useEffect(() => {
    if (installed) void load(0);
  }, [installed, load]);

  const loadDetail = useCallback(async (h: string) => {
    try {
      const r = await api.ziyiEntry(h, AbortSignal.timeout(DETAIL_TIMEOUT_MS));
      if (h === hanRef.current) setDetail({ han: h, entry: r.entry, resolvedFrom: r.resolvedFrom });
    } catch (e) {
      if (h !== hanRef.current) return; // 已切到别的字，丢弃迟到的响应
      if ((e as { status?: number }).status === 404) {
        setDetail({ han: h, entry: null, resolvedFrom: null });
        return;
      }
      const message = (e as Error).name === 'TimeoutError' ? `${DETAIL_TIMEOUT_MS / 1000} 秒内没有响应` : errorMessage(e);
      reportDiagnostic('WARN', `[ziyi] 载入「${h}」的字义失败：${message}`);
      setDetail({ han: h, entry: null, resolvedFrom: null, error: message });
    }
  }, []);

  useEffect(() => {
    if (han && installed) void loadDetail(han);
  }, [han, installed, loadDetail]);

  if (status && !installed) {
    return (
      <div className="max-w-5xl mx-auto py-6 px-4">
        <EmptyState
          icon={<BookA className="w-8 h-8" />}
          title="尚未导入字义库"
          hint="字义文件不随程序分发。请在 设置 → 字义库 中导入字义文件（.json 或 .zip）。"
          action={<Button asChild size="sm"><Link to="/settings?tab=ziyi">去导入</Link></Button>}
        />
      </div>
    );
  }

  const terms = q.split(/\s+/).filter(Boolean);
  const shown = detail && detail.han === han ? detail : null;

  return (
    <div className="max-w-5xl mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">字义库</h1>
        {status && <span className="text-xs text-muted-foreground stat-num">{status.count} 字</span>}
      </div>
      <div className="flex gap-4 items-start">
        <aside className="w-72 shrink-0 space-y-3">
          <div className="relative">
            <SearchIcon className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              data-wb-ziyi-search
              className="pl-8"
              placeholder="查字、释义或出处（空格分隔多词）"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setParam({ q: input.trim() }); }}
              autoFocus
            />
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); const h = newHan.trim(); if (h) { setParam({ han: h }); setNewHan(''); } }}
          >
            <Input data-wb-ziyi-new className="h-8" placeholder="新建：输入字头" value={newHan} onChange={(e) => setNewHan(e.target.value)} />
            <Button type="submit" variant="outline" size="sm" disabled={!newHan.trim()}><Plus /> 新建</Button>
          </form>
          <div className="flex flex-wrap gap-1" data-wb-ziyi-origin-filter>
            {([[null, '全部'], ...ZIYI_ORIGIN_FILTERS] as const).map(([o, label]) => {
              const n = o ? status?.origins?.[o] ?? 0 : status?.count ?? 0;
              const active = origin === o;
              // 没有条目的来源不列出；当前选中的始终保留，免得筛选状态无处可见
              if (o && !n && !active) return null;
              return (
                <button
                  key={o ?? 'all'}
                  data-wb-ziyi-origin-opt={o ?? 'all'}
                  className={`text-xs px-2 py-1 rounded-md border transition-colors ${active ? 'border-primary/60 bg-primary/5 text-foreground' : 'border-border text-muted-foreground hover:border-primary/60'}`}
                  onClick={() => setParam({ origin: o ?? '' })}
                >
                  {label} <span className="stat-num">{n}</span>
                </button>
              );
            })}
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            {q ? <>命中 <span className="stat-num">{total}</span> 字</> : <>共 <span className="stat-num">{total}</span> 字</>}
            {slow && <InlineLoading text="" />}
          </div>
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          <ul className="space-y-1" data-wb-ziyi-results>
            {hits.map((h) => (
              <li key={h.han}>
                <button
                  data-wb-ziyi-hit={h.han}
                  className={`w-full text-left rounded-md border px-3 py-2 transition-colors ${h.han === han ? 'border-primary/60 bg-primary/5' : 'border-transparent hover:border-primary/60'}`}
                  onClick={() => setParam({ han: h.han })}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-serif text-base">{h.han}</span>
                    <ZiyiOriginTag origin={h.origin} />
                    {h.field === 'source' && <span className="text-xs text-muted-foreground">出处命中</span>}
                    {h.editedAt && <span className="text-xs text-muted-foreground">本地修改</span>}
                  </div>
                  <div className="text-xs text-muted-foreground line-clamp-2"><Highlight text={displayZiyiText(h.snippet)} terms={terms} emphasis /></div>
                </button>
              </li>
            ))}
          </ul>
          {!loading && hits.length === 0 && !error && <EmptyState compact title={q || origin ? '没有找到' : '字义库是空的'} />}
          {hits.length < total && (
            <Button variant="ghost" size="sm" className="w-full" loading={loading} onClick={() => { void load(hits.length); }}>加载更多</Button>
          )}
        </aside>

        <section data-wb-ziyi-detail className="flex-1 min-w-0 bg-card border border-border rounded-lg p-6">
          {shown?.error ? (
            <div data-wb-ziyi-detail-error role="alert" className="space-y-3 text-sm">
              <p>载入「{han}」的字义失败：{shown.error}</p>
              <Button variant="outline" size="sm" onClick={() => { setDetail(null); void loadDetail(han); }}>重试</Button>
            </div>
          ) : shown ? (
            <ZiyiEntryView
              key={shown.han}
              char={shown.han}
              entry={shown.entry}
              resolvedFrom={shown.resolvedFrom}
              onChange={(entry) => { setDetail({ han, entry, resolvedFrom: shown.resolvedFrom }); void load(0); }}
              onDeleted={() => { setDetail(null); setParam({ han: '' }); void load(0); }}
            />
          ) : han ? (
            <div data-wb-ziyi-detail-loading className="flex justify-center py-6 text-sm"><InlineLoading text={`正在载入「${han}」…`} /></div>
          ) : (
            <EmptyState compact icon={<BookA className="w-5 h-5" />} title="在左侧选择一个字" />
          )}
        </section>
      </div>
    </div>
  );
}
