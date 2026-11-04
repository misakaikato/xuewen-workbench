// API 访问层：统一错误处理
import type {
  ConfigResponse, FilePayload, ScanStatus, TreeNode, StatsResponse, UpdateState,
  SearchResult, RefResolution, Collection, MetadataMapping, TopicEntry, ConceptEntry, FileEntry, LibraryInfo, IndexingProgress,
} from './types';
import type { Theme } from './theme-context';

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
  kind: 'auto' | 'wiki' | 'wiki-missing' | 'html';
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

export interface BacklinkSnippet {
  text: string;
  /**命中词在原文档中的 UTF-16 偏移（点击定位用） */
  offset: number;
  /**命中词在片段 text 内的精确区间（服务端按链接 from/to 拼出，非文本搜索） */
  hiFrom: number;
  hiTo: number;
  term: string;
}

export interface BacklinkEntry {
  path: string;
  title: string;
  count: number;
  kinds: string[];
  snippets: BacklinkSnippet[];
}

export interface LinkTerm {
  term: string;
  path: string;
  heading: string | null;
}

type EntryResult = { ok: boolean; kind: 'file' | 'folder'; oldPath?: string; path: string };

// ---------- 知识库作用域 ----------
// 当前前端实例作用的知识库 id；所有请求自动携带 ?ds=，切库后旧库响应被各页 dsId 守卫丢弃。
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

/** 界面设置（/api/ui-settings，服务端持久化）；agentEnabled 是智能助手总开关，缺省 false */
export interface UiSettings {
  theme: Theme;
  autoUpdate: boolean;
  notesDir: string;
  showMetaFiles: boolean;
  agentEnabled: boolean;
}

