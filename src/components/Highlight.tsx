// 命中高亮：查询词与文本都经繁→简归一化（等长映射）后匹配，重叠命中合并；检索页与字义库页共用
import { normalizeText } from '../../server/linkMatch.js';

export function Highlight({ text, terms, emphasis }: { text: string; terms: string[]; emphasis?: boolean }) {
  const normalized = normalizeText(text).toLowerCase();
  const matches: { from: number; to: number }[] = [];
  for (const term of terms.filter(Boolean)) {
    const needle = normalizeText(term).toLowerCase();
    for (let at = normalized.indexOf(needle); at >= 0; at = normalized.indexOf(needle, at + needle.length)) {
      matches.push({ from: at, to: at + needle.length });
    }
  }
  matches.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: typeof matches = [];
  for (const hit of matches) {
    const prev = merged[merged.length - 1];
    if (prev && hit.from <= prev.to) prev.to = Math.max(prev.to, hit.to);
    else merged.push({ ...hit });
  }
  let from = 0;
  return <>{merged.map((hit) => {
    const before = text.slice(from, hit.from);
    from = hit.to;
    return <span key={hit.from}>{before}<mark className={emphasis ? 'bg-warning/30 text-foreground rounded-sm px-0.5' : undefined}>{text.slice(hit.from, hit.to)}</mark></span>;
  })}{text.slice(from)}</>;
}
