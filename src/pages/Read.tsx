// 阅读页：默认阅读模式打开一切文件。目录(TOC)、正文查找、引用跳转、阅读偏好面板、
// 固定/反链/编辑入口。编辑为次级操作，阅读态不产生未保存状态。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, Link, useSearchParams, useBlocker, useNavigationType } from 'react-router-dom';
import { api } from '@/lib/api';
import { Sparkles } from 'lucide-react';
import { findSearchLocation, searchLocationRange, findAllRanges, locateNote } from '@/lib/searchLocation';
import { collectTextNodes, markDomFind, unmarkDomFind, wrapTextRanges } from '@/lib/domFind';
import { setFindHl } from '@/lib/readFindHighlight';
import { perfInc } from '@/lib/perf';
import { useApp } from '@/store/app-context';
import { useAgentEnabled } from '@/lib/theme-context';
import { useReadingPrefs } from '@/lib/reading-prefs';
import { loadReadPos, saveReadPos, loadDraft, saveDraft, clearDraft } from '@/lib/drafts';
import { registerOpenDoc } from '@/lib/openEditor';
import { registerUnsaved } from '@/lib/unsaved';
import { detectLineSeparator } from '@/components/editor/lineSeparator';
import { FormatToolbar } from '@/components/editor/FormatToolbar';
import { pushDocLinks } from '@/components/editor/autoLinks';
import { whenIndexSettled } from '@/lib/indexReady';
import { errorMessage, notify } from '@/lib/notify';
import type { FilePayload, FileEntry } from '@/lib/types';
import { ReadOnlyDoc } from '@/components/ReadOnlyDoc';
import { docHeadings, scrollDocToPos } from '@/components/editor/readDocHelpers';
import { CodeMirrorEditor } from '@/components/editor/CodeMirrorEditor';
import { editorBaseExtensions, editorBaseThemeSpec } from '@/components/editor/setup';
import { EditorState, type Extension } from '@codemirror/state';
import { htmlLangAsync } from '@/components/editor/htmlLang';
import { EditorView } from '@codemirror/view';
import { JsonViewer } from '@/components/JsonViewer';
import { WordReader } from '@/components/WordReader';
import { HtmlReader } from '@/components/HtmlReader';
import { TxtReadBody } from '@/components/TxtReadBody';
import { PathListPopover, type PathListRequest } from '@/components/CorpusRefPopover';
import { BacklinksPanel } from '@/components/BacklinksPanel';
import { ReadAgentPanel } from '@/components/ReadAgentPanel';
import { ConceptCard } from '@/components/ConceptCard';
import { TagChips } from '@/components/TagChips';
import { DocTabs } from '@/components/DocTabs';
import { loadTabs, saveTabs, ensureTab, removeTab, TABS_CHANGED_EVENT } from '@/lib/tabs';
import { usePresence } from '@/lib/presence';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { extIcon } from '@/lib/extIcon';
import { Button } from '@/components/ui/button';
import { PageLoading, PageError } from '@/components/ui-states';
import type { DocLink } from '@/lib/api';
import type { EditorView as EditorViewType } from '@codemirror/view';
import {
  Pencil, Pin, PinOff, ListTree, Link2, Search, X, Settings2, ChevronUp, NotebookPen,
  Save, AlertTriangle, CheckCircle2, Columns2, ArrowLeft, ArrowRight, Loader2,
} from 'lucide-react';

type EditSaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error';

// Word 首次打开要在服务端转换，加载超过 1.5 秒时说明原因
const WORD_EXT = /\.docx?$/i;
// 跳转后目标离可视区顶部的距离：吸顶区（标签、工具栏，以及打开时的查找条/偏好面板）高度会变，按实时高度留出空间
const jumpOffset = (sticky: HTMLElement | null, gap: number) => (sticky?.offsetHeight ?? 0) + gap;
const WORD_SLOW_TEXT = '正在转换 Word 文档，首次打开较慢…';

// TXT 原位编辑主题：排版完全跟随阅读偏好（--rd-*），高度随内容增长、页面滚动，
// 与阅读态的纯文本渲染零跳变（阅读态 div 与编辑态 CM 用同一组变量）
const txtInPlaceTheme = EditorView.theme({
  ...editorBaseThemeSpec,
  '&': { ...editorBaseThemeSpec['&'], height: 'auto' },
  '.cm-scroller': { ...editorBaseThemeSpec['.cm-scroller'], overflow: 'visible' },
  '.cm-line': { padding: '0' },
  '.cm-content': { ...editorBaseThemeSpec['.cm-content'], padding: '0' },
});

// TXT 阅读态排版：与 txtInPlaceTheme 同变量，保证阅读↔编辑一致
const txtReaderStyle = {
  fontFamily: 'var(--rd-font)',
  fontSize: 'var(--rd-size)',
  lineHeight: 'var(--rd-line)',
} as const;

interface TocItem { key: string; text: string; level: number; pos?: number; id?: string }

