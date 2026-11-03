// 大文档的重活（JSON.parse、TXT 分段）推迟到加载态首帧绘制之后再做：
// 返回 false 时调用方先渲染加载态；下一帧回调（rAF）之后再经 setTimeout(0) 落到绘制完成后，才返回 true。
// 主线程随后忙于解析时，CSS 转圈动画仍由合成器继续转。
// 窗口隐藏时帧回调会暂停，rAF 与 50ms 定时器先到先用，内容不会停在加载态。
import { useEffect, useState } from 'react';

/** 超过这个字符数的文档才推迟（小文档直接渲染，不闪加载态） */
export const LARGE_DOC_CHARS = 256 * 1024;

export function useAfterPaint(key: unknown, defer: boolean): boolean {
  const [readyFor, setReadyFor] = useState<unknown>(undefined);
  useEffect(() => {
    if (!defer) return;
    let fired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      if (fired) return;
      fired = true;
      timer = setTimeout(() => setReadyFor(key), 0);
    };
    const raf = requestAnimationFrame(go);
    const backup = setTimeout(go, 50);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(backup);
      if (timer) clearTimeout(timer);
    };
  }, [key, defer]);
  return !defer || Object.is(readyFor, key);
}
