// Word 预览 HTML 净化：与 HtmlReader 同配置；mammoth 的 data: 图片 DOMPurify 默认保留。
import DOMPurify from 'dompurify';

export function sanitizeWordHtml(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
