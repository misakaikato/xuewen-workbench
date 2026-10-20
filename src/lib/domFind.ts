import { findAllRanges } from './searchLocation';

export function unmarkDomFind(root: HTMLElement) {
  for (const mark of root.querySelectorAll('mark.wb-find-hl')) {
    mark.replaceWith(...mark.childNodes);
  }
  root.normalize();
}

// 按正文整体匹配，Range 可跨行内标签；逆序包装各节点片段，不改变标签结构。
export function markDomFind(root: HTMLElement, needle: string, smart: boolean): number {
  unmarkDomFind(root);
  if (!needle) return 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; from: number; to: number }[] = [];
  let length = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n.parentElement?.closest('script, style, button')) continue;
    const node = n as Text;
    nodes.push({ node, from: length, to: length + node.length });
    length += node.length;
  }
  const ranges = findAllRanges(nodes.map(({ node }) => node.data).join(''), needle, smart);
  for (let i = ranges.length - 1; i >= 0; i--) {
    const hit = ranges[i];
    for (let j = nodes.length - 1; j >= 0; j--) {
      const { node, from, to } = nodes[j];
      if (to <= hit.from || from >= hit.to) continue;
      const start = Math.max(0, hit.from - from);
      const end = Math.min(to, hit.to) - from;
      if (end < node.length) node.splitText(end);
      const target = start ? node.splitText(start) : node;
      const mark = document.createElement('mark');
      mark.className = 'wb-find-hl';
      mark.dataset.findIndex = String(i);
      target.replaceWith(mark);
      mark.appendChild(target);
    }
  }
  return ranges.length;
}
