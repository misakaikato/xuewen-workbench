// 文档标签页状态：按数据源持久化到 localStorage，URL 仍是激活标签的单一真相
// tabs 只记路径；标题渲染时从路径推导（文件名去扩展名）
const KEY = (dsId: string) => `wb:tabs:${dsId}`;
const MAX_TABS = 20;

export function loadTabs(dsId: string | null | undefined): string[] {
  if (!dsId) return [];
  try {
    const v = JSON.parse(localStorage.getItem(KEY(dsId)) || '[]');
    return Array.isArray(v) ? v.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

export function saveTabs(dsId: string | null | undefined, tabs: string[]): void {
  if (!dsId) return;
  try {
    localStorage.setItem(KEY(dsId), JSON.stringify(tabs.slice(-MAX_TABS)));
  } catch { /* 存储满时静默 */ }
}

/** 确保 path 在标签里。已存在则**位置不变**（点击只切换激活态，不重排）；不存在才追加到末尾 */
export function ensureTab(tabs: string[], path: string): string[] {
  if (tabs.includes(path)) return tabs;
  return [...tabs, path].slice(-MAX_TABS);
}

export function removeTab(tabs: string[], path: string): string[] {
  return tabs.filter((p) => p !== path);
}

/** 标签列表在阅读页之外被改写（条目改名 / 移动 / 删除）时派发，detail 为 { dsId } */
export const TABS_CHANGED_EVENT = 'wb-tabs-changed';

/** 条目改名 / 移动（to 为新路径）或删除（to 为 null）后同步已存标签：
 *  文件本身，目录时连同其下的文档；位置不变，去重；有变化才写回并派发 TABS_CHANGED_EVENT */
export function retargetTabs(dsId: string | null | undefined, from: string, to: string | null, isDir: boolean): void {
  if (!dsId) return;
  const prev = loadTabs(dsId);
  const hit = (p: string) => p === from || (isDir && p.startsWith(from + '/'));
  if (!prev.some(hit)) return;
  const next: string[] = [];
  for (const p of prev) {
    const q = hit(p) ? (to === null ? null : to + p.slice(from.length)) : p;
    if (q !== null && !next.includes(q)) next.push(q);
  }
  saveTabs(dsId, next);
  window.dispatchEvent(new CustomEvent(TABS_CHANGED_EVENT, { detail: { dsId } }));
}

export function tabTitle(path: string): string {
  const name = path.split('/').pop() || path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
