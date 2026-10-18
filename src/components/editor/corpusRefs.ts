// 语料引用编辑器扩展：把正文中的完整文件名 / 「集合|文件名」画成 corpus-ref chip。
// 语义与旧 remarkCorpusRefs 对齐：
// - 跳过围栏代码、链接（含引用式）、图片、自动链接内部；
// - 行内代码整体是一个文件名时，整节点转代码风引用；
// - 与自动内链（alField）区间重叠时让位，避免同一文本双重标记；
// - 光标所在行显示源码（编辑态）；只读态恒渲染。
// 文档变更防抖重扫（装饰只影响显示，绝不改动文档字节）。
import { syntaxTree } from '@codemirror/language';
import { Facet, StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { buildCorpusRefMatcher } from '@/lib/corpusRefMatch';
import type { CorpusRefMatcher, CorpusRefNameEntry } from '@/lib/corpusRefMatch';
import { alField } from './autoLinks';

const crReadOnly = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) });

export const setCorpusNames = StateEffect.define<{
  names: CorpusRefNameEntry[];
  collections: { name: string }[];
}>();
const crRefresh = StateEffect.define<null>();

interface StoredHit {
  from: number;
  to: number;
  url: string;
  inlineCode: boolean;
}

interface CrState {
  matcher: CorpusRefMatcher | null;
  hits: StoredHit[];
  deco: DecorationSet;
}

// 可扫描的文本容器：段落与 ATX 标题（引用/列表内部经由下探自然覆盖）
const SCANNABLE = new Set(['Paragraph', 'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6']);

function scanHits(state: EditorState, matcher: CorpusRefMatcher): StoredHit[] {
  const doc = state.doc;
  const out: StoredHit[] = [];
  const excluded: { from: number; to: number }[] = [];
  const inlineCodes: SyntaxNode[] = [];
  syntaxTree(state).iterate({
    enter: (ref) => {
      const n = ref.name;
      if (n === 'FencedCode' || n === 'Link' || n === 'LinkReference' || n === 'Image' || n === 'Autolink' || n === 'Table') {
        excluded.push({ from: ref.from, to: ref.to });
        return false;
      }
      if (n === 'InlineCode') {
        inlineCodes.push(ref.node);
        excluded.push({ from: ref.from, to: ref.to });
        return false;
      }
      return;
    },
  });
  const overlapsExcluded = (from: number, to: number) => excluded.some((e) => from < e.to && to > e.from);

  syntaxTree(state).iterate({
    enter: (ref) => {
      if (!SCANNABLE.has(ref.name)) return;
      const text = doc.sliceString(ref.from, ref.to);
      for (const h of matcher.find(text)) {
        const from = ref.from + h.start;
        const to = ref.from + h.end;
        if (to <= from || doc.sliceString(from, to).includes('\n')) continue; // 标记不跨行
        if (!overlapsExcluded(from, to)) out.push({ from, to, url: h.url, inlineCode: false });
      }
      return false;
    },
  });

  // 行内代码整体为文件名 → 代码风引用（保留代码观感，去反引号后匹配）
  for (const ic of inlineCodes) {
    const raw = doc.sliceString(ic.from, ic.to).replace(/^`+/, '').replace(/`+$/, '');
    const hits = matcher.find(raw);
    if (hits.length === 1 && hits[0].start === 0 && hits[0].end === raw.length) {
      out.push({ from: ic.from, to: ic.to, url: hits[0].url, inlineCode: true });
    }
  }

  // 与自动内链重叠时让位（词条链接优先，镜像阅读端插件顺序的净效果）
  const links = state.field(alField, false)?.links.filter((l) => !l.ignored) || [];
  if (links.length) {
    return out.filter((h) => !links.some((l) => h.from < l.to && h.to > l.from));
  }
  return out;
}

