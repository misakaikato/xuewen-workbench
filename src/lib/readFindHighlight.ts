import { StateEffect, StateField } from '@codemirror/state';
import type { Range } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

// 文内查找高亮：宿主（Read 页查找条）用 findAllRanges 算出区间后整组注入；
// current 单独配色，随「下一个」移动。文档变化时装饰随 changes 映射（大约跟随，不保证精确）。
export const setFindHl = StateEffect.define<{ ranges: { from: number; to: number }[]; current: { from: number; to: number } | null }>();
export const findHlField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let payload: { ranges: { from: number; to: number }[]; current: { from: number; to: number } | null } | null = null;
    for (const e of tr.effects) if (e.is(setFindHl)) payload = e.value;
    if (payload === null) return value.map(tr.changes);
    if (!payload.ranges.length) return Decoration.none;
    const cur = payload.current;
    const parts: Range<Decoration>[] = payload.ranges
      .filter((r) => r.to > r.from && r.from >= 0 && r.to <= tr.state.doc.length)
      .map((r) =>
        Decoration.mark({
          class: cur && r.from === cur.from && r.to === cur.to ? 'cm-rd-find-current' : 'cm-rd-find',
        }).range(r.from, r.to)
      );
    return Decoration.set(parts, true);
  },
  provide: (f) => EditorView.decorations.from(f),
});

