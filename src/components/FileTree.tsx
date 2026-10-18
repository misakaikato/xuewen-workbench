// 目录树：动态来自扫描结果，可折叠，支持同名文件（以路径区分）。
// 展开状态按资料库持久化（localStorage），跟随当前阅读/浏览位置自动展开父链并滚动定位（reveal）；
// 过滤时切换为平铺结果模式（命中高亮 + 转全文检索）；支持键盘导航（↑↓←→/Enter/Home/End/F2/Delete/首字母跳转）；
// 右键菜单含复制文件名/相对路径/集合引用与在系统中显示；行内徽标提示本地草稿与元数据问题。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { TreeNode, FileEntry, Collection } from '@/lib/types';
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, FilePlus, FolderPlus,
  Pencil, FolderInput, Trash2, ChevronsDownUp, ChevronsUpDown,
  Copy, Quote, ExternalLink, PenLine, AlertTriangle,
} from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { EntryActionDialogs, type EntryAction } from './EntryActionDialogs';
import { MetaIssuesBadge } from './MetaIssuesBadge';
import { useApp } from '@/store/app';
import { CreateEntryDialog, type CreateKind, type CreateTarget } from './CreateEntryDialog';
import { extIcon } from '@/lib/extIcon';
import { api, type MetaIssue } from '@/lib/api';

type OnCreate = (dir: string, kind: CreateKind) => void;
type OnAction = (a: EntryAction) => void;
type Entry = Omit<EntryAction, 'type'>; // { path, name, isDir }

// ---- 路径与展开集工具 ----

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

const nameOf = (p: string) => p.split('/').pop() || p;

// 'a/b/c' -> ['a', 'a/b']（不含自身）
function ancestorDirs(p: string): string[] {
  const segs = p.split('/');
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join('/'));
  return out;
}

const openKey = (id: string) => `wb.filetree.open.${id}`;

function loadOpen(id: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(openKey(id));
    if (!raw) return null;
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    return null;
  }
}

function saveOpen(id: string, set: Set<string>) {
  try {
    localStorage.setItem(openKey(id), JSON.stringify([...set]));
  } catch {
    /* 隐私模式/配额问题：忽略，当次会话内仍有效 */
  }
}

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

// 行内徽标：本地草稿（琥珀色笔）/ 元数据旁注问题（红色警告）
function RowBadges({ path, drafts, metaMsgs }: { path: string; drafts: Set<string>; metaMsgs: Map<string, string[]> }) {
  const msgs = metaMsgs.get(path);
  if (!drafts.has(path) && !msgs) return null;
  return (
    <span className="flex items-center gap-0.5 shrink-0">
      {drafts.has(path) && (
        <span title="存在本地草稿（上次未完成的编辑）">
          <PenLine className="w-3 h-3 text-amber-600" />
        </span>
      )}
      {msgs && (
        <span title={msgs.join('\n')}>
          <AlertTriangle className="w-3 h-3 text-red-500" />
        </span>
      )}
    </span>
  );
}

// 复制到剪贴板（http://127.0.0.1 为安全上下文，clipboard API 可用；失败静默）
const copyText = (t: string) => navigator.clipboard.writeText(t).catch(() => {});

function ActionItems({ entry, onAction, colRef }: { entry: Entry; onAction: OnAction; colRef?: string | null }) {
  const fire = (type: EntryAction['type']) => setTimeout(() => onAction({ ...entry, type }), 0);
  return (
    <>
      <ContextMenuItem onSelect={() => fire('rename')}><Pencil />重命名</ContextMenuItem>
      <ContextMenuItem onSelect={() => fire('move')}><FolderInput />移动到…</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => copyText(entry.name)}><Copy />复制文件名</ContextMenuItem>
      <ContextMenuItem onSelect={() => copyText(entry.path)}><Copy />复制相对路径</ContextMenuItem>
      {colRef && (
        <ContextMenuItem onSelect={() => copyText(colRef)}><Quote />复制集合引用「{colRef.split('|')[0]}」</ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => { api.revealInSystem(entry.path).catch(() => {}); }}>
        <ExternalLink />在系统中显示
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onSelect={() => fire('delete')}><Trash2 />删除</ContextMenuItem>
    </>
  );
}

