// remark 插件：在阅读渲染的 Markdown 语法树中识别语料引用
// - 正文中出现的完整文件名（含扩展名）→ 引用链接
// - 「集合名|文件名」（扩展名可省略）→ 集合范围引用
// - 行内代码中完整出现的文件名 → 保留代码外观的引用
// 不处理代码围栏与既有链接内部；只在解析树节点上操作，不做全局文本替换。
import type { Root, Content, Link, InlineCode, Text } from 'mdast';
import { visit } from 'unist-util-visit';

export interface RefNameEntry {
  name: string;
  base: string;
  path: string;
  ext: string;
  dir: string;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BOUNDARY = 'A-Za-z0-9_.\\-/~'; // 文件名特征字符，邻接这些字符时视为更长名称的一部分

export interface RefsPluginOptions {
  names: RefNameEntry[];
  collections: { name: string }[];
  /** 文件名自动链接：已由服务端词条索引（/api/links/doc）接管，默认关闭 */
  fileLinks?: boolean;
}

export function remarkCorpusRefs(options: RefsPluginOptions) {
  const fileNames = options.fileLinks === false
    ? []
    : [...new Set(options.names.map((n) => n.name))].sort((a, b) => b.length - a.length);
  const colNames = options.collections.map((c) => c.name).filter(Boolean);
  if (!fileNames.length && !colNames.length) return () => {};

  const fileAlt = fileNames.map(escapeRe).join('|');
  const fileRe = fileAlt
    ? new RegExp(`(?<![${BOUNDARY}])(${fileAlt})(?![${BOUNDARY}])`, 'g')
    : null;

  // 集合|文件名：文件名部分允许空格与中文，但不跨越标点与空白
  const colAlt = colNames.map(escapeRe).join('|');
  const colRe = colAlt
    ? new RegExp(`(?<![${BOUNDARY}])(${colAlt})\\|([^\\s|()\\[\\]<>"'，。；：、？！]+)`, 'g')
    : null;

  interface Hit { start: number; end: number; url: string }
  function findHits(value: string): Hit[] {
    const hits: Hit[] = [];
    if (colRe) {
      colRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = colRe.exec(value))) {
        hits.push({ start: m.index, end: m.index + m[0].length, url: 'refc://' + encodeURIComponent(m[1]) + '|' + encodeURIComponent(m[2]) });
      }
    }
    if (fileRe) {
      fileRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = fileRe.exec(value))) {
        const s = m.index;
        const e = s + m[0].length;
        // 不与「集合|文件名」命中重叠
        if (!hits.some((h) => s < h.end && e > h.start)) {
          hits.push({ start: s, end: e, url: 'ref://' + encodeURIComponent(m[0]) });
        }
      }
    }
    return hits.sort((a, b) => a.start - b.start);
  }

  function splitText(node: Text, hits: Hit[]): Content[] {
    const out: Content[] = [];
    let pos = 0;
    for (const h of hits) {
      if (h.start > pos) out.push({ type: 'text', value: node.value.slice(pos, h.start) });
      const link: Link = {
        type: 'link',
        url: h.url,
        children: [{ type: 'text', value: node.value.slice(h.start, h.end) }],
      };
      out.push(link);
      pos = h.end;
    }
    if (pos < node.value.length) out.push({ type: 'text', value: node.value.slice(pos) });
    return out;
  }

  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (!parent || index == null) return;
      const ptype: string = parent.type;
      if (ptype === 'link' || ptype === 'linkReference' || ptype === 'definition') return;

      if (node.type === 'text') {
        const hits = findHits((node as Text).value);
        if (!hits.length) return;
        const parts = splitText(node as Text, hits);
        (parent.children as Content[]).splice(index, 1, ...parts);
        return index + parts.length;
      }

      if (node.type === 'inlineCode' && ptype !== 'code') {
        const value = (node as InlineCode).value;
        const hits = findHits(value);
        // 行内代码整体是一个文件名时才转为引用，保留代码外观
        if (hits.length === 1 && hits[0].start === 0 && hits[0].end === value.length) {
          const link: Link = { type: 'link', url: hits[0].url, children: [node as InlineCode] };
          (parent.children as Content[])[index] = link;
          return index + 1;
        }
      }
    });
  };
}
