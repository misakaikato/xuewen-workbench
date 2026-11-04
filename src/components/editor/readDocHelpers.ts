// 阅读操作辅助：高亮字段与标题/定位/查找，宿主（Read 页）经 view 驱动。
import { StateEffect, StateField } from '@codemirror/state';
import type { Range } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { findAllRanges } from '@/lib/searchLocation';
import { frontmatterRange } from './frontmatter';

// ?h= 高亮词：mark 装饰（行内命中，不跨行）
export const setHlTerm = StateEffect.define<string>();

export const hlField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let term: string | null = null;
    for (const e of tr.effects) if (e.is(setHlTerm)) term = e.value;
    if (term === null) return value.map(tr.changes);
    if (!term) return Decoration.none;
    const parts: Range<Decoration>[] = [];
    const doc = tr.state.doc;
    for (const r of findAllRanges(doc.toString().toLowerCase(), term.toLowerCase(), false)) {
      parts.push(Decoration.mark({ class: 'cm-rd-hl' }).range(r.from, r.to));
    }
    return Decoration.set(parts, true);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// 扫描源文 ATX 标题（跳过头信息与围栏代码）：TOC 与锚点定位用
export function docHeadings(view: EditorView): { pos: number; text: string; level: number }[] {
  const out: { pos: number; text: string; level: number }[] = [];
  let inFence = false;
  const doc = view.state.doc;
  const fm = frontmatterRange(doc); // 头信息里的 # 注释不是标题
  for (let i = fm ? doc.lineAt(fm.to).number + 1 : 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const t = line.text;
    if (/^\s*(```|~~~)/.test(t)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(t);
    if (m) out.push({ pos: line.from, text: m[2].replace(/\s+#+\s*$/, '').trim(), level: m[1].length });
  }
  return out;
}

// 滚动外层容器到指定文档位置。
// CM 只渲染视口附近内容：远处位置 coordsAtPos 返回 null（TOC 点击/检索命中跳转曾因此静默失败）。
// 此时用 lineBlockAt 的高度估计先滚到位（误差通常几百 px），目标进入渲染区后再用真实坐标精修。
export function scrollDocToPos(view: EditorView, pos: number, scroller: HTMLElement, offset = 80): boolean {
  const coords = view.coordsAtPos(pos);
  if (coords) {
    const top = coords.top - scroller.getBoundingClientRect().top + scroller.scrollTop - offset;
    scroller.scrollTop = Math.max(0, top);
    return true;
  }
  const block = view.lineBlockAt(pos);
  const scRect = scroller.getBoundingClientRect();
  const docTopInScroller = view.contentDOM.getBoundingClientRect().top - scRect.top + scroller.scrollTop;
  scroller.scrollTop = Math.max(0, docTopInScroller + block.top - offset);
  // 等 CM 测量并渲染目标行，再连续校正排版后的真实坐标。
  const expectedDoc = view.state.doc;
  let lastTop = scroller.scrollTop;
  let tries = 0;
  const refine = () => {
    if (!view.dom.isConnected || view.state.doc !== expectedDoc || !scroller.isConnected) return;
    if (Math.abs(scroller.scrollTop - lastTop) > 2) return; // 用户已滚动，取消旧导航
    const c2 = view.coordsAtPos(pos);
    if (c2) {
      const t2 = c2.top - scroller.getBoundingClientRect().top + scroller.scrollTop - offset;
      scroller.scrollTop = Math.max(0, t2);
      lastTop = scroller.scrollTop;
    }
    if (++tries < 8) requestAnimationFrame(refine);
  };
  requestAnimationFrame(refine);
  return true;
}

// 自 from 起找下一个命中（区分大小写，不回绕；找不到返回 null 由调用方处理）
export function findNextInDoc(
  view: EditorView,
  term: string,
  from: number
): { from: number; to: number } | null {
  const doc = view.state.doc;
  if (!term) return null;
  const startLine = doc.lineAt(Math.min(Math.max(0, from), doc.length));
  for (let i = startLine.number; i <= doc.lines; i++) {
    const line = doc.line(i);
    const start = i === startLine.number ? from - line.from : 0;
    const idx = line.text.indexOf(term, Math.max(0, start));
    if (idx >= 0) return { from: line.from + idx, to: line.from + idx + term.length };
  }
  return null;
}
