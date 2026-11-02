// HTML 语法高亮按需加载：只在打开 html 文档时取用，不进主包与页面 chunk
import type { Extension } from '@codemirror/state';

let cached: Promise<Extension> | null = null;

export function htmlLangAsync(): Promise<Extension> {
  cached ??= import('@codemirror/lang-html').then((m) => m.html());
  return cached;
}