function buildDeco(hits: StoredHit[]): DecorationSet {
  // 全时渲染：光标行也不揭示源码（论坛编辑器式）
  const parts: Range<Decoration>[] = [];
  for (const h of hits) {
    parts.push(
      Decoration.mark({
        class: h.inlineCode ? 'corpus-ref corpus-ref-inline-code' : 'corpus-ref',
        attributes: { 'data-cr-url': h.url },
      }).range(h.from, h.to)
    );
  }
  return Decoration.set(parts, true);
}

const crField = StateField.define<CrState>({
  create(): CrState {
    return { matcher: null, hits: [], deco: Decoration.none };
  },
  update(value, tr) {
    let matcher = value.matcher;
    let hits = value.hits;
    let rebuildDeco = false;
    let rescan = false;
    for (const e of tr.effects) {
      if (e.is(setCorpusNames)) {
        matcher = buildCorpusRefMatcher(e.value.names, e.value.collections);
        rescan = true;
      } else if (e.is(crRefresh)) {
        rescan = true;
      }
    }
    if (tr.docChanged) {
      // 区间随编辑映射；触及编辑内部的丢弃（与自动内链同策略），稍后由防抖重扫补全
      const changed: [number, number][] = [];
      tr.changes.iterChangedRanges((_fA, _tA, fromB, toB) => changed.push([fromB, toB]));
      hits = hits
        .map((h) => {
          const from = tr.changes.mapPos(h.from, 1);
          const to = tr.changes.mapPos(h.to, 1);
          return from >= to ? null : { ...h, from, to };
        })
        .filter((h): h is StoredHit => !!h && !changed.some(([a, b]) => h.from < b && h.to > a));
      rebuildDeco = true;
    }
    if (tr.selection) rebuildDeco = true;
    if (rescan && matcher) hits = scanHits(tr.state, matcher);
    if (!rescan && !rebuildDeco) return value;
    return { matcher, hits, deco: matcher ? buildDeco(hits) : Decoration.none };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export interface CorpusRefsOptions {
  names: CorpusRefNameEntry[];
  collections: { name: string }[];
  /** 打开引用：url 为 ref:// 或 refc://；at 为点击坐标（供弹层定位） */
  onOpen: (url: string, at: { x: number; y: number }) => void;
  /** 只读实例：永不因选区隐藏，单击即触发 onOpen */
  readOnly?: boolean;
}

function makeCrPlugin(onOpen: (url: string, at: { x: number; y: number }) => void, readOnly: boolean) {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined;
      private view: EditorView;
      constructor(view: EditorView) {
        this.view = view;
      }
      destroy() {
        this.clear();
      }
      private clear() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
      }
      update(u: { docChanged: boolean }) {
        if (!u.docChanged) return;
        this.clear();
        // 停顿 250ms 后全量重扫，输入过程中只依赖区间映射的近似结果
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.view.dispatch({ effects: crRefresh.of(null) });
        }, 250);
      }
    },
    {
      eventHandlers: {
        mousedown(event: MouseEvent, view: EditorView) {
          if (!(readOnly || event.metaKey || event.ctrlKey)) return false;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos == null) return false;
          const hit = view.state.field(crField, false)?.hits.find((h) => h.from <= pos && pos <= h.to);
          if (!hit) return false;
          event.preventDefault();
          onOpen(hit.url, { x: event.clientX, y: event.clientY });
          return true;
        },
      },
    }
  );
}

export function corpusRefsExtension(opts: CorpusRefsOptions): Extension[] {
  return [
    crReadOnly.of(!!opts.readOnly),
    crField,
    makeCrPlugin(opts.onOpen, !!opts.readOnly),
  ];
}

/** 注入 / 更新名称清单（挂载与 refNames 变化时由宿主调用） */
export function pushCorpusNames(
  view: EditorView | null,
  names: CorpusRefNameEntry[],
  collections: { name: string }[]
): void {
  view?.dispatch({ effects: setCorpusNames.of({ names, collections }) });
}
