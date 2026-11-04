// 应用级 Provider：知识库配置、扫描状态、目录树（上下文定义与 useApp 在 app-context.ts）。
// 当前库由 activeId 决定；所有请求经 api 作用域携带 ds，切库后统一重取并丢弃旧库响应。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, setApiScope } from '@/lib/api';
import { usePolling } from '@/hooks/usePolling';
import { notify } from '@/lib/notify';
import { INDEX_SETTLED_EVENT } from '@/lib/indexReady';
import { AppCtx, type AppState, type BackendWork } from './app-context';
import type { ConfigResponse, IndexingProgress, TreeNode, UpdateState } from '@/lib/types';

// 更新状态内容相同则视为未变（服务端每次返回新对象，身份相同但字段不变不应触发整树重渲）
function sameUpdate(a: UpdateState | null, b: UpdateState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.enabled === b.enabled &&
    a.status === b.status &&
    a.currentVersion === b.currentVersion &&
    a.error === b.error &&
    (a.phase ?? null) === (b.phase ?? null) &&
    (a.canCancel ?? false) === (b.canCancel ?? false) &&
    (a.installMode ?? null) === (b.installMode ?? null) &&
    (a.installModeReason ?? null) === (b.installModeReason ?? null) &&
    (a.info?.version ?? null) === (b.info?.version ?? null) &&
    (a.progress?.percent ?? null) === (b.progress?.percent ?? null) &&
    (a.progress?.transferred ?? null) === (b.progress?.transferred ?? null) &&
    (a.progress?.etaSeconds ?? null) === (b.progress?.etaSeconds ?? null) &&
    (a.lastInstall?.result ?? null) === (b.lastInstall?.result ?? null) &&
    (a.lastInstall?.toVersion ?? null) === (b.lastInstall?.toVersion ?? null) &&
    (a.lastInstall?.error ?? null) === (b.lastInstall?.error ?? null)
  );
}

