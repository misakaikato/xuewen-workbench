// 目录树：动态来自扫描结果，可折叠，支持同名文件（以路径区分）
import { useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { TreeNode } from '@/lib/types';
import { ChevronRight, ChevronDown, Folder, FolderOpen, FilePlus, FolderPlus } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Pencil, FolderInput, Trash2 } from 'lucide-react';
import { loadDraft, saveDraft, clearDraft } from '@/lib/drafts';
import { EntryActionDialogs, type EntryAction } from './EntryActionDialogs';
import { MetaIssuesBadge } from './MetaIssuesBadge';
import { useApp } from '@/store/app';
import { CreateEntryDialog, type CreateKind, type CreateTarget } from './CreateEntryDialog';

type OnCreate = (dir: string, kind: CreateKind) => void;
type OnAction = (a: EntryAction) => void;

function ActionItems({ onAction, target }: { onAction: OnAction; target: Omit<EntryAction, 'type'> }) {
  const fire = (type: EntryAction['type']) => setTimeout(() => onAction({ ...target, type }), 0);
  return (
    <>
      <ContextMenuItem onSelect={() => fire('rename')}><Pencil />重命名</ContextMenuItem>
      <ContextMenuItem onSelect={() => fire('move')}><FolderInput />移动到…</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onSelect={() => fire('delete')}><Trash2 />删除</ContextMenuItem>
    </>
  );
}
import { extIcon } from './RefChip';

function Node({
  node,
  depth,
  filter,
  currentPath,
  onCreate,
  onAction,
}: {
  node: TreeNode;
  depth: number;
  filter: string;
  currentPath?: string;
  onCreate: OnCreate;
  onAction: OnAction;
}) {
  const [open, setOpen] = useState(depth < 1);
  const navigate = useNavigate();
  const f = filter.trim().toLowerCase();
  // 从菜单打开对话框时延后一帧，避免菜单关闭与对话框焦点管理冲突
  const create = (kind: CreateKind) => { setOpen(true); setTimeout(() => onCreate(node.path, kind), 0); };

  const dirs = useMemo(
    () =>
      node.dirs.filter(
        (d) => !f || d.name.toLowerCase().includes(f) || JSON.stringify(d).toLowerCase().includes(f)
      ),
    [node.dirs, f]
  );
  const files = useMemo(
    () => node.files.filter((x) => !f || x.name.toLowerCase().includes(f) || x.path.toLowerCase().includes(f)),
    [node.files, f]
  );

  return (
    <div>
      {node.path !== '' && (
        <ContextMenu>
        <ContextMenuTrigger asChild>
        <div
          className="group flex items-center gap-1 py-1 px-1.5 rounded cursor-pointer hover:bg-sidebar-accent text-sm select-none"
          style={{ paddingLeft: depth * 14 + 4 }}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
          {open ? <FolderOpen className="w-4 h-4 shrink-0 text-amber-600" /> : <Folder className="w-4 h-4 shrink-0 text-amber-600" />}
          <button
            className="truncate text-left flex-1"
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
          <ActionItems onAction={onAction} target={{ path: node.path, name: node.name, isDir: true }} />
        </ContextMenuContent>
        </ContextMenu>
      )}
      {(node.path === '' || open) && (
        <>
          {dirs.map((d) => (
            <Node key={d.path} node={d} depth={depth + (node.path === '' ? 0 : 1)} filter={filter} currentPath={currentPath} onCreate={onCreate} onAction={onAction} />
          ))}
          {files.map((x) => (
            <ContextMenu key={x.path}>
            <ContextMenuTrigger asChild>
            <button
              className={`w-full flex items-center gap-1.5 py-1 px-1.5 rounded text-sm text-left hover:bg-sidebar-accent ${
                currentPath === x.path ? 'bg-sidebar-accent font-medium text-primary' : ''
              }`}
              style={{ paddingLeft: (depth + (node.path === '' ? 0 : 1)) * 14 + 22 }}
              onClick={() => navigate('/read/' + x.path.split('/').map(encodeURIComponent).join('/'))}
              title={x.path}
            >
              {extIcon(x.ext)}
              <span className="truncate">{x.name}</span>
            </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ActionItems onAction={onAction} target={{ path: x.path, name: x.name, isDir: false }} />
            </ContextMenuContent>
            </ContextMenu>
          ))}
        </>
      )}
    </div>
  );
}

export function FileTree({ tree, filter }: { tree: TreeNode; filter: string }) {
  const params = useParams();
  const currentPath = params['*'] ? decodeURIComponent(params['*']) : undefined;
  const navigate = useNavigate();
  const { refreshTree, dsId } = useApp();
  const location = useLocation();
  const [action, setAction] = useState<EntryAction | null>(null);
  const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
  // 当前打开的文档被重命名/移动时跟随到新路径（迁移草稿）；被删除时关闭
  const onActionDone = async (a: EntryAction, newPath: string | null) => {
    setAction(null);
    await refreshTree().catch(() => {});
    const m = location.pathname.match(/^\/(read|edit)\//);
    const cur = currentPath;
    if (!m || !cur) return;
    const affected = cur === a.path || (a.isDir && cur.startsWith(a.path + '/'));
    if (!affected) return;
    if (newPath === null) { navigate('/', { replace: true, state: { wbFollow: true } }); return; }
    const next = newPath + cur.slice(a.path.length);
    if (dsId) {
      const d = loadDraft(dsId, cur);
      if (d) { saveDraft(dsId, next, d.content); clearDraft(dsId, cur); }
    }
    navigate('/' + m[1] + '/' + enc(next), { replace: true, state: { wbFollow: true } });
  };
  const [target, setTarget] = useState<CreateTarget | null>(null);
  const onCreate: OnCreate = (dir, kind) => setTarget({ dir, kind });
  const onCreated = async (p: string, kind: CreateKind) => {
    setTarget(null);
    await refreshTree().catch(() => {});
    if (kind === 'md') navigate('/edit/' + p.split('/').map(encodeURIComponent).join('/'));
  };
  return (
    <div className="text-sidebar-foreground">
      <div className="flex items-center gap-1 px-1 pb-1 mb-1 border-b border-sidebar-border">
        <button
          className="flex items-center gap-1 text-xs px-1.5 py-1 rounded hover:bg-sidebar-accent"
          onClick={() => onCreate('', 'md')}
          title="在数据源根目录新建文档"
        >
          <FilePlus className="w-3.5 h-3.5" />新建文档
        </button>
        <button
          className="flex items-center gap-1 text-xs px-1.5 py-1 rounded hover:bg-sidebar-accent"
          onClick={() => onCreate('', 'folder')}
          title="在数据源根目录新建文件夹"
        >
          <FolderPlus className="w-3.5 h-3.5" />新建文件夹
        </button>
        <MetaIssuesBadge tree={tree} />
      </div>
      <Node node={tree} depth={0} filter={filter} currentPath={currentPath} onCreate={onCreate} onAction={setAction} />
      <EntryActionDialogs action={action} tree={tree} onClose={() => setAction(null)} onDone={onActionDone} />
      <CreateEntryDialog target={target} onClose={() => setTarget(null)} onCreated={onCreated} />
      {tree.files.length === 0 && tree.dirs.length === 0 && (
        <div className="text-xs text-muted-foreground p-3">数据源中没有可支持的文件（.md / .json / .doc / .docx）</div>
      )}
    </div>
  );
}
