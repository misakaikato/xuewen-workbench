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
