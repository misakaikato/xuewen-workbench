// 外观主题：A 宣纸 · 书卷 / B 现代极简 / C 夜读。
// 服务端为权威持久化（Electron 端口会变、localStorage 按 origin 隔离），localStorage 仅作首帧防闪烁兜底。
import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { errorMessage, notify } from './notify';
import { applyTheme, isTheme, ThemeCtx, THEME_STORAGE_KEY, type Theme } from './theme-context';

// 首帧主题来自 <head> 内联防闪烁脚本写入的 data-theme
function readInitialTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return isTheme(t) ? t : 'A';
}

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
          try { localStorage.setItem(THEME_STORAGE_KEY, s.theme); } catch { /* ignore */ }
        }
      })
      .catch(() => { /* 服务未就绪或离线：维持首帧主题 */ });
    return () => { alive = false; };
  }, []);

  const setTheme = (t: Theme) => {
    applyTheme(t);
    setThemeState(t);
    try { localStorage.setItem(THEME_STORAGE_KEY, t); } catch { /* ignore */ }
    // 保存失败不回退当前界面，但要说明：下次启动会按服务端的旧主题对账
    api.saveUiSettings({ theme: t }).catch((e) =>
      notify('外观主题保存失败：' + errorMessage(e) + '（重启后可能恢复为原主题）', { kind: 'error' })
    );
  };

  return <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>;
}
