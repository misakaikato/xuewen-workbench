// 编辑器更新广播：格式工具栏等订阅光标/文档变化刷新激活态，
// 替代「父组件每次光标移动 setState 触发整页重渲」的旧路径。
// 由编辑器唯一 updateListener 发出；无订阅者时为零开销。
import type { EditorView, ViewUpdate } from '@codemirror/view';

const subs = new Set<(u: ViewUpdate) => void>();

export function emitViewUpdate(u: ViewUpdate): void {
  for (const cb of subs) cb(u);
}

export function subscribeViewUpdates(view: EditorView, cb: (u: ViewUpdate) => void): () => void {
  const wrap = (u: ViewUpdate) => {
    if (u.view === view) cb(u);
  };
  subs.add(wrap);
  return () => {
    subs.delete(wrap);
  };
}
