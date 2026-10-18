// 阅读页：默认阅读模式打开一切文件。目录(TOC)、正文查找、引用跳转、阅读偏好面板、
// 固定/反链/编辑入口。编辑为次级操作，阅读态不产生未保存状态。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, Link, useSearchParams, useBlocker, useNavigationType } from 'react-router-dom';
import { api } from '@/lib/api';
import { useApp } from '@/store/app';
import { useReadingPrefs } from '@/lib/prefs';
import { loadReadPos, saveReadPos, loadDraft, saveDraft, clearDraft } from '@/lib/drafts';
import { registerOpenDoc } from '@/lib/openEditor';
import { detectLineSeparator } from '@/components/editor/lineSeparator';
import { FormatToolbar } from '@/components/editor/FormatToolbar';
import { pushDocLinks } from '@/components/editor/autoLinks';
import type { FilePayload, FileEntry } from '@/lib/types';
import { ReadOnlyDoc, docHeadings, scrollDocToPos, findNextInDoc } from '@/components/ReadOnlyDoc';
import { JsonViewer } from '@/components/JsonViewer';
import { WordReader } from '@/components/WordReader';
import { BacklinksPanel } from '@/components/BacklinksPanel';
import { extIcon } from '@/lib/extIcon';
import type { DocLink } from '@/lib/api';
import type { EditorView } from '@codemirror/view';
import {
  Pencil, Pin, PinOff, ListTree, Link2, Search, X, Settings2, ChevronUp, AlertCircle,
  Save, AlertTriangle, CheckCircle2, Columns2, ArrowLeft, ArrowRight,
} from 'lucide-react';

type EditSaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error';

interface TocItem { key: string; text: string; level: number; pos?: number; id?: string }

