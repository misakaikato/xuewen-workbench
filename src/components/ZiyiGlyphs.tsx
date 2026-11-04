// 字形演变：滚到可见时才向后端要这个字的代表字形（后端按需从 zi.tools 取一次并缓存在本机）。
// 没取到时后端立即回 pending，这里每秒再问一次，直到取到或失败；卸载或换字即停止——停止询问的字后端会丢掉、不请求。
// 网格显示，点开放大。设置里关闭了联网取字形时整块不渲染。
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { api, type ZiyiGlyphs as Glyphs } from '@/lib/api';
import { errorMessage } from '@/lib/notify';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { Button } from '@/components/ui/button';
import { InlineLoading } from '@/components/ui-states';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const POLL_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Phase = 'idle' | 'loading' | 'ok' | 'error' | 'disabled';

/** 调用方以字作 key：换字即重新挂载 */
export function ZiyiGlyphs({ char, compact = false }: { char: string; compact?: boolean }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [data, setData] = useState<Glyphs | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const slow = useDelayedFlag(phase === 'loading' || phase === 'idle', 300);
  const rootRef = useRef<HTMLDivElement>(null);
  // n：每次开始询问 +1、卸载时也 +1，旧的轮询看到不等就停；waiting：正在等后端取（卸载时据此撤销登记）
  const runId = useRef({ n: 0, waiting: false });

  /** 问到有结果为止；refresh 只在第一问带上 */
  const run = async (refresh: boolean) => {
    const id = ++runId.current.n;
    setPhase('loading');
    for (let first = true; ; first = false) {
      try {
        const r = await api.ziyiGlyphs(char, first && refresh);
        if (id !== runId.current.n) return;
        if (r.status === 'pending') {
          runId.current.waiting = true;
          await sleep(POLL_MS);
          if (id !== runId.current.n) return;
          continue;
        }
        runId.current.waiting = false;
        setData(r);
        setPhase('ok');
      } catch (e) {
        if (id !== runId.current.n) return;
        runId.current.waiting = false;
        const err = e as { code?: string; items?: unknown };
        if (err.code === 'glyphs-disabled') { setPhase('disabled'); return; }
        // 失败时后端会附上旧缓存：照样显示旧字形，同时报错
        if (Array.isArray(err.items)) setData(e as unknown as Glyphs);
        setError(errorMessage(e));
        setPhase('error');
      }
      return;
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  // 滚进可视范围才开始（侧栏一次列出多个字时，屏幕外的不取）
  useEffect(() => {
    const el = rootRef.current;
    const ids = runId.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) {
        io.disconnect();
        void runRef.current(false);
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      ids.n++;
      if (ids.waiting) void api.ziyiGlyphsCancel(char).catch(() => { /* 撤销失败：后端几秒后也会丢掉没人再问的字 */ });
    };
  }, [char]);

  if (phase === 'disabled') return null;
  const items = data?.items ?? [];
  const cur = open !== null ? items[open] : null;

  return (
    <div ref={rootRef} data-wb-ziyi-glyphs={char} className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">字形演变</span>
        {items.length > 0 && <span className="stat-num">{items.length}</span>}
        <span className="ml-auto flex items-center gap-1">
          <a
            href={'https://zi.tools/zi/' + encodeURIComponent(char)}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-0.5 hover:text-foreground transition-colors"
            title="在 zi.tools 字統网查看全部历代字形"
          >
            zi.tools <ExternalLink className="w-3 h-3" />
          </a>
          {(phase === 'ok' || phase === 'error') && (
            <button
              className="p-0.5 rounded hover:bg-accent hover:text-foreground transition-colors"
              title="重新从 zi.tools 获取"
              onClick={() => { void run(true); }}
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          )}
        </span>
      </div>

      {(phase === 'loading' || phase === 'idle') && slow && <div className="text-xs"><InlineLoading text="正在从 zi.tools 获取字形…" /></div>}
      {phase === 'error' && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" role="alert">
          字形获取失败：{error}
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => { void run(true); }}>重试</Button>
        </div>
      )}
      {phase === 'ok' && items.length === 0 && <div className="text-xs text-muted-foreground">zi.tools 没有这个字的字形演变</div>}
      {items.length > 0 && (
        <div className={`flex flex-wrap ${compact ? 'gap-1' : 'gap-2'}`}>
          {items.map((g, i) => (
            <button
              key={i}
              data-wb-ziyi-glyph
              className="flex flex-col items-center rounded-md border border-transparent hover:border-primary/60 transition-colors px-1 py-1 bg-card"
              title={[g.period, g.styleName, g.label, g.variant !== char ? '字形：' + g.variant : ''].filter(Boolean).join(' · ')}
              onClick={() => setOpen(i)}
            >
              <img src={g.src} alt={`${g.period}${g.styleName}`} className={`wb-glyph-img ${compact ? 'h-10' : 'h-12'} w-auto`} />
              <span className="text-xs text-muted-foreground max-w-16 truncate">{g.period}</span>
              <span className="text-xs text-muted-foreground max-w-16 truncate">{compact ? g.styleName : [g.styleName, g.label].filter(Boolean).join('·')}</span>
            </button>
          ))}
        </div>
      )}

      <Dialog open={cur !== null} onOpenChange={(o) => { if (!o) setOpen(null); }}>
        {cur && (
          <DialogContent className="sm:max-w-sm" data-wb-ziyi-glyph-dialog>
            <DialogHeader>
              <DialogTitle>「{char}」{cur.period} · {cur.styleName}</DialogTitle>
              <DialogDescription>
                {[cur.label && '出处：' + cur.label, cur.variant && cur.variant !== char && '字形：' + cur.variant].filter(Boolean).join('　')}
                {'　'}（{(open ?? 0) + 1} / {items.length}，来源 zi.tools）
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-center py-4 bg-card rounded-md">
              <img src={cur.src} alt={`${cur.period}${cur.styleName}`} className="wb-glyph-img h-40 w-auto" />
            </div>
            <div className="flex justify-between">
              <Button variant="ghost" size="sm" disabled={open === 0} onClick={() => setOpen((i) => (i ?? 0) - 1)}>上一个</Button>
              <Button variant="ghost" size="sm" disabled={open === items.length - 1} onClick={() => setOpen((i) => (i ?? 0) + 1)}>下一个</Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
