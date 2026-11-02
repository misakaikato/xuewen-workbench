// server/editorText.js 的类型声明（服务端为纯 JS，浏览器侧经 vite 直接打包同一份文件；
// TS 按 .js → .d.ts 回退解析本文件）
export type LineSeparator = '\r\n' | '\n';
export declare function detectLineSeparator(text: string): LineSeparator;
export declare function toEditorText(raw: string): string;