// 后台索引进度的浅比较（轮询返回新对象，内容不变不触发重渲）
function sameIndexing(a: IndexingProgress | null, b: IndexingProgress | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.phase === b.phase && a.done === b.done && a.total === b.total && a.startedAt === b.startedAt;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [backend, setBackend] = useState<BackendWork>({ scanning: false, scanned: 0, indexing: null, indexError: null });
  const genRef = useRef(0);
  const dsRef = useRef<string | null>(null);
  // 后台状态的对账基线：linksSeq 递增 → 广播索引就绪；新 indexError → 提示一次
  const lastLinksSeqRef = useRef<number | null>(null);
  const lastIndexErrorRef = useRef<string | null>(null);
  // 外部入口（如添加知识库）预告知后台活动，轮询临时收紧
  const [activityHintUntil, setActivityHintUntil] = useState(0);
  const hintActivity = useCallback(() => setActivityHintUntil(Date.now() + 10000), []);
  useEffect(() => {
    if (!activityHintUntil) return;
    const t = setTimeout(() => setActivityHintUntil(0), Math.max(0, activityHintUntil - Date.now()) + 100);
    return () => clearTimeout(t);
  }, [activityHintUntil]);

  const refreshConfig = useCallback(async () => {
    const cfg = await api.getConfig();
    const prevGen = genRef.current;
    const prevDs = dsRef.current;
    genRef.current = cfg.generation;
    dsRef.current = cfg.dsId;
    setApiScope(cfg.dsId);
    setConfig(cfg);
    setLoading(false);
    const dsChanged = cfg.configured && cfg.dsId !== prevDs;
    const genChanged = cfg.configured && cfg.generation !== prevGen;
    if (dsChanged) {
      // 切库：后台状态对账基线重置，旧库的进度不串到新库；旧库目录树立即撤下，不在新库名下显示
      lastLinksSeqRef.current = null;
      lastIndexErrorRef.current = null;
      setBackend({ scanning: false, scanned: 0, indexing: null, indexError: null });
      setTree(null);
    }
    if (dsChanged || genChanged) {
      // 知识库或代际变化：重取目录树
      const t = await api.tree();
      if (genRef.current === cfg.generation && dsRef.current === cfg.dsId) setTree(t.tree);
    } else if (cfg.configured && !tree) {
      const t = await api.tree().catch(() => null);
      if (t && genRef.current === cfg.generation && dsRef.current === cfg.dsId) setTree(t.tree);
    } else if (!cfg.configured) {
      setTree(null);
    }
  }, [tree]);

  const refreshTree = useCallback(async () => {
    if (!config?.configured) return;
    const gen = genRef.current;
    const ds = dsRef.current;
    const t = await api.tree();
    if (gen === genRef.current && ds === dsRef.current && t.dsId === config.dsId) setTree(t.tree);
  }, [config]);

  // scanning 全局化：⌘K 面板是 fire-and-forget（不等 Promise），本地 state 看不到过程，
  // 必须放 store 里让顶栏图标对所有入口同步转圈
  const [scanning, setScanning] = useState(false);
  const rescan = useCallback(async () => {
    setScanning(true);
    hintActivity();
    try {
      await api.rescan();
      const gen = genRef.current;
      const ds = dsRef.current;
      const [cfg, t] = await Promise.all([api.getConfig(), api.tree().catch(() => null)]);
      if (gen === genRef.current && ds === dsRef.current) {
        setConfig(cfg);
        if (t) setTree(t.tree);
      }
    } catch (e) {
      notify('重新扫描失败：' + (e as Error).message, { kind: 'error' });
    } finally {
      setScanning(false);
    }
  }, [hintActivity]);

  // 切换知识库（含移除后落到另一个库）：新库的 config 与目录树都加载完之前 switchingLib 为 true；
  // 失败抛给调用方提示
  const [switchingLib, setSwitchingLib] = useState(false);
  const switchLib = useCallback(async (change: () => Promise<unknown>) => {
    setSwitchingLib(true);
    try {
      await change();
      await refreshConfig();
    } finally {
      setSwitchingLib(false);
    }
  }, [refreshConfig]);
  const activateLib = useCallback((id: string) => switchLib(() => api.activateLibrary(id)), [switchLib]);
  const removeLib = useCallback(async (id: string) => {
    if (id === dsRef.current) return switchLib(() => api.removeLibrary(id)); // 移除当前库会落到另一个库
    await api.removeLibrary(id);
    await refreshConfig();
  }, [switchLib, refreshConfig]);

  useEffect(() => {
    refreshConfig().catch(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时执行
  }, []);

  // 轮询扫描状态（文件监听触发服务端重扫后同步前端；多库时看各库 scannedAt）。
  // 页面隐藏时暂停（usePolling），回到可见立即补拉。
  // 更新进行中（checking/downloading/installing）或有后台扫描/索引时收紧到 1 秒：
  // 顶栏指示、检索「可能不完整」、反链等待都靠这班车，不新增请求循环。
  const updateBusy = !!update && ['checking', 'downloading', 'installing'].includes(update.status);
  const backendBusy = scanning || backend.scanning || backend.indexing?.phase != null || Date.now() < activityHintUntil;
  usePolling(() => {
    (async () => {
      try {
        const st = await api.status();
        setUpdate((prev) => (sameUpdate(prev, st.update ?? null) ? prev : (st.update ?? null))); // 更新状态搭同一班车（规格：不新增请求循环）
        const seq = st.linksSeq ?? null;
        if (seq !== null && lastLinksSeqRef.current !== null && seq !== lastLinksSeqRef.current) {
          window.dispatchEvent(new CustomEvent(INDEX_SETTLED_EVENT)); // 索引就绪：等待方再取一次
        }
        if (seq !== null) lastLinksSeqRef.current = seq;
        const idxErr = st.indexError ?? null;
        if (idxErr && idxErr !== lastIndexErrorRef.current) {
          notify('索引构建失败：' + idxErr, { kind: 'error' });
        }
        lastIndexErrorRef.current = idxErr;
        setBackend((prev) => {
          const next: BackendWork = {
            scanning: !!st.scanning,
            scanned: st.scanned ?? 0,
            indexing: st.indexing ?? null,
            indexError: st.indexError ?? null,
          };
          return prev.scanning === next.scanning && prev.scanned === next.scanned &&
            sameIndexing(prev.indexing, next.indexing) && prev.indexError === next.indexError
            ? prev
            : next;
        });
        const active = config?.dsId ? st.libs?.[config.dsId] : null;
        // 目录不可达期间快照不变（scannedAt 不动），可达性与监听状态的变化也要拉一次配置
        const reachChanged = !!config && (!!st.unreachable !== !!config.status.unreachable || st.watching !== config.status.watching);
        if ((active?.scannedAt && config?.status.scannedAt && active.scannedAt !== config.status.scannedAt) || reachChanged) {
          await refreshConfig();
        }
      } catch { /* 后端未就绪时忽略 */ }
    })();
  }, updateBusy || backendBusy ? 1000 : 5000);

  const libraries = useMemo(() => config?.libraries ?? [], [config]);
  const dsId = config?.dsId ?? null;
  const value = useMemo<AppState>(
    () => ({
      config, libraries, tree, loading, dsId, update, scanning, switchingLib, backend, applyUpdate: setUpdate,
      refreshConfig, refreshTree, rescan, activateLib, removeLib, hintActivity,
    }),
    [config, libraries, tree, loading, dsId, update, scanning, switchingLib, backend, refreshConfig, refreshTree, rescan, activateLib, removeLib, hintActivity]
  );

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
