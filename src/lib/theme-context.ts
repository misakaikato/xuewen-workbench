// 外观主题的类型、判定与应用逻辑与 Context：供 Provider（theme.tsx）与各页面共用。
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
}

export const ThemeCtx = createContext<ThemeCtx>({ theme: 'A', setTheme: () => {} });

export function useTheme() {
  return useContext(ThemeCtx);
}
