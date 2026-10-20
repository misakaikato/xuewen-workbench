// TXT 阅读正文：把链接图（自动内链 / wikilink）按服务端偏移渲染成可点链接，其余纯文本原样。
// 偏移口径与服务端一致：先在 BOM 剥离 + CRLF→LF 的归一化文本上切分（\r 在渲染中本不可见，
// 归一化不改变视觉但保证链接区间不随换行漂移）。
// 样式复用 .wb-autolink / .wb-wikilink / .wb-wikilink-missing，与 md 阅读态视觉一致。
import { memo, useMemo } from 'react';
import type { DocLink } from '@/lib/api';

export interface TxtLinkTarget {
  path: string;
  heading?: string | null;
}

// 与 editor/autoLinks.ts 的 wikilink 标签口径一致：[[name|display]] → display，[[name#heading]] → name
function wikiLabel(raw: string): string | null {
  if (!raw.startsWith('[[') || !raw.endsWith(']]')) return null;
  const inner = raw.slice(2, -2);
  const bar = inner.indexOf('|');
  if (bar >= 0) return inner.slice(bar + 1);
  const hash = inner.indexOf('#');
  return hash >= 0 ? inner.slice(0, hash) : inner;
}

export const TxtReadBody = memo(function TxtReadBody({
  content,
  links,
  style,
  onOpenTarget,
  onCandidates,
}: {
  content: string;
  links: DocLink[];
  style?: React.CSSProperties;
  onOpenTarget: (t: TxtLinkTarget) => void;
  onCandidates: (term: string, candidates: string[], at: { x: number; y: number }) => void;
}) {
  const text = useMemo(() => content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'), [content]);

  const segs = useMemo(() => {
    const out: { key: number; text: string; link?: DocLink }[] = [];
    let pos = 0;
    let key = 0;
    const sorted = links.filter((l) => !l.ignored && l.to > l.from).sort((a, b) => a.from - b.from);
    for (const l of sorted) {
      if (l.from < pos || l.to > text.length) continue; // 重叠 / 越界防御（索引滞后于编辑时）
      if (l.from > pos) out.push({ key: key++, text: text.slice(pos, l.from) });
      const raw = text.slice(l.from, l.to);
      const label = l.kind !== 'auto' ? wikiLabel(raw) : null;
      out.push({ key: key++, text: label ?? raw, link: l });
      pos = l.to;
    }
    if (pos < text.length) out.push({ key: key++, text: text.slice(pos) });
    return out;
  }, [text, links]);

  return (
    <div className="whitespace-pre-wrap break-words" style={style}>
      {segs.map((s) => {
        if (!s.link) return <span key={s.key}>{s.text}</span>;
        const l = s.link;
        const missing = l.kind === 'wiki-missing' || (!l.target && !l.candidates?.length);
        const cls = missing
          ? 'wb-wikilink-missing'
          : l.kind === 'auto'
            ? 'wb-autolink'
            : 'wb-wikilink';
        return (
          <span
            key={s.key}
            className={cls}
            title={missing ? '未找到目标文档' : undefined}
            onClick={(e) => {
              if (missing) return;
              if (l.target) {
                onOpenTarget(l.target);
              } else if (l.candidates?.length) {
                onCandidates(l.term, l.candidates, { x: e.clientX, y: e.clientY });
              }
            }}
          >
            {s.text}
          </span>
        );
      })}
    </div>
  );
});
