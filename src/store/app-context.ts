// 应用级上下文定义与 hook：知识库配置、扫描状态、目录树。支持多知识库并行，
// 当前库由 activeId 决定；所有请求经 api 作用域携带 ds，切库后统一重取并丢弃旧库响应。
// Provider 组件在 app.tsx。
import { createContext, useContext } from 'react';
import type { ConfigResponse, IndexingProgress, LibraryInfo, TreeNode, UpdateState } from '@/lib/types';

/** 当前知识库的后台扫描/索引状态（来自 /api/status 轮询，反馈第 4 批） */
export interface BackendWork {
  scanning: boolean;
  /** 扫描进行中已遍历的文件数 */
  scanned: number;
  /** 文本索引/内链索引进度；phase 为 null 表示空闲 */
  indexing: IndexingProgress | null;
  /** 最近一次索引构建失败原因 */
  indexError: string | null;
}

export interface AppState {
  config: ConfigResponse | null;
  libraries: LibraryInfo[];
  tree: TreeNode | null;
  loading: boolean;
  dsId: string | null;
  update: UpdateState | null;
  /** 手动重扫进行中（所有入口共享：顶栏图标 / ⌘K 命令同一反馈） */
  scanning: boolean;
  /** 切换知识库进行中：新库的 config 与目录树都到位前为 true（内容区显示骨架，不露旧库数据） */
  switchingLib: boolean;
  backend: BackendWork;
  applyUpdate: (s: UpdateState) => void;
  refreshConfig: () => Promise<void>;
  refreshTree: () => Promise<void>;
  rescan: () => Promise<void>;
  activateLib: (id: string) => Promise<void>;
  removeLib: (id: string) => Promise<void>;
  /** 预告知接下来可能有后台扫描/索引（如添加知识库），让状态轮询收紧到 1 秒 */
  hintActivity: () => void;
}

export const AppCtx = createContext<AppState>({
  config: null, libraries: [], tree: null, loading: true, dsId: null, update: null, scanning: false, switchingLib: false,
  backend: { scanning: false, scanned: 0, indexing: null, indexError: null },
  applyUpdate: () => {},
  refreshConfig: async () => {}, refreshTree: async () => {}, rescan: async () => {},
  activateLib: async () => {}, removeLib: async () => {}, hintActivity: () => {},
});

export function useApp() {
  return useContext(AppCtx);
}
