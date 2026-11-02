// 文档渲染组件：同一个 CodeMirror 实例承载阅读态与原位编辑态。
// editing 切换只走 StateEffect.reconfigure——文档、滚动、装饰、选区全部原地保留，
// 阅读态与编辑态之间零跳变（这正是「点击编辑=页面不变，只是可改」的实现基础）。
// 页面由外层容器滚动；CM 按视口渲染，远处定位先按块高度滚动再校正。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';
import { EditorView, drawSelection } from '@codemirror/view';
import type { DocLink } from '@/lib/api';
import type { CorpusRefNameEntry } from '@/lib/corpusRefMatch';
import { CodeMirrorEditor } from '@/components/editor/CodeMirrorEditor';
import { livePreview, pushNoteMarks } from '@/components/editor/livePreview';
import { editorBaseExtensions } from '@/components/editor/setup';
import { corpusRefsExtension, pushCorpusNames } from '@/components/editor/corpusRefs';
import { linksExtensionFor, pushDocLinks } from '@/components/editor/autoLinks';
import { copyAsRendered, scheduleCopyRenderWarmup } from '@/components/editor/copyAsRendered';
import { CorpusRefPopover, PathListPopover, type CorpusRefRequest, type PathListRequest } from '@/components/CorpusRefPopover';
import { ExternalLinkDialog } from '@/components/ExternalLinkDialog';
import { resolveDocTarget } from '@/lib/docLink';
import { useApp } from '@/store/app-context';
import { findHlField } from '@/lib/readFindHighlight';
import { hlField, setHlTerm } from '@/components/editor/readDocHelpers';

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

// 内容变化时按差异范围 dispatch：找公共前后缀，只替换中间变化段。
// 未变化区域的内链/装饰保留，滚动位置也不动（外部改动刷新与预览更新共用）。
function diffReplace(view: EditorView, next: string): void {
  const cur = view.state.sliceDoc(0);
  if (cur === next) return;
  const n = cur.length;
  const m = next.length;
  let start = 0;
  while (start < n && start < m && cur.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (end < n - start && end < m - start && cur.charCodeAt(n - 1 - end) === next.charCodeAt(m - 1 - end)) end++;
  view.dispatch({ changes: { from: start, to: n - end, insert: next.slice(start, m - end) } });
}

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
  // 库外链接确认：解析越过知识库根的相对链接
  const [extPath, setExtPath] = useState<string | null>(null);
  const { config } = useApp();
  const baseDirRef = useRef(config?.baseDir ?? null);
  baseDirRef.current = config?.baseDir ?? null;

  const docDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
  const docDirRef = useRef(docDir);
  docDirRef.current = docDir;
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const onOpenConceptRef = useRef(onOpenConcept);
  onOpenConceptRef.current = onOpenConcept;

  // 挂载后空闲时预热复制渲染管线（unified/remark 按需 chunk）
  useEffect(() => { scheduleCopyRenderWarmup(); }, []);

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
    let decoded: string;
    try {
      decoded = decodeURIComponent(filePart);
    } catch {
      return;
    }
    const target = resolveDocTarget(docDirRef.current, decoded, baseDirRef.current);
    if (target.kind === 'external') {
      setExtPath(target.path);
      return;
    }
    const nav = '/read/' + encPath(target.path);
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
  // 统一更新入口：经 CodeMirrorEditor 的唯一 updateListener 调用（不再另挂第二个监听器）
  const onUpdate = useCallback(
    (u: ViewUpdate) => {
      if (u.docChanged) onDocChangedRef.current?.(u.state.sliceDoc(0));
      onViewUpdateRef.current?.(u);
    },
    []
  );

  const extensions = useMemo<Extension[]>(() => {
    const stack: Extension[] = [
      EditorState.lineSeparator.of(lineSep),
      EditorView.lineWrapping,
      drawSelection(),
      ...livePreview({ docPath, openLink, openNote: onOpenNote, openDocLink: openLinkTarget, onCandidates, readOnly: !editing, geometry: 'card' }),
      ...corpusRefsExtension({
        names: [],
        collections: [],
        onOpen: (url, at) => setCrReq({ url, ...at }),
        readOnly: !editing,
      }),
      ...linksExtensionFor(docPath, { onOpen: openLinkTarget, onCandidates, readOnly: !editing }),
      hlField,
      findHlField,
    ];
    if (editing) {
      stack.push(...editorBaseExtensions({ lineNumbers: false, foldGutter: false }));
    } else {
      stack.push(EditorView.editable.of(false), EditorState.readOnly.of(true), copyAsRendered());
    }
    return stack;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docPath, editing, lineSep]);

  // content 外部变化（换文档 / 保存后刷新 / 外部改动）：编辑态绝不回写（缓冲区是唯一事实）
  useEffect(() => {
    const v = viewRef.current;
    if (!v || editing) return;
    diffReplace(v, content);
  }, [content, editing]);

  // 数据注入：名称清单 / 词条链接 / 高亮词（reconfigure 不重建 StateField，注入跨态存活）
  useEffect(() => {
    pushCorpusNames(viewRef.current, refNames, collections);
  }, [refNames, collections]);
  useEffect(() => {
    pushDocLinks(viewRef.current, links || [], 0);
  }, [links]);
  useEffect(() => {
    pushNoteMarks(viewRef.current, noteMarks || []);
  }, [noteMarks]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setHlTerm.of(highlightTerm || '') });
  }, [highlightTerm]);

  return (
    <div className="min-w-0 ro-doc">
      <CodeMirrorEditor
        initialDoc={content}
        extensions={extensions}
        onUpdate={onUpdate}
        onCreate={(v) => {
          viewRef.current = v;
          onReady?.(v);
        }}
        height="auto"
        ariaLabel="文档阅读器"
      />
      <CorpusRefPopover req={crReq} onClose={() => setCrReq(null)} />
      <PathListPopover req={candReq} onClose={() => setCandReq(null)} />
      <ExternalLinkDialog path={extPath} onClose={() => setExtPath(null)} />
    </div>
  );
}
