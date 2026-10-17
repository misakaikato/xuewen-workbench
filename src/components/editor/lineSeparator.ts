// 行分隔符检测：保证编辑器字节精确往返（打开→不改→保存 与原文件逐字节一致）。
// CodeMirror 默认把 \r\n、\n、\r 等都当作换行拆分；显式设置 lineSeparator 后只按该分隔符拆分，
// 其余字符（如混入的孤立 \r）作为普通字符保留在行内，doc 序列化（sliceDoc）时原样还原。

export type LineSeparator = '\r\n' | '\n';

// 仅当文本含 \r\n 且不含任何“裸 \n / 裸 \r”时才判定为 CRLF 文档，否则一律按 \n 拆分
export function detectLineSeparator(text: string): LineSeparator {
  if (!text.includes('\r\n')) return '\n';
  const stripped = text.split('\r\n').join('');
  return stripped.includes('\n') || stripped.includes('\r') ? '\n' : '\r\n';
}
