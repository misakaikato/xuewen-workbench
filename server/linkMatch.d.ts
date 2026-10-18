// server/linkMatch.js 的类型声明（服务端为纯 JS，浏览器侧经 vite 直接打包同一份文件；
// TS 按 .js → .d.ts 回退解析本文件）
export interface AutoIndexEntry {
  norm: string;
  len: number;
  isLatin: boolean;
  term: string | null;
  targets: { path: string; heading?: string | null }[];
  /** 屏蔽/歧义占位条目：仅参与最长匹配整体消费，永不链出（byNorm 不收） */
  blocked?: boolean;
}
export interface AutoIndex {
  byChar: Map<string, AutoIndexEntry[]>;
  byNorm: Map<string, AutoIndexEntry>;
  ambiguous: Set<string>;
}
export interface VocabEntry {
  term: string;
  path: string;
  heading?: string | null;
  kind: 'title' | 'alias' | 'heading';
}
export interface ExtractedLink {
  from: number;
  to: number;
  term: string;
  norm: string;
  target: { path: string; heading?: string | null };
}
export interface WikiLinkSpan {
  from: number;
  to: number;
  name: string;
  heading: string | null;
  display: string | null;
  raw: string;
}
export declare function normalizeChar(ch: string): string;
export declare function normalizeText(s: string): string;
export declare function isTermLike(name: string | null | undefined): boolean;
export declare function buildAutoIndex(entries: VocabEntry[], blocklist?: string[]): AutoIndex;
export declare function computeSkipRanges(text: string): [number, number][];
export declare function computeSectionStarts(text: string): number[];
export declare function extractLinks(
  text: string,
  autoIndex: AutoIndex | null,
  opts?: { selfPath?: string | null }
): ExtractedLink[];
export declare function extractWikilinks(text: string): WikiLinkSpan[];
export declare function wikiNameAt(text: string, pos: number): { name: string; from: number } | null;