function Node({
  node,
  depth,
  currentPath,
  currentDir,
  isOpen,
  onToggleDir,
  onEnsureOpen,
  onCreate,
  onAction,
  colRefOf,
  drafts,
  metaMsgs,
}: {
  node: TreeNode;
  depth: number;
  currentPath?: string;
  currentDir: string | null;
  isOpen: (p: string) => boolean;
  onToggleDir: (p: string) => void;
  onEnsureOpen: (p: string) => void;
  onCreate: OnCreate;
  onAction: OnAction;
  colRefOf: (p: string) => string | null;
  drafts: Set<string>;
  metaMsgs: Map<string, string[]>;
}) {
  const navigate = useNavigate();
  // 从菜单打开对话框时延后一帧，避免菜单关闭与对话框焦点管理冲突
  const create = (kind: CreateKind) => { onEnsureOpen(node.path); setTimeout(() => onCreate(node.path, kind), 0); };
  const open = node.path === '' || isOpen(node.path);
  const active = currentDir !== null && currentDir === node.path;
  const childDepth = depth + (node.path === '' ? 0 : 1);

  return (
    <div>
      {node.path !== '' && (
        <ContextMenu>
        <ContextMenuTrigger asChild>
        <div
          data-tpath={node.path} data-name={node.name} data-kind="dir" data-open={open ? '1' : '0'}
          tabIndex={-1}
          className={`group flex items-center gap-1 py-1 px-1.5 rounded cursor-pointer hover:bg-sidebar-accent text-sm select-none focus:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
            active ? 'bg-sidebar-accent' : ''
          }`}
          style={{ paddingLeft: depth * 14 + 4 }}
          onClick={() => onToggleDir(node.path)}
        >
          {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
          {open ? <FolderOpen className="w-4 h-4 shrink-0 text-amber-600" /> : <Folder className="w-4 h-4 shrink-0 text-amber-600" />}
          <button
            className={`truncate text-left flex-1 ${active ? 'text-primary font-medium' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              navigate('/browse?dir=' + encodeURIComponent(node.path));
            }}
            title={node.path}
          >
            {node.name}
          </button>
          <span className="hidden group-hover:flex group-focus-within:flex items-center gap-0.5 shrink-0">
            <button
              className="p-0.5 rounded hover:bg-background"
              title="新建文档" aria-label="新建文档"
              onClick={(e) => { e.stopPropagation(); create('md'); }}
            >
              <FilePlus className="w-3.5 h-3.5" />
            </button>
            <button
              className="p-0.5 rounded hover:bg-background"
              title="新建文件夹" aria-label="新建文件夹"
              onClick={(e) => { e.stopPropagation(); create('folder'); }}
            >
              <FolderPlus className="w-3.5 h-3.5" />
            </button>
          </span>
        </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => create('md')}><FilePlus />新建文档</ContextMenuItem>
          <ContextMenuItem onSelect={() => create('folder')}><FolderPlus />新建文件夹</ContextMenuItem>
          <ContextMenuSeparator />
          <ActionItems entry={{ path: node.path, name: node.name, isDir: true }} onAction={onAction} colRef={null} />
        </ContextMenuContent>
        </ContextMenu>
      )}
      {(node.path === '' || open) && (
        <>
          {node.dirs.map((d) => (
            <Node key={d.path} node={d} depth={childDepth} currentPath={currentPath} currentDir={currentDir}
              isOpen={isOpen} onToggleDir={onToggleDir} onEnsureOpen={onEnsureOpen} onCreate={onCreate} onAction={onAction}
              colRefOf={colRefOf} drafts={drafts} metaMsgs={metaMsgs} />
          ))}
          {node.files.map((x) => (
            <ContextMenu key={x.path}>
            <ContextMenuTrigger asChild>
            <button
              data-tpath={x.path} data-name={x.name} data-kind="file"
              className={`w-full flex items-center gap-1.5 py-1 px-1.5 rounded text-sm text-left hover:bg-sidebar-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                currentPath === x.path ? 'bg-sidebar-accent font-medium text-primary' : ''
              }`}
              style={{ paddingLeft: childDepth * 14 + 22 }}
              onClick={() => navigate('/read/' + x.path.split('/').map(encodeURIComponent).join('/'))}
              title={x.path}
            >
              {extIcon(x.ext)}
              <span className="truncate">{x.name}</span>
              <RowBadges path={x.path} drafts={drafts} metaMsgs={metaMsgs} />
            </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ActionItems entry={{ path: x.path, name: x.name, isDir: false }} onAction={onAction} colRef={colRefOf(x.path)} />
            </ContextMenuContent>
            </ContextMenu>
          ))}
        </>
      )}
    </div>
  );
}

// 平铺结果模式：过滤时不再展示层级，所有命中文件平铺、显示相对路径、高亮命中片段
function collectFiles(n: TreeNode, out: FileEntry[] = []): FileEntry[] {
  out.push(...n.files);
  for (const d of n.dirs) collectFiles(d, out);
  return out;
}

function FlatResults({
  tree,
  filter,
  onAction,
  onFilterChange,
  colRefOf,
  drafts,
  metaMsgs,
}: {
  tree: TreeNode;
  filter: string;
  onAction: OnAction;
  onFilterChange: (v: string) => void;
  colRefOf: (p: string) => string | null;
  drafts: Set<string>;
  metaMsgs: Map<string, string[]>;
}) {
  const navigate = useNavigate();
  const f = filter.trim().toLowerCase();
  const open = (x: FileEntry) => {
    // 打开后清空过滤，回到树视图并 reveal 到该文件
    onFilterChange('');
    navigate('/read/' + x.path.split('/').map(encodeURIComponent).join('/'));
  };
  const files = useMemo(() => {
    const out = collectFiles(tree).filter((x) => x.name.toLowerCase().includes(f) || x.path.toLowerCase().includes(f));
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }, [tree, f]);

  return (
    <div>
      <div className="flex items-center gap-2 px-1.5 py-1 text-[11px] text-muted-foreground">
        <span className="stat-num">{files.length}</span> 个匹配文件
        <span className="flex-1" />
        <button className="hover:text-primary" onClick={() => navigate('/search?q=' + encodeURIComponent(filter.trim()))}>
          转全文检索 →
        </button>
      </div>
      {files.length === 0 ? (
        <div className="text-xs text-muted-foreground p-3">没有文件名或路径匹配「{filter.trim()}」</div>
      ) : (
        files.map((x) => (
          <ContextMenu key={x.path}>
          <ContextMenuTrigger asChild>
          <button
            data-tpath={x.path} data-name={x.name} data-kind="file"
            className="w-full flex items-center gap-1.5 py-1 px-1.5 rounded text-sm text-left hover:bg-sidebar-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => open(x)}
            title={x.path}
          >
            {extIcon(x.ext)}
            <span className="truncate"><Highlight text={x.name} q={f} /></span>
            <RowBadges path={x.path} drafts={drafts} metaMsgs={metaMsgs} />
            <span className="ml-auto pl-2 shrink-0 max-w-[45%] truncate text-[11px] text-muted-foreground" title={x.dir}>
              {x.dir}
            </span>
          </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ActionItems entry={{ path: x.path, name: x.name, isDir: false }} onAction={onAction} colRef={colRefOf(x.path)} />
          </ContextMenuContent>
          </ContextMenu>
        ))
      )}
    </div>
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
  // /browse 时跟随并高亮当前目录；/read、/edit 跟随当前文件
  const currentDir = location.pathname === '/browse' ? searchParams.get('dir') || '' : null;
  const navigate = useNavigate();
  const { refreshTree, dsId } = useApp();
  const [action, setAction] = useState<EntryAction | null>(null);
  // 刷新树、迁移草稿、跟随导航均已由 runEntryAction（lib/entryOps）统一完成，这里只关闭对话框
  const onActionDone = () => {
    setAction(null);
  };
  const [target, setTarget] = useState<CreateTarget | null>(null);
  const onCreate: OnCreate = (dir, kind) => setTarget({ dir, kind });
  const onCreated = async (p: string, kind: CreateKind) => {
    setTarget(null);
    await refreshTree().catch(() => {});
    if (kind === 'md') navigate('/edit/' + p.split('/').map(encodeURIComponent).join('/'));
  };

  // 元数据旁注问题（供头部徽标汇总与行内红点），集合配置（供「复制集合引用」）
  const [metaIssues, setMetaIssues] = useState<MetaIssue[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  useEffect(() => {
    let dead = false;
    api.metaIssues().then((r) => { if (!dead) setMetaIssues(r.issues); }).catch(() => {});
    api.collections().then((r) => { if (!dead) setCollections(r.collections); }).catch(() => {});
    return () => { dead = true; };
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

  // 本地草稿集合（wb:draft:<dsId>:<path>）；导航/树刷新时重算
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
    // 依赖故意超出实际使用：导航/过滤/树刷新时重算，让新写入的草稿及时反映为徽标
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsId, tree, currentPath, currentDir, filter]);

  // 集合引用：文件目录落在某集合目录（或其子目录）内时给出「集合|文件名」
  const colRefOf = (filePath: string): string | null => {
    const dir = dirOf(filePath);
    for (const c of collections) {
      for (const d of c.dirs) {
        if (dir === d || dir.startsWith(d + '/')) return `${c.name}|${nameOf(filePath)}`;
      }
    }
    return null;
  };

  // 展开集随资料库整体替换，避免把 A 库的状态写到 B 库
  const [openState, setOpenState] = useState<{ dsId: string | null; set: Set<string> }>({ dsId: null, set: new Set() });
  const containerRef = useRef<HTMLDivElement>(null);
  const revealedRef = useRef<string | null>(null);
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);

  // 新库初始化（无存档时默认展开第一层，与旧行为一致）；树刷新后清掉已消失的目录
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

  // 持久化展开集
  useEffect(() => {
    if (!dsId || openState.dsId !== dsId) return;
    saveOpen(dsId, openState.set);
  }, [openState, dsId]);

  const applyOpen = (fn: (set: Set<string>) => Set<string>) =>
    setOpenState((prev) => {
      if (prev.dsId !== dsId) return prev;
      const next = fn(prev.set);
      return next === prev.set ? prev : { dsId: prev.dsId, set: next };
    });
  const isOpen = (p: string) => openState.dsId === dsId && openState.set.has(p);
  const toggleDir = (p: string) =>
    applyOpen((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  const ensureOpen = (p: string) => applyOpen((s) => (s.has(p) ? s : new Set(s).add(p)));

  // 跟随当前文件/目录：展开父链后滚动定位；同一目标只处理一次，重扫刷新不打断
  const revealKey =
    currentPath !== undefined ? 'f:' + currentPath : currentDir ? 'd:' + currentDir : null;
  useEffect(() => {
    if (!tree || !revealKey || revealedRef.current === revealKey) return;
    revealedRef.current = revealKey;
    const targetPath = revealKey.slice(2);
    // 文件 → 展开它所在目录的整条父链（含自身）；目录 → 展开它的父链（含自身）
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
    setPendingScroll(targetPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, revealKey]);
  useEffect(() => {
    if (!pendingScroll) return;
    const el = containerRef.current?.querySelector(`[data-tpath="${CSS.escape(pendingScroll)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [pendingScroll]);

  // 键盘导航：DOM 顺序即视觉顺序；↑↓/Home/End 移动，→← 展开/折叠/回父级，Enter 打开，F2/Delete 操作，可打印字符首字母跳转
  const typeBufRef = useRef('');
  const typeAtRef = useRef(0);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const cont = containerRef.current;
    if (!cont) return;
    const all = Array.from(cont.querySelectorAll<HTMLElement>('[data-tpath]'));
    if (!all.length) return;
    const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const row = activeEl?.closest('[data-tpath]');
    const cur = row && cont.contains(row) ? (row as HTMLElement) : null;
    const idx = cur ? all.indexOf(cur) : -1;
    const focusAt = (i: number) => {
      const el = all[Math.max(0, Math.min(all.length - 1, i))];
      el?.focus();
      el?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(idx + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(idx - 1); return; }
    if (e.key === 'Home') { e.preventDefault(); focusAt(0); return; }
    if (e.key === 'End') { e.preventDefault(); focusAt(all.length - 1); return; }
    if (!cur) return;
    const entryPath = cur.getAttribute('data-tpath') || '';
    const name = cur.getAttribute('data-name') || nameOf(entryPath);
    const isDir = cur.getAttribute('data-kind') === 'dir';
    const open = cur.getAttribute('data-open') === '1';
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (isDir && !open) toggleDir(entryPath);
      else focusAt(idx + 1);
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (isDir && open) toggleDir(entryPath);
      else {
        const parent = cont.querySelector<HTMLElement>(`[data-tpath="${CSS.escape(dirOf(entryPath))}"]`);
        parent?.focus();
        parent?.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isDir) toggleDir(entryPath);
      else navigate('/read/' + entryPath.split('/').map(encodeURIComponent).join('/'));
      return;
    }
    if (e.key === 'F2') {
      e.preventDefault();
      setTimeout(() => setAction({ type: 'rename', path: entryPath, name, isDir }), 0);
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      setTimeout(() => setAction({ type: 'delete', path: entryPath, name, isDir }), 0);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      typeBufRef.current = now - typeAtRef.current > 800 ? e.key : typeBufRef.current + e.key;
      typeAtRef.current = now;
      const buf = typeBufRef.current.toLowerCase();
      for (let k = 1; k <= all.length; k++) {
        const i = ((idx >= 0 ? idx : 0) + k) % all.length;
        const n = (all[i].getAttribute('data-name') || '').toLowerCase();
        if (n.startsWith(buf)) { focusAt(i); break; }
      }
      e.preventDefault();
    }
  };

  const collapseAll = () => setOpenState((prev) => (prev.dsId === dsId ? { dsId, set: new Set() } : prev));
  const expandAll = () => {
    if (countFiles(tree) > 3000 && !window.confirm('这个资料库文件较多，全部展开可能让页面卡顿。仍要继续吗？')) return;
    setOpenState((prev) => (prev.dsId === dsId ? { dsId, set: new Set(allDirPaths(tree)) } : prev));
  };
  const filtering = !!filter.trim();

  return (
    <div className="text-sidebar-foreground outline-none" ref={containerRef} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="flex items-center gap-1 px-1 pb-1 mb-1 border-b border-sidebar-border">
        <button
          className="flex items-center gap-1 text-xs px-1.5 py-1 rounded hover:bg-sidebar-accent"
          onClick={() => onCreate('', 'md')}
          title="在资料库根目录新建文档"
        >
          <FilePlus className="w-3.5 h-3.5" />新建文档
        </button>
        <button
          className="flex items-center gap-1 text-xs px-1.5 py-1 rounded hover:bg-sidebar-accent"
          onClick={() => onCreate('', 'folder')}
          title="在资料库根目录新建文件夹"
        >
          <FolderPlus className="w-3.5 h-3.5" />新建文件夹
        </button>
        <span className="ml-auto flex items-center gap-0.5">
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
          <MetaIssuesBadge issues={metaIssues} />
        </span>
      </div>
      {filtering ? (
        <FlatResults tree={tree} filter={filter} onAction={setAction} onFilterChange={onFilterChange} colRefOf={colRefOf} drafts={draftPaths} metaMsgs={metaMsgs} />
      ) : (
        <Node node={tree} depth={0} currentPath={currentPath} currentDir={currentDir} isOpen={isOpen}
          onToggleDir={toggleDir} onEnsureOpen={ensureOpen} onCreate={onCreate} onAction={setAction}
          colRefOf={colRefOf} drafts={draftPaths} metaMsgs={metaMsgs} />
      )}
      <EntryActionDialogs action={action} tree={tree} onClose={() => setAction(null)} onDone={onActionDone} />
      <CreateEntryDialog target={target} onClose={() => setTarget(null)} onCreated={onCreated} />
      {tree.files.length === 0 && tree.dirs.length === 0 && (
        <div className="text-xs text-muted-foreground p-3">资料库中没有可支持的文件（.md / .json / .doc / .docx）</div>
      )}
    </div>
  );
}