export const api = {
  getUiSettings: () => req<UiSettings>('/api/ui-settings'),
  // 用系统默认应用打开知识库外部的本地路径（文档内越库根链接，经用户确认后调用）
  openExternal: (path: string) => req<{ ok: boolean }>('/api/open-external', json('POST', { path })),
  saveUiSettings: (patch: Partial<UiSettings>) =>
    req<{ ok: boolean } & UiSettings>('/api/ui-settings', json('PUT', patch)),
  tags: () =>
    req<{ dsId: string; dir: string; tags: TagEntry[]; topicsMissing: boolean; errors: string[]; counts: { manual: number; ai: number } }>('/api/tags'),
  tagsDoc: (path: string) =>
    req<{ dsId: string; path: string; manual: string[]; ai: string[]; coreConcepts: string[]; mentioned: string[]; all: string[] }>('/api/tags/doc?path=' + encodeURIComponent(path)),
  concepts: () =>
    req<{ dsId: string; dir: string; concepts: ConceptItem[]; conceptsMissing: boolean; graphMissing: boolean; nodeCount: number; edgeCount: number; errors: string[] }>('/api/concepts'),
  conceptDetail: (name: string) =>
    req<{ concept: ConceptItem; neighbors: { rel: string; dir: 'in' | 'out'; other: string }[] }>('/api/concept?name=' + encodeURIComponent(name)),
  notesFor: (path: string) =>
    req<{ ok: boolean; notes: { notePath: string; count: number; latest: string | null }[] }>(
      '/api/notes/for?path=' + encodeURIComponent(path)),
  notesAppend: (payload: { sourcePath: string; quote?: string; note?: string }) =>
    req<{ ok: boolean; path: string }>('/api/notes/append', json('POST', payload)),
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
  updateCheck: () => req<UpdateState>('/api/update/check', json('POST')),
  updateDownload: () => req<UpdateState>('/api/update/download', json('POST')),
  updateCancel: () => req<UpdateState>('/api/update/cancel', json('POST')),
  // install 会在安装时杀死应用，请求可能中途断开——调用方需吞错
  updateInstall: () => req<{ ok: boolean }>('/api/update/install', json('POST')),
  openReleasePage: () => req<{ ok: boolean }>('/api/update/open-release', json('POST')),
  openInstaller: () => req<{ ok: boolean }>('/api/update/open-installer', json('POST')),
  diagnosticsState: () => req<{ pending: DiagnosticsIncident | null; logsDir: string }>('/api/diagnostics/state'),
  diagnosticsAck: () => req<{ ok: boolean }>('/api/diagnostics/ack', json('POST', {})),
  exportDiagnostics: () => req<{ ok: boolean; file: string }>('/api/diagnostics/export', json('POST', {})),
  status: () =>
    req<
      ScanStatus & {
        indexing?: IndexingProgress | null;
        indexError?: string | null;
        linksReady?: boolean;
        linksSeq?: number;
        libs?: Record<
          string,
          {
            scanning: boolean;
            watching: boolean;
            scannedAt: string | null;
            scanned?: number;
            indexing?: IndexingProgress | null;
            indexError?: string | null;
          }
        >;
        ragModel?: RagModelTask | null;
        ragIndex?: RagIndexTask | null;
      } & { update: UpdateState }
    >('/api/status'),
  tree: () => req<{ dsId: string; tree: TreeNode }>('/api/tree'),
  stats: () => req<StatsResponse>('/api/stats'),
  file: (path: string) => req<FilePayload>('/api/file?path=' + encodeURIComponent(path)),
  fileStat: (path: string) => req<{ dsId: string; path: string; mtimeMs: number; size: number }>('/api/file/stat?path=' + encodeURIComponent(path)),
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
  linkCounts: () => req<{ dsId: string; ready: boolean; counts: Record<string, number> }>('/api/links/counts'),
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

  // ---- RAG ----
  ragStatus: () =>
    req<RagStatus>('/api/rag/status'),
  ragModelDownload: (force = false) =>
    req<{ ok: boolean; error?: string; started?: boolean; already?: boolean; ready?: boolean }>('/api/rag/model/download', json('POST', { force })),
  ragModelImport: (dir: string) => req<{ ok: boolean; error?: string; started?: boolean; kind?: string }>('/api/rag/model/import', json('POST', { dir })),
  ragModelCancel: () => req<{ ok: boolean; error?: string }>('/api/rag/model/cancel', json('POST', {})),
  ragIndexBuild: (rebuild: boolean) => req<{ ok: boolean }>('/api/rag/index/build', json('POST', { rebuild })),
  ragIndexPause: () => req<{ ok: boolean }>('/api/rag/index/pause', json('POST', {})),
  ragSearch: (q: string, limit = 50) => req<RagSearchResponse>('/api/rag/search', json('POST', { q, limit })),
  ragConfigGet: () => req<{ dsId: string; config: RagConfig }>('/api/rag/config'),
  ragConfigSave: (patch: Partial<RagConfig>) => req<{ ok: boolean; config: RagConfig }>('/api/rag/config', json('PUT', patch)),
  ragLlmGet: () => req<RagLlmConfig>('/api/rag/llm'),
  ragLlmSave: (cfg: Partial<RagLlmConfig>) => req<{ ok: boolean }>('/api/rag/llm', json('PUT', cfg)),
  ragLlmTest: () => req<{ ok: boolean; models?: string[]; error?: string }>('/api/rag/llm/test', json('POST', {})),

  // ---- 智能助手（pi agent） ----
  agentStatus: () => req<AgentStatus>('/api/agent/status'),
  agentNewSession: () => req<{ id: string; title: string }>('/api/agent/session', json('POST', {})),
  agentSession: (id: string) => req<{ id: string; title: string; messages: AgentMessage[] }>('/api/agent/session/' + encodeURIComponent(id)),
  agentDeleteSession: (id: string) => req<{ ok: boolean }>('/api/agent/session/' + encodeURIComponent(id), json('DELETE', {})),
  agentAbort: (id: string) => req<{ ok: boolean }>('/api/agent/abort', json('POST', { sessionId: id })),
  agentFork: (id: string, uptoIndex: number) => req<{ id: string; title: string }>('/api/agent/fork', json('POST', { sessionId: id, uptoIndex })),
  agentExport: (id: string) => '/api/agent/export/' + encodeURIComponent(id),
  agentModels: (pending?: { baseUrl?: string; apiKey?: string }) =>
    req<{ ok: boolean; models: string[]; status: number; url: string; error: string }>('/api/agent/models', json('POST', pending || {})),
  agentSettings: (patch: Partial<AgentSettingsPatch>) => req<AgentStatus>('/api/agent/settings', json('PUT', patch)),
  agentEditMessage: (id: string, idx: number, text: string) => req<{ ok: boolean }>(`/api/agent/session/${encodeURIComponent(id)}/message/${idx}`, json('PUT', { text })),
  agentDeleteMessage: (id: string, idx: number) => req<{ ok: boolean }>(`/api/agent/session/${encodeURIComponent(id)}/message/${idx}`, json('DELETE', {})),
  agentConfirm: (confirmId: string, approved: boolean) => req<{ ok: boolean }>('/api/agent/confirm', json('POST', { id: confirmId, approved })),

  // ---- 记忆管理 ----
  memoryGet: (scope: string) => req<MemoryPayload>('/api/agent/memory?scope=' + encodeURIComponent(scope)),
  memoryAdd: (body: { scope: string; fact: string; kind?: string; pinned?: boolean }) => req<{ ok: boolean; item: MemoryFact }>('/api/agent/memory', json('POST', body)),
  memoryUpdate: (id: string, body: { scope: string; fact?: string; pinned?: boolean }) => req<{ ok: boolean }>('/api/agent/memory/' + encodeURIComponent(id), json('PUT', body)),
  memoryDelete: (id: string, scope: string) => req<{ ok: boolean; removed: number }>('/api/agent/memory/' + encodeURIComponent(id) + '?scope=' + encodeURIComponent(scope), json('DELETE', {})),
  memoryConsolidate: (scope: string) => req<{ ok: boolean; summaryChars: number; kept: number; dropped: number }>('/api/agent/memory/consolidate', json('POST', { scope })),

  // ---- 对话文件夹 ----
  folderCreate: (name: string) => req<AgentFolder>('/api/agent/folder', json('POST', { name })),
  folderRename: (id: string, name: string) => req<AgentFolder>('/api/agent/folder/' + encodeURIComponent(id), json('PUT', { name })),
  folderDelete: (id: string) => req<{ ok: boolean }>('/api/agent/folder/' + encodeURIComponent(id), json('DELETE', {})),
  convMove: (convId: string, folderId: string | null) => req<{ ok: boolean }>(`/api/agent/session/${encodeURIComponent(convId)}/folder`, json('PUT', { folderId })),

  // ---- Agent 定义 ----
  agentsMdGet: () => req<{ content: string; path: string }>('/api/agent/agents-md'),
  agentsMdSave: (content: string) => req<{ ok: boolean }>('/api/agent/agents-md', json('PUT', { content })),
};

