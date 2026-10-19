// 反向链接面板（提到本篇的文档）：阅读页与编辑页共用。
// 列出来源文档、提及次数与上下文片段（命中词高亮）；点击打开来源文档并定位到提及处。
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { BacklinkEntry } from '@/lib/api';
import { Link2, X } from 'lucide-react';

export function BacklinksPanel({
  path,
  dsId,
  onOpen,
  onClose,
}: {
  path: string;
  dsId: string | null;
  onOpen: (sourcePath: string, term: string) => void;
  onClose?: () => void;
}) {
  const [backlinks, setBacklinks] = useState<BacklinkEntry[] | null>(null);
  const [seq, setSeq] = useState(0);

  useEffect(() => {
    if (!dsId || !path) return;
    let dead = false;
    setBacklinks(null);
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchBl = async () => {
      try {
        const r = await api.linksBacklinks(path);
        if (dead || r.dsId !== dsId) return;
        if (!r.ready && tries++ < 20) {
          timer = setTimeout(fetchBl, 600); // 索引尚在构建：稍后再取
          return;
        }
        setBacklinks(r.backlinks);
      } catch {
        if (!dead) setBacklinks([]);
      }
    };
    fetchBl();
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
    };
  }, [dsId, path, seq]);

  // 外部通知刷新（如保存后）
  useEffect(() => {
    const h = () => setSeq((s) => s + 1);
    window.addEventListener('wb-links-updated', h);
    return () => window.removeEventListener('wb-links-updated', h);
  }, []);

  const list = backlinks || [];

  return (
    <div className="text-xs">
      <div className="flex items-center gap-1 font-medium text-muted-foreground mb-2">
        <Link2 className="w-3.5 h-3.5" /> 提到本篇的文档（{backlinks == null ? '…' : list.length}）
        {onClose && (
          <button className="ml-auto p-0.5 rounded hover:bg-accent" onClick={onClose} title="收起">
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      {backlinks == null ? (
        <div className="text-muted-foreground">加载中…</div>
      ) : list.length === 0 ? (
        <div className="text-muted-foreground">还没有其他文档提到本篇</div>
      ) : (
        <ul className="space-y-2 wb-selectable">
          {list.map((b) => (
            <li key={b.path} className="border border-border rounded p-1.5">
              <button
                className="w-full text-left flex items-center gap-1 hover:text-primary"
                onClick={() => onOpen(b.path, b.snippets[0]?.term || '')}
                title={b.path}
              >
                <span className="stat-num">{b.count}</span>
                <span className="truncate flex-1">{b.title}</span>
              </button>
              <div className="mt-1 space-y-1">
                {b.snippets.slice(0, 3).map((s, i) => {
                  // 高亮一律用服务端给出的精确区间（由链接 from/to 拼出）；
                  // 旧响应无区间时才退回文本搜索，绝不能把长词（如 孔子家语）内部的短词误标
                  const aligned =
                    Number.isInteger(s.hiFrom) && Number.isInteger(s.hiTo) && s.text.slice(s.hiFrom, s.hiTo) === s.term;
                  const idx = aligned ? s.hiFrom : s.text.indexOf(s.term);
                  return (
                    <button
                      key={i}
                      className="block w-full text-left text-muted-foreground hover:text-foreground break-all leading-relaxed"
                      onClick={() => onOpen(b.path, s.term)}
                      title={b.path}
                    >
                      {idx >= 0 ? (
                        <>
                          {s.text.slice(0, idx)}
                          <mark className="wb-bl-mark">{s.text.slice(idx, idx + s.term.length)}</mark>
                          {s.text.slice(idx + s.term.length)}
                        </>
                      ) : (
                        s.text
                      )}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
