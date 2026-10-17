// 编辑页：仅由用户主动进入。MD 源码/预览/分栏；JSON 校验与格式化；
// 显式保存写回原文件（原子写+备份+冲突检测）；草稿自动本地保存、打开时提示恢复。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useBlocker } from 'react-router-dom';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { api } from '@/lib/api';
import { useApp } from '@/store/app';
import { useReadingPrefs } from '@/lib/prefs';
import { saveDraft, loadDraft, clearDraft } from '@/lib/drafts';
import type { FilePayload } from '@/lib/types';
import { MarkdownReader } from '@/components/MarkdownReader';
import { Save, Undo2, AlertTriangle, X, CheckCircle2, Columns2, Eye, Code2 } from 'lucide-react';

type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error';

export default function Edit() {
  const params = useParams();
  const relPath = useMemo(() => decodeURIComponent(params['*'] || ''), [params]);
  const { dsId } = useApp();
  const { prefs } = useReadingPrefs();
  const navigate = useNavigate();

  const [file, setFile] = useState<FilePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('clean');
  const [saveMsg, setSaveMsg] = useState('');
  const [mode, setMode] = useState<'source' | 'preview' | 'split'>('source');
  const [draftPrompt, setDraftPrompt] = useState<{ content: string; savedAt: number } | null>(null);
  const [conflict, setConflict] = useState<{ current: string; currentMtimeMs: number } | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const baseMtimeRef = useRef(0);
  const [refNames, setRefNames] = useState<{ name: string; base: string; path: string; ext: string; dir: string }[]>([]);
  const [collections, setCollections] = useState<{ name: string }[]>([]);

  const dirty = saveState === 'dirty' || saveState === 'error';
  // 文件被重命名/移动/删除后由目录树带 wbFollow 跳转，不拦截（草稿已迁移）
  const blocker = useBlocker(({ nextLocation }) => dirty && !(nextLocation.state as { wbFollow?: boolean } | null)?.wbFollow);

  // 加载文件 + 草稿检测（草稿不自动进入编辑，由用户选择恢复）
  useEffect(() => {
    if (!dsId || !relPath) return;
    let dead = false;
    api.file(relPath)
      .then((f) => {
        if (dead) return;
        if (f.readonly) {
          navigate('/read/' + relPath.split('/').map(encodeURIComponent).join('/'), { replace: true });
          return;
        }
        setFile(f);
        baseMtimeRef.current = f.mtimeMs;
        const draft = loadDraft(dsId, relPath);
        if (draft && draft.content !== f.content) setDraftPrompt(draft);
        setContent(f.content || '');
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

  const isJson = file?.type === 'json';

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

  const doSave = useCallback(
    async (andReturn: boolean, overrideMtime?: number) => {
      if (!file || !dsId) return;
      if (!validateJson(content)) {
        setSaveState('error');
        setSaveMsg('JSON 语法错误，修正后才能保存');
        return;
      }
      setSaveState('saving');
      setSaveMsg('');
      try {
        const r = await api.saveFile(relPath, content, overrideMtime ?? baseMtimeRef.current, dsId);
        baseMtimeRef.current = r.mtimeMs;
        clearDraft(dsId, relPath);
        setConflict(null);
        setSaveState('saved');
        setSaveMsg('已保存到 ' + relPath);
        if (andReturn) {
          navigate('/read/' + relPath.split('/').map(encodeURIComponent).join('/'));
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
    [file, dsId, content, relPath, navigate, validateJson]
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

  // 路由离开拦截：使用页面内对话框（window.confirm 在部分嵌入浏览器中不可靠）
  // blocker.state === 'blocked' 时渲染确认层
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

  const extensions = [isJson ? json() : markdown()];

  const editorEl = (
    <CodeMirror
      value={content}
      height="100%"
      theme={prefs.theme}
      extensions={extensions}
      onChange={(v) => {
        setContent(v);
        setSaveState('dirty');
        if (isJson) validateJson(v);
      }}
      basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: true }}
      style={{ height: '100%', fontSize: prefs.codeFontSize }}
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
            {([['source', Code2, '源码'], ['preview', Eye, '预览'], ['split', Columns2, '分栏']] as const).map(([m, Icon, label]) => (
              <button
                key={m}
                className={`px-2.5 py-1 flex items-center gap-1 ${mode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
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
                setContent(JSON.stringify(JSON.parse(content), null, 2));
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
          onClick={() => navigate('/read/' + relPath.split('/').map(encodeURIComponent).join('/'))}
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
      <div className="flex-1 min-h-0 flex">
        {(mode === 'source' || mode === 'split' || isJson) && (
          <div className={`min-w-0 ${mode === 'split' ? 'w-1/2 border-r border-border' : 'flex-1'}`}>{editorEl}</div>
        )}
        {(mode === 'preview' || mode === 'split') && !isJson && (
          <div className={`min-w-0 overflow-auto p-6 ${mode === 'split' ? 'w-1/2' : 'flex-1'}`}>
            <MarkdownReader content={content} docPath={relPath} refNames={refNames} collections={collections} />
          </div>
        )}
      </div>

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
                  setContent(draftPrompt.content);
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
                  setContent(conflict.current);
                  baseMtimeRef.current = conflict.currentMtimeMs;
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
