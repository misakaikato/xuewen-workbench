// YAML 头信息识别：首行是 `---`，前 100 行内以 `---` 或 `...` 收尾，中间每个非空行都像 YAML
// （键: 值 / - 列表项 / 缩进续行 / # 注释）。实时预览据此整块渲染为元数据框，目录扫描据此跳过。
import type { Text } from '@codemirror/state';

const MAX_LINES = 100;
const YAML_LINE = /^(\s*#.*|\s*-\s.*|\s+\S.*|[^\s:#][^:]*:(\s.*)?)$/;
const KEY_LINE = /^([^\s:#][^:]*):(\s.*)?$/;

export interface Frontmatter {
  from: number;
  to: number;
  /** 首尾分隔行之间的原始行 */
  lines: string[];
}

export function frontmatterRange(doc: Text): Frontmatter | null {
  if (doc.lines < 3 || doc.line(1).text.trimEnd() !== '---') return null;
  const lines: string[] = [];
  for (let n = 2; n <= Math.min(doc.lines, MAX_LINES); n++) {
    const text = doc.line(n).text;
    if (/^(---|\.\.\.)\s*$/.test(text)) {
      return lines.some((l) => l.trim()) ? { from: 0, to: doc.line(n).to, lines } : null;
    }
    if (text.trim() && !YAML_LINE.test(text)) return null;
    lines.push(text);
  }
  return null;
}

/** 「键: 值」行拆成键与值；其它行（列表项、续行、注释）返回 null */
export function frontmatterKeyValue(line: string): { key: string; value: string } | null {
  const m = KEY_LINE.exec(line);
  return m ? { key: m[1], value: (m[2] ?? '').trim() } : null;
}
