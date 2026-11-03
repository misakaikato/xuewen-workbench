// 共享类型定义
export interface FileEntry {
  path: string; // 规范化相对路径（posix 分隔符）
  name: string;
  base: string;
  ext: '.md' | '.json' | '.txt' | '.doc' | '.docx' | '.html' | '.htm';
  dir: string;
  size: number;
  mtimeMs: number;
}

export interface TreeNode {
  name: string;
  path: string;
  dirs: TreeNode[];
  files: FileEntry[];
}

export interface ScanStatus {
  dsId: string | null;
  baseDir: string | null;
  scanning: boolean;
  watching: boolean;
  generation: number;
  scannedAt: string | null;
  counts: { files: number; dirs: number; md: number; json: number; txt: number; doc: number; docx: number; html: number } | null;
  dirErrors: { path: string; reason: string }[];
  fileErrors: { path: string; reason: string }[];
}

export interface UpdateProgress {
  percent: number; // 0-100
  transferred: number;
  total: number;
  bytesPerSecond: number;
  etaSeconds: number | null; // 剩余字节 ÷ 最近速度；速度为 0 时 null
}

export type UpdatePhase = 'preparing' | 'copying' | 'verifying' | 'restarting' | 'launching-installer';

export interface UpdateLastInstall {
  result: 'updated' | 'failed';
  fromVersion: string;
  toVersion: string;
  error?: string;
  dmgPath?: string;
}

// 应用更新快照（GET /api/update/state；也随 /api/status 返回），镜像 electron/updater.js 的状态机
export interface UpdateState {
  enabled: boolean;
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'ready' | 'installing' | 'error';
  currentVersion: string | null;
  info: { version: string | null; releaseDate: string | null; notes: string | null } | null;
  progress: UpdateProgress | null;
  error: string | null;
  /** installing 期间的阶段 */
  phase: UpdatePhase | null;
  /** 下载中可取消 */
  canCancel: boolean;
  /** mac 预检结果：auto=退出后自动替换重启；Windows 恒为 auto */
  installMode: 'auto' | 'manual' | null;
  /** installMode 为 manual 时的原因（枚举：app-translocation / on-dmg-volume / dir-not-writable / bundle-not-writable / prepare-failed） */
  installModeReason: string | null;
  /** 本次启动时消费的上次安装结果（提示一次后由前端忽略） */
  lastInstall: UpdateLastInstall | null;
}

export interface ConfigResponse {
  configured: boolean;
  baseDir: string | null;
  dsId: string | null;
  generation: number;
  status: ScanStatus;
  /** 已打开的全部知识库（多库并行） */
  libraries?: LibraryInfo[];
  activeId?: string | null;
}

/** 已打开的知识库（服务端 Lib 清单项） */
export interface LibraryInfo {
  id: string;
  name: string;
  baseDir: string;
  status: ScanStatus;
}

export interface FilePayload {
  dsId: string;
  path: string;
  name: string;
  ext: string;
  type: 'markdown' | 'json' | 'text' | 'word' | 'html';
  content?: string;
  bom?: boolean;
  html?: string;
  text?: string;
  engine?: string;
  warning?: string | null;
  mtimeMs: number;
  size: number;
  readonly: boolean;
  encoding?: string;
  readonlyReason?: string;
}

export interface Collection {
  name: string;
  dirs: string[];
  validDirs?: string[];
  missingDirs?: string[];
}

export interface RefResolution {
  status: 'unique' | 'candidates' | 'missing';
  targets: FileEntry[];
  suggestions?: FileEntry[];
  reason?: string;
}

export interface SearchMatch {
  field: 'name' | 'path' | 'content';
  snippet: string;
  index?: number;
  score: number;
}

export interface SearchResult {
  file: FileEntry;
  matches: SearchMatch[];
  score: number;
}

export interface StatsResponse {
  dsId: string;
  scannedAt: string;
  counts: {
    total: number; md: number; json: number; txt: number; doc: number; docx: number; html: number;
    dirs: number; dirErrors: number; fileErrors: number;
  };
  distribution: { dir: string; count: number }[];
  recentModified: FileEntry[];
}

export interface MetadataMapping {
  file: string;
  itemPath: string;
  fields: { file: string; topics: string; concepts: string };
}

export interface TopicEntry { topic: string; count: number; files: string[] }
export interface ConceptEntry { concept: string; count: number; files: string[] }
