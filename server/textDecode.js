// 文本解码单一真相源：所有读正文的地方都走这里，避免非 UTF-8 原文被当 UTF-8 读坏。
// 识别 UTF-8（含 BOM）/ UTF-16LE/BE（BOM）/ GB18030；lossless 仅 UTF-8 为 true。
// 非 UTF-8 一律只读展示，不写回（无内置 GBK/UTF-16 编码器，也不引入 iconv-lite）。
export function decodeText(buf) {
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { content: buf.subarray(3).toString('utf8'), bom: true, encoding: 'utf-8', lossless: true };
  }
  // UTF-16 LE / BE BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { content: new TextDecoder('utf-16le').decode(buf.subarray(2)), bom: false, encoding: 'utf-16le', lossless: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { content: new TextDecoder('utf-16be').decode(buf.subarray(2)), bom: false, encoding: 'utf-16be', lossless: false };
  }
  // 严格 UTF-8 成功即按 UTF-8；失败回落 GB18030（兼容 GBK，非 fatal）
  try {
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(buf), bom: false, encoding: 'utf-8', lossless: true };
  } catch {
    return { content: new TextDecoder('gb18030').decode(buf), bom: false, encoding: 'gb18030', lossless: false };
  }
}

// 编码显示名（只读理由文案用）
export function encodingLabel(encoding) {
  if (encoding === 'gb18030') return 'GBK';
  if (encoding === 'utf-16le' || encoding === 'utf-16be') return 'UTF-16';
  return 'UTF-8';
}