export default function Read() {
  const params = useParams();
  const relPath = useMemo(() => decodeURIComponent(params['*'] || ''), [params]);
  const { dsId, config } = useApp();
  const { prefs, update, reset } = useReadingPrefs();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const highlightTerm = searchParams.get('h') || '';

  const [file, setFile] = useState<FilePayload | null>(null);
  const [error, setError] = useState<{ message: string; missing?: boolean } | null>(null);
  const [refNames, setRefNames] = useState<{ name: string; base: string; path: string; ext: string; dir: string }[]>([]);
  const [collections, setCollections] = useState<{ name: string }[]>([]);
  const [docLinks, setDocLinks] = useState<DocLink[]>([]);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [backlinks, setBacklinks] = useState<FileEntry[]>([]);
  const [showToc, setShowToc] = useState(true);
  const [showBacklinks, setShowBacklinks] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQ, setFindQ] = useState('');
  const [pinned, setPinned] = useState(false);
  const navType = useNavigationType();
  const [navDepth, setNavDepth] = useState({ idx: 0, max: 0 });
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [viewReady, setViewReady] = useState(0);
  const lastFindRef = useRef<{ from: number; to: number } | null>(null);

  // ---------- 原位编辑会话（与 Edit 页保存机制同源：原子写/备份/冲突/草稿） ----------
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState('');
  const [saveState, setSaveState] = useState<EditSaveState>('clean');
  const [saveMsg, setSaveMsg] = useState('');
  const [conflict, setConflict] = useState<{ current: string; currentMtimeMs: number } | null>(null);
  const [draftPrompt, setDraftPrompt] = useState<{ content: string; savedAt: number } | null>(null);
  const [lineSep, setLineSep] = useState<'\r\n' | '\n'>('\n');
  const [fmtVer, setFmtVer] = useState(0);
  const baseTextRef = useRef('');
  const baseMtimeRef = useRef(0);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const dirty = saveState === 'dirty' || saveState === 'error';

  const buffer = useCallback(
    () => (viewRef.current ? viewRef.current.state.sliceDoc(0) : file?.content || ''),
    [file]
  );

  const onEditDocChanged = useCallback((exact: string) => {
    setEditBuffer(exact);
    setSaveState(exact === baseTextRef.current ? 'clean' : 'dirty');
  }, []);

  const performSave = useCallback(
    async (text: string, overrideMtime?: number) => {
      if (!dsId) throw new Error('未选定资料库');
      const r = await api.saveFile(relPath, text, overrideMtime ?? baseMtimeRef.current, dsId);
      baseMtimeRef.current = r.mtimeMs;
      baseTextRef.current = text;
      clearDraft(dsId, relPath);
      return r;
    },
    [dsId, relPath]
  );

  const rePullLinks = useCallback(async () => {
    for (let i = 0; i < 20; i++) {
      const r = await api.linksDoc(relPath).catch(() => null);
      if (r && r.dsId === dsId && r.ready) {
        setDocLinks(r.links);
        pushDocLinks(viewRef.current, r.links, r.buildSeq);
        return;
      }
      await new Promise((s) => setTimeout(s, 600));
    }
  }, [dsId, relPath]);

  const doSave = useCallback(async (): Promise<boolean> => {
    if (!file || !dsId) return false;
    const text = buffer();
    if (text === baseTextRef.current) {
      setSaveState('clean');
      return true;
    }
    setSaveState('saving');
    setSaveMsg('');
    try {
      await performSave(text);
      setConflict(null);
      setSaveState('saved');
      setSaveMsg('已保存到 ' + relPath);
      setFile((f) => (f ? { ...f, content: text, mtimeMs: baseMtimeRef.current } : f));
      rePullLinks();
      window.dispatchEvent(new CustomEvent('wb-links-updated'));
      return true;
    } catch (e) {
      const err = e as Error & { conflict?: boolean; current?: string; currentMtimeMs?: number };
      setSaveState('error');
      if (err.conflict) {
        setConflict({ current: err.current || '', currentMtimeMs: err.currentMtimeMs || 0 });
        setSaveMsg('文件已被外部修改，请处理冲突');
      } else {
        setSaveMsg('保存失败：' + err.message + '（草稿已保留在本地）');
      }
      return false;
    }
  }, [file, dsId, buffer, performSave, relPath, rePullLinks]);

  const doSaveWithMtime = useCallback(
    async (mtime: number): Promise<boolean> => {
      const text = buffer();
      try {
        await performSave(text, mtime);
        setConflict(null);
        setSaveState('saved');
        setSaveMsg('已保存到 ' + relPath);
        setFile((f) => (f ? { ...f, content: text, mtimeMs: baseMtimeRef.current } : f));
        rePullLinks();
        return true;
      } catch (e) {
        setSaveState('error');
        setSaveMsg('保存失败：' + (e as Error).message);
        return false;
      }
    },
    [buffer, performSave, relPath, rePullLinks]
  );

  const enterEdit = useCallback(() => {
    if (!file || !dsId || file.readonly || editingRef.current) return;
    const text = file.content || '';
    setLineSep(detectLineSeparator(text));
    baseTextRef.current = text;
    baseMtimeRef.current = file.mtimeMs;
    setSaveState('clean');
    setSaveMsg('');
    const draft = loadDraft(dsId, relPath);
    if (draft && draft.content !== text) setDraftPrompt(draft);
    // 补偿编辑条替换面包屑行带来的布局位移：保持正文视觉位置纹丝不动
    const beforeTop = contentRef.current?.getBoundingClientRect().top;
    setEditing(true);
    requestAnimationFrame(() => {
      const afterTop = contentRef.current?.getBoundingClientRect().top;
      const sc = scrollRef.current;
      if (beforeTop != null && afterTop != null && sc) sc.scrollTop += afterTop - beforeTop;
      viewRef.current?.focus();
    });
  }, [file, dsId, relPath]);

  const finishEdit = useCallback(async () => {
    const text = buffer();
    if (text !== baseTextRef.current) {
      const ok = await doSave();
      if (!ok) return; // 保存失败/冲突：留在编辑态处理
    }
    // 与进入时同理：补偿编辑条收起带来的布局位移
    const beforeTop = contentRef.current?.getBoundingClientRect().top;
    setEditing(false);
    setEditBuffer('');
    setSaveMsg('');
    requestAnimationFrame(() => {
      const afterTop = contentRef.current?.getBoundingClientRect().top;
      const sc = scrollRef.current;
      if (beforeTop != null && afterTop != null && sc) sc.scrollTop += afterTop - beforeTop;
    });
  }, [buffer, doSave]);

  // 加载文件与引用名称清单（wbFollow 重命名跟随：原位编辑中只重绑基准，不重置缓冲区）
  useEffect(() => {
    if (!dsId || !relPath) return;
    let dead = false;
    const follow = (location.state as { wbFollow?: boolean } | null)?.wbFollow === true;
    const rebind = editingRef.current && follow;
    if (editingRef.current && !follow) {
      // 非跟随导航到新文档：退出原位编辑（脏状态已被路由拦截器拦下）
      setEditing(false);
      setEditBuffer('');
      setSaveState('clean');
      setSaveMsg('');
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 既有行为：切换文档时先清空
    setFile(null);
    setError(null);
    setDocLinks([]); // 上一文档的链接区间对新文档是非法坐标，必须先清（否则 field 里 lineAt 越界）
    api.file(relPath)
      .then(async (f) => {
        if (dead) return;
        if (f.dsId !== dsId) return; // 数据源已切换，丢弃旧响应
        setFile(f);
        setLineSep(detectLineSeparator(f.content || ''));
        if (rebind) {
          baseTextRef.current = viewRef.current ? viewRef.current.state.sliceDoc(0) : f.content || '';
          baseMtimeRef.current = f.mtimeMs;
          return;
        }
        api.touchRecent(relPath).catch(() => {});
        const [names, bl, pins, linksDoc] = await Promise.all([
          api.refNames().catch(() => null),
          api.backlinks(relPath).catch(() => ({ backlinks: [] })),
          api.pins().catch(() => ({ pins: [] })),
          api.linksDoc(relPath).catch(() => null),
        ]);
        if (dead) return;
        if (names && names.dsId === dsId) {
          setRefNames(names.names);
          setCollections(names.collections);
        }
        setBacklinks(bl.backlinks);
        setPinned(pins.pins.some((p) => p.path === relPath));
        if (linksDoc && linksDoc.dsId === dsId) {
          if (linksDoc.ready) setDocLinks(linksDoc.links);
          else {
            // 索引尚在构建：稍后重拉一次
            setTimeout(() => {
              if (dead) return;
              api.linksDoc(relPath).then((r) => {
                if (!dead && r.dsId === dsId && r.ready) setDocLinks(r.links);
              }).catch(() => {});
            }, 1500);
          }
        }
      })
      .catch((e) => {
        if (!dead) setError({ message: e.message, missing: (e as { missing?: boolean }).missing });
      });
    return () => {
      dead = true;
    };
  }, [dsId, relPath, config?.status.scannedAt]);

  // 渲染后：markdown 走只读 CM（TOC 从源文扫，?h= 由组件内部装饰）；Word/JSON 沿用 DOM 标题/高亮
  useEffect(() => {
    if (!file) return;
    if (file.type === 'markdown') {
      if (!viewRef.current) return; // 等只读实例就绪（viewReady 变化后重跑）
      setToc(docHeadings(viewRef.current).map((h) => ({ key: 'p' + h.pos, ...h })));
      return;
    }
    const el = contentRef.current;
    if (!el) return;
    const headings = [...el.querySelectorAll('h1, h2, h3, h4')].map((h, i) => {
      const id = h.id || 'h-' + i;
      h.id = id;
      return { key: id, id, text: h.textContent || '', level: Number(h.tagName[1]) };
    });
    setToc(headings);

    // 搜索命中高亮（Word/JSON）
    if (highlightTerm) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let n: Node | null;
      while ((n = walker.nextNode())) nodes.push(n as Text);
      for (const t of nodes) {
        const idx = t.data.indexOf(highlightTerm);
        if (idx >= 0 && t.parentElement && !['SCRIPT', 'STYLE', 'MARK'].includes(t.parentElement.tagName)) {
          const after = t.splitText(idx);
          after.splitText(highlightTerm.length);
          const mark = document.createElement('mark');
          mark.textContent = after.data;
          after.parentNode?.replaceChild(mark, after);
        }
      }
    }
  }, [file, highlightTerm, viewReady]);

  // 导航深度（react-router 在 history.state.idx 维护栈位）：后退/前进按钮可用性
  useEffect(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    setNavDepth((d) => ({ idx, max: Math.max(d.max, idx) }));
  }, [location]);

  // 恢复阅读位置/锚点：#锚点 > 携带比例（非 POP）> 记忆位置
  // 后退/前进（POP）时优先「离开该文档时的记忆位置」，而非当初入场比例
  useEffect(() => {
    if (!file) return;
    const sc = scrollRef.current;
    if (!sc) return;
    const apply = () => {
      const anchor = location.hash ? decodeURIComponent(location.hash.slice(1)) : null;
      if (anchor) {
        if (file.type === 'markdown' && viewRef.current) {
          const h = docHeadings(viewRef.current).find((x) => x.text === anchor);
          if (h && scrollDocToPos(viewRef.current, h.pos, sc, 80)) return;
        } else {
          const el2 = document.getElementById(anchor);
          if (el2) {
            sc.scrollTop = el2.offsetTop - 80;
            return;
          }
        }
      }
      const ratio = navType === 'POP'
        ? undefined
        : (location.state as { wbScrollRatio?: number } | null)?.wbScrollRatio;
      if (typeof ratio === 'number' && ratio > 0) {
        const max = sc.scrollHeight - sc.clientHeight;
        if (max > 0) {
          sc.scrollTop = ratio * max;
          return;
        }
      }
      if (dsId) {
        const pos = loadReadPos(dsId, relPath);
        sc.scrollTop = pos > 0 ? pos : 0;
      }
    };
    const timer = setTimeout(apply, 60);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, viewReady, location.hash, dsId, relPath]);

  // 记录阅读位置
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !dsId) return;
    const onScroll = () => saveReadPos(dsId, relPath, sc.scrollTop);
    sc.addEventListener('scroll', onScroll, { passive: true });
    return () => sc.removeEventListener('scroll', onScroll);
  }, [dsId, relPath, file]);

  // 快捷键：Ctrl+F 文内查找，Ctrl+E 进入/结束编辑，Ctrl+S 保存，Escape 关浮层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          setFindOpen(true);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (editingRef.current) {
          e.preventDefault();
          doSave();
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && file && !file.readonly) {
          e.preventDefault();
          if (editingRef.current) finishEdit();
          else enterEdit();
        }
      }
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        navigate(-1);
      }
      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        navigate(1);
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === '[' || e.key === ']')) {
        e.preventDefault();
        navigate(e.key === '[' ? -1 : 1);
      }
      if (e.key === 'Escape') {
        setFindOpen(false);
        setShowPrefs(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [file, enterEdit, finishEdit, doSave]);

  // 原位编辑：草稿自动保存（防抖）+ 关页保护 + 目录树操作前 flush
  useEffect(() => {
    if (!editing || !dirty || !dsId) return;
    const t = setTimeout(() => saveDraft(dsId, relPath, editBuffer), 1200);
    return () => clearTimeout(t);
  }, [editing, dirty, dsId, relPath, editBuffer]);
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (editingRef.current && dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
  useEffect(() => {
    if (!editing || !dsId || !file || file.readonly) return;
    return registerOpenDoc({
      path: relPath,
      isDirty: () => buffer() !== baseTextRef.current,
      flush: async () => {
        const text = buffer();
        if (text === baseTextRef.current) return;
        await performSave(text);
        setSaveState('saved');
        setSaveMsg('已自动保存：' + relPath);
      },
    });
  }, [editing, dsId, relPath, file, buffer, performSave]);

  // 原位编辑脏状态的路由离开拦截
  const blocker = useBlocker(({ nextLocation }) =>
    editing && dirty && !(nextLocation.state as { wbFollow?: boolean } | null)?.wbFollow
  );

  // e2e 钩子（仅 wb:e2e=1 时安装；每次渲染刷新引用，无状态依赖）
  useEffect(() => {
    if (localStorage.getItem('wb:e2e') !== '1') return;
    (window as unknown as Record<string, unknown>).__wbr = {
      editor: () => viewRef.current,
      editing: () => editingRef.current,
      enter: () => enterEdit(),
      finish: () => finishEdit(),
      save: () => doSave(),
      dirty: () => buffer() !== baseTextRef.current,
      buffer: () => buffer(),
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__wbr;
    };
  });

  // 文内查找：markdown 走只读 CM 定位；Word/JSON 沿用 DOM 文本扫描
  useEffect(() => {
    if (!findQ) return;
    lastFindRef.current = null;
    if (file?.type === 'markdown' && viewRef.current && scrollRef.current) {
      const hit = findNextInDoc(viewRef.current, findQ, 0);
      if (hit) {
        lastFindRef.current = hit;
        viewRef.current.dispatch({ selection: { anchor: hit.from, head: hit.to } });
        scrollDocToPos(viewRef.current, hit.from, scrollRef.current, 120);
      }
      return;
    }
    const el = contentRef.current;
    if (!el) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if ((n as Text).data.includes(findQ)) {
        (n.parentElement as HTMLElement)?.scrollIntoView({ block: 'center' });
        break;
      }
    }
  }, [findQ, file]);

  // 查找条 Enter：下一个命中（到尾回绕）
  const findNext = useCallback(() => {
    const v = viewRef.current;
    const sc = scrollRef.current;
    if (!v || !sc || !findQ || file?.type !== 'markdown') return;
    const from = lastFindRef.current ? lastFindRef.current.to : 0;
    let hit = findNextInDoc(v, findQ, from);
    if (!hit && from > 0) hit = findNextInDoc(v, findQ, 0);
    if (hit) {
      lastFindRef.current = hit;
      v.dispatch({ selection: { anchor: hit.from, head: hit.to } });
      scrollDocToPos(v, hit.from, sc, 120);
    }
  }, [findQ, file]);

  const togglePin = useCallback(async () => {
    await api.pin(relPath, pinned ? 'remove' : 'add');
    setPinned(!pinned);
  }, [pinned, relPath]);

  if (error) {
    return (
      <div className="max-w-xl mx-auto py-16 px-4 text-center">
        <AlertCircle className="w-10 h-10 mx-auto text-amber-600 mb-3" />
        <h1 className="text-lg font-bold mb-2">无法打开文件</h1>
        <p className="text-sm text-muted-foreground mb-1 mono">{relPath}</p>
        <p className="text-sm text-muted-foreground mb-6">{error.message}</p>
        <div className="flex gap-2 justify-center">
          <Link to="/browse" className="px-4 py-2 rounded border border-border text-sm hover:bg-accent">浏览目录</Link>
          <Link to={'/search?q=' + encodeURIComponent(relPath.split('/').pop() || '')} className="px-4 py-2 rounded bg-primary text-primary-foreground text-sm">
            搜索同名文件
          </Link>
        </div>
      </div>
    );
  }

  if (!file) {
    return <div className="py-20 text-center text-sm text-muted-foreground">加载中…</div>;
  }

  const crumbs = relPath.split('/');

  return (
    <div className="h-full flex min-h-0">
      {/* 阅读纸面：A 主题下带纸纹侧影（见 themes.css .wb-paper） */}
      <div className="flex-1 min-w-0 overflow-auto wb-paper" ref={scrollRef}>
        <div className="max-w-5xl mx-auto px-4 py-5">
          {/* 顶部工具栏区（sticky，不随正文滚走）：阅读态=面包屑+操作行，
              原位编辑态=格式工具栏+保存控件；查找条与偏好面板也收在同一 sticky 区，
              避免多个 sticky 互相重叠 */}
          <div className="sticky top-0 z-20 mb-3 space-y-2">
          {editing ? (
            <div
              className="bg-card border border-border rounded-lg shadow-sm p-1 flex items-center gap-2"
              data-wb-inplace-bar
            >
              <div className="flex-1 min-w-0">
                <FormatToolbar view={viewRef.current} version={fmtVer} />
              </div>
              <span
                className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${
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
                {saveState === 'clean' && '编辑中'}
              </span>
              <button
                className="text-xs px-2.5 py-1.5 rounded border border-border hover:bg-accent disabled:opacity-40 flex items-center gap-1 shrink-0"
                disabled={!dirty}
                onClick={() => doSave()}
                title="Ctrl+S"
              >
                <Save className="w-3.5 h-3.5" /> 保存
              </button>
              <button
                className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 flex items-center gap-1 shrink-0"
                onClick={() => finishEdit()}
                title="保存并回到阅读 (Ctrl+E)"
              >
                <CheckCircle2 className="w-3.5 h-3.5" /> 完成
              </button>
              {saveMsg && (
                <span
                  className={`text-xs shrink-0 max-w-[30vw] truncate ${saveState === 'saved' ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}
                  title={saveMsg}
                >
                  {saveMsg}
                </span>
              )}
              <button
                className="p-1.5 rounded hover:bg-accent text-muted-foreground shrink-0"
                title="打开完整编辑器（源码 / 分栏 / 预览）"
                onClick={() => {
                  const sc = scrollRef.current;
                  const max = sc ? sc.scrollHeight - sc.clientHeight : 0;
                  const ratio = max > 0 && sc ? Math.min(1, Math.max(0, sc.scrollTop / max)) : 0;
                  navigate('/edit/' + relPath.split('/').map(encodeURIComponent).join('/'), { state: { wbScrollRatio: ratio } });
                }}
              >
                <Columns2 className="w-4 h-4" />
              </button>
            </div>
          ) : (
          <div className="bg-card border border-border rounded-lg shadow-sm p-1.5 flex items-center gap-2 flex-wrap">
            <button
              className="p-1.5 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
              disabled={navDepth.idx <= 0}
              onClick={() => navigate(-1)}
              title="后退：上一个文档（Alt+← / ⌘[）"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <button
              className="p-1.5 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
              disabled={navDepth.idx >= navDepth.max}
              onClick={() => navigate(1)}
              title="前进（Alt+→ / ⌘]）"
            >
              <ArrowRight className="w-4 h-4" />
            </button>
            <nav className="text-xs text-muted-foreground flex items-center gap-1 flex-wrap min-w-0">
              {crumbs.map((seg, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <span>/</span>}
                  {i === crumbs.length - 1 ? (
                    <span className="text-foreground font-medium flex items-center gap-1">{extIcon(file.ext)}{seg}</span>
                  ) : (
                    <Link
                      to={'/browse?dir=' + encodeURIComponent(crumbs.slice(0, i + 1).join('/'))}
                      className="hover:text-primary"
                    >
                      {seg}
                    </Link>
                  )}
                </span>
              ))}
            </nav>
            <div className="flex-1" />
            <button className="p-1.5 rounded hover:bg-accent text-muted-foreground" title="文内查找 (Ctrl+F)" onClick={() => setFindOpen(true)}>
              <Search className="w-4 h-4" />
            </button>
            <button className="p-1.5 rounded hover:bg-accent text-muted-foreground" title="阅读设置" onClick={() => setShowPrefs(!showPrefs)}>
              <Settings2 className="w-4 h-4" />
            </button>
            <button
              className="p-1.5 rounded hover:bg-accent text-muted-foreground"
              title={pinned ? '取消固定' : '固定到常用入口'}
              onClick={togglePin}
            >
              {pinned ? <PinOff className="w-4 h-4 text-primary" /> : <Pin className="w-4 h-4" />}
            </button>
            <button
              className="p-1.5 rounded hover:bg-accent text-muted-foreground"
              title="反向引用"
              onClick={() => setShowBacklinks(!showBacklinks)}
            >
              <Link2 className="w-4 h-4" />
              {backlinks.length > 0 && <span className="text-xs stat-num ml-0.5">{backlinks.length}</span>}
            </button>
            {file.readonly ? (
              <span className="text-xs text-muted-foreground border border-dashed border-border rounded px-2 py-1">只读预览</span>
            ) : (
              <button
                className="text-xs px-3 py-1.5 rounded border border-border hover:border-primary hover:text-primary flex items-center gap-1"
                onClick={enterEdit}
                title="进入编辑 (Ctrl+E)"
              >
                <Pencil className="w-3.5 h-3.5" /> 编辑
              </button>
            )}
          </div>
          )}

          {/* 文内查找条（随 sticky 顶栏区） */}
          {findOpen && (
            <div className="bg-card border border-border rounded-lg shadow-sm p-2 flex items-center gap-2">
              <Search className="w-4 h-4 text-muted-foreground" />
              <input
                autoFocus
                value={findQ}
                onChange={(e) => setFindQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    findNext();
                  }
                }}
                placeholder="在当前文档内查找…（回车下一个）"
                className="flex-1 text-sm bg-transparent outline-none"
              />
              <button className="p-1 rounded hover:bg-accent" onClick={() => { setFindOpen(false); setFindQ(''); }}>
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* 阅读偏好快捷面板（随 sticky 顶栏区，仅阅读态） */}
          {!editing && showPrefs && (
            <div className="bg-card border border-border rounded-lg shadow-sm p-3 text-xs space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-muted-foreground w-14">字体</span>
                {(['serif', 'sans', 'mono'] as const).map((f) => (
                  <button
                    key={f}
                    className={`px-2 py-1 rounded border ${prefs.font === f ? 'border-primary text-primary' : 'border-border hover:bg-accent'}`}
                    onClick={() => update({ font: f })}
                  >
                    {f === 'serif' ? '衬线' : f === 'sans' ? '无衬线' : '等宽'}
                  </button>
                ))}
                <span className="text-muted-foreground w-14 ml-2">主题</span>
                {(['light', 'dark'] as const).map((t) => (
                  <button
                    key={t}
                    className={`px-2 py-1 rounded border ${prefs.theme === t ? 'border-primary text-primary' : 'border-border hover:bg-accent'}`}
                    onClick={() => update({ theme: t })}
                  >
                    {t === 'light' ? '浅色' : '深色'}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-muted-foreground w-14">字号</span>
                <button className="px-2 py-1 rounded border border-border hover:bg-accent" onClick={() => update({ fontSize: Math.max(14, prefs.fontSize - 1) })}>A−</button>
                <span className="stat-num w-12 text-center">{prefs.fontSize}px</span>
                <button className="px-2 py-1 rounded border border-border hover:bg-accent" onClick={() => update({ fontSize: Math.min(32, prefs.fontSize + 1) })}>A＋</button>
                <input
                  type="number" min={14} max={32} value={prefs.fontSize}
                  onChange={(e) => update({ fontSize: Math.min(32, Math.max(14, Number(e.target.value) || 17)) })}
                  className="w-16 px-1 py-1 rounded border border-input bg-background text-center"
                />
                <span className="text-muted-foreground ml-2">行距</span>
                <input type="range" min={1.4} max={2.4} step={0.05} value={prefs.lineHeight}
                  onChange={(e) => update({ lineHeight: Number(e.target.value) })} className="w-24" />
                <span className="stat-num">{prefs.lineHeight.toFixed(2)}</span>
                <span className="text-muted-foreground ml-2">宽度</span>
                <input type="range" min={560} max={1080} step={20} value={prefs.width}
                  onChange={(e) => update({ width: Number(e.target.value) })} className="w-24" />
                <span className="stat-num">{prefs.width}px</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-14">段距</span>
                <input type="range" min={0} max={2} step={0.1} value={prefs.paraSpacing}
                  onChange={(e) => update({ paraSpacing: Number(e.target.value) })} className="w-24" />
                <span className="stat-num">{prefs.paraSpacing.toFixed(1)}em</span>
                <span className="text-muted-foreground ml-2">代码字号</span>
                <input type="range" min={12} max={20} step={1} value={prefs.codeFontSize}
                  onChange={(e) => update({ codeFontSize: Number(e.target.value) })} className="w-24" />
                <span className="stat-num">{prefs.codeFontSize}px</span>
                <div className="flex-1" />
                <button className="px-2 py-1 rounded border border-border hover:bg-accent" onClick={reset}>恢复默认</button>
              </div>
              <div className="text-muted-foreground">阅读偏好即时生效，仅影响界面呈现，不会修改源文件。切换文档与重启后保留。</div>
            </div>
          )}
          </div>

          {/* 正文 */}
          <div ref={contentRef} data-wb-content-card className="bg-card border border-border rounded-lg p-6 md:p-8 min-h-[40vh]">
            {file.type === 'markdown' && (
              <ReadOnlyDoc
                key={relPath}
                content={file.content || ''}
                docPath={relPath}
                refNames={refNames}
                collections={collections}
                links={docLinks}
                highlightTerm={highlightTerm}
                editing={editing}
                lineSep={lineSep}
                onDocChanged={onEditDocChanged}
                onViewUpdate={(u) => {
                  if (u.docChanged || u.selectionSet) setFmtVer((x) => x + 1);
                }}
                onReady={(v) => {
                  viewRef.current = v;
                  setViewReady((s) => s + 1);
                }}
              />
            )}
            {file.type === 'json' && <JsonViewer content={file.content || ''} />}
            {file.type === 'word' && (
              <WordReader path={relPath} name={file.name} html={file.html || ''} text={file.text || ''} warning={file.warning} engine={file.engine} />
            )}
          </div>

          <div className="text-xs text-muted-foreground mt-3 flex gap-4 flex-wrap">
            <span>修改时间：{new Date(file.mtimeMs).toLocaleString('zh-CN')}</span>
            <span>大小：{(file.size / 1024).toFixed(1)} KB</span>
            {file.bom && <span>UTF-8 BOM</span>}
          </div>
        </div>
      </div>

      {/* 右侧：目录 + 反链 */}
      {(showToc || showBacklinks) && (
        <aside className="hidden lg:block w-64 shrink-0 border-l border-border overflow-auto p-3">
          {showToc && toc.length > 0 && (
            <div className="mb-4">
              <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-2">
                <ListTree className="w-3.5 h-3.5" /> 文档目录
                <button className="ml-auto p-0.5 rounded hover:bg-accent" onClick={() => setShowToc(false)}>
                  <X className="w-3 h-3" />
                </button>
              </div>
              <ul className="space-y-0.5">
                {toc.map((t) => (
                  <li key={t.key}>
                    <button
                      className="text-xs text-left w-full py-0.5 px-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground truncate"
                      style={{ paddingLeft: (t.level - 1) * 12 + 6 }}
                      onClick={() => {
                        const sc = scrollRef.current;
                        if (!sc) return;
                        if (t.pos != null && viewRef.current) {
                          scrollDocToPos(viewRef.current, t.pos, sc, 70);
                        } else if (t.id) {
                          const el = document.getElementById(t.id);
                          if (el) sc.scrollTop = el.offsetTop - 70;
                        }
                      }}
                    >
                      {t.text}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!showToc && (
            <button className="text-xs text-muted-foreground flex items-center gap-1 mb-3 hover:text-primary" onClick={() => setShowToc(true)}>
              <ChevronUp className="w-3 h-3" /> 展开文档目录
            </button>
          )}
          {showBacklinks && (
            <div data-wb-backlinks>
            <BacklinksPanel
              path={relPath}
              dsId={dsId}
              onOpen={(src, term) => navigate('/read/' + src.split('/').map(encodeURIComponent).join('/') + '?h=' + encodeURIComponent(term))}
              onClose={() => setShowBacklinks(false)}
            />
            </div>
          )}
        </aside>
      )}

      {/* 原位编辑：草稿恢复提示 */}
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
                  const v = viewRef.current;
                  if (v) {
                    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: draftPrompt.content } });
                    onEditDocChanged(draftPrompt.content);
                  }
                  setDraftPrompt(null);
                }}
              >
                恢复草稿
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 原位编辑：外部修改冲突 */}
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
              <button className="px-3 py-1.5 rounded border border-border text-sm hover:bg-accent" onClick={() => setConflict(null)}>
                继续编辑（暂不保存）
              </button>
              <button
                className="px-3 py-1.5 rounded border border-border text-sm hover:bg-accent"
                onClick={() => {
                  const v = viewRef.current;
                  if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: conflict.current } });
                  baseMtimeRef.current = conflict.currentMtimeMs;
                  baseTextRef.current = conflict.current;
                  clearDraft(dsId!, relPath);
                  setConflict(null);
                  setSaveState('clean');
                  setFile((f) => (f ? { ...f, content: conflict.current, mtimeMs: conflict.currentMtimeMs } : f));
                }}
              >
                重新加载磁盘版本（放弃我的修改）
              </button>
              <button
                className="px-3 py-1.5 rounded bg-destructive text-destructive-foreground text-sm"
                onClick={async () => {
                  const ok = await doSaveWithMtime(conflict.currentMtimeMs);
                  if (ok) setConflict(null);
                }}
              >
                用我的修改覆盖磁盘版本
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 原位编辑：未保存修改的路由离开拦截 */}
      {blocker.state === 'blocked' && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg p-5 max-w-md w-full shadow-xl">
            <h3 className="font-medium mb-2">有未保存的修改</h3>
            <p className="text-sm text-muted-foreground mb-4">
              当前修改尚未保存。无论选择哪种方式，草稿都会保留在本地，下次进入编辑时可恢复。
            </p>
            <div className="flex gap-2 justify-end flex-wrap">
              <button className="px-3 py-1.5 rounded border border-border text-sm hover:bg-accent" onClick={() => blocker.reset()}>
                继续编辑
              </button>
              <button className="px-3 py-1.5 rounded border border-border text-sm hover:bg-accent" onClick={() => blocker.proceed()}>
                放弃并离开
              </button>
              <button
                className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm"
                onClick={async () => {
                  const ok = await doSave();
                  if (ok) blocker.proceed();
                }}
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
