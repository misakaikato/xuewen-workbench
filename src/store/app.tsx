// 应用级上下文：数据源配置、扫描状态、目录树。数据源切换后统一重取，丢弃旧数据源响应。
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import type { ConfigResponse, TreeNode } from '@/lib/types';

interface AppState {
  config: ConfigResponse | null;
  tree: TreeNode | null;
  loading: boolean;
  dsId: string | null;
  refreshConfig: () => Promise<void>;
  refreshTree: () => Promise<void>;
  rescan: () => Promise<void>;
}

const Ctx = createContext<AppState>({
  config: null, tree: null, loading: true, dsId: null,
  refreshConfig: async () => {}, refreshTree: async () => {}, rescan: async () => {},
});

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const genRef = useRef(0);

  const refreshConfig = useCallback(async () => {
    const cfg = await api.getConfig();
    const prevGen = genRef.current;
    genRef.current = cfg.generation;
    setConfig(cfg);
    setLoading(false);
    if (cfg.configured && cfg.generation !== prevGen) {
      // 数据源或代际变化：重取目录树
      const t = await api.tree();
      if (genRef.current === cfg.generation) setTree(t.tree);
    } else if (cfg.configured && !tree) {
      const t = await api.tree().catch(() => null);
      if (t) setTree(t.tree);
    } else if (!cfg.configured) {
      setTree(null);
    }
  }, [tree]);

  const refreshTree = useCallback(async () => {
    if (!config?.configured) return;
    const gen = genRef.current;
    const t = await api.tree();
    if (gen === genRef.current && t.dsId === config.dsId) setTree(t.tree);
  }, [config]);

  const rescan = useCallback(async () => {
    await api.rescan();
    const gen = genRef.current;
    const [cfg, t] = await Promise.all([api.getConfig(), api.tree().catch(() => null)]);
    if (gen === genRef.current) {
      setConfig(cfg);
      if (t) setTree(t.tree);
    }
  }, []);

  useEffect(() => {
    refreshConfig().catch(() => setLoading(false));
    // 轮询扫描状态（文件监听触发服务端重扫后同步前端）
    const timer = setInterval(async () => {
      try {
        const st = await api.status();
        if (st.scannedAt && config?.status.scannedAt && st.scannedAt !== config.status.scannedAt) {
          await refreshConfig();
        }
      } catch { /* 后端未就绪时忽略 */ }
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.status.scannedAt]);

  return (
    <Ctx.Provider value={{ config, tree, loading, dsId: config?.dsId ?? null, refreshConfig, refreshTree, rescan }}>
      {children}
    </Ctx.Provider>
  );
}

export function useApp() {
  return useContext(Ctx);
}
