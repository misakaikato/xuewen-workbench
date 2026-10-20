// 文档渲染组件：同一个 CodeMirror 实例承载阅读态与原位编辑态。
// editing 切换只走 StateEffect.reconfigure——文档、滚动、装饰、选区全部原地保留，
// 阅读态与编辑态之间零跳变（这正是「点击编辑=页面不变，只是可改」的实现基础）。
// 页面滚动由外层容器承担（height auto、全文渲染）；滚动定位统一走 coordsAtPos。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import type { Extension, Range } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';
import { Decoration, EditorView, drawSelection } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import type { DocLink } from '@/lib/api';
import type { CorpusRefNameEntry } from '@/lib/corpusRefMatch';
import { CodeMirrorEditor } from '@/components/editor/CodeMirrorEditor';
import { livePreview } from '@/components/editor/livePreview';
import { editorBaseExtensions } from '@/components/editor/setup';
import { corpusRefsExtension, pushCorpusNames } from '@/components/editor/corpusRefs';
import { linksExtensionFor, pushDocLinks } from '@/components/editor/autoLinks';
import { copyAsRendered } from '@/components/editor/copyAsRendered';
import { CorpusRefPopover, PathListPopover, type CorpusRefRequest, type PathListRequest } from '@/components/CorpusRefPopover';

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

function joinRel(baseDir: string, rel: string): string {
  const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean);
  for (const seg of rel.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

// ?h= 高亮词：mark 装饰（行内命中，不跨行）
export const setHlTerm = StateEffect.define<string>();
const hlField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let term: string | null = null;
    for (const e of tr.effects) if (e.is(setHlTerm)) term = e.value;
    if (term === null) return value.map(tr.changes);
    if (!term) return Decoration.none;
    const parts: Range<Decoration>[] = [];
    const doc = tr.state.doc;
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      let from = 0;
      while ((from = line.text.indexOf(term, from)) >= 0) {
        parts.push(Decoration.mark({ class: 'cm-rd-hl' }).range(line.from + from, line.from + from + term.length));
        from += term.length;
      }
    }
    return Decoration.set(parts, true);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export interface ReadOnlyDocProps {
  content: string;
  docPath: string;
  refNames: CorpusRefNameEntry[];
  collections: { name: string }[];
  links?: DocLink[];
  /** 搜索跳转携带的高亮词（backlinks 的 ?h=） */
  highlightTerm?: string;
  /** 划线笔记标记：正文中做过的笔记原文 → 下划线，点击跳笔记锚点 */
  noteMarks?: { quote: string; href: string }[];
  onOpenNote?: (href: string) => void;
  /** 点击概念词条：打开概念详情 */
  onOpenConcept?: (name: string) => void;
  onReady?: (view: EditorView) => void;
  /** 原位编辑态：切换只 reconfigure，实例与滚动不动 */
  editing?: boolean;
  /** 行分隔符（字节精确：创建与编辑都显式声明） */
  lineSep?: '\r\n' | '\n';
  /** 编辑态：文档变化回调（精确文本，含 CRLF） */
  onDocChanged?: (exactText: string) => void;
  /** 编辑态：选区/文档变化通知（工具栏刷新用） */
  onViewUpdate?: (u: ViewUpdate) => void;
}

