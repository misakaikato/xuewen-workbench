// 字形演变：查看某个字时向后端要它的代表字形（后端按需从 zi.tools 取一次并缓存在本机），网格显示，点开放大。
// 设置里关闭了联网取字形时整块不渲染。
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { api, type ZiyiGlyphs as Glyphs } from '@/lib/api';
import { errorMessage } from '@/lib/notify';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { Button } from '@/components/ui/button';
import { InlineLoading } from '@/components/ui-states';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; data: Glyphs }
  | { kind: 'error'; message: string }
  | { kind: 'disabled' };

/** 请求结果 → 显示状态（关闭了联网取字形时为 disabled） */
function settle(p: Promise<Glyphs>): Promise<State> {
  return p.then(
    (data): State => ({ kind: 'ok', data }),
    (e): State => ((e as { code?: string }).code === 'glyphs-disabled' ? { kind: 'disabled' } : { kind: 'error', message: errorMessage(e) }),
  );
}

/** 调用方以字作 key：换字即重新挂载、重新加载 */
export function ZiyiGlyphs({ char, compact = false }: { char: string; compact?: boolean }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [open, setOpen] = useState<number | null>(null);
  const slow = useDelayedFlag(state.kind === 'loading', 300);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; // StrictMode 下会先卸载再挂载，重新置真
    return () => { alive.current = false; };
  }, []);

  // 挂载（换字即重新挂载）时取一次；初始状态已是 loading，回调里才写状态
  useEffect(() => {
    void settle(api.ziyiGlyphs(char)).then((next) => { if (alive.current) setState(next); });
  }, [char]);
  // 重试与刷新：先置回 loading
  const load = (refresh: boolean) => {
    setState({ kind: 'loading' });
    void settle(api.ziyiGlyphs(char, refresh)).then((next) => { if (alive.current) setState(next); });
  };

  if (state.kind === 'disabled') return null;
  const items = state.kind === 'ok' ? state.data.items : [];
  const cur = open !== null ? items[open] : null;

  return (
    <div data-wb-ziyi-glyphs={char} className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">字形演变</span>
        {state.kind === 'ok' && items.length > 0 && <span className="stat-num">{items.length}</span>}
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
          {state.kind !== 'loading' && (
            <button
              className="p-0.5 rounded hover:bg-accent hover:text-foreground transition-colors"
              title="重新从 zi.tools 获取"
              onClick={() => load(true)}
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          )}
        </span>
      </div>

      {state.kind === 'loading' && slow && <div className="text-xs"><InlineLoading text="正在从 zi.tools 获取字形…" /></div>}
      {state.kind === 'error' && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" role="alert">
          字形获取失败：{state.message}
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => load(false)}>重试</Button>
        </div>
      )}
      {state.kind === 'ok' && items.length === 0 && <div className="text-xs text-muted-foreground">zi.tools 没有这个字的字形演变</div>}
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
              {!compact && <span className="text-xs text-muted-foreground max-w-16 truncate">{g.styleName}</span>}
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
