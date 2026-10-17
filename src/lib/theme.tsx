// 外观主题：A 宣纸 · 书卷 / B 现代极简 / C 夜读。
// 服务端为权威持久化（Electron 端口会变、localStorage 按 origin 隔离），localStorage 仅作首帧防闪烁兜底。
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export type Theme = 'A' | 'B' | 'C';

const STORAGE_KEY = 'wb:theme';

function isTheme(v: unknown): v is Theme {
  return v === 'A' || v === 'B' || v === 'C';
}

// 首帧主题来自 <head> 内联防闪烁脚本写入的 data-theme
function readInitialTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return isTheme(t) ? t : 'A';
}

function applyTheme(t: Theme) {
  const el = document.documentElement;
  el.dataset.theme = t;
  el.classList.toggle('dark', t === 'C');
}

interface ThemeCtx {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const Ctx = createContext<ThemeCtx>({ theme: 'A', setTheme: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);

  // 启动时与服务端对账：以持久化设置为准（防闪烁脚本可能读到过期的 localStorage）
  useEffect(() => {
    let alive = true;
    api
      .getUiSettings()
      .then((s) => {
        if (!alive) return;
        if (isTheme(s.theme)) {
          if (s.theme !== document.documentElement.dataset.theme) {
            applyTheme(s.theme);
            setThemeState(s.theme);
          }
          try { localStorage.setItem(STORAGE_KEY, s.theme); } catch { /* ignore */ }
        }
      })
      .catch(() => { /* 服务未就绪或离线：维持首帧主题 */ });
    return () => { alive = false; };
  }, []);

  const setTheme = (t: Theme) => {
    applyTheme(t);
    setThemeState(t);
    try { localStorage.setItem(STORAGE_KEY, t); } catch { /* ignore */ }
    api.saveUiSettings(t).catch(() => { /* 保存失败不打断界面切换 */ });
  };

  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>;
}

export function useTheme() {
  return useContext(Ctx);
}