export default function Read() {
  perfInc('readRenders'); // 渲染计数（仅开发/e2e 钩子下存在）
  const params = useParams();
  const relPath = useMemo(() => decodeURIComponent(params['*'] || ''), [params]);
  const { dsId, config } = useApp();
  const { prefs, update, reset } = useReadingPrefs();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const highlightTerm = searchParams.get('h') || '';
  const hitText = searchParams.get('hit') || '';
  const hitOccurrence = Math.max(0, Number(searchParams.get('occ')) || 0);

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
  const [findQEff, setFindQEff] = useState(''); // 150ms 防抖后的生效查询（大文档不逐键重算）
  const [findMode, setFindMode] = useState<'smart' | 'exact'>('smart');
  const [findHits, setFindHits] = useState(0);
  useEffect(() => {
    // 清空立即生效（关闭查找即清高亮，不等防抖）；非空查询 150ms 防抖，大文档不逐键重算
    if (findQ === '') { setFindQEff(''); return; }
    const t = setTimeout(() => setFindQEff(findQ), 150);
    return () => clearTimeout(t);
  }, [findQ]);
  // 命中结果按（文档版本 + 查询词 + 模式）缓存：回车跳转不重算，输入防抖后也只算一次
  const findCacheRef = useRef<{ doc: unknown; key: string; ranges: { from: number; to: number }[] } | null>(null);
  const findRanges = useCallback((q: string, mode: 'smart' | 'exact') => {
    const v = viewRef.current;
    if (!v || !q) return [];
    const doc = v.state.doc;
    const key = mode + ':' + q;
    const c = findCacheRef.current;
    if (c && c.doc === doc && c.key === key) return c.ranges;
    const ranges = findAllRanges(doc.toString(), q, mode === 'smart');
    findCacheRef.current = { doc, key, ranges };
    return ranges;
  }, []);
  const [docNotes, setDocNotes] = useState<{ notePath: string; count: number; quotes?: { quote: string; anchor: string | null }[] }[]>([]);
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!relPath) return;
    let dead = false;
    api.notesFor(relPath)
      .then((r) => { if (!dead) setDocNotes(r.notes || []); })
      .catch(() => { if (!dead) setDocNotes([]); });
    return () => { dead = true; };
  }, [relPath]);

  // 划线笔记标记：把做过笔记的原文映射到「笔记文件#锚点」
  const noteMarks = useMemo(() => {
    const out: { quote: string; href: string }[] = [];
    for (const n of docNotes) {
      for (const q of n.quotes || []) {
        if (!q.quote || !q.anchor) continue;
        out.push({
          quote: q.quote,
          href: '/read/' + n.notePath.split('/').map(encodeURIComponent).join('/') + '#' + encodeURIComponent(q.anchor),
        });
      }
    }
    return out;
  }, [docNotes]);
  const [aiOpen, setAiOpen] = useState(false);
  // 文档标签页：URL 是激活标签的单一真相，tabs 只持久化「开过哪些」
  const [tabs, setTabs] = useState<string[]>(() => loadTabs(dsId));
  useEffect(() => { setTabs(loadTabs(dsId)); }, [dsId]);
  // 条目改名 / 移动 / 删除在目录树里完成：标签已随之改写，这里重新载入
  useEffect(() => {
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<{ dsId: string }>).detail?.dsId === dsId) setTabs(loadTabs(dsId));
    };
    window.addEventListener(TABS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(TABS_CHANGED_EVENT, onChanged);
  }, [dsId]);
  useEffect(() => {
    if (!dsId || !relPath) return;
    setTabs((prev) => {
      if (prev.includes(relPath)) return prev;
      const next = ensureTab(prev, relPath);
      saveTabs(dsId, next);
      return next;
    });
  }, [dsId, relPath]);
  const closeTab = useCallback((p: string) => {
    setTabs((prev) => {
      const next = removeTab(prev, p);
      saveTabs(dsId, next);
      if (p === relPath) {
        const i = prev.indexOf(p);
        const target = next[Math.min(i, next.length - 1)];
        navigate(target ? '/read/' + target.split('/').map(encodeURIComponent).join('/') : '/');
      }
      return next;
    });
  }, [dsId, relPath, navigate]);
  // 批量关闭（右键菜单：左侧/右侧/其他/全部）。当前标签被关时跳到原位置相邻标签
  const closeManyTabs = useCallback((paths: string[]) => {
    setTabs((prev) => {
      const next = prev.filter((p) => !paths.includes(p));
      saveTabs(dsId, next);
      if (paths.includes(relPath)) {
        const i = prev.indexOf(relPath);
        const target = next[Math.min(i, next.length - 1)];
        navigate(target ? '/read/' + target.split('/').map(encodeURIComponent).join('/') : '/');
      }
      return next;
    });
  }, [dsId, relPath, navigate]);
  const [conceptName, setConceptName] = useState<string | null>(null);
  // TXT 阅读正文的歧义链接候选弹层（md 的同类弹层在 ReadOnlyDoc 内部）
  const [txtCandReq, setTxtCandReq] = useState<PathListRequest | null>(null);
  // 传给 memo 组件（TxtReadBody 等）的回调保持身份稳定，避免无谓重渲
  const openDocPath = useCallback(
    (p: string, heading?: string | null) => {
      const nav = '/read/' + p.split('/').map(encodeURIComponent).join('/');
      navigate(heading ? nav + '#' + encodeURIComponent(heading) : nav);
    },
    [navigate]
  );
  const onTxtOpenTarget = useCallback(
    (t: { path: string; heading?: string | null }) => {
      if (t.path.startsWith('concept:')) {
        setConceptName(t.path.slice('concept:'.length));
        return;
      }
      openDocPath(t.path, t.heading);
    },
    [openDocPath]
  );
  const onTxtCandidates = useCallback(
    (term: string, candidates: string[], at: { x: number; y: number }) =>
      setTxtCandReq({ title: `「${term}」指向 ${candidates.length} 个文档，请选择：`, paths: candidates, ...at }),
    []
  );
  const onOpenNoteHref = useCallback((href: string) => navigate(href), [navigate]);
  const [aiWidth, setAiWidth] = useState(() => {
    const n = Number(localStorage.getItem('wb.read.aiWidth'));
    return Number.isFinite(n) && n >= 260 && n <= 720 ? n : 380;
  });
  const aiDragRef = useRef(false);
  const aiAsideRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let raf = 0;
    let pending = -1;
    const onMove = (e: MouseEvent) => {
      if (!aiDragRef.current) return;
      // 从右边拖：宽度 = 视口宽 - 鼠标 x。拖动中不 setState：rAF 节流后直接写 CSS 变量
      pending = Math.max(260, Math.min(720, window.innerWidth - e.clientX));
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          aiAsideRef.current?.style.setProperty('--wb-ai-w', pending + 'px');
        });
      }
    };
    const onUp = () => {
      if (!aiDragRef.current) return;
      aiDragRef.current = false;
      document.body.style.cursor = '';
      if (raf) cancelAnimationFrame(raf);
      // 松手才提交 state；localStorage 由下方 effect 随之落盘一次
      if (pending > 0) setAiWidth(pending);
      pending = -1;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);
  useEffect(() => { try { localStorage.setItem('wb.read.aiWidth', String(Math.round(aiWidth))); } catch { /* 隐私模式/配额：宽度只在本次会话生效 */ } }, [aiWidth]);
  const [aiQuote, setAiQuote] = useState<string | null>(null);
  // 智能助手总开关：关闭时不渲染 AI 按钮与「问 AI」；面板若开着则收起（presence 播完离场再卸载），
  // 未消费的引用一并丢弃。渲染期对账，再打开开关也不会自己弹出来
  const agentEnabled = useAgentEnabled();
  if (!agentEnabled && (aiOpen || aiQuote !== null)) {
    setAiOpen(false);
    setAiQuote(null);
  }
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteDraftSaved, setNoteDraftSaved] = useState(false);
  const [resumeHint, setResumeHint] = useState<string | null>(null);
  // 定位中：从检索结果/锚点进入时，跳转完成前给出提示，避免「先到顶部再猛跳」看起来像卡死。
  // locatingActive 由定位流程直接维护；useDelayedFlag 让提示延迟 150ms 才出现：
  // 定位本身很快时（多数情况）根本不亮，避免一闪而过
  const [locatingActive, setLocatingActive] = useState(false);
  const locating = useDelayedFlag(locatingActive, 150);
  const [pinned, setPinned] = useState(false);
  const navType = useNavigationType();
  const [navDepth, setNavDepth] = useState({ idx: 0, max: 0 });
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorViewType | null>(null);
  const [viewReady, setViewReady] = useState(0);
  const lastFindRef = useRef<{ from: number; to: number } | null>(null);
  const onWordReady = useCallback(() => setViewReady((n) => n + 1), []);
  const findDomIdxRef = useRef(-1); // 非 markdown：DOM mark 循环游标

  // ---------- 原位编辑会话（与 Edit 页保存机制同源：原子写/备份/冲突/草稿） ----------
  // 编辑缓冲区不进组件 state：按键只翻转 dirty 标志，内容需要时从 view 读取
  const [editing, setEditing] = useState(false);
  const [saveState, setSaveState] = useState<EditSaveState>('clean');
  const [saveMsg, setSaveMsg] = useState('');
  const [conflict, setConflict] = useState<{ current: string; currentMtimeMs: number } | null>(null);
  const [draftPrompt, setDraftPrompt] = useState<{ content: string; savedAt: number } | null>(null);
  const [lineSep, setLineSep] = useState<'\r\n' | '\n'>('\n');
  const baseTextRef = useRef('');
  const baseMtimeRef = useRef(0);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const dirty = saveState === 'dirty' || saveState === 'error';
  // 面板挂载/卸载过渡（统一做法，见 src/lib/presence.ts）：data-state 驱动进/离场动画
  const findPresence = usePresence(findOpen);
  const prefsPresence = usePresence(!editing && showPrefs);
  const aiPresence = usePresence(aiOpen);
  const sidePresence = usePresence(!aiOpen && ((showToc && toc.length > 0) || showBacklinks));
  // saveState 镜像：按键路径上只做同值判断，避免无变化也走一遍 setState
  const saveStateRef = useRef<EditSaveState>('clean');
  useEffect(() => { saveStateRef.current = saveState; }, [saveState]);

  const buffer = useCallback(
    () => (viewRef.current ? viewRef.current.state.sliceDoc(0) : file?.content || ''),
    [file]
  );

  // 草稿防抖写入：按键路径只重置计时器，实际读文本在计时器触发时做
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleDraft = useCallback(() => {
    if (!dsId) return;
    clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      if (!editingRef.current) return;
      const text = buffer();
      if (text !== baseTextRef.current) saveDraft(dsId, relPath, text);
    }, 1200);
  }, [dsId, relPath, buffer]);
  useEffect(() => () => clearTimeout(draftTimerRef.current), []);

  const onEditDocChanged = useCallback((exact: string) => {
    if (!editingRef.current) return; // 阅读态的外部刷新不算编辑（diffReplace 也产生 docChanged）
    // 只在「干净 ⇄ 脏」翻转时 setState；其余按键完全不动 React
    const next: EditSaveState = exact === baseTextRef.current ? 'clean' : 'dirty';
    if (saveStateRef.current !== next) {
      saveStateRef.current = next;
      setSaveState(next);
    }
    scheduleDraft();
  }, [scheduleDraft]);

  const performSave = useCallback(
    async (text: string, overrideMtime?: number) => {
      if (!dsId) throw new Error('未选定知识库');
      const r = await api.saveFile(relPath, text, overrideMtime ?? baseMtimeRef.current, dsId);
      baseMtimeRef.current = r.mtimeMs;
      baseTextRef.current = text;
      clearDraft(dsId, relPath);
      return r;
    },
    [dsId, relPath]
  );

  // 索引未就绪时不再固定重试：订阅全局索引就绪信号，就绪后再取一次（反馈第 4 批）
  const rePullLinks = useCallback(async () => {
    for (;;) {
      const r = await api.linksDoc(relPath).catch(() => null);
      if (r && r.dsId === dsId && r.ready) {
        setDocLinks(r.links);
        pushDocLinks(viewRef.current, r.links, r.buildSeq);
        return;
      }
      await whenIndexSettled();
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
      setSaveState('clean');
      setSaveMsg('');
    }

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
        api.touchRecent(relPath).catch(() => {}); // 最近记录只影响概览页列表，写失败不打扰阅读
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
            // 索引尚在构建：等全局索引就绪信号后再取一次（与 rePullLinks 同口径，不再固定延时重试）
            await whenIndexSettled();
            if (dead) return;
            const r = await api.linksDoc(relPath).catch(() => null); // 链接是正文的附加装饰：取不到时正文照常显示
            if (!dead && r && r.dsId === dsId && r.ready) setDocLinks(r.links);
          }
        }
      })
      .catch((e) => {
        if (!dead) setError({ message: e.message, missing: (e as { missing?: boolean }).missing });
      });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsId, relPath]);

  // 监听重扫（scannedAt 变化）：当前文档被外部改动时原地刷新内容，不整页重载、不显示加载态。
  // 判定：后端扫描快照里的 mtime 必须「新于」当前已加载的 mtime 才拉取——快照滞后于已加载内容时不动，
  // 因此首次挂载不误拉；保存自身触发的重扫 mtime 已同步，此处为空操作。
  const fileMtimeRef = useRef(0);
  useEffect(() => { fileMtimeRef.current = file?.mtimeMs ?? 0; }, [file]);
  useEffect(() => {
    if (!dsId || !relPath || !fileMtimeRef.current) return;
    if (editingRef.current) return;
    api.fileStat(relPath)
      .then((st) => {
        if (st.dsId !== dsId || editingRef.current) return;
        if (st.mtimeMs <= fileMtimeRef.current) return;
        api.file(relPath)
          .then((nf) => {
            if (nf.dsId !== dsId || editingRef.current) return;
            fileMtimeRef.current = nf.mtimeMs;
            setFile(nf);
            setLineSep(detectLineSeparator(nf.content || ''));
          })
          .catch(() => {}); // 外部改动的静默刷新：失败时保留当前内容，下次重扫再试
      })
      .catch(() => {}); // 同上

  }, [config?.status.scannedAt, dsId, relPath]);

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
    const headings = [...el.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h, i) => {
      const id = h.id || 'h-' + i;
      h.id = id;
      return { key: id, id, text: h.textContent || '', level: Number(h.tagName[1]) };
    });
    setToc(headings);

    // 划线笔记标记（JSON/Word/HTML 走 DOM；markdown 由 livePreview、TXT 由 TxtReadBody 处理）
    // 引文在全部文本节点拼接成的正文里定位（一句话常被行内标签拆成多个节点），命中区间逐节点包成链接；
    // 已在链接内的片段（原文超链接、先前的笔记标记）不包，避免嵌套 <a> 与重跑时重复包装
    if (noteMarks.length && file.type !== 'text') {
      for (const mk of noteMarks) {
        const nodes = collectTextNodes(el); // 每条重收：上一条的包装已切分节点
        const ranges = locateNote(nodes.map(({ node }) => node.data).join(''), mk.quote);
        wrapTextRanges(nodes, ranges, (_, node) => {
          if (node.parentElement?.closest('a')) return null;
          const a = document.createElement('a');
          a.className = 'cm-note-mark';
          a.setAttribute('data-note-href', mk.href);
          a.setAttribute('title', '此处有笔记，点击查看');
          a.href = mk.href;
          a.addEventListener('click', (ev) => {
            ev.preventDefault();
            navigate(mk.href);
          });
          return a;
        });
      }
    }

    // 搜索命中高亮（Word/JSON/HTML；TXT 由 TxtReadBody 处理）
    if (highlightTerm && file.type !== 'text') {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let n: Node | null;
      while ((n = walker.nextNode())) nodes.push(n as Text);
      for (const t of nodes) {
        const idx = t.data.toLowerCase().indexOf(highlightTerm.toLowerCase());
        if (idx >= 0 && t.parentElement && !['SCRIPT', 'STYLE', 'MARK'].includes(t.parentElement.tagName)) {
          const after = t.splitText(idx);
          after.splitText(highlightTerm.length);
          const mark = document.createElement('mark');
          mark.textContent = after.data;
          after.parentNode?.replaceChild(mark, after);
        }
      }
    }
  }, [file, highlightTerm, viewReady, noteMarks, navigate]);

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
    const hasTarget = !!(hitText || highlightTerm || location.hash);
    setLocatingActive(hasTarget);
    const apply = (allowFallback: boolean): boolean => {
      // 优先定位点击的结果块；查询词只负责高亮，避免总跳到全文第一次命中。
      if (hitText) {
        const target = { text: hitText, occurrence: hitOccurrence };
        if (file.type === 'markdown') {
          const v = viewRef.current;
          if (!v) return false;
          const hit = findSearchLocation(v.state.doc.toString(), target);
          if (hit && scrollDocToPos(v, hit.from, sc, Math.round(sc.clientHeight / 3))) return true;
        } else if (contentRef.current) {
          const range = searchLocationRange(contentRef.current, target);
          if (range) {
            const rect = range.getBoundingClientRect();
            sc.scrollTop += rect.top - sc.getBoundingClientRect().top - sc.clientHeight / 3;
            return true;
          }
        }
      }
      // 旧链接兼容：?h= 词落到首个命中处（高亮已由装饰/DOM walker 生成）
      if (highlightTerm) {
        if (file.type === 'markdown') {
          const v = viewRef.current;
          if (!v) return false; // 只读实例未就绪，稍后重试
          const doc = v.state.doc.toString().toLowerCase();
          const idx = doc.indexOf(highlightTerm.toLowerCase());
          if (idx >= 0 && scrollDocToPos(v, idx, sc, Math.round(sc.clientHeight / 3))) return true;
          // 词不在正文（智能检索的语义命中常见）：继续走锚点/比例/记忆位置
        } else {
          const mark = contentRef.current?.querySelector('mark');
          if (mark) {
            sc.scrollTop += mark.getBoundingClientRect().top - sc.getBoundingClientRect().top - sc.clientHeight / 3;
            return true;
          }
          if (!allowFallback) return false; // 高亮尚未生成（渲染滞后），稍后重试
        }
      }
      const anchor = location.hash ? decodeURIComponent(location.hash.slice(1)) : null;
      if (anchor) {
        if (file.type === 'markdown' && viewRef.current) {
          const h = docHeadings(viewRef.current).find((x) => x.text === anchor);
          if (h && scrollDocToPos(viewRef.current, h.pos, sc, jumpOffset(stickyRef.current, 16))) return true;
        } else {
          const el2 = document.getElementById(anchor);
          if (el2) {
            sc.scrollTop += el2.getBoundingClientRect().top - sc.getBoundingClientRect().top - jumpOffset(stickyRef.current, 16);
            return true;
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
          return true;
        }
      }
      if (dsId) {
        const pos = loadReadPos(dsId, relPath);
        sc.scrollTop = pos > 0 ? pos : 0;
        if (pos > 40) {
          setResumeHint(`已回到上次阅读位置（${Math.round(pos)}px）`);
          window.setTimeout(() => setResumeHint(null), 4000);
        }
      }
      return true;
    };
    // 渲染滞后（只读 CM 未就绪 / Word 异步排版 / DOM walker 未跑完）时短间隔重试，
    // 最后一轮允许回退到锚点/比例/记忆位置，避免永远停在文件开头
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      const settled = apply(tries >= 9);
      if (!settled && ++tries < 10) {
        timer = setTimeout(attempt, 100);
        return;
      }
      // 定位落点后再留 180ms：scrollDocToPos 的 rAF 排版校正最多还要跑 8 帧，
      // 提前揭提示会把校正过程露出来
      if (hasTarget) {
        timer = setTimeout(() => setLocatingActive(false), 180);
      }
    };
    timer = setTimeout(attempt, 60);
    return () => {
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, viewReady, location.hash, dsId, relPath, highlightTerm, hitText, hitOccurrence]);

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
        setFindQ('');
        setShowPrefs(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [file, enterEdit, finishEdit, doSave, navigate]);

  // 原位编辑：草稿写入由 onEditDocChanged 的防抖计时器负责（scheduleDraft）；关页保护 + 目录树操作前 flush
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (editingRef.current && dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
  // 未保存登记表：安装更新（会关闭应用）前据此弹确认；干净或退出编辑时注销
  useEffect(() => {
    if (!editing || !dirty) return;
    return registerUnsaved(() => editingRef.current && buffer() !== baseTextRef.current);
  }, [editing, dirty, buffer]);
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

  // 文内查找：命中全部高亮 + 当前命中选中。markdown 走 CM 装饰；Word/JSON/TXT 走 DOM mark
  useEffect(() => {
    const v = viewRef.current;
    const isMd = file?.type === 'markdown';
    if (!findQEff) {
      setFindHits(0);
      lastFindRef.current = null;
      findDomIdxRef.current = -1;
      findCacheRef.current = null;
      if (isMd && v) v.dispatch({ effects: setFindHl.of({ ranges: [], current: null }) });
      else if (contentRef.current) unmarkDomFind(contentRef.current);
      return;
    }
    lastFindRef.current = null;
    findDomIdxRef.current = -1;
    if (isMd && v && scrollRef.current) {
      const ranges = findRanges(findQEff, findMode);
      setFindHits(ranges.length);
      const hit = ranges[0];
      v.dispatch({ effects: setFindHl.of({ ranges, current: hit || null }) });
      if (hit) {
        lastFindRef.current = hit;
        v.dispatch({ selection: { anchor: hit.from, head: hit.to } });
        scrollDocToPos(v, hit.from, scrollRef.current, jumpOffset(stickyRef.current, 40));
      }
      return;
    }
    const el = contentRef.current;
    if (!el) return;
    const n = markDomFind(el, findQEff, findMode === 'smart');
    setFindHits(n);
    const first = el.querySelector('mark.wb-find-hl');
    if (first) { findDomIdxRef.current = 0; first.classList.add('wb-find-current'); (first as HTMLElement).scrollIntoView({ block: 'center' }); }
    return () => unmarkDomFind(el);
  }, [findQEff, file, findMode, viewReady, findRanges]);

  // 查找条 Enter：下一个命中（到尾回绕）；命中集合走缓存，不重算
  const findNext = useCallback(() => {
    if (!findQEff) return;
    const v = viewRef.current;
    const sc = scrollRef.current;
    if (file?.type === 'markdown') {
      if (!v || !sc) return;
      const ranges = findRanges(findQEff, findMode);
      const from = lastFindRef.current ? lastFindRef.current.to : 0;
      const hit = ranges.find((r) => r.from >= from) || ranges[0];
      if (hit) {
        lastFindRef.current = hit;
        v.dispatch({ selection: { anchor: hit.from, head: hit.to }, effects: setFindHl.of({ ranges, current: hit }) });
        scrollDocToPos(v, hit.from, sc, jumpOffset(stickyRef.current, 40));
      }
      return;
    }
    const el = contentRef.current;
    if (!el) return;
    const marks = [...el.querySelectorAll<HTMLElement>('mark.wb-find-hl')];
    if (!marks.length) return;
    marks.forEach((m) => m.classList.remove('wb-find-current'));
    const count = new Set(marks.map((m) => m.dataset.findIndex)).size;
    findDomIdxRef.current = (findDomIdxRef.current + 1) % count;
    const current = marks.filter((m) => m.dataset.findIndex === String(findDomIdxRef.current));
    current.forEach((m) => m.classList.add('wb-find-current'));
    current[0]?.scrollIntoView({ block: 'center' });
  }, [findQEff, file, findMode, findRanges]);

  // 划线：选中正文后在选区旁浮出「记笔记」按钮
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      const t = e.target as Element | null;
      // 浮动操作条 / 笔记弹窗 / AI 面板内的点击：保留 sel，否则依赖它的浮层会被卸载
      if (t && typeof t.closest === 'function' && t.closest('[data-wb-selbar], [data-wb-overlay]')) return;
      const card = contentRef.current;
      if (!card) return;
      // 点在正文之外（且不在上述浮层内）：清空选区浮层
      if (!card.contains(t as Node)) { setSel(null); return; }
      const selection = window.getSelection();
      const text = (selection?.toString() || '').trim();
      if (!text || text.length < 2) { setSel(null); return; }
      const rect = selection!.getRangeAt(0).getBoundingClientRect();
      setSel({ text: text.slice(0, 2000), x: Math.min(window.innerWidth - 140, rect.left + rect.width / 2), y: rect.bottom + 6 });
    };
    document.addEventListener('mouseup', onUp);
    return () => document.removeEventListener('mouseup', onUp);
  }, []);

  // 笔记草稿自动保存（按文档隔离，关闭/崩溃都不丢）
  useEffect(() => {
    if (!noteOpen) return;
    const t = setTimeout(() => {
      try { localStorage.setItem('wb:note-draft:' + relPath, noteText); setNoteDraftSaved(true); } catch { /* 存不了草稿时不显示「草稿已存」，输入框内容仍在 */ }
    }, 400);
    return () => clearTimeout(t);
  }, [noteOpen, noteText, relPath]);

  const saveNote = useCallback(async () => {
    if (!sel) return;
    setNoteSaving(true);
    try {
      const r = await api.notesAppend({ sourcePath: relPath, quote: sel.text, note: noteText });
      setNoteOpen(false); setNoteText(''); setSel(null); window.getSelection()?.removeAllRanges();
      try { localStorage.removeItem('wb:note-draft:' + relPath); } catch { /* 草稿清不掉只会在下次打开时多一份旧草稿 */ }
      setNoteDraftSaved(false);
      // 重新拉取本文笔记，下划线与计数立即更新（不再等切换文档）
      api.notesFor(relPath).then((x) => setDocNotes(x.notes || [])).catch(() => {}); // 笔记已保存，只是标记列表刷新失败：下次打开再取
      setResumeHint(`已写入阅读笔记：${r.path}`);
      window.setTimeout(() => setResumeHint(null), 5000);
    } catch (err) {
      setResumeHint('写入笔记失败：' + (err as Error).message);
      window.setTimeout(() => setResumeHint(null), 6000);
    } finally { setNoteSaving(false); }
  }, [sel, relPath, noteText]);

  const togglePin = useCallback(async () => {
    try {
      await api.pin(relPath, pinned ? 'remove' : 'add');
      setPinned(!pinned);
    } catch (e) {
      notify((pinned ? '取消固定失败：' : '固定失败：') + errorMessage(e), { kind: 'error' });
    }
  }, [pinned, relPath]);

  // TXT 原位编辑扩展：行分隔符锁定 + 基础扩展（无行号/折叠）+ 阅读排版主题
  // 注意：必须在上方早退（error/loading return）之前声明，保持 hooks 顺序稳定
  const txtExtensions = useMemo<Extension[]>(
    () => [
      EditorState.lineSeparator.of(lineSep),
      ...editorBaseExtensions({ lineNumbers: false, foldGutter: false }),
      txtInPlaceTheme,
    ],
    [lineSep]
  );

  // HTML 原位编辑：与 TXT 同排版主题，HTML 语法高亮按需加载（加载完成前无高亮，不影响编辑）
  const [htmlExt, setHtmlExt] = useState<Extension | null>(null);
  const isHtmlDoc = file?.type === 'html';
  useEffect(() => {
    if (!isHtmlDoc || htmlExt) return;
    let alive = true;
    htmlLangAsync().then((e) => { if (alive) setHtmlExt(e); });
    return () => { alive = false; };
  }, [isHtmlDoc, htmlExt]);
  const htmlExtensions = useMemo<Extension[]>(
    () => [
      EditorState.lineSeparator.of(lineSep),
      ...(htmlExt ? [htmlExt] : []),
      ...editorBaseExtensions({ lineNumbers: false, foldGutter: false }),
      txtInPlaceTheme,
    ],
    [lineSep, htmlExt]
  );

  // 阅读态双击正文进入原位编辑（可写文本类格式：md / txt / html）
  const onContentDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (editingRef.current || !file || file.readonly) return;
      if (file.type !== 'markdown' && file.type !== 'text' && file.type !== 'html') return;
      // 注意 [contenteditable="true"]：只读态 CodeMirror 的 contentDOM 带 contenteditable="false"，
      // 裸写 [contenteditable] 会把阅读态 CM 整个排除，md 双击永远不生效
      if ((e.target as HTMLElement).closest('a,button,input,select,textarea,[contenteditable="true"]')) return;
      enterEdit();
    },
    [file, enterEdit]
  );

  const crumbs = relPath.split('/');

  return (
    <div className="h-full flex min-h-0">
      {/* 阅读纸面：A 主题下带纸纹侧影（见 themes.css .wb-paper） */}
      <div className="flex-1 min-w-0 overflow-auto wb-paper" ref={scrollRef}>
        <div className="max-w-5xl mx-auto px-4 py-5">
          {/* 顶部工具栏区（sticky，不随正文滚走）：阅读态=面包屑+操作行，
              原位编辑态=格式工具栏+保存控件；查找条与偏好面板也收在同一 sticky 区，
              避免多个 sticky 互相重叠 */}
          <div ref={stickyRef} className="sticky top-0 z-20 pb-3 space-y-2 bg-background">
          <DocTabs
            tabs={tabs}
            active={relPath}
            onActivate={(p2) => navigate('/read/' + p2.split('/').map(encodeURIComponent).join('/'))}
            onClose={closeTab}
            onCloseMany={closeManyTabs}
          />
          {file && (editing ? (
            <div
              className="bg-card border border-border rounded-lg shadow-sm p-1 flex items-center gap-2"
              data-wb-inplace-bar
            >
              <div className="flex-1 min-w-0">
                {file.type === 'markdown' && <FormatToolbar view={viewRef.current} />}
              </div>
              <span
                className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${
                  saveState === 'dirty'
                    ? 'border-warning/60 text-warning'
                    : saveState === 'saved'
                      ? 'border-success/60 text-success'
                      : saveState === 'error'
                        ? 'border-destructive/60 text-destructive'
                        : 'border-border text-muted-foreground'
                }`}
              >
                {saveState === 'dirty' && '未保存'}
                {saveState === 'saving' && <><Loader2 className="inline w-3 h-3 mr-1 align-[-2px] animate-spin" />保存中…</>}
                {saveState === 'saved' && '已保存'}
                {saveState === 'error' && '保存失败'}
                {saveState === 'clean' && '编辑中'}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="text-xs shrink-0"
                loading={saveState === 'saving'}
                disabled={!dirty}
                onClick={() => doSave()}
                title="Ctrl+S"
              >
                <Save className="w-3.5 h-3.5" /> 保存
              </Button>
              <Button
                size="sm"
                className="text-xs shrink-0"
                onClick={() => finishEdit()}
                title="保存并回到阅读 (Ctrl+E)"
              >
                <CheckCircle2 className="w-3.5 h-3.5" /> 完成
              </Button>
              {saveMsg && (
                <span
                  className={`text-xs shrink-0 max-w-[30vw] truncate ${saveState === 'saved' ? 'text-success' : 'text-destructive'}`}
                  title={saveMsg}
                >
                  {saveMsg}
                </span>
              )}
              <button
                className="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground shrink-0"
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
              className="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground disabled:opacity-30"
              disabled={navDepth.idx <= 0}
              onClick={() => navigate(-1)}
              title="后退：上一个文档（Alt+← / ⌘[）"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <button
              className="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground disabled:opacity-30"
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
            <button className="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground" title="文内查找 (Ctrl+F)" onClick={() => setFindOpen(true)}>
              <Search className="w-4 h-4" />
            </button>
            <button className="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground" title="阅读设置" onClick={() => setShowPrefs(!showPrefs)}>
              <Settings2 className="w-4 h-4" />
            </button>
            <button
              className="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground"
              title={pinned ? '取消固定' : '固定到常用入口'}
              onClick={togglePin}
            >
              {pinned ? <PinOff className="w-4 h-4 text-primary" /> : <Pin className="w-4 h-4" />}
            </button>
            {docNotes.length > 0 && (
              <button
                className="p-1.5 rounded hover:bg-accent transition-colors text-amber-600"
                title={`本文档有 ${docNotes.reduce((n, x) => n + x.count, 0)} 条阅读笔记，点击查看`}
                onClick={() => navigate('/read/' + docNotes[0].notePath.split('/').map(encodeURIComponent).join('/'))}
              >
                <NotebookPen className="w-4 h-4" />
                <span className="text-xs stat-num ml-0.5">{docNotes.reduce((n, x) => n + x.count, 0)}</span>
              </button>
            )}
            {agentEnabled && (
              <button
                className={`p-1.5 rounded hover:bg-accent transition-colors ${aiOpen ? 'text-primary' : 'text-muted-foreground'}`}
                title="AI 助手（就当前文档提问）"
                onClick={() => setAiOpen((v) => !v)}
              >
                <Sparkles className="w-4 h-4" />
              </button>
            )}
            <button
              className="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground"
              title="反向引用"
              onClick={() => setShowBacklinks(!showBacklinks)}
            >
              <Link2 className="w-4 h-4" />
              {backlinks.length > 0 && <span className="text-xs stat-num ml-0.5">{backlinks.length}</span>}
            </button>
            {file.readonly ? (
              <span className="text-xs text-muted-foreground border border-dashed border-border rounded px-2 py-1" title={file.readonlyReason || '只读预览'}>{file.readonlyReason || '只读预览'}</span>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="text-xs hover:border-primary hover:text-primary"
                onClick={enterEdit}
                title="进入编辑 (Ctrl+E)"
              >
                <Pencil className="w-3.5 h-3.5" /> 编辑
              </Button>
            )}
          </div>
          ))}

          {/* 查找条与偏好面板：浮层（绝对定位不占文档流，开阖不推挤正文）；挂载/卸载走统一过渡 */}
          {(findPresence.mounted || prefsPresence.mounted) && (
          <div className="absolute inset-x-0 top-full -mt-2 z-30 space-y-2">
          {findPresence.mounted && (
            <div data-state={findPresence.state} className="bg-card border border-border rounded-lg shadow-sm p-2 flex items-center gap-2 duration-med ease-signature fill-mode-both data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2">
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
                placeholder={findMode === 'smart' ? '文内查找（忽略空白/大小写/全角）…回车下一个' : '文内查找（精确匹配）…回车下一个'}
                className="flex-1 text-sm bg-transparent outline-none"
              />
              <span className="inline-flex rounded border border-border overflow-hidden text-xs shrink-0">
                <button className={`px-2 py-1 transition-colors ${findMode === 'exact' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
                  onClick={() => setFindMode('exact')}>精确</button>
                <button className={`px-2 py-1 transition-colors ${findMode === 'smart' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
                  onClick={() => setFindMode('smart')}>智能</button>
              </span>
              {findQ && <span className="text-xs text-muted-foreground stat-num shrink-0">{findHits} 处</span>}
              <button className="p-1 rounded hover:bg-accent transition-colors" onClick={() => { setFindOpen(false); setFindQ(''); }}>
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* 阅读偏好快捷面板（浮层，仅阅读态） */}
          {prefsPresence.mounted && (
            <div data-state={prefsPresence.state} className="bg-card border border-border rounded-lg shadow-sm p-3 text-xs space-y-2 duration-med ease-signature fill-mode-both data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-muted-foreground w-14">字体</span>
                {(['serif', 'sans', 'mono'] as const).map((f) => (
                  <button
                    key={f}
                    className={`px-2 py-1 rounded border ${prefs.font === f ? 'border-primary text-primary' : 'border-border hover:bg-accent transition-colors'}`}
                    onClick={() => update({ font: f })}
                  >
                    {f === 'serif' ? '衬线' : f === 'sans' ? '无衬线' : '等宽'}
                  </button>
                ))}
                <span className="text-muted-foreground w-14 ml-2">主题</span>
                {(['light', 'dark'] as const).map((t) => (
                  <button
                    key={t}
                    className={`px-2 py-1 rounded border ${prefs.theme === t ? 'border-primary text-primary' : 'border-border hover:bg-accent transition-colors'}`}
                    onClick={() => update({ theme: t })}
                  >
                    {t === 'light' ? '浅色' : '深色'}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-muted-foreground w-14">字号</span>
                <button className="px-2 py-1 rounded border border-border hover:bg-accent transition-colors" onClick={() => update({ fontSize: Math.max(14, prefs.fontSize - 1) })}>A−</button>
                <span className="stat-num w-12 text-center">{prefs.fontSize}px</span>
                <button className="px-2 py-1 rounded border border-border hover:bg-accent transition-colors" onClick={() => update({ fontSize: Math.min(32, prefs.fontSize + 1) })}>A＋</button>
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
                <button className="px-2 py-1 rounded border border-border hover:bg-accent transition-colors" onClick={reset}>恢复默认</button>
              </div>
              <div className="text-muted-foreground">阅读偏好即时生效，仅影响界面呈现，不会修改源文件。切换文档与重启后保留。</div>
            </div>
          )}
          </div>
          )}
          </div>

          {/* 主题标签（人工 tags + AI 标注），点击看同主题文档 */}
          {file && (
            <div className="mb-2">
              <TagChips path={relPath} onOpenDoc={(p2) => navigate('/read/' + p2.split('/').map(encodeURIComponent).join('/'))} onOpenConcept={(n) => setConceptName(n)} />
            </div>
          )}

          {/* 正文：加载/错误只替换这张卡片，标签栏、工具栏、AI 面板、目录侧栏保持挂载 */}
          <div
            ref={contentRef}
            data-wb-content-card
            className="bg-card border border-border rounded-lg p-6 md:p-8 min-h-[40vh]"
            onDoubleClick={onContentDoubleClick}
            title={!editing && file && !file.readonly && (file.type === 'markdown' || file.type === 'text' || file.type === 'html') ? '双击进入编辑' : undefined}
          >
            {error ? (
              <PageError
                title="无法打开文件"
                detail={<><p className="mono">{relPath}</p><p>{error.message}</p></>}
              >
                <Button onClick={() => navigate(-1)}>返回上一页</Button>
                <Button variant="outline" asChild><Link to="/browse">浏览目录</Link></Button>
                <Button asChild>
                  <Link to={'/search?q=' + encodeURIComponent(relPath.split('/').pop() || '') + '&mode=exact'}>搜索同名文件</Link>
                </Button>
              </PageError>
            ) : !file ? (
              WORD_EXT.test(relPath) ? <PageLoading slowText={WORD_SLOW_TEXT} slowAfterMs={1500} /> : <PageLoading />
            ) : (
              <>
              {file.type === 'markdown' && (
              <ReadOnlyDoc
                key={relPath}
                noteMarks={noteMarks}
                onOpenNote={(href) => navigate(href)}
                onOpenConcept={(n) => setConceptName(n)}
                content={file.content || ''}
                docPath={relPath}
                refNames={refNames}
                collections={collections}
                links={docLinks}
                highlightTerm={highlightTerm}
                editing={editing}
                lineSep={lineSep}
                onDocChanged={onEditDocChanged}
                onReady={(v) => {
                  viewRef.current = v;
                  setViewReady((s) => s + 1);
                }}
              />
            )}
            {file.type === 'text' &&
              (editing ? (
                <CodeMirrorEditor
                  key={relPath}
                  initialDoc={file.content || ''}
                  extensions={txtExtensions}
                  height="auto"
                  onDocChanged={onEditDocChanged}
                  onCreate={(v) => {
                    viewRef.current = v;
                    setViewReady((s) => s + 1);
                  }}
                />
              ) : (
                <TxtReadBody
                  key={relPath}
                  content={file.content || ''}
                  links={docLinks}
                  style={txtReaderStyle}
                  noteMarks={noteMarks}
                  highlightTerm={highlightTerm}
                  onOpenNote={onOpenNoteHref}
                  onOpenTarget={onTxtOpenTarget}
                  onCandidates={onTxtCandidates}
                  onContentReady={onWordReady}
                />
              ))}
            {file.type === 'json' && (
              <JsonViewer key={relPath} content={file.content || ''} highlightTerm={highlightTerm || hitText || findQ} onContentReady={onWordReady} />
            )}
            {file.type === 'html' &&
              (editing ? (
                <CodeMirrorEditor
                  key={relPath}
                  initialDoc={file.content || ''}
                  extensions={htmlExtensions}
                  height="auto"
                  onDocChanged={onEditDocChanged}
                  onCreate={(v) => {
                    viewRef.current = v;
                    setViewReady((s) => s + 1);
                  }}
                />
              ) : (
                <HtmlReader key={relPath} content={file.content || ''} docPath={relPath} onContentReady={onWordReady} />
              ))}
            {file.type === 'word' && (
              <WordReader key={relPath} onContentReady={onWordReady} path={relPath} name={file.name} html={file.html || ''} text={file.text || ''} warning={file.warning} engine={file.engine} />
            )}
              </>
            )}
          </div>

          {file && (
          <div className="text-xs text-muted-foreground mt-3 flex gap-4 flex-wrap">
            <span>修改时间：{new Date(file.mtimeMs).toLocaleString('zh-CN')}</span>
            <span>大小：{(file.size / 1024).toFixed(1)} KB</span>
            {file.bom && <span>UTF-8 BOM</span>}
          </div>
          )}
        </div>
      </div>

      {/* 右侧：AI 助手（优先）——切换文档时保持挂载 */}
      {aiPresence.mounted && (
        <aside
          ref={aiAsideRef}
          data-wb-overlay
          data-state={aiPresence.state}
          className="hidden lg:flex shrink-0 relative duration-med ease-signature fill-mode-both data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-2"
          style={{ width: 'var(--wb-ai-w)', '--wb-ai-w': aiWidth + 'px' } as React.CSSProperties}
        >
          <div
            className="absolute left-0 top-0 bottom-0 w-1 -ml-0.5 cursor-col-resize hover:bg-primary/30 z-10"
            title="拖动调整宽度"
            onMouseDown={() => { aiDragRef.current = true; document.body.style.cursor = 'col-resize'; }}
          />
          <ReadAgentPanel
            docPath={relPath}
            docName={file?.name || ''}
            pendingQuote={aiQuote}
            onQuoteConsumed={() => setAiQuote(null)}
            onClose={() => setAiOpen(false)}
            onOpenDoc={(p, term) => navigate('/read/' + p.split('/').map(encodeURIComponent).join('/') + (term ? '?h=' + encodeURIComponent(term) : ''))}
          />
        </aside>
      )}

      {/* 右侧：目录 + 反链 */}
      {sidePresence.mounted && (
        <aside
          data-state={sidePresence.state}
          className="hidden lg:block w-64 shrink-0 border-l border-border overflow-auto p-3 duration-med ease-signature fill-mode-both data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-2"
        >
          {showToc && toc.length > 0 && (
            <div className="mb-4">
              <div className="flex items-center gap-1 text-xs font-semibold text-muted-foreground mb-2">
                <ListTree className="w-3.5 h-3.5" /> 文档目录
                <button className="ml-auto p-0.5 rounded hover:bg-accent transition-colors" onClick={() => setShowToc(false)}>
                  <X className="w-3 h-3" />
                </button>
              </div>
              <ul className="space-y-0.5">
                {toc.map((t) => (
                  <li key={t.key}>
                    <button
                      className="text-xs text-left w-full py-0.5 px-1.5 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground truncate"
                      style={{ paddingLeft: (t.level - 1) * 12 + 6 }}
                      onClick={() => {
                        const sc = scrollRef.current;
                        if (!sc) return;
                        if (t.pos != null && viewRef.current) {
                          scrollDocToPos(viewRef.current, t.pos, sc, jumpOffset(stickyRef.current, 16));
                        } else if (t.id) {
                          const el = document.getElementById(t.id);
                          if (el) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - jumpOffset(stickyRef.current, 16);
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
          {!showToc && toc.length > 0 && (
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

      {/* 恢复阅读位置 / 笔记写入提示 */}
      {resumeHint && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-card border border-border rounded-lg shadow-lg px-3 py-2 text-xs text-muted-foreground" role="status">
          {resumeHint}
        </div>
      )}

      {/* 选区旁的浮动操作：记笔记 / 问 AI（助手关闭时只有记笔记） */}
      {sel && !noteOpen && (
        <div
          data-wb-selbar
          className="fixed z-40 -translate-x-1/2 flex items-center gap-1"
          style={{ left: sel.x, top: sel.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs shadow-lg transition-colors hover:opacity-90"
            onClick={() => {
              setNoteOpen(true);
              try { setNoteText(localStorage.getItem('wb:note-draft:' + relPath) || ''); } catch { setNoteText(''); }
            }}
          >
            <NotebookPen className="w-3.5 h-3.5" /> 记笔记
          </button>
          {agentEnabled && (
            <button
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-card border border-border text-xs shadow-lg transition-colors hover:border-primary/50 hover:text-primary"
              title="把选中内容引用到智能助手"
              onClick={() => {
                setAiQuote(sel.text);
                setAiOpen(true);
                window.getSelection()?.removeAllRanges();
                setSel(null);
              }}
            >
              <Sparkles className="w-3.5 h-3.5" /> 问 AI
            </button>
          )}
        </div>
      )}

      {/* 划线笔记：编辑弹窗 */}
      {noteOpen && sel && (
        <div data-wb-overlay className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setNoteOpen(false)}>
          <div className="bg-card border border-border rounded-lg p-5 max-w-2xl w-full shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5"><NotebookPen className="w-4 h-4 text-primary" />添加到阅读笔记</h3>
            <blockquote className="text-xs text-muted-foreground border-l-2 border-primary/50 pl-2 mb-3 max-h-24 overflow-auto whitespace-pre-wrap">
              {sel.text}
            </blockquote>
            <textarea
              autoFocus
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              rows={10}
              placeholder="写下你的想法（可留空，只记录划线）…"
              className="w-full text-sm px-3 py-2 rounded border border-input bg-background resize-y min-h-[180px] leading-relaxed"
            />
            <div className="flex items-center gap-2 mt-3">
              <span className="text-xs text-muted-foreground">{noteDraftSaved ? '草稿已自动保存（按文档隔离）' : '输入内容会自动保存草稿'}</span>
              <span className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => setNoteOpen(false)}>取消</Button>
              <Button size="sm" disabled={noteSaving} onClick={saveNote}>{noteSaving ? '写入中…' : '保存笔记'}</Button>
            </div>
          </div>
        </div>
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  clearDraft(dsId!, relPath);
                  setDraftPrompt(null);
                }}
              >
                丢弃草稿
              </Button>
              <Button
                size="sm"
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
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 原位编辑：外部修改冲突 */}
      {conflict && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg p-5 max-w-2xl w-full shadow-xl max-h-[80vh] flex flex-col">
            <h3 className="font-medium mb-2 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-warning" /> 文件已被外部修改
            </h3>
            <p className="text-sm text-muted-foreground mb-3">
              磁盘上的文件在你打开后发生了变化。选择处理方式（你的修改已作为草稿保留在本地）：
            </p>
            <div className="text-xs text-muted-foreground mb-2">磁盘当前内容预览（前 800 字符）：</div>
            <pre className="text-xs bg-muted rounded p-3 overflow-auto flex-1 whitespace-pre-wrap">{conflict.current.slice(0, 800)}</pre>
            <div className="flex gap-2 justify-end mt-4 flex-wrap">
              <Button variant="outline" size="sm" onClick={() => setConflict(null)}>
                继续编辑（暂不保存）
              </Button>
              <Button
                variant="outline"
                size="sm"
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
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={async () => {
                  const ok = await doSaveWithMtime(conflict.currentMtimeMs);
                  if (ok) setConflict(null);
                }}
              >
                用我的修改覆盖磁盘版本
              </Button>
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
              <Button variant="outline" size="sm" onClick={() => blocker.reset()}>
                继续编辑
              </Button>
              <Button variant="outline" size="sm" onClick={() => blocker.proceed()}>
                放弃并离开
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  const ok = await doSave();
                  if (ok) blocker.proceed();
                }}
              >
                保存并离开
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 定位中提示：检索命中/锚点跳转完成前悬浮，消除「先顶部后猛跳」的卡顿感 */}
      {locating && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 pl-2.5 pr-3.5 py-1.5 rounded-full bg-card border border-border shadow-lg text-xs text-muted-foreground animate-in fade-in slide-in-from-top-2 duration-200">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
          正在定位到命中位置…
        </div>
      )}

      {/* TXT 阅读正文的歧义链接候选 */}
      <PathListPopover req={txtCandReq} onClose={() => setTxtCandReq(null)} />

      {/* 概念详情（点正文里的概念词条打开） */}
      {conceptName && (
        <ConceptCard
          key={conceptName}
          name={conceptName}
          onClose={() => setConceptName(null)}
          onOpenDoc={(p2) => { setConceptName(null); navigate('/read/' + p2.split('/').map(encodeURIComponent).join('/')); }}
          onOpenConcept={(n) => setConceptName(n)}
        />
      )}
    </div>
  );
}
