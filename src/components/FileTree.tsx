// 目录树（虚拟滚动版）：行数据先行——先把可见行摊平成数组，再按 28px 定高窗口化渲染。
// 三种视图：物理目录树 / 逻辑集合分组 / 过滤平铺；跟随导航 reveal、展开集与选项按库持久化。
// 键盘：↑↓←→/Home/End/Enter/F2/Delete/首字母，Ctrl+C/X/V 剪贴板语义（剪切=移动，复制=duplicate）。
// 行内徽标：草稿/元数据问题/近期修改/只读 Word（可开关）；被引用数（可开关）。
// 文件行可拖拽：拖进编辑器落成完整文件名引用（见 Edit 页 drop 处理）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { TreeNode, FileEntry, Collection } from '@/lib/types';
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, FilePlus, FolderPlus,
  ChevronsDownUp, ChevronsUpDown, Boxes, Eye, EyeOff, Link2, Lock, PenLine, AlertTriangle,
  FolderInput, Trash2, ArrowUpDown,
} from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EntryActionDialogs, type EntryAction } from './EntryActionDialogs';
import { MetaIssuesBadge } from './MetaIssuesBadge';
import { useApp } from '@/store/app';
import { CreateEntryDialog, type CreateKind, type CreateTarget } from './CreateEntryDialog';
import { extIcon } from '@/lib/extIcon';
import { api, type MetaIssue } from '@/lib/api';
import { runEntryAction } from '@/lib/entryOps';
import { ActionItems, type Entry } from './EntryMenu';

type OnCreate = (dir: string, kind: CreateKind) => void;
type OnAction = (a: EntryAction) => void;

const ROW_H = 28; // 统一行高（h-7）；虚拟滚动与键盘定位都依赖它

// ---- 路径工具 ----

function allDirPaths(n: TreeNode, out: string[] = []): string[] {
  for (const d of n.dirs) {
    out.push(d.path);
    allDirPaths(d, out);
  }
  return out;
}

function countFiles(n: TreeNode): number {
  return n.files.length + n.dirs.reduce((s, d) => s + countFiles(d), 0);
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

// 'a/b/c' -> ['a', 'a/b']（不含自身）
function ancestorDirs(p: string): string[] {
  const segs = p.split('/');
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join('/'));
  return out;
}

const fmtKB = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB');

// 文件夹聚合统计（悬浮提示 + 时间/大小排序用）：目录 -> { files, dirs, size, mtime }
// mtime = 目录（含子目录）内最新文件的修改时间
interface DirStat { files: number; dirs: number; size: number; mtime: number }

function computeStats(n: TreeNode, map: Map<string, DirStat>) {
  let files = n.files.length;
  let dirs = n.dirs.length;
  let size = n.files.reduce((s, f) => s + f.size, 0);
  let mtime = n.files.reduce((m, f) => Math.max(m, f.mtimeMs), 0);
  for (const d of n.dirs) {
    const st = computeStats(d, map);
    files += st.files;
    dirs += st.dirs;
    size += st.size;
    mtime = Math.max(mtime, st.mtime);
  }
  map.set(n.path, { files, dirs, size, mtime });
  return { files, dirs, size, mtime };
}

function collectFiles(n: TreeNode, out: FileEntry[] = []): FileEntry[] {
  out.push(...n.files);
  for (const d of n.dirs) collectFiles(d, out);
  return out;
}

// ---- 排序：名称（中文自然序，与服务端扫描一致）/ 修改时间 / 大小，各可选升降 ----

type SortKey = 'name' | 'mtime' | 'size';
type SortSpec = { key: SortKey; dir: 'asc' | 'desc' };
const DEFAULT_SORT: SortSpec = { key: 'name', dir: 'asc' };
const SORT_KEY_LABEL: Record<SortKey, string> = { name: '名称', mtime: '修改时间', size: '大小' };
// 方向的可读提示（因维度而异）
const dirHint = (key: SortKey, dir: 'asc' | 'desc') =>
  key === 'name' ? (dir === 'asc' ? 'A→Z' : 'Z→A')
  : key === 'mtime' ? (dir === 'asc' ? '旧→新' : '新→旧')
  : (dir === 'asc' ? '小→大' : '大→小');

const cmpName = (a: string, b: string) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
const cmpPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// 文件排序（返回新数组）：非名称维度以名称作次级排序，保证稳定
function sortFiles(files: FileEntry[], sort: SortSpec): FileEntry[] {
  const mul = sort.dir === 'asc' ? 1 : -1;
  return [...files].sort((a, b) => {
    if (sort.key === 'mtime') return mul * (a.mtimeMs - b.mtimeMs) || cmpName(a.name, b.name);
    if (sort.key === 'size') return mul * (a.size - b.size) || cmpName(a.name, b.name);
    return mul * cmpName(a.name, b.name) || cmpPath(a.path, b.path);
  });
}

// 目录排序（返回新数组）：时间/大小按聚合值（DirStat），名称自然序
function sortDirs(dirs: TreeNode[], sort: SortSpec, stats: Map<string, DirStat>): TreeNode[] {
  const mul = sort.dir === 'asc' ? 1 : -1;
  const val = (d: TreeNode) => {
    const st = stats.get(d.path);
    return sort.key === 'mtime' ? (st?.mtime ?? 0) : (st?.size ?? 0);
  };
  return [...dirs].sort((a, b) => {
    if (sort.key === 'name') return mul * cmpName(a.name, b.name);
    return mul * (val(a) - val(b)) || cmpName(a.name, b.name);
  });
}

// ---- 按库持久化的小存取 ----

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch { /* 隐私模式/配额：忽略，当次会话内仍有效 */ }
}

function loadOpen(id: string): Set<string> | null {
  const arr = loadJson<string[] | null>(`wb.filetree.open.${id}`, null);
  return Array.isArray(arr) ? new Set(arr) : null;
}

const RECENT_MS = 7 * 24 * 3600 * 1000; // 「近期修改」徽标阈值：7 天
let recentCutoff = 0; // 惰性计算：首次调用时定一次基线（天级粒度，无需逐渲染取时钟）
const isRecent = (mtimeMs: number) => {
  if (!recentCutoff) recentCutoff = Date.now() - RECENT_MS;
  return mtimeMs > recentCutoff;
};

