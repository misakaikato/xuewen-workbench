// 应用级上下文：知识库配置、扫描状态、目录树。支持多知识库并行，
// 当前库由 activeId 决定；所有请求经 api 作用域携带 ds，切库后统一重取并丢弃旧库响应。
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, setApiScope } from '@/lib/api';
import { usePolling } from '@/hooks/usePolling';
import type { ConfigResponse, LibraryInfo, TreeNode, UpdateState } from '@/lib/types';

interface AppState {
  config: ConfigResponse | null;
  libraries: LibraryInfo[];
  tree: TreeNode | null;
  loading: boolean;
  dsId: string | null;
  update: UpdateState | null;
  /** 手动重扫进行中（所有入口共享：顶栏图标 / ⌘K 命令同一反馈） */
  scanning: boolean;
  applyUpdate: (s: UpdateState) => void;
  refreshConfig: () => Promise<void>;
  refreshTree: () => Promise<void>;
  rescan: () => Promise<void>;
  activateLib: (id: string) => Promise<void>;
  removeLib: (id: string) => Promise<void>;
}

const Ctx = createContext<AppState>({
  config: null, libraries: [], tree: null, loading: true, dsId: null, update: null, scanning: false,
  applyUpdate: () => {},
  refreshConfig: async () => {}, refreshTree: async () => {}, rescan: async () => {},
  activateLib: async () => {}, removeLib: async () => {},
});

// 更新状态内容相同则视为未变（服务端每次返回新对象，身份相同但字段不变不应触发整树重渲）
function sameUpdate(a: UpdateState | null, b: UpdateState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.enabled === b.enabled &&
    a.status === b.status &&
    a.currentVersion === b.currentVersion &&
    a.error === b.error &&
    (a.info?.version ?? null) === (b.info?.version ?? null) &&
    (a.progress?.percent ?? null) === (b.progress?.percent ?? null) &&
    (a.progress?.transferred ?? null) === (b.progress?.transferred ?? null)
  );
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const genRef = useRef(0);
  const dsRef = useRef<string | null>(null);

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
    try {
      await api.rescan();
      const gen = genRef.current;
      const ds = dsRef.current;
      const [cfg, t] = await Promise.all([api.getConfig(), api.tree().catch(() => null)]);
      if (gen === genRef.current && ds === dsRef.current) {
        setConfig(cfg);
        if (t) setTree(t.tree);
      }
    } finally {
      setScanning(false);
    }
  }, []);

  const activateLib = useCallback(async (id: string) => {
    await api.activateLibrary(id);
    await refreshConfig();
  }, [refreshConfig]);

  const removeLib = useCallback(async (id: string) => {
    await api.removeLibrary(id);
    await refreshConfig();
  }, [refreshConfig]);

  useEffect(() => {
    refreshConfig().catch(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时执行
  }, []);

  // 轮询扫描状态（文件监听触发服务端重扫后同步前端；多库时看各库 scannedAt）。
  // 页面隐藏时暂停（usePolling），回到可见立即补拉。
  usePolling(() => {
    (async () => {
      try {
        const st = await api.status();
        setUpdate((prev) => (sameUpdate(prev, st.update ?? null) ? prev : (st.update ?? null))); // 更新状态搭同一班车（规格：不新增请求循环）
        const active = config?.dsId ? st.libs?.[config.dsId] : null;
        if (active?.scannedAt && config?.status.scannedAt && active.scannedAt !== config.status.scannedAt) {
          await refreshConfig();
        }
      } catch { /* 后端未就绪时忽略 */ }
    })();
  }, 5000);

  const libraries = useMemo(() => config?.libraries ?? [], [config]);
  const dsId = config?.dsId ?? null;
  const value = useMemo<AppState>(
    () => ({
      config, libraries, tree, loading, dsId, update, scanning, applyUpdate: setUpdate,
      refreshConfig, refreshTree, rescan, activateLib, removeLib,
    }),
    [config, libraries, tree, loading, dsId, update, scanning, refreshConfig, refreshTree, rescan, activateLib, removeLib]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  return useContext(Ctx);
}
