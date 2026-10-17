// API 访问层：统一错误处理
import type {
  ConfigResponse, FilePayload, ScanStatus, TreeNode, StatsResponse,
  SearchResult, RefResolution, Collection, MetadataMapping, TopicEntry, ConceptEntry, FileEntry,
} from './types';

export type DocType = '文章' | '讲稿' | '知乎';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
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
  getConfig: () => req<ConfigResponse>('/api/config'),
  testDir: (baseDir: string) =>
    req<{ ok: boolean; error?: string; readable?: boolean; writable?: boolean }>(
      '/api/config/test', json('POST', { baseDir })),
  saveConfig: (baseDir: string) =>
    req<ConfigResponse & { ok: boolean }>('/api/config', json('POST', { baseDir })),
  rescan: () => req<{ ok: boolean; status: ScanStatus }>('/api/rescan', json('POST')),
  status: () => req<ScanStatus>('/api/status'),
  tree: () => req<{ dsId: string; tree: TreeNode }>('/api/tree'),
  stats: () => req<StatsResponse>('/api/stats'),
  file: (path: string) => req<FilePayload>('/api/file?path=' + encodeURIComponent(path)),
  saveFile: (path: string, content: string, baseMtimeMs: number, dsId: string) =>
    req<{ ok: boolean; mtimeMs: number }>('/api/file', json('PUT', { path, content, baseMtimeMs, dsId })),
  saveAs: (path: string, content: string, dsId: string) =>
    req<{ ok: boolean }>('/api/file/save-as', json('POST', { path, content, dsId })),
  createEntry: (body: { dsId: string | null; dir: string; kind: 'md' | 'folder'; name: string; title?: string; docType?: DocType }) =>
    req<{ ok: boolean; kind: 'md' | 'folder'; path: string }>('/api/file/create', json('POST', body)),
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
  recents: () => req<{ recents: { path: string; at: number; exists: boolean; file: FileEntry | null }[] }>('/api/recents'),
  touchRecent: (path: string) => req('/api/recents', json('POST', { path })),
  pins: () => req<{ pins: { path: string; at: number; exists: boolean }[] }>('/api/pins'),
  pin: (path: string, action: 'add' | 'remove') => req('/api/pins', json('POST', { path, action })),
  collections: () => req<{ collections: Collection[] }>('/api/collections'),
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
  return '/api/file/raw?path=' + encodeURIComponent(path);
}