export interface RagConfig {
  chunk: { maxChars: number; jsonValueLimit: number; headingContext: boolean; fileNameContext: boolean; hardSplitOversize: boolean };
  embed: { maxLength: number };
  search: { topN: number; rrfK: number; rrfMin: number; cosFloor: number; cosSigma: number; semanticWeight: number };
}

export interface AgentFailure {
  kind: string;
  title: string;
  message: string;
  details?: string;
}

export interface TagEntry {
  tag: string;
  count: number;
  files: { path: string; title: string; source: 'manual' | 'ai' }[];
  source: 'manual' | 'ai' | 'mixed';
}

export interface ConceptItem {
  name: string;
  aliases: string[];
  type: string;
  def: string;
  refs: string[];
  related: string[];
  status: 'machine' | 'confirmed';
  source_hash: string | null;
}

export interface MemoryFact {
  id: string;
  fact: string;
  kind: 'preference' | 'knowledge' | 'convention';
  pinned: boolean;
  source: string | null;
  at: string;
}

export interface MemoryPayload {
  scope: string;
  dsId: string | null;
  facts: MemoryFact[];
  summary: string;
  stats: Record<string, { facts: number; pinned: number; hasSummary: boolean; summaryChars: number }>;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  text: string;
  tools?: { name: string; args?: unknown; summary?: string; isError?: boolean; durationMs?: number }[];
  thinking?: string;
  failure?: AgentFailure;
  /** 生成被中断（退出应用、崩溃）后从进行中记录恢复的半截回复 */
  interrupted?: boolean;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compactions?: { reason: string; tokensBefore: number | null; tokensAfter: number | null; aborted: boolean; error: string | null; at: string }[];
  at?: string;
}

export interface AgentSettingsPatch {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  enabled?: boolean;
  mode?: 'auto' | 'confirm' | 'readonly';
}

