// 阅读偏好：字体/字号/行距/段落间距/宽度/主题/代码字号。持久化到 localStorage，即时生效。
// dark 类在此统一裁定：阅读偏好选深色，或外观主题为 C（夜读）时挂上，避免两处开关互相覆盖。
import { useEffect, useState, type ReactNode } from 'react';
import { useTheme } from './theme-context';
import { DEFAULT_PREFS, FONT_STACKS, loadPrefs, PREFS_KEY, PrefsCtx, type ReadingPrefs } from './reading-prefs';

export function ReadingPrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<ReadingPrefs>(loadPrefs);
  const { theme } = useTheme();

  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    const r = document.documentElement;
    r.style.setProperty('--rd-font', FONT_STACKS[prefs.font]);
    r.style.setProperty('--rd-size', prefs.fontSize + 'px');
    r.style.setProperty('--rd-line', String(prefs.lineHeight));
    r.style.setProperty('--rd-para', prefs.paraSpacing + 'em');
    r.style.setProperty('--rd-width', prefs.width + 'px');
    r.style.setProperty('--rd-code-size', prefs.codeFontSize + 'px');
    r.classList.toggle('dark', prefs.theme === 'dark' || theme === 'C');
  }, [prefs, theme]);

  const update = (patch: Partial<ReadingPrefs>) => setPrefs((p) => ({ ...p, ...patch }));
  const reset = () => setPrefs(DEFAULT_PREFS);

  return <PrefsCtx.Provider value={{ prefs, update, reset }}>{children}</PrefsCtx.Provider>;
}
