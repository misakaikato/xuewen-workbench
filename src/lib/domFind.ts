import { findAllRanges } from './searchLocation';

export type TextNodeSpan = { node: Text; from: number; to: number };

export function unmarkDomFind(root: HTMLElement) {
  for (const mark of root.querySelectorAll('mark.wb-find-hl')) {
    mark.replaceWith(...mark.childNodes);
  }
  root.normalize();
}

// root 下参与匹配的文本节点及其在拼接文本中的区间（跳过 script/style/button 内的节点）
export function collectTextNodes(root: HTMLElement): TextNodeSpan[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: TextNodeSpan[] = [];
  let length = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n.parentElement?.closest('script, style, button')) continue;
    const node = n as Text;
    nodes.push({ node, from: length, to: length + node.length });
    length += node.length;
  }
  return nodes;
}

// 把拼接文本坐标里的区间逐节点包装：区间、节点都逆序处理，splitText 不影响尚未处理的偏移；
// make 返回 null 时该节点片段保持原样（不切分）。
export function wrapTextRanges(
  nodes: TextNodeSpan[],
  ranges: { from: number; to: number }[],
  make: (rangeIndex: number, node: Text) => HTMLElement | null,
): void {
  for (let i = ranges.length - 1; i >= 0; i--) {
    const hit = ranges[i];
    for (let j = nodes.length - 1; j >= 0; j--) {
      const { node, from, to } = nodes[j];
      if (to <= hit.from || from >= hit.to) continue;
      const wrapper = make(i, node);
      if (!wrapper) continue;
      const start = Math.max(0, hit.from - from);
      const end = Math.min(to, hit.to) - from;
      if (end < node.length) node.splitText(end);
      const target = start ? node.splitText(start) : node;
      target.replaceWith(wrapper);
      wrapper.appendChild(target);
    }
  }
}

// 按正文整体匹配，Range 可跨行内标签；逆序包装各节点片段，不改变标签结构。
export function markDomFind(root: HTMLElement, needle: string, smart: boolean): number {
  unmarkDomFind(root);
  if (!needle) return 0;
  const nodes = collectTextNodes(root);
  const ranges = findAllRanges(nodes.map(({ node }) => node.data).join(''), needle, smart);
  wrapTextRanges(nodes, ranges, (i) => {
    const mark = document.createElement('mark');
    mark.className = 'wb-find-hl';
    mark.dataset.findIndex = String(i);
    return mark;
  });
  return ranges.length;
}
