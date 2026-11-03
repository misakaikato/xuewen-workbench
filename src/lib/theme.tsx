// 界面设置 Provider：外观主题（A 宣纸 · 书卷 / B 现代极简 / C 夜读）与智能助手总开关。
// 服务端为权威持久化（Electron 端口会变、localStorage 按 origin 隔离），localStorage 仅作首帧主题防闪烁兜底；
// 助手开关只存服务端（ui-settings.agentEnabled），启动时读一次，设置页切换后经 setAgentEnabled 即时生效。
import { useCallback, useEffect, useState, type ReactNode } from 'react';
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
  const [agentEnabled, setAgentEnabledState] = useState<boolean | null>(null);

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
        setAgentEnabledState(s.agentEnabled === true);
      })
      .catch((e) => {
        if (!alive) return;
        // 服务未就绪或离线：维持首帧主题；助手按关闭处理，并说明原因
        setAgentEnabledState(false);
        notify('读取界面设置失败：' + errorMessage(e), { kind: 'error' });
      });
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

  // 关闭时后端先中止进行中的生成再返回，这里拿到结果才更新状态：入口在生成停止之后才隐藏
  const setAgentEnabled = useCallback(async (v: boolean) => {
    try {
      const saved = await api.saveUiSettings({ agentEnabled: v });
      setAgentEnabledState(saved.agentEnabled === true);
    } catch (e) {
      await api.getUiSettings().then((s) => setAgentEnabledState(s.agentEnabled === true)).catch(() => { /* 读也失败：维持原值 */ });
      throw e;
    }
  }, []);

  return (
    <ThemeCtx.Provider value={{ theme, setTheme, agentEnabled, setAgentEnabled }}>{children}</ThemeCtx.Provider>
  );
}
