// 编辑草稿：按数据源 + 文件路径隔离存储在 localStorage
const key = (dsId: string, path: string) => `wb:draft:${dsId}:${path}`;

export interface Draft {
  content: string;
  savedAt: number;
}

export function saveDraft(dsId: string, path: string, content: string) {
  try {
    localStorage.setItem(key(dsId, path), JSON.stringify({ content, savedAt: Date.now() } satisfies Draft));
  } catch { /* 容量满时静默失败 */ }
}

export function loadDraft(dsId: string, path: string): Draft | null {
  try {
    const raw = localStorage.getItem(key(dsId, path));
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

export function clearDraft(dsId: string, path: string) {
  try {
    localStorage.removeItem(key(dsId, path));
  } catch { /* ignore */ }
}

// 重命名 / 移动后迁移草稿键：旧路径（或旧文件夹前缀下）的草稿搬到新路径
export function migrateDrafts(dsId: string, fromPrefix: string, toPrefix: string) {
  try {
    const prefix = `wb:draft:${dsId}:`;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) {
      const p = k.slice(prefix.length);
      if (p !== fromPrefix && !p.startsWith(fromPrefix + '/')) continue;
      const raw = localStorage.getItem(k);
      if (raw) localStorage.setItem(prefix + toPrefix + p.slice(fromPrefix.length), raw);
      localStorage.removeItem(k);
    }
  } catch { /* 容量满等异常不影响条目操作 */ }
}

// 阅读位置：按数据源 + 路径记录滚动位置
const posKey = (dsId: string, path: string) => `wb:readpos:${dsId}:${path}`;

export function saveReadPos(dsId: string, path: string, scrollY: number) {
  try {
    sessionStorage.setItem(posKey(dsId, path), String(Math.round(scrollY)));
  } catch { /* ignore */ }
}

export function loadReadPos(dsId: string, path: string): number {
  try {
    return Number(sessionStorage.getItem(posKey(dsId, path)) || 0);
  } catch {
    return 0;
  }
}
