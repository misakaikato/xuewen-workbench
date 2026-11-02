// TXT 阅读正文：把链接图（自动内链 / wikilink）按服务端偏移渲染成可点链接，其余纯文本原样。
// 笔记标记与 ?h= 高亮也作为数据传入，由本组件在分段渲染时生成对应 span——不再对 DOM 做 splitText，
// 链接数据晚到重渲后标记仍在。
// 偏移口径与服务端一致：与 indexer 共用 toEditorText（剥 BOM、纯 CRLF 归一为 LF），
// 保证链接区间不随换行漂移。
// 样式复用 .wb-autolink / .wb-wikilink / .wb-wikilink-missing / .cm-note-mark。
import { memo, useMemo } from 'react';
import type { DocLink } from '@/lib/api';
import { toEditorText } from '../../server/editorText.js';

export interface TxtLinkTarget {
  path: string;
  heading?: string | null;
}

interface NoteMark {
  quote: string;
  href: string;
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

// 笔记定位候选：引文每个非空行（≥6 字）截前 80 字，长的优先；只保留长度接近最长候选的，
// 避免退到「第一章」这类到处都有的短串去误标。
function noteQueries(quote: string): string[] {
  const cands = (quote || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 6)
    .map((l) => l.slice(0, 80))
    .sort((a, b) => b.length - a.length);
  if (!cands.length) return [];
  const floor = Math.max(6, Math.floor(cands[0].length * 0.6));
  return cands.filter((q) => q.length >= floor);
}

export const TxtReadBody = memo(function TxtReadBody({
  content,
  links,
  style,
  onOpenTarget,
  onCandidates,
  noteMarks,
  highlightTerm,
  onOpenNote,
}: {
  content: string;
  links: DocLink[];
  style?: React.CSSProperties;
  onOpenTarget: (t: TxtLinkTarget) => void;
  onCandidates: (term: string, candidates: string[], at: { x: number; y: number }) => void;
  noteMarks?: NoteMark[];
  highlightTerm?: string;
  onOpenNote?: (href: string) => void;
}) {
  const text = useMemo(() => toEditorText(content), [content]);

  const segs = useMemo(() => {
    const linkSpans = links
      .filter((l) => !l.ignored && l.to > l.from && l.to <= text.length)
      .map((l) => ({ from: l.from, to: l.to, link: l }))
      .sort((a, b) => a.from - b.from);
    // 笔记 / 高亮区间：与链接重叠时链接优先（否则会切断 wikilink 标签，破坏替换显示）
    const overlap = (a: { from: number; to: number }, b: { from: number; to: number }) => a.from < b.to && a.to > b.from;
    const noteSpans: { from: number; to: number; href: string }[] = [];
    for (const mk of noteMarks || []) {
      for (const q of noteQueries(mk.quote)) {
        let idx = text.indexOf(q);
        while (idx >= 0) {
          const span = { from: idx, to: idx + q.length, href: mk.href };
          if (!linkSpans.some((l) => overlap(span, l))) noteSpans.push(span);
          idx = text.indexOf(q, idx + q.length);
        }
      }
    }
    const hlSpans: { from: number; to: number }[] = [];
    if (highlightTerm) {
      const lower = text.toLowerCase();
      const h = highlightTerm.toLowerCase();
      let idx = lower.indexOf(h);
      while (idx >= 0) {
        const span = { from: idx, to: idx + h.length };
        if (!linkSpans.some((l) => overlap(span, l))) hlSpans.push(span);
        idx = lower.indexOf(h, idx + 1);
      }
    }

    const cuts = new Set<number>([0, text.length]);
    for (const s of [...linkSpans, ...noteSpans, ...hlSpans]) {
      if (s.from >= 0 && s.from <= text.length) cuts.add(s.from);
      if (s.to >= 0 && s.to <= text.length) cuts.add(s.to);
    }
    const points = [...cuts].sort((a, b) => a - b);
    const out: { key: number; text: string; link?: DocLink; noteHref?: string; hl?: boolean }[] = [];
    let key = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i];
      const to = points[i + 1];
      if (from === to) continue;
      const link = linkSpans.find((l) => l.from <= from && to <= l.to);
      if (link) {
        const raw = text.slice(from, to);
        // 标签替换仅在整个链接未被打断时有效（链接区间内的切点只会来自链接自身边界）
        const full = from === link.from && to === link.to;
        const label = full && link.link.kind !== 'auto' ? wikiLabel(raw) : null;
        out.push({ key: key++, text: label ?? raw, link: link.link });
        continue;
      }
      const note = noteSpans.find((n) => n.from <= from && to <= n.to);
      const hl = hlSpans.some((h) => h.from <= from && to <= h.to);
      out.push({ key: key++, text: text.slice(from, to), noteHref: note?.href, hl });
    }
    return out;
  }, [text, links, noteMarks, highlightTerm]);

  return (
    <div className="whitespace-pre-wrap break-words" style={style}>
      {segs.map((s) => {
        if (s.link) {
          const l = s.link;
          const missing = l.kind === 'wiki-missing' || (!l.target && !l.candidates?.length);
          const cls = missing ? 'wb-wikilink-missing' : l.kind === 'auto' ? 'wb-autolink' : 'wb-wikilink';
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
        }
        if (s.noteHref) {
          return (
            <a
              key={s.key}
              className="cm-note-mark"
              title="此处有笔记，点击查看"
              href={s.noteHref}
              onClick={(e) => {
                e.preventDefault();
                onOpenNote?.(s.noteHref!);
              }}
            >
              {s.hl ? <mark>{s.text}</mark> : s.text}
            </a>
          );
        }
        if (s.hl) return <mark key={s.key}>{s.text}</mark>;
        return <span key={s.key}>{s.text}</span>;
      })}
    </div>
  );
});
