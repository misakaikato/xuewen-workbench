// 行分隔符检测：保证编辑器字节精确往返（打开→不改→保存 与原文件逐字节一致）。
// 实现与后端共用一份（server/editorText.js），这里只做再导出，
// 避免前后端出现两份不同口径的检测逻辑。
export type LineSeparator = '\r\n' | '\n';
export { detectLineSeparator } from '../../../server/editorText.js';
