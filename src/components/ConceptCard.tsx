// 概念详情弹层：点正文里的概念词条时打开，显示释义、别名、出处文档、图上的相关概念
import { useEffect, useState } from 'react';
import { X, BookOpen, Link2, ArrowRight, ArrowLeft, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { ConceptItem } from '@/lib/api';

export function ConceptCard({
  name,
  onClose,
  onOpenDoc,
  onOpenConcept,
}: {
  name: string;
  onClose: () => void;
  onOpenDoc: (path: string) => void;
  onOpenConcept: (name: string) => void;
}) {
  const [data, setData] = useState<{ concept: ConceptItem; neighbors: { rel: string; dir: 'in' | 'out'; other: string }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 不在此处同步 setState：切换概念由父组件用 key={name} 重挂载，初始态即为空
  useEffect(() => {
    let dead = false;
    api.conceptDetail(name)
      .then((r) => { if (!dead) setData(r); })
      .catch((e) => { if (!dead) setErr((e as Error).message); });
    return () => { dead = true; };
  }, [name]);

  const c = data?.concept;

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-start justify-center pt-[12vh] px-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-[560px] max-w-[94vw] max-h-[72vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-card border-b border-border px-4 py-2.5 flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-primary shrink-0" />
          <span className="text-sm font-semibold truncate">{name}</span>
          {c && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0">
              {c.type}{c.status === 'confirmed' ? ' · 已确认' : ''}
            </span>
          )}
          <span className="flex-1" />
          <button className="p-1 rounded hover:bg-accent text-muted-foreground" onClick={onClose}><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3">
          {!data && !err && <div className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />加载中…</div>}
          {err && <div className="text-xs text-destructive">{err}</div>}

          {c && (
            <>
              {c.aliases.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  别名：<span className="text-foreground">{c.aliases.join('、')}</span>
                </div>
              )}
              {c.def ? (
                <div className="text-sm leading-relaxed whitespace-pre-wrap">{c.def}</div>
              ) : (
                <div className="text-xs text-muted-foreground">（暂无释义）</div>
              )}

              {c.refs.length > 0 && (
                <div>
                  <div className="text-[11px] text-muted-foreground mb-1 flex items-center gap-1"><Link2 className="w-3 h-3" />出处文档</div>
                  <div className="space-y-0.5">
                    {c.refs.map((r) => (
                      <button key={r} className="block text-xs text-primary hover:underline text-left truncate w-full" onClick={() => onOpenDoc(r)}>
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {data!.neighbors.length > 0 && (
                <div>
                  <div className="text-[11px] text-muted-foreground mb-1">相关概念（知识图谱）</div>
                  <div className="flex flex-wrap gap-1">
                    {data!.neighbors.map((n, i) => (
                      <button
                        key={i}
                        className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-border hover:border-primary/50 hover:text-primary"
                        onClick={() => onOpenConcept(n.other)}
                        title={n.rel ? `${n.dir === 'out' ? '→' : '←'} ${n.rel}` : undefined}
                      >
                        {n.dir === 'out' ? <ArrowRight className="w-2.5 h-2.5" /> : <ArrowLeft className="w-2.5 h-2.5" />}
                        {n.other}
                        {n.rel && <span className="text-[10px] text-muted-foreground">{n.rel}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
