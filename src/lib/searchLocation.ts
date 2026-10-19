// 将检索块映射到阅读文本；忽略换行/排版空白，同时保留原始字符坐标。
export interface SearchLocation { text: string; occurrence: number }

export function findSearchLocation(source: string, target: SearchLocation): { from: number; to: number } | null {
  const chars: string[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (/\s/.test(source[i])) continue;
    chars.push(source[i]);
    offsets.push(i);
  }
  const haystack = chars.join('');
  const needle = target.text.replace(/\s/g, '');
  if (!needle) return null;
  let at = -1;
  for (let i = 0; i <= Math.max(0, target.occurrence); i++) {
    at = haystack.indexOf(needle, at + 1);
    if (at < 0) return null;
  }
  return { from: offsets[at], to: offsets[at + needle.length - 1] + 1 };
}

// Word 的段落/行内标签会把一句话拆成多个 Text 节点，使用 Range 跨节点定位。
export function searchLocationRange(root: HTMLElement, target: SearchLocation): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n.parentElement?.closest('script, style, button')) continue;
    nodes.push(n as Text);
  }
  const hit = findSearchLocation(nodes.map((node) => node.data).join(''), target);
  if (!hit) return null;
  const range = document.createRange();
  let offset = 0;
  for (const node of nodes) {
    if (hit.from >= offset && hit.from < offset + node.length) range.setStart(node, hit.from - offset);
    if (hit.to > offset && hit.to <= offset + node.length) {
      range.setEnd(node, hit.to - offset);
      return range;
    }
    offset += node.length;
  }
  return null;
}
