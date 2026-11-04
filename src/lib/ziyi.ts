// 字义库状态的单一来源：模块级快照 + useSyncExternalStore。启动时读一次 /api/ziyi/status，
// 导入、移除、新建、删除后调用 refreshZiyiStatus 刷新；顶栏、阅读页、设置页都从这里读是否已安装。
import { useSyncExternalStore } from 'react';
import { api, type ZiyiStatus } from './api';

let status: ZiyiStatus | null = null; // null = 尚未读到，按未安装处理
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();

function emit() {
  for (const fn of subs) fn();
}

export function refreshZiyiStatus(): Promise<void> {
  loading = api.ziyiStatus()
    .then((s) => { status = s; emit(); })
    .catch(() => { /* 读不到：维持原值，入口按上次状态显示 */ });
  return loading;
}

function subscribe(fn: () => void) {
  subs.add(fn);
  if (!loading) void refreshZiyiStatus();
  return () => { subs.delete(fn); };
}

export function useZiyiStatus(): ZiyiStatus | null {
  return useSyncExternalStore(subscribe, () => status);
}

/** 是否已导入字义库（读取完成前为 false） */
export function useZiyiInstalled(): boolean {
  return useZiyiStatus()?.installed === true;
}

/** 字义库页地址 */
export const ziyiHref = (han?: string) => '/ziyi' + (han ? '?han=' + encodeURIComponent(han) : '');

/** 是否为汉字（含扩展区与兼容区）；与后端 lookup 的口径一致 */
export const isHanChar = (ch: string) => /\p{Script=Han}/u.test(ch);

/** 视口坐标下鼠标正压着的那个字（按码点，含代理对）；落在字与字的空隙或非文本上返回 null */
export function charAtPoint(x: number, y: number): string | null {
  const caret = document.caretRangeFromPoint?.(x, y);
  const node = caret?.startContainer;
  if (!caret || !node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent || '';
  // 光标落在字的左半或右半，分别对应 offset 与 offset-1；代理对再各退一位
  for (const i of [caret.startOffset, caret.startOffset - 1, caret.startOffset - 2]) {
    if (i < 0 || i >= text.length) continue;
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) continue; // 代理对的后半
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const r = document.createRange();
    r.setStart(node, i);
    r.setEnd(node, i + ch.length);
    const b = r.getBoundingClientRect();
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return ch;
  }
  return null;
}
