// 主题标签：阅读页显示当前文档的主题，点击展开同主题文档列表
import { useEffect, useState } from 'react';
import { Tag, X, Loader2, Sparkles, UserPen } from 'lucide-react';
import { api } from '@/lib/api';
import type { TagEntry } from '@/lib/api';

export function TagChips({ path, onOpenDoc, onOpenConcept }: { path: string; onOpenDoc: (p: string) => void; onOpenConcept?: (name: string) => void }) {
  const [data, setData] = useState<{ manual: string[]; ai: string[]; coreConcepts: string[]; mentioned: string[] } | null>(null);
  const [openTag, setOpenTag] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    api.tagsDoc(path)
      .then((r) => { if (!dead) setData({ manual: r.manual, ai: r.ai, coreConcepts: r.coreConcepts || [], mentioned: r.mentioned || [] }); })
      .catch(() => { if (!dead) setData(null); });
    return () => { dead = true; };
  }, [path]);

  const all = [...new Set([...(data?.manual || []), ...(data?.ai || [])])];
  const core = (data?.coreConcepts || []);
  const mentioned = (data?.mentioned || []).filter((m) => !core.includes(m));
  if (!all.length && !core.length && !mentioned.length) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <Tag className="w-3 h-3 text-muted-foreground shrink-0" />
      {all.map((t) => {
        const isAi = (data?.ai || []).includes(t) && !(data?.manual || []).includes(t);
        return (
          <button
            key={t}
            className="text-[11px] px-1.5 py-0.5 rounded-full border border-border hover:border-primary/60 hover:text-primary transition-colors flex items-center gap-1"
            title={isAi ? 'AI 标注的主题' : '人工标注的主题'}
            onClick={() => setOpenTag(t)}
          >
            {isAi && <Sparkles className="w-2.5 h-2.5 opacity-60" />}
            {t}
          </button>
        );
      })}
      {core.length > 0 && (
        <span className="flex items-center gap-1.5 flex-wrap ml-3">
          <span className="text-[10px] text-muted-foreground">核心概念</span>
          {core.map((c) => (
            <button
              key={c}
              className="text-[11px] px-1.5 py-0.5 rounded-full border border-primary/40 text-primary hover:bg-primary/10 transition-colors"
              title="本文核心概念，点击查看释义"
              onClick={() => onOpenConcept?.(c)}
            >
              {c}
            </button>
          ))}
        </span>
      )}
      {mentioned.length > 0 && (
        <span className="flex items-center gap-1 flex-wrap ml-3">
          <span className="text-[10px] text-muted-foreground">提及</span>
          {mentioned.slice(0, 6).map((c) => (
            <button
              key={c}
              className="text-[11px] text-muted-foreground hover:text-primary transition-colors"
              title="本文提及的概念，点击查看释义"
              onClick={() => onOpenConcept?.(c)}
            >
              {c}
            </button>
          ))}
          {mentioned.length > 6 && <span className="text-[10px] text-muted-foreground">+{mentioned.length - 6}</span>}
        </span>
      )}
      {openTag && (
        <TagDocsCard tag={openTag} onClose={() => setOpenTag(null)} onOpenDoc={(p) => { setOpenTag(null); onOpenDoc(p); }} />
      )}
    </div>
  );
}

function TagDocsCard({ tag, onClose, onOpenDoc }: { tag: string; onClose: () => void; onOpenDoc: (p: string) => void }) {
  const [entry, setEntry] = useState<TagEntry | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    api.tags()
      .then((r) => {
        if (dead) return;
        const hit = r.tags.find((x) => x.tag === tag);
        if (hit) setEntry(hit);
        else setErr('没有找到该主题');
      })
      .catch((e) => { if (!dead) setErr((e as Error).message); });
    return () => { dead = true; };
  }, [tag]);

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-start justify-center pt-[14vh] px-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-[520px] max-w-[94vw] max-h-[66vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-card border-b border-border px-4 py-2.5 flex items-center gap-2">
          <Tag className="w-4 h-4 text-primary shrink-0" />
          <span className="text-sm font-semibold truncate">{tag}</span>
          {entry && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{entry.count} 篇</span>}
          <span className="flex-1" />
          <button className="p-1 rounded hover:bg-accent text-muted-foreground" onClick={onClose}><X className="w-4 h-4" /></button>
        </div>
        <div className="p-2">
          {!entry && !err && <div className="p-3 text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />加载中…</div>}
          {err && <div className="p-3 text-xs text-destructive">{err}</div>}
          {entry?.files.map((f) => (
            <button
              key={f.path}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-accent flex items-center gap-2"
              onClick={() => onOpenDoc(f.path)}
            >
              <span className="text-sm truncate flex-1">{f.title}</span>
              <span className="text-[10px] text-muted-foreground shrink-0 flex items-center gap-1">
                {f.source === 'ai' ? <><Sparkles className="w-2.5 h-2.5" />AI</> : <><UserPen className="w-2.5 h-2.5" />人工</>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
