// 行分隔符检测与编辑器文本归一：前后端共用一份（服务端内链偏移必须与前端
// CodeMirror 文档逐字符一致）。纯函数、无 Node 依赖，浏览器经 vite 直接打包同一份。

// 仅当文本含 \r\n 且不含任何「裸 \n / 裸 \r」时才判定为 CRLF 文档，否则一律按 \n 拆分。
export function detectLineSeparator(text) {
  if (!text.includes('\r\n')) return '\n';
  const stripped = text.split('\r\n').join('');
  return stripped.includes('\n') || stripped.includes('\r') ? '\n' : '\r\n';
}

// 先剥 BOM；纯 CRLF 文档把 \r\n 换成 \n（与 CodeMirror 行分隔符归一一致），
// 否则原样返回——孤立 \r 与混用文档里的 \r 都保留。
export function toEditorText(raw) {
  const text = String(raw).replace(/^\uFEFF/, '');
  return detectLineSeparator(text) === '\r\n' ? text.replace(/\r\n/g, '\n') : text;
}
