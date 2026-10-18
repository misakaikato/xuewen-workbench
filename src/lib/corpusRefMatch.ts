// 语料引用命中（纯函数）：编辑器 corpusRefs 装饰的匹配语义，与旧 remarkRefs 对齐。
// - 正文中出现的完整文件名（含扩展名）→ ref:// 引用
// - 「集合名|文件名」（扩展名可省略）→ refc:// 集合范围引用
// 邻接文件名字符（BOUNDARY）时视为更长名称的一部分；集合引用的文件名部分
// 允许空格与中文，但不跨越标点与空白。
export interface CorpusRefNameEntry {
  name: string;
  base: string;
  path: string;
  ext: string;
  dir: string;
}

export interface CorpusRefHit {
  start: number;
  end: number;
  url: string;
  kind: 'file' | 'collection';
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BOUNDARY = 'A-Za-z0-9_.\\-/~';

export interface CorpusRefMatcher {
  find(value: string): CorpusRefHit[];
}

export function buildCorpusRefMatcher(
  names: { name: string }[],
  collections: { name: string }[]
): CorpusRefMatcher | null {
  const fileNames = [...new Set(names.map((n) => n.name))].sort((a, b) => b.length - a.length);
  const colNames = collections.map((c) => c.name).filter(Boolean);
  if (!fileNames.length && !colNames.length) return null;

  const fileAlt = fileNames.map(escapeRe).join('|');
  const fileRe = fileAlt
    ? new RegExp(`(?<![${BOUNDARY}])(${fileAlt})(?![${BOUNDARY}])`, 'g')
    : null;
  const colAlt = colNames.map(escapeRe).join('|');
  const colRe = colAlt
    ? new RegExp(`(?<![${BOUNDARY}])(${colAlt})\\|([^\\s|()\\[\\]<>"'，。；：、？！]+)`, 'g')
    : null;

  return {
    find(value: string): CorpusRefHit[] {
      const hits: CorpusRefHit[] = [];
      if (colRe) {
        colRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = colRe.exec(value))) {
          hits.push({
            start: m.index,
            end: m.index + m[0].length,
            url: 'refc://' + encodeURIComponent(m[1]) + '|' + encodeURIComponent(m[2]),
            kind: 'collection',
          });
        }
      }
      if (fileRe) {
        fileRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = fileRe.exec(value))) {
          const s = m.index;
          const e = s + m[0].length;
          // 不与「集合|文件名」命中重叠
          if (!hits.some((h) => s < h.end && e > h.start)) {
            hits.push({ start: s, end: e, url: 'ref://' + encodeURIComponent(m[0]), kind: 'file' });
          }
        }
      }
      return hits.sort((a, b) => a.start - b.start);
    },
  };
}
