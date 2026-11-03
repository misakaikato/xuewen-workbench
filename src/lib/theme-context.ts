// 界面设置的全局 Context：外观主题（类型、判定与应用逻辑）与智能助手总开关。
// Provider 在 theme.tsx（启动时读一次 /api/ui-settings），供各页面共用。
import { createContext, useContext } from 'react';

export type Theme = 'A' | 'B' | 'C';

export const THEME_STORAGE_KEY = 'wb:theme';

export function isTheme(v: unknown): v is Theme {
  return v === 'A' || v === 'B' || v === 'C';
}

export function applyTheme(t: Theme) {
  const el = document.documentElement;
  el.dataset.theme = t;
  el.classList.toggle('dark', t === 'C');
}

interface ThemeCtx {
  theme: Theme;
  setTheme: (t: Theme) => void;
  /** 智能助手总开关（ui-settings.agentEnabled）；null = 启动读取尚未完成，按关闭处理 */
  agentEnabled: boolean | null;
  /** 保存开关：成功即全局生效；失败时先把状态对账回服务端实际值，再抛出错误供调用方提示 */
  setAgentEnabled: (v: boolean) => Promise<void>;
}

export const ThemeCtx = createContext<ThemeCtx>({
  theme: 'A', setTheme: () => {}, agentEnabled: null, setAgentEnabled: async () => {},
});

export function useTheme() {
  return useContext(ThemeCtx);
}

/** 助手入口是否可见：所有入口（顶栏、⌘J、命令面板、路由、阅读页）只经此读取，不各自请求接口 */
export function useAgentEnabled(): boolean | null {
  return useContext(ThemeCtx).agentEnabled;
}
