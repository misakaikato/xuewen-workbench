// 编辑页：仅由用户主动进入。MD 实时预览（默认）/源码/预览/分栏；JSON 校验与格式化；
// 显式保存写回原文件（原子写+备份+冲突检测，字节精确：除用户改动外不变）；
// 草稿自动本地保存、打开时提示恢复；重命名/移动时缓冲区跟随新路径不丢失。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useBlocker, useLocation } from 'react-router-dom';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { json } from '@codemirror/lang-json';
import { api } from '@/lib/api';
import { useApp } from '@/store/app';
import { useReadingPrefs } from '@/lib/prefs';
import { saveDraft, loadDraft, clearDraft } from '@/lib/drafts';
import type { FilePayload } from '@/lib/types';
import type { DocLink } from '@/lib/api';
import { ReadOnlyDoc } from '@/components/ReadOnlyDoc';
import { registerOpenDoc } from '@/lib/openEditor';
import { runEntryAction, type EntryAction } from '@/lib/entryOps';
import { CodeMirrorEditor } from '@/components/editor/CodeMirrorEditor';
import { editorBaseExtensions, editorBaseThemeSpec } from '@/components/editor/setup';
import { livePreview } from '@/components/editor/livePreview';
import { mdLang } from '@/components/editor/mdLanguage';
import { linksExtensionFor, pushDocLinks } from '@/components/editor/autoLinks';
import { corpusRefsExtension, pushCorpusNames } from '@/components/editor/corpusRefs';
import { FormatToolbar } from '@/components/editor/FormatToolbar';
import { CorpusRefPopover, type CorpusRefRequest } from '@/components/CorpusRefPopover';
import { detectLineSeparator } from '@/components/editor/lineSeparator';
import { BacklinksPanel } from '@/components/BacklinksPanel';
import { Save, Undo2, AlertTriangle, X, CheckCircle2, Columns2, Eye, Code2, Wand2, Link2 } from 'lucide-react';

type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error';
type Mode = 'live' | 'source' | 'preview' | 'split';

// e2e 测试钩子（仅 localStorage wb:e2e=1 时安装）
declare global {
  interface Window {
    __wb?: {
      editor: () => EditorView | null;
      save: () => Promise<void>;
      entryAction: (a: EntryAction) => Promise<{ newPath: string | null }>;
      path: () => string;
      isDirty: () => boolean;
    };
  }
}

