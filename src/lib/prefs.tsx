// 阅读偏好：字体/字号/行距/段落间距/宽度/主题/代码字号。持久化到 localStorage，即时生效。
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export interface ReadingPrefs {
  font: 'serif' | 'sans' | 'mono';
  fontSize: number; // 14-32
  lineHeight: number; // 1.4-2.4
  paraSpacing: number; // 0-2 (em)
  width: number; // 560-1080 px
  theme: 'light' | 'dark';
  codeFontSize: number; // 12-20
}

export const DEFAULT_PREFS: ReadingPrefs = {
  font: 'serif',
  fontSize: 17,
  lineHeight: 1.85,
  paraSpacing: 0.9,
  width: 720,
  theme: 'light',
  codeFontSize: 14,
};

const FONT_STACKS: Record<ReadingPrefs['font'], string> = {
  serif: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "STSong", "SimSun", serif',
  sans: '"Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  mono: '"JetBrains Mono", "Sarasa Mono SC", Consolas, "Courier New", monospace',
};

const KEY = 'wb:reading-prefs';

function load(): ReadingPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_PREFS;
}

interface PrefsCtx {
  prefs: ReadingPrefs;
  update: (patch: Partial<ReadingPrefs>) => void;
  reset: () => void;
}

const Ctx = createContext<PrefsCtx>({ prefs: DEFAULT_PREFS, update: () => {}, reset: () => {} });

export function ReadingPrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<ReadingPrefs>(load);

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(prefs));
    const r = document.documentElement;
    r.style.setProperty('--rd-font', FONT_STACKS[prefs.font]);
    r.style.setProperty('--rd-size', prefs.fontSize + 'px');
    r.style.setProperty('--rd-line', String(prefs.lineHeight));
    r.style.setProperty('--rd-para', prefs.paraSpacing + 'em');
    r.style.setProperty('--rd-width', prefs.width + 'px');
    r.style.setProperty('--rd-code-size', prefs.codeFontSize + 'px');
    r.classList.toggle('dark', prefs.theme === 'dark');
  }, [prefs]);

  const update = (patch: Partial<ReadingPrefs>) => setPrefs((p) => ({ ...p, ...patch }));
  const reset = () => setPrefs(DEFAULT_PREFS);

  return <Ctx.Provider value={{ prefs, update, reset }}>{children}</Ctx.Provider>;
}

export function useReadingPrefs() {
  return useContext(Ctx);
}