export interface AgentFolder {
  id: string;
  name: string;
  dsId: string;
  order: number;
}

export interface AgentStatus {
  endpoint: { baseUrl: string; model: string; ready: boolean; enabled: boolean; thinkingLevel?: string };
  mode?: 'auto' | 'confirm' | 'readonly';
  agentDir: string;
  skills: string[];
  mcp?: { name: string; type: string; url?: string; enabled: boolean }[];
  tools?: string[];
  conversations: { id: string; title: string; updatedAt: string; busy?: boolean; folderId?: string | null }[];
  folders?: AgentFolder[];
}

export type RagModelPhase = 'env-extract' | 'env-install' | 'probe' | 'download' | 'verify' | 'copy';

export interface RagModelProgress {
  file: string;
  bytes: number; // 当前文件已处理字节
  total: number; // 当前文件总量（未知为 0）
  done: number; // 已完成文件数
  files: number; // 总文件数
  host: string;
  attempt: number;
  speedBps: number;
  phase: RagModelPhase | '';
  phaseDetail: string; // 给人看的一句话（如「安装依赖 3/21」）
  overallBytes: number; // 已知总量的累计已处理字节
  overallTotal: number; // 已知文件总大小（未开始的文件未知时不计入）
  percent: number | null; // 后端算好的总体百分比（无法计量时 null）
  estimated: boolean; // true=按文件数折算的估算值
  etaSeconds: number | null;
  startedAt: number | null;
}

/** 阶段能否按字节计量：只有下载/复制/校验有量可算，解压/装依赖/探测没有 */
export const measurablePhase = (p: RagModelProgress) => ['download', 'copy', 'verify'].includes(p.phase) && p.percent != null;

/** 进行中的模型下载/导入任务（/api/status 全局带出，不分知识库） */
export interface RagModelTask {
  state: 'downloading' | 'importing';
  progress: RagModelProgress;
}

export interface RagRuntimeStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  phase: 'env' | 'start' | 'warmup' | null;
  startedAt: number | null;
  error: string | null;
}

export interface RagModelStatus {
  state: 'missing' | 'downloading' | 'importing' | 'ready' | 'error';
  backend: 'mock' | 'onnx' | 'mlx' | string;
  ep: string | null; // Windows 实际执行设备（dml / cpu），其他平台 null
  id: string;
  dim: number;
  sha: string | null;
  progress: RagModelProgress | null;
  canCancel: boolean;
  runtime: RagRuntimeStatus;
  error: string | null;
}

/** 当前知识库进行中的 RAG 索引构建（/api/status 带出） */
export interface RagIndexTask {
  state: 'building' | 'pausing';
  phase: string;
  done: number;
  total: number;
}

export interface RagIndexStatus {
  state: 'none' | 'building' | 'pausing' | 'paused' | 'ready' | 'error' | 'stale';
  phase: string; // 等待文本索引 | 清理旧索引 | 切块 | 嵌入 | 加载模型 | 完成
  done: number;
  total: number;
  currentFile: string | null;
  fileChunksDone: number;
  fileChunksTotal: number;
  chunksPerSec: number | null;
  etaSeconds: number | null;
  clearing: { done: number; total: number } | null;
  files: number;
  filesDone: number;
  chunks: number;
  vecs: number;
  dbBytes: number;
  updatedAt: number | null;
  error: string | null;
  configChanged?: boolean;
  ftsError?: string | null;
}

export interface RagStatus {
  dsId: string;
  model: RagModelStatus;
  index: RagIndexStatus;
  llm: RagLlmConfig;
}

export interface RagLlmConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface RagSearchResponse {
  dsId: string;
  hits: {
    path: string;
    name: string;
    headingPath: string;
    ordinal: number;
    kind: string;
    snippet: string;
    location?: { text: string; occurrence: number };
    score: number;
    bm25: boolean;
    cos: number | null;
  }[];
  total?: number; // 融合命中总数（截断显示前）
  candidates?: { fts: number; cos: number; fused: number };
  reason?: string | null;
  took: number;
  backend?: string;
}

export interface DiagnosticsIncident {
  kind: string;
  at: string;
  detail?: unknown;
}

export function rawFileUrl(path: string) {
  return withDs('/api/file/raw?path=' + encodeURIComponent(path));
}
