// 应用级上下文定义与 hook：知识库配置、扫描状态、目录树。支持多知识库并行，
// 当前库由 activeId 决定；所有请求经 api 作用域携带 ds，切库后统一重取并丢弃旧库响应。
// Provider 组件在 app.tsx。
import { createContext, useContext } from 'react';
import type { ConfigResponse, LibraryInfo, TreeNode, UpdateState } from '@/lib/types';

export interface AppState {
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

export const AppCtx = createContext<AppState>({
  config: null, libraries: [], tree: null, loading: true, dsId: null, update: null, scanning: false,
  applyUpdate: () => {},
  refreshConfig: async () => {}, refreshTree: async () => {}, rescan: async () => {},
  activateLib: async () => {}, removeLib: async () => {},
});

export function useApp() {
  return useContext(AppCtx);
}
