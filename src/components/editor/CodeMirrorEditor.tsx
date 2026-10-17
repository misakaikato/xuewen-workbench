// 轻量 CodeMirror 6 挂载组件：不经 @uiw/react-codemirror 的受控 value 同步，
// 原因是它的 value 对比用 doc.toString()（恒以 \n 连接），CRLF 文档会被反复整段重置，
// 无法保证字节精确与“重命名跟随时不重置缓冲区”。这里改为：
// - 初始文本只在挂载时写入（换新文件由父组件换 key 重挂载）；
// - extensions 变化走 StateEffect.reconfigure（保留撤销历史）；
// - 文档变化回调直接给“精确文本”（state.sliceDoc，按当前分隔符还原）。
import { useEffect, useRef } from 'react';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

export interface CodeMirrorEditorProps {
  initialDoc: string;
  extensions: Extension[];
  onDocChanged?: (exactText: string) => void;
  onCreate?: (view: EditorView) => void;
  className?: string;
  ariaLabel?: string;
  /** 容器高度：'100%'（默认，内部滚动）或 'auto'（只读阅读态，随内容增长） */
  height?: string;
}

export function CodeMirrorEditor({ initialDoc, extensions, onDocChanged, onCreate, className, ariaLabel, height = '100%' }: CodeMirrorEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const changedRef = useRef(onDocChanged);
  changedRef.current = onDocChanged;
  // 文档变化监听：稳定扩展，建实例与每次 reconfigure 都带上。
  // （StateEffect.reconfigure 会整体替换扩展配置，只在建实例时加的监听会被丢弃，
  // 导致重命名/模式切换后脏状态、草稿自动保存与离开拦截全部失效。）
  const listenerExtRef = useRef(
    EditorView.updateListener.of((vu) => {
      if (vu.docChanged) changedRef.current?.(vu.state.sliceDoc(0));
    })
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [...extensions, listenerExtRef.current],
      }),
      parent: host,
    });
    viewRef.current = view;
    view.dom.setAttribute('aria-label', ariaLabel || '文档编辑器');
    onCreate?.(view);
    return () => {
      if (viewRef.current === view) viewRef.current = null;
      view.destroy();
    };
    // extensions 由下方 effect 走 reconfigure，避免重建实例
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const extRef = useRef(extensions);
  extRef.current = extensions;
  useEffect(() => {
    // 重配置扩展：不重建视图，撤销历史 / 光标 / 缓冲区全部保留；监听扩展必须随行
    viewRef.current?.dispatch({
      effects: StateEffect.reconfigure.of([...extRef.current, listenerExtRef.current]),
    });
  }, [extensions]);

  return <div ref={hostRef} className={className} style={{ height, overflow: 'hidden' }} />;
}