export function ReadOnlyDoc({
  content, docPath, refNames, collections, links, highlightTerm, noteMarks, onOpenNote, onOpenConcept, onReady,
  editing = false, lineSep = '\n', onDocChanged, onViewUpdate,
}: ReadOnlyDocProps) {
  const navigate = useNavigate();
  const viewRef = useRef<EditorView | null>(null);
  const [crReq, setCrReq] = useState<CorpusRefRequest | null>(null);
  const [candReq, setCandReq] = useState<PathListRequest | null>(null);

  const docDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
  const docDirRef = useRef(docDir);
  docDirRef.current = docDir;
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const onOpenConceptRef = useRef(onOpenConcept);
  onOpenConceptRef.current = onOpenConcept;

  // 相对链接应用内导航，http(s) 外开；本文件锚点走 hash（页面按标题定位）
  const openLink = useCallback((href: string) => {
    if (/^https?:\/\//i.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    const [filePart, anchor] = href.split('#');
    if (!filePart) {
      if (anchor) navRef.current('#' + encodeURIComponent(decodeURIComponent(anchor)));
      return;
    }
    let target: string;
    try {
      target = joinRel(docDirRef.current, decodeURIComponent(filePart));
    } catch {
      return;
    }
    const nav = '/read/' + encPath(target);
    navRef.current(anchor ? nav + '#' + encodeURIComponent(anchor) : nav);
  }, []);

  const openLinkTarget = useCallback((t: { path: string; heading?: string | null }) => {
    // 概念词条：target 是 concept:<名称> 伪路径，交给上层打开概念详情
    if (t.path.startsWith('concept:')) {
      onOpenConceptRef.current?.(t.path.slice('concept:'.length));
      return;
    }
    const nav = '/read/' + encPath(t.path);
    navRef.current(t.heading ? nav + '#' + encodeURIComponent(t.heading) : nav);
  }, []);
  const onCandidates = useCallback((term: string, candidates: string[], at: { x: number; y: number }) => {
    setCandReq({ title: `「${term}」指向 ${candidates.length} 个文档，请选择：`, paths: candidates, ...at });
  }, []);

  // 回调走 ref：扩展数组不因回调身份变化而重建
  const onDocChangedRef = useRef(onDocChanged);
  onDocChangedRef.current = onDocChanged;
  const onViewUpdateRef = useRef(onViewUpdate);
  onViewUpdateRef.current = onViewUpdate;
  const vuListenerRef = useRef(
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onDocChangedRef.current?.(u.state.sliceDoc(0));
      onViewUpdateRef.current?.(u);
    })
  );

  const extensions = useMemo<Extension[]>(() => {
    const stack: Extension[] = [
      EditorState.lineSeparator.of(lineSep),
      EditorView.lineWrapping,
      drawSelection(),
      ...livePreview({ docPath, openLink, openNote: onOpenNote, openDocLink: openLinkTarget, readOnly: !editing, geometry: 'card', noteMarks }),
      ...corpusRefsExtension({
        names: [],
        collections: [],
        onOpen: (url, at) => setCrReq({ url, ...at }),
        readOnly: !editing,
      }),
      ...linksExtensionFor(docPath, { onOpen: openLinkTarget, onCandidates, readOnly: !editing }),
      hlField,
    ];
    if (editing) {
      stack.push(...editorBaseExtensions({ lineNumbers: false, foldGutter: false }), vuListenerRef.current);
    } else {
      stack.push(EditorView.editable.of(false), EditorState.readOnly.of(true), copyAsRendered());
    }
    return stack;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docPath, editing, lineSep]);

  // content 外部变化（换文档 / 保存后刷新）：编辑态绝不回写（缓冲区是唯一事实）
  useEffect(() => {
    const v = viewRef.current;
    if (!v || editing) return;
    if (v.state.sliceDoc(0) !== content) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content } });
    }
  }, [content, editing, onReady]);

  // 数据注入：名称清单 / 词条链接 / 高亮词（reconfigure 不重建 StateField，注入跨态存活）
  useEffect(() => {
    pushCorpusNames(viewRef.current, refNames, collections);
  }, [refNames, collections]);
  useEffect(() => {
    pushDocLinks(viewRef.current, links || [], 0);
  }, [links]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setHlTerm.of(highlightTerm || '') });
  }, [highlightTerm]);

  return (
    <div className="min-w-0 ro-doc">
      <CodeMirrorEditor
        initialDoc={content}
        extensions={extensions}
        onCreate={(v) => {
          viewRef.current = v;
          onReady?.(v);
        }}
        onDocChanged={onDocChanged}
        height="auto"
        ariaLabel="文档阅读器"
      />
      <CorpusRefPopover req={crReq} onClose={() => setCrReq(null)} />
      <PathListPopover req={candReq} onClose={() => setCandReq(null)} />
    </div>
  );
}

// ---------- 阅读操作辅助：宿主（Read 页）经 view 驱动 ----------

// 扫描源文 ATX 标题（跳过围栏代码）：TOC 与锚点定位用
export function docHeadings(view: EditorView): { pos: number; text: string; level: number }[] {
  const out: { pos: number; text: string; level: number }[] = [];
  let inFence = false;
  const doc = view.state.doc;
  for (let i = 1; i <= doc.lines; i++) {
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

// 滚动外层容器到指定文档位置
export function scrollDocToPos(view: EditorView, pos: number, scroller: HTMLElement, offset = 80): boolean {
  const coords = view.coordsAtPos(pos);
  if (!coords) return false;
  const top = coords.top - scroller.getBoundingClientRect().top + scroller.scrollTop - offset;
  scroller.scrollTop = Math.max(0, top);
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
