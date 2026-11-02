// 阅读偏好的数据定义与上下文：类型、默认值、持久化读取、Context 与 hook。
// Provider 组件在 prefs.tsx；本文件不放组件，供页面与 Provider 共用。
import { createContext, useContext } from 'react';

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

export const FONT_STACKS: Record<ReadingPrefs['font'], string> = {
  serif: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "STSong", "SimSun", serif',
  sans: '"Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  mono: '"JetBrains Mono", "Sarasa Mono SC", Consolas, "Courier New", monospace',
};

export const PREFS_KEY = 'wb:reading-prefs';

export function loadPrefs(): ReadingPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_PREFS;
}

interface PrefsCtx {
  prefs: ReadingPrefs;
  update: (patch: Partial<ReadingPrefs>) => void;
  reset: () => void;
}

export const PrefsCtx = createContext<PrefsCtx>({ prefs: DEFAULT_PREFS, update: () => {}, reset: () => {} });

export function useReadingPrefs() {
  return useContext(PrefsCtx);
}
