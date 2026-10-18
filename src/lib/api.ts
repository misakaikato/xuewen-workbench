// API 访问层：统一错误处理
import type {
  ConfigResponse, FilePayload, ScanStatus, TreeNode, StatsResponse,
  SearchResult, RefResolution, Collection, MetadataMapping, TopicEntry, ConceptEntry, FileEntry, LibraryInfo,
} from './types';
import type { Theme } from './theme';

export type DocType = '文章' | '讲稿' | '知乎';

export interface MetaIssue {
  kind: 'orphan' | 'moved' | 'duplicateId' | 'invalid';
  message: string;
  sidecar?: string;
  sidecars?: string[];
  target?: string;
  id?: string | null;
  candidates?: string[];
}

export interface MetaImportItem {
  line: number;
  path: string;
  action: 'create' | 'update' | 'skip';
  fields?: Record<string, unknown>; // 新建：拟定字段；更新：仅变化字段 {field:{from,to}}
  reason?: string;
  confidence?: Record<string, number>;
  notes?: string;
}

export interface MetaImportSummary {
  lines: number;
  valid: number;
  errors: number;
  create: number;
  update: number;
  skip: number;
  written?: number; // 仅 apply
}

export interface MetaImportResponse {
  dsId: string | null;
  mode: 'preview' | 'apply';
  overwrite: boolean;
  summary: MetaImportSummary;
  items: MetaImportItem[];
  errors: { line: number; path?: string; error: string }[];
}

// ---------- 自动内链（词条）与反向链接 ----------

export interface DocLink {
  from: number;
  to: number;
  term: string;
  norm?: string;
  kind: 'auto' | 'wiki' | 'wiki-missing';
  display: string | null;
  target: { path: string; heading?: string | null } | null;
  candidates?: string[];
  ignored?: boolean;
}

export interface LinksStatus {
  ready: boolean;
  building: boolean;
  buildSeq: number;
  files: number;
  terms: number;
  links: number;
  lastFullMs: number;
  lastUpdateMs: number;
  ignoredCount?: number;
}

export interface BacklinkEntry {
  path: string;
  title: string;
  count: number;
  kinds: string[];
  snippets: { text: string; offset: number; term: string }[];
}

export interface LinkTerm {
  term: string;
  path: string;
  heading: string | null;
}

type EntryResult = { ok: boolean; kind: 'file' | 'folder'; oldPath?: string; path: string };

// ---------- 资料库作用域 ----------
// 当前前端实例作用的资料库 id；所有请求自动携带 ?ds=，切库后旧库响应被各页 dsId 守卫丢弃。
let scopeDs: string | null = null;

export function setApiScope(ds: string | null) {
  scopeDs = ds;
}

export function getApiScope() {
  return scopeDs;
}