// ---- 行模型：三种视图都摊平为 Row[]，虚拟滚动与键盘导航共用 ----

interface Row {
  key: string;
  kind: 'dir' | 'file' | 'head'; // head = 集合视图分组头（含「未归入集合」）
  path: string; // data-tpath；head 为 'col:<名称>' / 'uncat'
  name: string;
  depth: number;
  isDir: boolean;
  open?: boolean; // dir/head 的展开态（键盘 ←→ 用）
  file?: FileEntry;
  entry?: Entry; // 右键菜单动作目标
  dirLabel?: string; // 平铺/集合视图的相对目录副文本
  title?: string; // 悬浮提示（目录统计 / 集合计数）
  count?: number; // head 成员数
}

function buildTreeRows(node: TreeNode, depth: number, openSet: Set<string>, stats: Map<string, DirStat>, sort: SortSpec, out: Row[]) {
  for (const d of sortDirs(node.dirs, sort, stats)) {
    const st = stats.get(d.path) ?? { files: 0, dirs: 0, size: 0, mtime: 0 };
    const open = openSet.has(d.path);
    out.push({
      key: d.path, kind: 'dir', path: d.path, name: d.name, depth, isDir: true, open,
      entry: { path: d.path, name: d.name, isDir: true },
      title: `${st.files} 个文件 · ${st.dirs} 个子目录 · ${fmtKB(st.size)}`,
    });
    if (open) buildTreeRows(d, depth + 1, openSet, stats, sort, out);
  }
  for (const f of sortFiles(node.files, sort)) {
    out.push({
      key: f.path, kind: 'file', path: f.path, name: f.name, depth, isDir: false, file: f,
      entry: { path: f.path, name: f.name, isDir: false },
    });
  }
}

function buildFlatRows(files: FileEntry[]): Row[] {
  return files.map((f) => ({
    key: f.path, kind: 'file' as const, path: f.path, name: f.name, depth: 0, isDir: false, file: f,
    entry: { path: f.path, name: f.name, isDir: false }, dirLabel: f.dir,
  }));
}

// 集合视图：按集合分组平铺成员（文件可属多个集合时归第一个）；未归入任何集合的收进「未归入集合」
function buildCollectionRows(collections: Collection[], allFiles: FileEntry[], closed: Set<string>, sort: SortSpec): Row[] {
  const claimed = new Map<string, string>(); // path -> 第一个认领它的集合名
  const groups: { name: string; files: FileEntry[] }[] = [];
  for (const c of collections) {
    const members = allFiles.filter((f) => c.dirs.some((d) => f.dir === d || f.dir.startsWith(d + '/')));
    for (const f of members) if (!claimed.has(f.path)) claimed.set(f.path, c.name);
    groups.push({ name: c.name, files: members });
  }
  const uncat = allFiles.filter((f) => !claimed.has(f.path));
  const out: Row[] = [];
  const pushHead = (key: string, name: string, files: FileEntry[], depth: number) => {
    const open = !closed.has(key);
    out.push({
      key, kind: 'head', path: key, name, depth, isDir: true, open,
      title: `${files.length} 个文档`, count: files.length,
    });
    if (open) {
      for (const f of sortFiles(files, sort)) {
        out.push({
          key: key + '/' + f.path, kind: 'file', path: f.path, name: f.name, depth: depth + 1, isDir: false,
          file: f, entry: { path: f.path, name: f.name, isDir: false }, dirLabel: f.dir,
        });
      }
    }
  };
  for (const g of groups) pushHead('col:' + g.name, g.name, g.files, 0);
  pushHead('uncat', '未归入集合', uncat, 0);
  return out;
}

// ---- 行内小组件 ----

