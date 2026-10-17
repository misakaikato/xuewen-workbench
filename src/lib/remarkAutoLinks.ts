// remark 插件：把服务端算好的自动内链（词条 / wikilink）按原文偏移映射到 Markdown
// 语法树的 text 节点上，切分为链接节点。链接由渲染层生成，绝不改写原文。
// 与服务端 /api/links/doc 的偏移同基准（GET /api/file 的 BOM 剥离文本）。
import type { Root, Content, Link, Text } from 'mdast';
import { visit } from 'unist-util-visit';
import type { DocLink } from './api';

export function encodeWblink(l: {
  kind: DocLink['kind'];
  path?: string;
  heading?: string | null;
  term: string;
  candidates?: string[];
}): string {
  return 'wblink://' + encodeURIComponent(JSON.stringify({
    k: l.kind, p: l.path ?? null, h: l.heading ?? null, t: l.term, c: l.candidates || null,
  }));
}

export function decodeWblink(url: string): {
  kind: DocLink['kind']; path: string | null; heading: string | null; term: string; candidates: string[] | null;
} | null {
  try {
    const v = JSON.parse(decodeURIComponent(url.replace(/^wblink:\/\//, '')));
    return { kind: v.k, path: v.p, heading: v.h, term: v.t, candidates: v.c };
  } catch {
    return null;
  }
}

export function remarkAutoLinks(links: DocLink[]) {
  // 只应用未忽略、完全落在某个 text 节点内的链接（跳过区已由服务端剔除）
  const usable = (links || [])
    .filter((l) => !l.ignored && l.to > l.from)
    .sort((a, b) => a.from - b.from);

  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (!parent || index == null || node.type !== 'text') return;
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start == null || end == null) return;
      const value = (node as Text).value;
      const hits = usable.filter((l) => l.from >= start && l.to <= end);
      if (!hits.length) return;
      const parts: Content[] = [];
      let pos = start;
      for (const l of hits) {
        if (l.from > pos) parts.push({ type: 'text', value: value.slice(pos - start, l.from - start) });
        const label = l.kind === 'wiki' || l.kind === 'wiki-missing'
          ? (l.display || l.term)
          : value.slice(l.from - start, l.to - start);
        const link: Link = {
          type: 'link',
          url: encodeWblink({
            kind: l.kind,
            path: l.target?.path,
            heading: l.target?.heading ?? null,
            term: l.term,
            candidates: l.candidates,
          }),
          children: [{ type: 'text', value: label }],
        };
        parts.push(link);
        pos = l.to;
      }
      if (pos < end) parts.push({ type: 'text', value: value.slice(pos - start) });
      (parent.children as Content[]).splice(index, 1, ...parts);
      return index + parts.length;
    });
  };
}