// 相对路径解析（与 livePreview / ReadOnlyDoc 同口径）
function joinRel(baseDir: string, rel: string): string {
  const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean);
  for (const seg of rel.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

const plainTheme = EditorView.theme({ ...editorBaseThemeSpec });
const jsonTheme = (codeFontSize: number) =>
  EditorView.theme({
    ...editorBaseThemeSpec,
    '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: codeFontSize + 'px', lineHeight: '1.65' },
  });

export default function Edit() {
  const params = useParams();
  const relPath = useMemo(() => decodeURIComponent(params['*'] || ''), [params]);
  const { dsId } = useApp();
  const { prefs } = useReadingPrefs();
  const navigate = useNavigate();
  const location = useLocation();

  const [file, setFile] = useState<FilePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState(''); // 精确文本（含 CRLF 等，与磁盘字节一致）
  const [saveState, setSaveState] = useState<SaveState>('clean');
  const [saveMsg, setSaveMsg] = useState('');
  const [mode, setMode] = useState<Mode>('live'); // .md 默认实时预览；JSON 恒为源码
  const [lineSep, setLineSep] = useState<'\r\n' | '\n'>('\n');
  const [loadSeq, setLoadSeq] = useState(0); // 全新加载时 +1 → 重建编辑器实例
  const [draftPrompt, setDraftPrompt] = useState<{ content: string; savedAt: number } | null>(null);
  const [conflict, setConflict] = useState<{ current: string; currentMtimeMs: number } | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const baseMtimeRef = useRef(0);
  const baseTextRef = useRef(''); // 最近一次载入/保存时的精确文本
  const viewRef = useRef<EditorView | null>(null);
  const dirtyRef = useRef(false);
  const everLoadedRef = useRef(false);
  const prevRelPathRef = useRef<string | null>(null);
  const pathRef = useRef(relPath);
  pathRef.current = relPath;
  const [refNames, setRefNames] = useState<{ name: string; base: string; path: string; ext: string; dir: string }[]>([]);
  const [collections, setCollections] = useState<{ name: string }[]>([]);
  const [docLinks, setDocLinks] = useState<DocLink[]>([]);
  const [crReq, setCrReq] = useState<CorpusRefRequest | null>(null);
  const [showBacklinks, setShowBacklinks] = useState(false);
  const splitPreviewRef = useRef<HTMLDivElement | null>(null);
  const syncLockRef = useRef(0);
  // 工具栏重渲染触发：选区/文档变化时递增版本（扩展身份稳定，随 reconfigure 复用）
  const [fmtVer, setFmtVer] = useState(0);
  const fmtListenerRef = useRef(
    EditorView.updateListener.of((u) => {
      if (u.docChanged || u.selectionSet) setFmtVer((v) => v + 1);
    })
  );

  const isJson = file?.type === 'json';
  const effMode: 'source' | 'preview' | 'split' | 'live' = isJson ? 'source' : mode;
  const isLive = effMode === 'live';
  const dirty = saveState === 'dirty' || saveState === 'error';
  dirtyRef.current = dirty;

  // 文件被重命名/移动/删除后由目录树带 wbFollow 跳转，不拦截（缓冲区与草稿已随行）
  const blocker = useBlocker(({ nextLocation }) => dirty && !(nextLocation.state as { wbFollow?: boolean } | null)?.wbFollow);

  // 缓冲区当前精确文本（保存与脏检测都以此为准，避免 React 状态滞后）
  const buffer = useCallback(
    () => (viewRef.current ? viewRef.current.state.sliceDoc(0) : content),
    [content]
  );

  const onDocChanged = useCallback(
    (exact: string) => {
      setContent(exact);
      setSaveState(exact === baseTextRef.current ? 'clean' : 'dirty');
      if (isJson) validateJson(exact);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isJson]
  );

  // 编辑器滚动比例（阅读↔编辑往返延续用）
  const editorRatio = useCallback(() => {
    const sc = viewRef.current?.scrollDOM;
    if (!sc) return 0;
    const max = sc.scrollHeight - sc.clientHeight;
    return max > 0 ? Math.min(1, Math.max(0, sc.scrollTop / max)) : 0;
  }, []);

  // 阅读页带来的滚动位置：编辑器就绪后按比例恢复（两引擎内容高度不同，比例近似）
  useEffect(() => {
    if (!file || !viewRef.current) return;
    const ratio = (location.state as { wbScrollRatio?: number } | null)?.wbScrollRatio;
    if (typeof ratio !== 'number' || ratio <= 0) return;
    const sc = viewRef.current.scrollDOM;
    const raf = requestAnimationFrame(() => {
      const max = sc.scrollHeight - sc.clientHeight;
      if (max > 0) sc.scrollTop = ratio * max;
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSeq]);

  // split 模式左右滚动同步（比例互随，150ms 防回环锁）
  useEffect(() => {
    if (effMode !== 'split') return;
    const v = viewRef.current;
    const right = splitPreviewRef.current;
    if (!v || !right) return;
    const left = v.scrollDOM;
    let raf = 0;
    const ratioOf = (el: HTMLElement) => {
      const m = el.scrollHeight - el.clientHeight;
      return m > 0 ? el.scrollTop / m : 0;
    };
    const onLeft = () => {
      if (Date.now() < syncLockRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        syncLockRef.current = Date.now() + 150;
        const m = right.scrollHeight - right.clientHeight;
        if (m > 0) right.scrollTop = ratioOf(left) * m;
      });
    };
    const onRight = () => {
      if (Date.now() < syncLockRef.current) return;
      syncLockRef.current = Date.now() + 150;
      const m = left.scrollHeight - left.clientHeight;
      if (m > 0) left.scrollTop = ratioOf(right) * m;
    };
    left.addEventListener('scroll', onLeft, { passive: true });
    right.addEventListener('scroll', onRight, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      left.removeEventListener('scroll', onLeft);
      right.removeEventListener('scroll', onRight);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effMode, loadSeq]);

  const validateJson = useCallback(
    (text: string): boolean => {
      if (!isJson) return true;
      try {
        JSON.parse(text);
        setJsonError(null);
        return true;
      } catch (e) {
        setJsonError((e as Error).message);
        return false;
      }
    },
    [isJson]
  );

  // 加载文件 + 草稿检测（草稿不自动进入编辑，由用户选择恢复）。
  // wbFollow 到达的新路径 = 本文档被重命名/移动：只重绑路径与 mtime 基准，
  // 绝不替换缓冲区（操作前已 flush，操作期间的输入也必须保留）。
  useEffect(() => {
    if (!dsId || !relPath) return;
    let dead = false;
    const from = prevRelPathRef.current;
    prevRelPathRef.current = relPath;
    const rebind =
      everLoadedRef.current && from !== null && from !== relPath &&
      (location.state as { wbFollow?: boolean } | null)?.wbFollow === true;
    api.file(relPath)
      .then((f) => {
        if (dead) return;
        if (f.readonly) {
          navigate('/read/' + encPath(relPath), { replace: true });
          return;
        }
        everLoadedRef.current = true;
        setFile(f);
        baseMtimeRef.current = f.mtimeMs;
        if (rebind) {
          baseTextRef.current = viewRef.current ? viewRef.current.state.sliceDoc(0) : f.content || '';
          return;
        }
        const draft = loadDraft(dsId, relPath);
        if (draft && draft.content !== f.content) setDraftPrompt(draft);
        const text = f.content || '';
        setContent(text);
        baseTextRef.current = text;
        setLineSep(detectLineSeparator(text));
        setSaveState('clean');
        setLoadSeq((s) => s + 1);
        api.refNames().then((n) => {
          if (!dead && n.dsId === dsId) {
            setRefNames(n.names);
            setCollections(n.collections);
          }
        }).catch(() => {});
      })
      .catch((e) => !dead && setError(e.message));
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsId, relPath]);

  // 草稿自动保存（防抖）
  useEffect(() => {
    if (!dirty || !dsId) return;
    const t = setTimeout(() => saveDraft(dsId, relPath, content), 1200);
    return () => clearTimeout(t);
  }, [content, dirty, dsId, relPath]);

  // 关闭页面保护
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // 自动内链：拉取服务端链接（就绪前轮询），注入编辑器装饰与预览面板；保存/更新后重拉
  const linksSeqRef = useRef(0);
  const isJsonRef = useRef(false);
  isJsonRef.current = isJson;
  const pullLinksAbortRef = useRef<() => void>(() => {});
  const pullLinks = useCallback(
    async (minSeq: number) => {
      if (!dsId || !relPath || isJsonRef.current) return;
      let dead = false;
      const stop = () => {
        dead = true;
      };
      pullLinksAbortRef.current?.();
      pullLinksAbortRef.current = stop;
      for (let i = 0; i < 30 && !dead; i++) {
        const r = await api.linksDoc(relPath).catch(() => null);
        if (dead || !r || r.dsId !== dsId) return;
        if (r.ready && r.buildSeq >= minSeq) {
          linksSeqRef.current = r.buildSeq;
          setDocLinks(r.links);
          pushDocLinks(viewRef.current, r.links, r.buildSeq);
          return;
        }
        await new Promise((s) => setTimeout(s, 500));
      }
    },
    [dsId, relPath]
  );
  useEffect(() => {
    linksSeqRef.current = 0;
    setDocLinks([]);
    pullLinks(0);
    return () => pullLinksAbortRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsId, relPath, loadSeq]);
  // 语料引用名称清单注入编辑器（挂载与 refNames 变化时）
  useEffect(() => {
    pushCorpusNames(viewRef.current, refNames, collections);
  }, [refNames, collections, loadSeq]);
  useEffect(() => {
    const h = () => pullLinks(0);
    window.addEventListener('wb-links-updated', h);
    return () => window.removeEventListener('wb-links-updated', h);
  }, [pullLinks]);

  // 实际写盘（抛错由调用方处理）；成功后更新基准文本与 mtime
  const performSave = useCallback(
    async (text: string, overrideMtime?: number) => {
      if (!file || !dsId) throw new Error('文档尚未加载');
      const r = await api.saveFile(relPath, text, overrideMtime ?? baseMtimeRef.current, dsId);
      baseMtimeRef.current = r.mtimeMs;
      baseTextRef.current = text;
      clearDraft(dsId, relPath);
      return r;
    },
    [file, dsId, relPath]
  );

  const doSave = useCallback(
    async (andReturn: boolean, overrideMtime?: number, force = false) => {
      if (!file || !dsId) return;
      const text = buffer();
      if (!force && text === baseTextRef.current && !dirty) return;
      if (isJson && !validateJson(text)) {
        setSaveState('error');
        setSaveMsg('JSON 语法错误，修正后才能保存');
        return;
      }
      setSaveState('saving');
      setSaveMsg('');
      try {
        await performSave(text, overrideMtime);
        setConflict(null);
        setSaveState('saved');
        setSaveMsg('已保存到 ' + relPath);
        // 保存后重拉自动内链（等待新一次索引构建）并刷新反向链接面板
        pullLinks(linksSeqRef.current + 1);
        window.dispatchEvent(new CustomEvent('wb-links-updated'));
        if (andReturn) {
          navigate('/read/' + encPath(relPath), { state: { wbScrollRatio: editorRatio() } });
        }
      } catch (e) {
        const err = e as Error & { conflict?: boolean; current?: string; currentMtimeMs?: number; missing?: boolean };
        setSaveState('error');
        if (err.conflict) {
          setConflict({ current: err.current || '', currentMtimeMs: err.currentMtimeMs || 0 });
          setSaveMsg('文件已被外部修改，请处理冲突');
        } else {
          setSaveMsg('保存失败：' + err.message + '（草稿已保留在本地）');
        }
      }
    },
    [file, dsId, buffer, dirty, isJson, relPath, navigate, performSave, validateJson, pullLinks, editorRatio]
  );

  // Ctrl+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        doSave(false);
      }
      if (e.key === 'Escape') setConflict(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doSave]);

  // 程序化替换整个缓冲区（恢复草稿 / 重载磁盘版本 / JSON 格式化）
  const replaceBuffer = useCallback((text: string) => {
    const v = viewRef.current;
    if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    else setContent(text);
  }, []);

  // 登记为“打开中的文档”：目录树重命名/移动前会先 flush
  const flushRef = useRef(() => Promise.resolve());
  flushRef.current = async () => {
    if (!file || !dsId) return;
    const text = buffer();
    if (text === baseTextRef.current) return; // 无修改：空操作
    await performSave(text);
    setSaveState('saved');
    setSaveMsg('已自动保存：' + relPath);
  };
  useEffect(() => {
    if (!dsId || !relPath || !file || file.readonly) return;
    return registerOpenDoc({
      path: relPath,
      isDirty: () => {
        const v = viewRef.current;
        return v ? v.state.sliceDoc(0) !== baseTextRef.current : dirtyRef.current;
      },
      flush: () => flushRef.current(),
    });
  }, [dsId, relPath, file]);

  // e2e 测试钩子
  const forceSaveRef = useRef(() => Promise.resolve());
  forceSaveRef.current = () => doSave(false, undefined, true);
  useEffect(() => {
    if (localStorage.getItem('wb:e2e') !== '1') return;
    window.__wb = {
      editor: () => viewRef.current,
      save: () => forceSaveRef.current(),
      entryAction: (a: EntryAction) => runEntryAction(a),
      path: () => pathRef.current,
      isDirty: () => {
        const v = viewRef.current;
        return v ? v.state.sliceDoc(0) !== baseTextRef.current : dirtyRef.current;
      },
    };
    return () => {
      if (window.__wb) delete window.__wb;
    };
  }, []);

  // 链接打开（实时预览 Cmd/Ctrl+点击）：内部相对路径应用内导航，http(s) 外开
  const docDirRef = useRef('');
  docDirRef.current = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const openLink = useCallback((href: string) => {
    if (/^https?:\/\//i.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    const [filePart, anchor] = href.split('#');
    if (!filePart) return;
    let target: string;
    try {
      target = joinRel(docDirRef.current, decodeURIComponent(filePart));
    } catch {
      return;
    }
    const nav = '/read/' + encPath(target);
    navRef.current(anchor ? nav + '#' + encodeURIComponent(anchor) : nav);
  }, []);

  // 自动内链目标打开：跳阅读页（含标题锚点）
  const openLinkTarget = useCallback((t: { path: string; heading?: string | null }) => {
    const nav = '/read/' + encPath(t.path);
    navRef.current(t.heading ? nav + '#' + encodeURIComponent(t.heading) : nav);
  }, []);
  const openLinkTargetRef = useRef(openLinkTarget);
  openLinkTargetRef.current = openLinkTarget;

  // 编辑器扩展：显式行分隔符保证字节精确；实时预览/源码按模式切换（重配置不重建）
  const extensions = useMemo<Extension[]>(() => {
    const list: Extension[] = [
      EditorState.lineSeparator.of(lineSep),
      fmtListenerRef.current,
      ...editorBaseExtensions({ lineNumbers: !isLive, foldGutter: !isLive }),
    ];
    if (isJson) {
      list.push(json(), jsonTheme(prefs.codeFontSize));
    } else {
      // 自动内链标记只在 md 模式挂载（实时预览与源码都有下划线；JSON 不适用）
      list.push(...linksExtensionFor(relPath, {
        onOpen: (t) => openLinkTargetRef.current(t),
      }));
      if (isLive) {
        list.push(
          ...livePreview({ docPath: relPath, openLink }),
          ...corpusRefsExtension({
            names: [],
            collections: [],
            onOpen: (url, at) => setCrReq({ url, ...at }),
          })
        );
      } else {
        list.push(...mdLang(), plainTheme);
      }
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isJson, isLive, lineSep, relPath, prefs.codeFontSize]);

  // 路由离开拦截：使用页面内对话框（window.confirm 在部分嵌入浏览器中不可靠）
  const [leaveAction, setLeaveAction] = useState<'save' | null>(null);
  useEffect(() => {
    if (leaveAction === 'save' && blocker.state === 'blocked') {
      setLeaveAction(null);
      doSave(false).then(() => blocker.proceed());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaveAction, blocker.state]);

  if (error) {
    return (
      <div className="max-w-xl mx-auto py-16 text-center">
        <AlertTriangle className="w-10 h-10 mx-auto text-amber-600 mb-3" />
        <p className="text-sm text-muted-foreground mb-4">{error}</p>
        <button className="px-4 py-2 rounded border border-border text-sm hover:bg-accent" onClick={() => navigate(-1)}>
          返回
        </button>
      </div>
    );
  }
  if (!file) return <div className="py-20 text-center text-sm text-muted-foreground">加载中…</div>;

  const editorEl = (
    <CodeMirrorEditor
      key={loadSeq}
      initialDoc={content}
      extensions={extensions}
      onCreate={(v) => {
        viewRef.current = v;
        setFmtVer((x) => x + 1);
      }}
      onDocChanged={onDocChanged}
    />
  );

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* 工具行 */}
      <div className="shrink-0 border-b border-border bg-card px-3 py-2 flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium truncate max-w-[40vw]" title={relPath}>{file.name}</span>
        <span className="text-xs text-muted-foreground truncate hidden sm:inline">{relPath}</span>
        <span
          className={`text-xs px-2 py-0.5 rounded-full border ${
            saveState === 'dirty'
              ? 'border-amber-400 text-amber-700 dark:text-amber-400'
              : saveState === 'saved'
                ? 'border-green-400 text-green-700 dark:text-green-400'
                : saveState === 'error'
                  ? 'border-red-400 text-red-700 dark:text-red-400'
                  : 'border-border text-muted-foreground'
          }`}
        >
          {saveState === 'dirty' && '未保存'}
          {saveState === 'saving' && '保存中…'}
          {saveState === 'saved' && '已保存'}
          {saveState === 'error' && '保存失败'}
          {saveState === 'clean' && '无修改'}
        </span>
        <div className="flex-1" />
        {!isJson && (
          <div className="inline-flex rounded border border-border overflow-hidden text-xs">
            {([['live', Wand2, '实时预览'], ['source', Code2, '源码'], ['preview', Eye, '预览'], ['split', Columns2, '分栏']] as const).map(([m, Icon, label]) => (
              <button
                key={m}
                className={`px-2.5 py-1 flex items-center gap-1 ${effMode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
                onClick={() => setMode(m)}
              >
                <Icon className="w-3.5 h-3.5" /> {label}
              </button>
            ))}
          </div>
        )}
        {isJson && (
          <button
            className="text-xs px-2.5 py-1 rounded border border-border hover:bg-accent"
            onClick={() => {
              try {
                const t = JSON.stringify(JSON.parse(buffer()), null, 2).split('\n').join(lineSep);
                replaceBuffer(t);
                setSaveState('dirty');
                setJsonError(null);
              } catch (e) {
                setJsonError((e as Error).message);
              }
            }}
          >
            格式化
          </button>
        )}
        {!isJson && (
          <button
            className={`text-xs px-2.5 py-1.5 rounded border flex items-center gap-1 ${showBacklinks ? 'border-primary text-primary' : 'border-border hover:bg-accent'}`}
            onClick={() => setShowBacklinks(!showBacklinks)}
            title="提到本篇的文档"
          >
            <Link2 className="w-3.5 h-3.5" /> 反向链接
          </button>
        )}
        <button
          className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent disabled:opacity-40 flex items-center gap-1"
          disabled={!dirty}
          onClick={() => doSave(false)}
          title="Ctrl+S"
        >
          <Save className="w-3.5 h-3.5" /> 保存
        </button>
        <button
          className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 flex items-center gap-1"
          disabled={!dirty}
          onClick={() => doSave(true)}
        >
          保存并返回阅读
        </button>
        <button
          className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent flex items-center gap-1"
          onClick={() => navigate('/read/' + encPath(relPath), { state: { wbScrollRatio: editorRatio() } })}
        >
          <Undo2 className="w-3.5 h-3.5" /> 返回阅读
        </button>
      </div>

      {saveMsg && (
        <div
          className={`shrink-0 text-xs px-3 py-1.5 flex items-center gap-1.5 ${
            saveState === 'saved' ? 'bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300' : 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300'
          }`}
        >
          {saveState === 'saved' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
          {saveMsg}
        </div>
      )}
      {jsonError && (
        <div className="shrink-0 text-xs px-3 py-1.5 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          JSON 语法错误：{jsonError}
        </div>
      )}

      {/* 编辑区 */}
      <div className="flex-1 min-h-0 flex flex-col">
        {isLive && <FormatToolbar view={viewRef.current} version={fmtVer} />}
        <div className="flex-1 min-h-0 flex">
          {effMode !== 'preview' && (
            <div className={`min-w-0 ${effMode === 'split' ? 'w-1/2 border-r border-border' : 'flex-1'}`}>{editorEl}</div>
          )}
          {(effMode === 'preview' || effMode === 'split') && (
            <div
              ref={splitPreviewRef}
              className={`min-w-0 overflow-auto p-6 ${effMode === 'split' ? 'w-1/2' : 'flex-1'}`}
            >
              <ReadOnlyDoc
                key={relPath + (effMode === 'split' ? ':split' : ':preview')}
                content={content}
                docPath={relPath}
                refNames={refNames}
                collections={collections}
                links={docLinks}
              />
            </div>
          )}
          {showBacklinks && !isJson && (
            <aside data-wb-backlinks className="hidden lg:block w-64 shrink-0 border-l border-border overflow-x-hidden overflow-y-auto p-3">
              <BacklinksPanel
                path={relPath}
                dsId={dsId}
                onOpen={(src, term) => navigate('/read/' + encPath(src) + '?h=' + encodeURIComponent(term))}
                onClose={() => setShowBacklinks(false)}
              />
            </aside>
          )}
        </div>
      </div>

      {/* 语料引用解析弹层 */}
      <CorpusRefPopover req={crReq} onClose={() => setCrReq(null)} />

      {/* 草稿恢复提示 */}
      {draftPrompt && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg p-5 max-w-md w-full shadow-xl">
            <h3 className="font-medium mb-2">发现未保存的草稿</h3>
            <p className="text-sm text-muted-foreground mb-4">
              本文件有一份 {new Date(draftPrompt.savedAt).toLocaleString('zh-CN')} 的本地草稿（来自上次未完成的编辑）。
            </p>
            <div className="flex gap-2 justify-end">
              <button
                className="px-3 py-1.5 rounded border border-border text-sm hover:bg-accent"
                onClick={() => {
                  clearDraft(dsId!, relPath);
                  setDraftPrompt(null);
                }}
              >
                丢弃草稿
              </button>
              <button
                className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm"
                onClick={() => {
                  replaceBuffer(draftPrompt.content);
                  setSaveState('dirty');
                  setDraftPrompt(null);
                }}
              >
                恢复草稿
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 外部修改冲突处理 */}
      {conflict && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg p-5 max-w-2xl w-full shadow-xl max-h-[80vh] flex flex-col">
            <h3 className="font-medium mb-2 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600" /> 文件已被外部修改
            </h3>
            <p className="text-sm text-muted-foreground mb-3">
              磁盘上的文件在你打开后发生了变化。选择处理方式（你的修改已作为草稿保留在本地）：
            </p>
            <div className="text-xs text-muted-foreground mb-2">磁盘当前内容预览（前 800 字符）：</div>
            <pre className="text-xs bg-muted rounded p-3 overflow-auto flex-1 whitespace-pre-wrap">{conflict.current.slice(0, 800)}</pre>
            <div className="flex gap-2 justify-end mt-4 flex-wrap">
              <button className="px-3 py-1.5 rounded border border-border text-sm hover:bg-accent flex items-center gap-1" onClick={() => setConflict(null)}>
                <X className="w-3.5 h-3.5" /> 继续编辑（暂不保存）
              </button>
              <button
                className="px-3 py-1.5 rounded border border-border text-sm hover:bg-accent"
                onClick={() => {
                  replaceBuffer(conflict.current);
                  baseMtimeRef.current = conflict.currentMtimeMs;
                  baseTextRef.current = conflict.current;
                  clearDraft(dsId!, relPath);
                  setConflict(null);
                  setSaveState('clean');
                }}
              >
                重新加载磁盘版本（放弃我的修改）
              </button>
              <button
                className="px-3 py-1.5 rounded bg-destructive text-destructive-foreground text-sm"
                onClick={() => doSave(false, conflict.currentMtimeMs)}
              >
                用我的修改覆盖磁盘版本
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 未保存修改的路由离开拦截 */}
      {blocker.state === 'blocked' && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg p-5 max-w-md w-full shadow-xl">
            <h3 className="font-medium mb-2">有未保存的修改</h3>
            <p className="text-sm text-muted-foreground mb-4">
              当前修改尚未保存。无论选择哪种方式，草稿都会保留在本地，下次进入编辑时可恢复。
            </p>
            <div className="flex gap-2 justify-end flex-wrap">
              <button
                className="px-3 py-1.5 rounded border border-border text-sm hover:bg-accent"
                onClick={() => blocker.reset()}
              >
                继续编辑
              </button>
              <button
                className="px-3 py-1.5 rounded border border-border text-sm hover:bg-accent"
                onClick={() => blocker.proceed()}
              >
                放弃并离开
              </button>
              <button
                className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm"
                onClick={() => setLeaveAction('save')}
              >
                保存并离开
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