// 过滤命中片段高亮（大小写不敏感，取名称中的第一处）
function Highlight({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0 || !q) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-transparent text-primary font-medium">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

interface RowCtx {
  activeFile?: string;
  activeDir: string | null;
  q: string;
  opts: { badges: boolean; refs: boolean };
  drafts: Set<string>;
  metaMsgs: Map<string, string[]>;
  linkCounts: Record<string, number>;
  cutPath: string | null;
  selected: Set<string>;
  onOpenFile: (row: Row, e?: React.MouseEvent) => void;
  onToggle: (row: Row, e?: React.MouseEvent) => void;
  onCreate: OnCreate;
  onAction: OnAction;
  dsId: string | null;
  onDuplicated: (path: string) => void;
  /** 拖拽到目录行：把路径（们）移入该目录 */
  onDropInto: (dirPath: string, paths: string[]) => void;
}

function RowView({ row, idx, ctx }: { row: Row; idx: number; ctx: RowCtx }) {
  const navigate = useNavigate();
  const cut = ctx.cutPath === row.path;
  const focusCls = 'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring';

  // 行内徽标：只读 Word / 近期修改 / 草稿 / 元数据问题（badge 开关统一控制）；被引用数单独开关
  const badges = () => {
    const f = row.file;
    if (!f || !ctx.opts.badges) {
      return ctx.opts.refs && f && (ctx.linkCounts[row.path] ?? 0) > 0 ? refBadge(ctx.linkCounts[row.path]) : null;
    }
    const msgs = ctx.metaMsgs.get(row.path);
    const recent = isRecent(f.mtimeMs);
    const ro = f.ext === '.doc' || f.ext === '.docx';
    const refs = ctx.opts.refs && (ctx.linkCounts[row.path] ?? 0) > 0;
    if (!ro && !recent && !ctx.drafts.has(row.path) && !msgs && !refs) return null;
    return (
      <span className="flex items-center gap-0.5 shrink-0">
        {ro && <span title="Word 文档（只读预览）"><Lock className="w-2.5 h-2.5 text-muted-foreground" /></span>}
        {recent && <span title="7 天内修改过"><span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" /></span>}
        {ctx.drafts.has(row.path) && (
          <span title="存在本地草稿（上次未完成的编辑）"><PenLine className="w-3 h-3 text-warning" /></span>
        )}
        {msgs && <span title={msgs.join('\n')}><AlertTriangle className="w-3 h-3 text-destructive" /></span>}
        {refs && refBadge(ctx.linkCounts[row.path])}
      </span>
    );
  };
  const refBadge = (n: number) => (
    <span title={`被 ${n} 个文档引用`} className="flex items-center gap-0.5 text-muted-foreground">
      <Link2 className="w-3 h-3" /><span className="text-xs tabular-nums">{n}</span>
    </span>
  );

  if (row.kind === 'file') {
    const active = ctx.activeFile === row.path;
    const sel = ctx.selected.has(row.path);
    return (
      <ContextMenu>
      <ContextMenuTrigger asChild>
      <div
        data-idx={idx} data-tpath={row.path} data-name={row.name} data-kind="file" data-sel={sel ? '1' : '0'}
        tabIndex={-1} draggable
        className={`group h-7 flex items-center gap-1.5 pr-1.5 rounded cursor-default text-sm select-none hover:bg-sidebar-accent ${focusCls} ${
          active ? 'bg-sidebar-accent font-medium text-primary' : ''
        } ${sel ? 'bg-primary/15 ring-1 ring-inset ring-primary/40' : ''} ${cut ? 'opacity-50' : ''}`}
        style={{ paddingLeft: row.depth * 14 + 22 }}
        onClick={(e) => ctx.onOpenFile(row, e)}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', row.name);
          e.dataTransfer.setData('application/x-wb-file', row.path);
          // 多选拖拽：整批随行（目录行 drop 优先读它；编辑器 drop 仍读单文件类型）
          if (ctx.selected.has(row.path) && ctx.selected.size > 1) {
            e.dataTransfer.setData('application/x-wb-multi', JSON.stringify([...ctx.selected]));
          }
          // copyMove：拖进编辑器=copy（插引用），拖到目录=move；
          // 若只允许 copy，目录行的 dropEffect='move' 会被浏览器判为非法目标，drop 不触发
          e.dataTransfer.effectAllowed = 'copyMove';
        }}
        title={row.path}
      >
        <span className="shrink-0 flex-none">{extIcon(row.file!.ext)}</span>
        <span className="min-w-0 flex-1 truncate">{ctx.q ? <Highlight text={row.name} q={ctx.q} /> : row.name}</span>
        {badges()}
        <span className="w-0" />
        {row.dirLabel && (
          <span className="shrink-0 max-w-[45%] truncate text-xs text-muted-foreground" title={row.dirLabel}>
            {row.dirLabel}
          </span>
        )}
      </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ActionItems entry={row.entry!} onAction={ctx.onAction} dsId={ctx.dsId} onDuplicated={ctx.onDuplicated} />
      </ContextMenuContent>
      </ContextMenu>
    );
  }

  // 目录行（物理树）与分组头（集合视图）
  const isHead = row.kind === 'head';
  const active = !isHead && ctx.activeDir === row.path;
  const sel = !isHead && ctx.selected.has(row.path);
  const [dropOver, setDropOver] = useState(false);
  const quickCreate = (kind: CreateKind) => setTimeout(() => ctx.onCreate(row.path, kind), 0);
  const dirRow = (
    <div
      data-idx={idx} data-tpath={row.path} data-name={row.name} data-kind="dir" data-sel={sel ? '1' : '0'}
      data-open={row.open ? '1' : '0'} tabIndex={-1}
      title={row.title}
      className={`group h-7 flex items-center gap-1 pr-1.5 rounded cursor-pointer select-none hover:bg-sidebar-accent ${focusCls} ${
        active ? 'bg-sidebar-accent' : ''
      } ${sel ? 'bg-primary/15 ring-1 ring-inset ring-primary/40' : ''} ${
        dropOver ? 'ring-2 ring-inset ring-primary bg-primary/10' : ''
      }`}
      style={{ paddingLeft: row.depth * 14 + 4 }}
      onClick={(e) => ctx.onToggle(row, e)}
      draggable={!isHead}
      onDragStart={(e) => {
        if (isHead) return;
        e.dataTransfer.setData('application/x-wb-file', row.path);
        if (ctx.selected.has(row.path) && ctx.selected.size > 1) {
          e.dataTransfer.setData('application/x-wb-multi', JSON.stringify([...ctx.selected]));
        }
        e.dataTransfer.effectAllowed = 'copyMove';
      }}
      onDragOver={(e) => {
        if (isHead) return;
        const types = Array.from(e.dataTransfer.types);
        if (!types.includes('application/x-wb-file') && !types.includes('application/x-wb-multi')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        e.stopPropagation();
        setDropOver(true);
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(e) => {
        if (isHead) return;
        const types = Array.from(e.dataTransfer.types);
        if (!types.includes('application/x-wb-file') && !types.includes('application/x-wb-multi')) return;
        e.preventDefault();
        e.stopPropagation();
        setDropOver(false);
        let paths: string[] = [];
        try {
          const multi = e.dataTransfer.getData('application/x-wb-multi');
          paths = multi ? (JSON.parse(multi) as string[]) : [e.dataTransfer.getData('application/x-wb-file')];
        } catch { /* 忽略坏载荷 */ }
        paths = paths.filter(Boolean);
        if (paths.length) ctx.onDropInto(row.path, paths);
      }}
    >
      {row.open ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
      {isHead ? (
        <Boxes className="w-4 h-4 shrink-0 text-primary/70" />
      ) : row.open ? (
        <FolderOpen className="w-4 h-4 shrink-0 text-primary/70" />
      ) : (
        <Folder className="w-4 h-4 shrink-0 text-primary/70" />
      )}
      <button
        className={`truncate text-left flex-1 ${active ? 'text-primary font-medium' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          navigate('/browse?dir=' + encodeURIComponent(row.path));
        }}
      >
        {row.name}
      </button>
      {row.count !== undefined && <span className="text-xs text-muted-foreground tabular-nums shrink-0">{row.count}</span>}
      {!isHead && (
        <span className="hidden group-hover:flex group-focus-within:flex items-center gap-0.5 shrink-0">
          <button
            className="p-0.5 rounded hover:bg-background"
            title="新建文档" aria-label="新建文档"
            onClick={(e) => { e.stopPropagation(); quickCreate('md'); }}
          >
            <FilePlus className="w-3.5 h-3.5" />
          </button>
          <button
            className="p-0.5 rounded hover:bg-background"
            title="新建文件夹" aria-label="新建文件夹"
            onClick={(e) => { e.stopPropagation(); quickCreate('folder'); }}
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
        </span>
      )}
    </div>
  );
  if (isHead) return dirRow; // 分组头不提供条目级右键（集合不是文件系统对象）
  return (
    <ContextMenu>
    <ContextMenuTrigger asChild>
    {dirRow}
    </ContextMenuTrigger>
    <ContextMenuContent>
      <ContextMenuItem onSelect={() => quickCreate('md')}><FilePlus />新建文档</ContextMenuItem>
      <ContextMenuItem onSelect={() => quickCreate('folder')}><FolderPlus />新建文件夹</ContextMenuItem>
      <ContextMenuSeparator />
      <ActionItems entry={row.entry!} onAction={ctx.onAction} dsId={ctx.dsId} onDuplicated={ctx.onDuplicated} />
    </ContextMenuContent>
    </ContextMenu>
  );
}

export function FileTree({
  tree,
  filter,
  onFilterChange,
}: {
  tree: TreeNode;
  filter: string;
  onFilterChange: (v: string) => void;
}) {
  // 注意：FileTree 渲染在 Layout 层，useParams 拿不到子路由的 splat 参数，
  // 当前文件路径从 location.pathname 推导（/read、/edit 均适用）
  const location = useLocation();
  const routeFile = /^\/(?:read|edit)\/(.+)$/.exec(location.pathname);
  const currentPath = routeFile ? decodeURIComponent(routeFile[1]) : undefined;
  const [searchParams] = useSearchParams();
  const currentDir = location.pathname === '/browse' ? searchParams.get('dir') || '' : null;
  const navigate = useNavigate();
  const { refreshTree, dsId } = useApp();
  const [action, setAction] = useState<EntryAction | null>(null);
  const onActionDone = () => setAction(null);
  const [target, setTarget] = useState<CreateTarget | null>(null);
  const onCreate: OnCreate = (dir, kind) => setTarget({ dir, kind });
  const onCreated = async (p: string, kind: CreateKind) => {
    setTarget(null);
    await refreshTree().catch(() => {});
    if (kind === 'md') navigate('/edit/' + p.split('/').map(encodeURIComponent).join('/'));
  };

  // 外部数据：元数据问题（徽标汇总 + 行内红点）、集合配置（集合视图 + 集合引用）、被引用计数
  //（链接索引异步构建，空结果时 2.5s 后补拉一次）
  const [metaIssues, setMetaIssues] = useState<MetaIssue[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [linkCounts, setLinkCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let dead = false;
    const pull = () => {
      api.metaIssues().then((r) => { if (!dead) setMetaIssues(r.issues); }).catch(() => {});
      api.collections().then((r) => { if (!dead) setCollections(r.collections); }).catch(() => {});
      api.linkCounts().then((r) => { if (!dead) setLinkCounts(r.counts); }).catch(() => {});
    };
    pull();
    const t = setTimeout(pull, 2500);
    return () => { dead = true; clearTimeout(t); };
  }, [tree]);
  const metaMsgs = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const it of metaIssues) {
      const docs = [...(it.sidecars ?? (it.sidecar ? [it.sidecar] : [])), ...(it.candidates ?? [])]
        .map((p) => p.replace(/\.meta\.json$/, ''));
      for (const d of docs) {
        const arr = m.get(d) ?? [];
        arr.push(it.message);
        m.set(d, arr);
      }
    }
    return m;
  }, [metaIssues]);

  // 本地草稿集合；导航/树刷新/过滤时重算，让新写入的草稿及时反映为徽标
  const draftPaths = useMemo(() => {
    const s = new Set<string>();
    if (!dsId) return s;
    const prefix = `wb:draft:${dsId}:`;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) s.add(k.slice(prefix.length));
      }
    } catch { /* 忽略 */ }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsId, tree, currentPath, currentDir, filter]);

  // 视图与选项（按库持久化）
  const [view, setViewState] = useState<'tree' | 'cols'>('tree');
  const [opts, setOpts] = useState<{ badges: boolean; refs: boolean }>({ badges: true, refs: true });
  const [sort, setSortSpec] = useState<SortSpec>(DEFAULT_SORT);
  useEffect(() => {
    if (!dsId) return;
    setViewState(loadJson<'tree' | 'cols'>(`wb.filetree.view.${dsId}`, 'tree') === 'cols' ? 'cols' : 'tree');
    setOpts(loadJson(`wb.filetree.opts.${dsId}`, { badges: true, refs: true }));
    const raw = loadJson<Partial<SortSpec>>(`wb.filetree.sort.${dsId}`, {});
    setSortSpec({
      key: raw.key === 'mtime' || raw.key === 'size' ? raw.key : 'name',
      dir: raw.dir === 'desc' ? 'desc' : 'asc',
    });
  }, [dsId]);
  const setView = (v: 'tree' | 'cols') => {
    setViewState(v);
    onFilterChange('');
    if (dsId) saveJson(`wb.filetree.view.${dsId}`, v);
  };
  const toggleOpt = (k: 'badges' | 'refs') => {
    setOpts((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      if (dsId) saveJson(`wb.filetree.opts.${dsId}`, next);
      return next;
    });
  };
  // 切排序维度时选常用方向：时间/大小默认降序（新→旧 / 大→小），名称升序；方向也可单独切
  const setSortKey = (key: SortKey) => {
    setSortSpec((prev) => {
      if (prev.key === key) return prev;
      const next: SortSpec = { key, dir: key === 'name' ? 'asc' : 'desc' };
      if (dsId) saveJson(`wb.filetree.sort.${dsId}`, next);
      return next;
    });
  };
  const setSortDir = (dir: 'asc' | 'desc') => {
    setSortSpec((prev) => {
      if (prev.dir === dir) return prev;
      const next = { ...prev, dir };
      if (dsId) saveJson(`wb.filetree.sort.${dsId}`, next);
      return next;
    });
  };

  // ---- 展开集（物理树，随库整体替换）----
  const [openState, setOpenState] = useState<{ dsId: string | null; set: Set<string> }>({ dsId: null, set: new Set() });
  useEffect(() => {
    if (!tree || !dsId) return;
    const existing = new Set(allDirPaths(tree));
    if (openState.dsId !== dsId) {
      const saved = loadOpen(dsId);
      const set = saved ? new Set([...saved].filter((p) => existing.has(p))) : new Set(tree.dirs.map((d) => d.path));
      setOpenState({ dsId, set });
      return;
    }
    if (openState.set.size === 0) return;
    let stale = false;
    for (const p of openState.set) if (!existing.has(p)) { stale = true; break; }
    if (stale) setOpenState({ dsId, set: new Set([...openState.set].filter((p) => existing.has(p))) });
  }, [tree, dsId, openState]);
  useEffect(() => {
    if (!dsId || openState.dsId !== dsId) return;
    saveJson(`wb.filetree.open.${dsId}`, [...openState.set]);
  }, [openState, dsId]);
  const applyOpen = (fn: (set: Set<string>) => Set<string>) =>
    setOpenState((prev) => {
      if (prev.dsId !== dsId) return prev;
      const next = fn(prev.set);
      return next === prev.set ? prev : { dsId: prev.dsId, set: next };
    });
  const toggleDir = (p: string) =>
    applyOpen((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  // 集合分组头展开集（存「已折叠」的分组，默认全开）
  const [closedCols, setClosedCols] = useState<{ dsId: string | null; set: Set<string> }>({ dsId: null, set: new Set() });
  useEffect(() => {
    if (!dsId) return;
    const arr = loadJson<string[] | null>(`wb.filetree.closedcol.${dsId}`, null);
    setClosedCols({ dsId, set: Array.isArray(arr) ? new Set(arr) : new Set() });
  }, [dsId]);
  useEffect(() => {
    if (!dsId || closedCols.dsId !== dsId) return;
    saveJson(`wb.filetree.closedcol.${dsId}`, [...closedCols.set]);
  }, [closedCols, dsId]);
  const toggleColHead = (key: string) =>
    setClosedCols((prev) => {
      if (prev.dsId !== dsId) return prev;
      const n = new Set(prev.set);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return { dsId: prev.dsId, set: n };
    });

  // ---- 行数据装配 ----
  const q = filter.trim().toLowerCase();
  const stats = useMemo(() => {
    const m = new Map<string, DirStat>();
    computeStats(tree, m);
    return m;
  }, [tree]);
  const allFiles = useMemo(() => collectFiles(tree), [tree]);
  const rows = useMemo<Row[]>(() => {
    if (q) {
      const out = allFiles.filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
      return buildFlatRows(sortFiles(out, sort));
    }
    if (view === 'cols') {
      if (!collections.length) return [];
      return buildCollectionRows(collections, allFiles, closedCols.dsId === dsId ? closedCols.set : new Set(), sort);
    }
    const openSet = openState.dsId === dsId ? openState.set : new Set(tree.dirs.map((d) => d.path));
    const out: Row[] = [];
    buildTreeRows(tree, 0, openSet, stats, sort, out);
    return out;
  }, [tree, q, view, openState, closedCols, collections, allFiles, stats, dsId, sort]);

  // ---- 虚拟滚动 ----
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(640);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_H) + 8);
  const winRows = rows.slice(start, end);

  // ---- reveal：跟随当前文件/目录展开父链并滚到可见 ----
  const revealedRef = useRef<string | null>(null);
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  const revealKey = currentPath !== undefined ? 'f:' + currentPath : currentDir ? 'd:' + currentDir : null;
  useEffect(() => {
    if (!tree || !revealKey || revealedRef.current === revealKey) return;
    revealedRef.current = revealKey;
    const targetPath = revealKey.slice(2);

    // 集合视图下打开文件：保持集合模式不切回物理树——
    // 展开其所在分组（首个认领集合，与 buildCollectionRows 同口径）并滚动定位
    if (view === 'cols' && revealKey.startsWith('f:') && !q) {
      const dir = dirOf(targetPath);
      const col = collections.find((c) => c.dirs.some((d) => dir === d || dir.startsWith(d + '/')));
      const key = col ? 'col:' + col.name : 'uncat';
      setClosedCols((prev) => {
        if (prev.dsId !== dsId || !prev.set.has(key)) return prev;
        const n = new Set(prev.set);
        n.delete(key);
        return { dsId: prev.dsId, set: n };
      });
      setPendingScroll(targetPath);
      return;
    }

    const dir = revealKey.startsWith('f:') ? dirOf(targetPath) : targetPath;
    const chain = dir ? [...ancestorDirs(dir), dir] : [];
    applyOpen((s) => {
      let next: Set<string> | null = null;
      for (const d of chain) {
        if (!next && s.has(d)) continue;
        next ??= new Set(s);
        next.add(d);
      }
      return next ?? s;
    });
    setViewState((v) => (v === 'cols' ? 'tree' : v)); // 集合视图无法表达父链，回到物理树（同时更新存档）
    if (dsId) saveJson(`wb.filetree.view.${dsId}`, 'tree');
    onFilterChange(''); // 退出平铺模式，否则看不到父链
    setPendingScroll(targetPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, revealKey]);
  useEffect(() => {
    if (!pendingScroll) return;
    const idx = rows.findIndex((r) => r.path === pendingScroll);
    if (idx >= 0 && scrollRef.current) {
      const vh = scrollRef.current.clientHeight;
      const top = idx * ROW_H;
      if (top < scrollTop || top + ROW_H > scrollTop + vh) {
        const target = Math.max(0, top - vh / 2 + ROW_H);
        scrollRef.current.scrollTop = target;
        setScrollTop(target);
      }
    }
    setPendingScroll(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScroll, rows]);

  // 剪贴板语义（树内）：Ctrl+C 复制 / Ctrl+X 剪切（半透明标记）/ Ctrl+V 粘贴（剪切=移动，复制=副本）
  const [clip, setClip] = useState<{ op: 'copy' | 'cut'; entry: Entry } | null>(null);
  const doPaste = async (targetDir: string) => {
    if (!clip) return;
    if (clip.op === 'cut') {
      if (dirOf(clip.entry.path) === targetDir) { setClip(null); return; }
      try {
        await runEntryAction({ ...clip.entry, type: 'move', targetDir });
        setClip(null);
      } catch (e) {
        alert((e as Error).message);
      }
    } else {
      try {
        await api.duplicateEntry({ dsId, path: clip.entry.path, targetDir });
        await refreshTree().catch(() => {});
        // 复制源保留，可连续粘贴
      } catch (e) {
        alert((e as Error).message);
      }
    }
  };
  const onDuplicated = async () => {
    await refreshTree().catch(() => {});
  };

  // 全部展开/折叠
  const collapseAll = () => setOpenState((prev) => (prev.dsId === dsId ? { dsId, set: new Set() } : prev));
  const expandAll = () => {
    if (countFiles(tree) > 3000 && !window.confirm('这个知识库文件较多，全部展开可能让页面卡顿。仍要继续吗？')) return;
    setOpenState((prev) => (prev.dsId === dsId ? { dsId, set: new Set(allDirPaths(tree)) } : prev));
  };

  // ---- 键盘导航：以 rows[] 为准；未渲染的行先滚再聚焦 ----
  const typeBufRef = useRef('');
  const typeAtRef = useRef(0);
  // 目标行尚未进入渲染窗口时：先滚动，窗口更新后由 effect 兑现聚焦
  //（不用 rAF：隐藏窗口会暂停帧回调，effect 在提交后必达）
  const [pendingFocus, setPendingFocus] = useState<number | null>(null);
  useEffect(() => {
    if (pendingFocus == null) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-idx="${pendingFocus}"]`);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: 'nearest' });
      setPendingFocus(null);
    }
  }, [pendingFocus, start, end]);
  const focusIdx = (i: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, i));
    const cont = scrollRef.current;
    if (!cont) return;
    const el = cont.querySelector<HTMLElement>(`[data-idx="${clamped}"]`);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: 'nearest' });
      return;
    }
    const target = Math.max(0, clamped * ROW_H - cont.clientHeight / 2 + ROW_H);
    cont.scrollTop = target;
    setScrollTop(target);
    setPendingFocus(clamped);
  };
  // ---- 多选（Cmd/Ctrl 点选、Shift 范围、Cmd+A 全选）与批量操作 ----
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef(-1);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchFail, setBatchFail] = useState(0);
  const [confirmDel, setConfirmDel] = useState(false);
  const [moveAsk, setMoveAsk] = useState<string[] | null>(null);
  // 换库 / 切视图 / 过滤时清空选择（路径含义已变）
  useEffect(() => {
    setSelected(new Set());
    anchorRef.current = -1;
  }, [dsId, view, q]);

  const toggleSel = (path: string, idx: number) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
    anchorRef.current = idx;
  };
  const rangeSel = (idx: number) => {
    const a = anchorRef.current >= 0 ? anchorRef.current : idx;
    const [lo, hi] = a <= idx ? [a, idx] : [idx, a];
    setSelected(new Set(rows.slice(lo, hi + 1).map((r) => r.path)));
  };

  // 条目元信息（批量 move 需要 name/isDir）：优先物理树，兼 flat/集合视图
  const entryOf = (path: string): { name: string; isDir: boolean } => {
    const f = allFiles.find((x) => x.path === path);
    if (f) return { name: f.name, isDir: false };
    const d = tree.dirs.find((x) => x.path === path);
    if (d) return { name: d.name, isDir: true };
    return { name: path.split('/').pop() || path, isDir: false };
  };
  const isDescendant = (p: string, dir: string) => p === dir || p.startsWith(dir + '/');

  // 批量执行：逐条复用 runEntryAction（flush / 刷新 / 草稿迁移 / 跟随导航全内置），失败计数
  const runBatch = async (paths: string[], run: (p: string) => Promise<unknown>) => {
    setBatchBusy(true);
    setBatchFail(0);
    let fail = 0;
    for (const p of paths) {
      try {
        await run(p);
      } catch {
        fail++;
      }
    }
    setBatchBusy(false);
    setBatchFail(fail);
    setSelected(new Set());
    setConfirmDel(false);
  };
  const batchMove = (paths: string[], targetDir: string) =>
    runBatch(
      paths.filter((p) => !isDescendant(targetDir, p) && dirOf(p) !== targetDir),
      (p) => {
        const { name, isDir } = entryOf(p);
        return runEntryAction({ type: 'move', path: p, name, isDir, targetDir });
      }
    ).then(() => {
      // 移完展开目标目录：用户能看到东西去哪了
      if (targetDir) applyOpen((s) => new Set([...s, targetDir]));
    });
  const batchDelete = (paths: string[]) =>
    runBatch(paths, (p) => {
      const { name, isDir } = entryOf(p);
      return runEntryAction({ type: 'delete', path: p, name, isDir });
    });

  const toggleRow = (row: Row, e?: React.MouseEvent) => {
    if (e?.shiftKey && row.kind !== 'head') {
      rangeSel(rows.findIndex((r) => r.path === row.path));
      return;
    }
    if ((e?.metaKey || e?.ctrlKey) && row.kind !== 'head') {
      toggleSel(row.path, rows.findIndex((r) => r.path === row.path));
      return;
    }
    if (!e || (!e.metaKey && !e.ctrlKey && !e.shiftKey)) setSelected(new Set());
    if (row.kind === 'head') toggleColHead(row.path);
    else if (row.kind === 'dir') toggleDir(row.path);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const cont = scrollRef.current;
    if (!cont || !rows.length) return;
    const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rowEl = activeEl?.closest('[data-idx]');
    const idx = rowEl && cont.contains(rowEl) ? Number(rowEl.getAttribute('data-idx')) : -1;
    const row = idx >= 0 ? rows[idx] : undefined;

    // 剪贴板语义
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'c' && row?.entry) { setClip({ op: 'copy', entry: row.entry }); e.preventDefault(); return; }
      if (k === 'x' && row?.entry) { setClip({ op: 'cut', entry: row.entry }); e.preventDefault(); return; }
      if (k === 'v' && clip) {
        const targetDir = !row ? '' : row.isDir ? row.path : dirOf(row.path);
        doPaste(targetDir);
        e.preventDefault();
        return;
      }
      return; // 其余 Ctrl 组合不拦截
    }
    if (e.key === 'Escape') {
      if (selected.size) {
        setSelected(new Set());
        e.preventDefault();
        return;
      }
      if (clip) { setClip(null); e.preventDefault(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelected(new Set(rows.filter((r) => r.kind !== 'head').map((r) => r.path)));
      anchorRef.current = -1;
      return;
    }

    if (e.key === 'ArrowDown') { e.preventDefault(); focusIdx(idx + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); focusIdx(idx - 1); return; }
    if (e.key === 'Home') { e.preventDefault(); focusIdx(0); return; }
    if (e.key === 'End') { e.preventDefault(); focusIdx(rows.length - 1); return; }
    if (!row) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (row.isDir && !row.open) toggleRow(row);
      else focusIdx(idx + 1);
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (row.isDir && row.open) toggleRow(row);
      else if (row.kind === 'dir') {
        const parent = rows.findIndex((r) => r.kind === 'dir' && r.path === dirOf(row.path));
        if (parent >= 0) focusIdx(parent);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (row.kind === 'file') ctxOpenFile(row);
      else toggleRow(row);
      return;
    }
    if (e.key === 'F2') {
      e.preventDefault();
      if (row.entry) setTimeout(() => setAction({ ...row.entry!, type: 'rename' }), 0);
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      if (row.entry) setTimeout(() => setAction({ ...row.entry!, type: 'delete' }), 0);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      typeBufRef.current = now - typeAtRef.current > 800 ? e.key : typeBufRef.current + e.key;
      typeAtRef.current = now;
      const buf = typeBufRef.current.toLowerCase();
      for (let k = 1; k <= rows.length; k++) {
        const i = ((idx >= 0 ? idx : 0) + k) % rows.length;
        if (rows[i].name.toLowerCase().startsWith(buf)) { focusIdx(i); break; }
      }
      e.preventDefault();
    }
  };

  const ctxOpenFile = (row: Row, e?: React.MouseEvent) => {
    const idx = rows.findIndex((r) => r.path === row.path);
    if (e?.shiftKey) {
      rangeSel(idx);
      return;
    }
    if (e?.metaKey || e?.ctrlKey) {
      toggleSel(row.path, idx);
      return;
    }
    setSelected(new Set());
    if (q) onFilterChange('');
    navigate('/read/' + row.path.split('/').map(encodeURIComponent).join('/'));
  };

  const ctx: RowCtx = {
    activeFile: currentPath,
    activeDir: currentDir,
    q,
    opts,
    drafts: draftPaths,
    metaMsgs,
    linkCounts,
    cutPath: clip?.op === 'cut' ? clip.entry.path : null,
    selected,
    onOpenFile: ctxOpenFile,
    onToggle: toggleRow,
    onCreate,
    onAction: setAction,
    dsId,
    onDuplicated,
    onDropInto: (dirPath, paths) => batchMove(paths, dirPath),
  };
  const filtering = !!q;
  const emptyTree = tree.files.length === 0 && tree.dirs.length === 0;

  const tabBtn = (v: 'tree' | 'cols', label: string, icon: React.ReactNode, title: string) => (
    <button
      className={`flex items-center gap-1 text-xs px-1.5 py-1 rounded hover:bg-sidebar-accent ${view === v && !filtering ? 'bg-sidebar-accent text-primary font-medium' : 'text-muted-foreground'}`}
      onClick={() => setView(v)}
      title={title}
    >
      {icon}{label}
    </button>
  );

  return (
    <div className="h-full flex flex-col text-sidebar-foreground">
      <div className="shrink-0 px-1 pt-1 pb-1 space-y-1 border-b border-sidebar-border">
        <div className="flex items-center gap-1">
          {tabBtn('tree', '目录', <Folder className="w-3.5 h-3.5" />, '物理目录视图')}
          {tabBtn('cols', '集合', <Boxes className="w-3.5 h-3.5" />, '逻辑集合分组视图（设置 → 逻辑集合）')}
          <span className="ml-auto flex items-center gap-0.5">
            <button
              className={`p-1 rounded hover:bg-sidebar-accent ${opts.badges ? 'text-primary' : 'text-muted-foreground'}`}
              title={opts.badges ? '隐藏行内徽标（草稿/问题/近期/只读）' : '显示行内徽标'}
              onClick={() => toggleOpt('badges')}
            >
              {opts.badges ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            </button>
            <button
              className={`p-1 rounded hover:bg-sidebar-accent ${opts.refs ? 'text-primary' : 'text-muted-foreground'}`}
              title={opts.refs ? '隐藏被引用数' : '显示被引用数'}
              onClick={() => toggleOpt('refs')}
            >
              <Link2 className="w-3.5 h-3.5" />
            </button>
            <MetaIssuesBadge issues={metaIssues} />
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="flex items-center gap-1 text-xs px-1.5 py-1 rounded hover:bg-sidebar-accent"
            onClick={() => onCreate('', 'md')}
            title="在知识库根目录新建文档"
          >
            <FilePlus className="w-3.5 h-3.5" />新建文档
          </button>
          <button
            className="flex items-center gap-1 text-xs px-1.5 py-1 rounded hover:bg-sidebar-accent"
            onClick={() => onCreate('', 'folder')}
            title="在知识库根目录新建文件夹"
          >
            <FolderPlus className="w-3.5 h-3.5" />新建文件夹
          </button>
          <span className="ml-auto flex items-center gap-0.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="p-1 rounded hover:bg-sidebar-accent text-muted-foreground"
                  title={`排序：${SORT_KEY_LABEL[sort.key]} · ${sort.dir === 'asc' ? '升序' : '降序'}（${dirHint(sort.key, sort.dir)}），对目录树/过滤结果/集合分组均生效`}
                >
                  <ArrowUpDown className="w-3.5 h-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuRadioGroup value={sort.key} onValueChange={(v) => setSortKey(v as SortKey)}>
                  <DropdownMenuRadioItem value="name">名称</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="mtime">修改时间</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="size">大小</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={sort.dir} onValueChange={(v) => setSortDir(v as 'asc' | 'desc')}>
                  <DropdownMenuRadioItem value="asc">
                    升序<span className="ml-auto pl-4 text-xs text-muted-foreground">{dirHint(sort.key, 'asc')}</span>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="desc">
                    降序<span className="ml-auto pl-4 text-xs text-muted-foreground">{dirHint(sort.key, 'desc')}</span>
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {view === 'tree' && !filtering && (
              <>
                <button
                  className="p-1 rounded hover:bg-sidebar-accent text-muted-foreground"
                  title="全部展开" aria-label="全部展开"
                  onClick={expandAll}
                >
                  <ChevronsUpDown className="w-3.5 h-3.5" />
                </button>
                <button
                  className="p-1 rounded hover:bg-sidebar-accent text-muted-foreground"
                  title="全部折叠" aria-label="全部折叠"
                  onClick={collapseAll}
                >
                  <ChevronsDownUp className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </span>
        </div>
      </div>
      {filtering && (
        <div className="shrink-0 flex items-center gap-2 px-1.5 py-1 text-xs text-muted-foreground border-b border-sidebar-border">
          <span className="stat-num">{rows.length}</span> 个匹配文件
          <span className="flex-1" />
          <button className="hover:text-primary" onClick={() => navigate('/search?q=' + encodeURIComponent(filter.trim()))}>
            转全文检索 →
          </button>
        </div>
      )}
      <div
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onDragOver={(e) => {
          const types = Array.from(e.dataTransfer.types);
          if (!types.includes('application/x-wb-file') && !types.includes('application/x-wb-multi')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          // 落在空白区/容器 = 移到根目录（行级 drop 会 stopPropagation，不会走到这）
          const types = Array.from(e.dataTransfer.types);
          if (!types.includes('application/x-wb-file') && !types.includes('application/x-wb-multi')) return;
          e.preventDefault();
          let paths: string[] = [];
          try {
            const multi = e.dataTransfer.getData('application/x-wb-multi');
            paths = multi ? (JSON.parse(multi) as string[]) : [e.dataTransfer.getData('application/x-wb-file')];
          } catch { /* 忽略坏载荷 */ }
          paths = paths.filter(Boolean).filter((p) => dirOf(p) !== '');
          if (paths.length) batchMove(paths, '');
        }}
        className="flex-1 min-h-0 overflow-auto p-1 outline-none"
      >
        {rows.length === 0 ? (
          filtering ? (
            <div className="text-xs text-muted-foreground p-3">没有文件名或路径匹配「{filter.trim()}」</div>
          ) : view === 'cols' && !collections.length ? (
            <div className="text-xs text-muted-foreground p-3">
              尚未配置逻辑集合。
              <button className="text-primary hover:underline" onClick={() => navigate('/settings')}>去设置 →</button>
            </div>
          ) : emptyTree ? (
            <div className="text-xs text-muted-foreground p-3">知识库中没有可支持的文件（.md / .txt / .json / .doc / .docx）</div>
          ) : null
        ) : (
          <div style={{ height: rows.length * ROW_H }} className="relative">
            <div style={{ transform: `translateY(${start * ROW_H}px)` }}>
              {winRows.map((r, i) => (
                <RowView key={r.key} row={r} idx={start + i} ctx={ctx} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 多选操作条：已选 n 项 → 移动 / 删除（行内确认）/ 清除；失败计数展示 */}
      {selected.size > 0 && (
        <div data-wb-selbar className="shrink-0 border-t border-sidebar-border px-1.5 py-1.5 flex items-center gap-1.5 text-xs flex-wrap">
          {confirmDel ? (
            <>
              <span className="text-destructive">删除所选 {selected.size} 项？</span>
              <button
                className="px-2 py-0.5 rounded bg-destructive text-destructive-foreground"
                disabled={batchBusy}
                onClick={() => batchDelete([...selected])}
              >
                确认删除
              </button>
              <button className="px-2 py-0.5 rounded border border-border" onClick={() => setConfirmDel(false)}>
                取消
              </button>
            </>
          ) : (
            <>
              <span className="stat-num">{selected.size}</span> 项已选
              <button
                className="flex items-center gap-1 px-2 py-0.5 rounded border border-border hover:bg-sidebar-accent"
                disabled={batchBusy}
                onClick={() => setMoveAsk([...selected])}
              >
                <FolderInput className="w-3.5 h-3.5" /> 移动到…
              </button>
              <button
                className="flex items-center gap-1 px-2 py-0.5 rounded border border-border hover:bg-sidebar-accent"
                disabled={batchBusy}
                onClick={() => setConfirmDel(true)}
              >
                <Trash2 className="w-3.5 h-3.5" /> 删除
              </button>
              <button className="px-2 py-0.5 rounded border border-border hover:bg-sidebar-accent" onClick={() => setSelected(new Set())}>
                清除
              </button>
            </>
          )}
          {batchBusy && <span className="text-muted-foreground">执行中…</span>}
          {batchFail > 0 && <span className="text-destructive" title="部分条目操作失败（重名冲突 / 外部修改等）">{batchFail} 项失败</span>}
        </div>
      )}

      {/* 批量移动：选目标目录（含根目录） */}
      {moveAsk && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setMoveAsk(null)}>
          <div
            className="bg-card border border-border rounded-lg shadow-xl p-4 w-80 max-w-[90vw] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium mb-1">移动 {moveAsk.length} 项到…</div>
            <div className="text-xs text-muted-foreground mb-2">同目录项与目标子目录自动跳过</div>
            <div className="max-h-72 overflow-auto space-y-0.5" data-wb-movetargets>
              <button
                className="w-full text-left px-2 py-1.5 rounded hover:bg-accent text-sm"
                onClick={() => {
                  const paths = moveAsk;
                  setMoveAsk(null);
                  batchMove(paths, '');
                }}
              >
                （知识库根目录）
              </button>
              {tree.dirs.map((d) => (
                <button
                  key={d.path}
                  className="w-full text-left px-2 py-1.5 rounded hover:bg-accent text-sm truncate"
                  title={d.path}
                  onClick={() => {
                    const paths = moveAsk;
                    setMoveAsk(null);
                    batchMove(paths, d.path);
                  }}
                >
                  {d.path}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <EntryActionDialogs action={action} tree={tree} onClose={() => setAction(null)} onDone={onActionDone} />
      <CreateEntryDialog target={target} onClose={() => setTarget(null)} onCreated={onCreated} />
    </div>
  );
}