function withDs(url: string) {
  if (!scopeDs) return url;
  return url + (url.includes('?') ? '&' : '?') + 'ds=' + encodeURIComponent(scopeDs);
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withDs(url), init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `请求失败 (${res.status})`) as Error & Record<string, unknown>;
    Object.assign(err, body, { status: res.status });
    throw err;
  }
  return body as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  getUiSettings: () => req<{ theme: Theme }>('/api/ui-settings'),
  saveUiSettings: (theme: Theme) =>
    req<{ ok: boolean; theme: Theme }>('/api/ui-settings', json('PUT', { theme })),
  getConfig: () => req<ConfigResponse>('/api/config'),
  testDir: (baseDir: string) =>
    req<{ ok: boolean; error?: string; readable?: boolean; writable?: boolean }>(
      '/api/config/test', json('POST', { baseDir })),
  saveConfig: (baseDir: string) =>
    req<ConfigResponse & { ok: boolean }>('/api/config', json('POST', { baseDir })),
  libraries: () => req<{ libraries: LibraryInfo[]; activeId: string | null }>('/api/libraries'),
  activateLibrary: (ds: string) =>
    req<{ ok: boolean } & ConfigResponse>('/api/library/activate', json('POST', { ds })),
  removeLibrary: (ds: string) =>
    req<{ ok: boolean; activeId: string | null; libraries: LibraryInfo[] }>('/api/library/remove', json('POST', { ds })),
  rescan: () => req<{ ok: boolean; status: ScanStatus }>('/api/rescan', json('POST')),
  status: () => req<ScanStatus & { libs?: Record<string, { scanning: boolean; watching: boolean; scannedAt: string | null }> }>('/api/status'),
  tree: () => req<{ dsId: string; tree: TreeNode }>('/api/tree'),
  stats: () => req<StatsResponse>('/api/stats'),
  file: (path: string) => req<FilePayload>('/api/file?path=' + encodeURIComponent(path)),
  saveFile: (path: string, content: string, baseMtimeMs: number, dsId: string) =>
    req<{ ok: boolean; mtimeMs: number }>('/api/file', json('PUT', { path, content, baseMtimeMs, dsId })),
  saveAs: (path: string, content: string, dsId: string) =>
    req<{ ok: boolean }>('/api/file/save-as', json('POST', { path, content, dsId })),
  createEntry: (body: { dsId: string | null; dir: string; kind: 'md' | 'folder'; name: string; title?: string; docType?: DocType; bodyTemplate?: 'blank' | 'title' | 'title-date' }) =>
    req<{ ok: boolean; kind: 'md' | 'folder'; path: string }>('/api/file/create', json('POST', body)),
  renameEntry: (body: { dsId: string | null; path: string; newName: string }) =>
    req<EntryResult & { titleUpdated: boolean }>('/api/file/rename', json('POST', body)),
  moveEntry: (body: { dsId: string | null; path: string; targetDir: string }) =>
    req<EntryResult>('/api/file/move', json('POST', body)),
  deleteEntry: (body: { dsId: string | null; path: string }) =>
    req<EntryResult & { trashedTo: 'os' | 'local'; trashPath: string | null }>('/api/file/delete', json('POST', body)),
  duplicateEntry: (body: { dsId: string | null; path: string; targetDir?: string }) =>
    req<{ ok: boolean; path: string; kind: string }>('/api/file/duplicate', json('POST', body)),
  linkCounts: () => req<{ dsId: string; counts: Record<string, number> }>('/api/links/counts'),
  metaIssues: () => req<{ dsId: string; total: number; issues: MetaIssue[] }>('/api/meta/issues'),
  importMeta: (body: { dsId: string | null; jsonl: string; mode: 'preview' | 'apply'; overwrite?: boolean }) =>
    req<MetaImportResponse>('/api/meta/import', json('POST', body)),
  search: (q: string, opts: { types?: string[]; dir?: string; exclude?: string[] } = {}) => {
    const p = new URLSearchParams({ q });
    if (opts.types?.length) p.set('types', opts.types.join(','));
    if (opts.dir) p.set('dir', opts.dir);
    if (opts.exclude?.length) p.set('exclude', opts.exclude.join(','));
    return req<{ results: SearchResult[]; total: number; terms: string[] }>('/api/search?' + p);
  },
  resolveRef: (name: string, collection?: string | null) => {
    const p = new URLSearchParams({ name });
    if (collection) p.set('collection', collection);
    return req<RefResolution>('/api/refs/resolve?' + p);
  },
  refNames: () =>
    req<{ dsId: string; names: { name: string; base: string; path: string; ext: string; dir: string }[]; collections: Collection[] }>(
      '/api/refs/names'),
  backlinks: (path: string) =>
    req<{ backlinks: FileEntry[] }>('/api/backlinks?path=' + encodeURIComponent(path)),
  linksDoc: (path: string) =>
    req<{ dsId: string; path: string; links: DocLink[] } & LinksStatus>('/api/links/doc?path=' + encodeURIComponent(path)),
  linksBacklinks: (path: string) =>
    req<{ dsId: string; path: string; backlinks: BacklinkEntry[] } & LinksStatus>('/api/links/backlinks?path=' + encodeURIComponent(path)),
  linksTerms: (q: string) =>
    req<{ terms: LinkTerm[] } & LinksStatus>('/api/links/terms?q=' + encodeURIComponent(q)),
  linksPreview: (path: string) =>
    req<{ path: string; title: string; excerpt: string }>('/api/links/preview?path=' + encodeURIComponent(path)),
  linksStatus: () => req<LinksStatus & { dsId?: string }>('/api/links/status'),
  linksIgnore: (body: { path: string; term: string; targetPath: string; ignore: boolean } | { clearAll: true }) =>
    req<{ ok: boolean; ignored?: boolean; ignoredCount: number }>('/api/links/ignore', json('POST', body)),
  linksBlocklist: () =>
    req<{ dsId: string; terms: string[]; ignoredCount: number }>('/api/links/blocklist'),
  saveLinksBlocklist: (terms: string[]) =>
    req<{ ok: boolean; terms: string[]; ignoredCount: number }>('/api/links/blocklist', json('PUT', { terms })),
  recents: () => req<{ recents: { path: string; at: number; exists: boolean; file: FileEntry | null }[] }>('/api/recents'),
  touchRecent: (path: string) => req('/api/recents', json('POST', { path })),
  pins: () => req<{ pins: { path: string; at: number; exists: boolean }[] }>('/api/pins'),
  pin: (path: string, action: 'add' | 'remove') => req('/api/pins', json('POST', { path, action })),
  collections: () => req<{ collections: Collection[] }>('/api/collections'),
  revealInSystem: (path: string) => req<{ ok: boolean; revealed: string }>('/api/reveal', json('POST', { path })),
  saveCollections: (collections: Collection[]) =>
    req('/api/collections', json('PUT', { collections })),
  metadata: () => req<{ mappings: MetadataMapping[] }>('/api/metadata'),
  saveMetadata: (mappings: MetadataMapping[]) => req('/api/metadata', json('PUT', { mappings })),
  inspectMetadata: (path: string) =>
    req<{ ok: boolean; shape: unknown; sample: string }>('/api/metadata/inspect?path=' + encodeURIComponent(path)),
  topics: () =>
    req<{ configured: boolean; topics: TopicEntry[]; concepts: ConceptEntry[]; errors: { file: string; reason: string }[] }>(
      '/api/topics'),
  wordCapability: () =>
    req<{ docx: { supported: boolean }; doc: { supported: boolean; limitation?: string } }>('/api/word-capability'),
};

export function rawFileUrl(path: string) {
  return withDs('/api/file/raw?path=' + encodeURIComponent(path));
}
