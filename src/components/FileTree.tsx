// 目录树：动态来自扫描结果，可折叠，支持同名文件（以路径区分）
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { TreeNode } from '@/lib/types';
import { ChevronRight, ChevronDown, Folder, FolderOpen } from 'lucide-react';
import { extIcon } from './RefChip';

function Node({
  node,
  depth,
  filter,
  currentPath,
}: {
  node: TreeNode;
  depth: number;
  filter: string;
  currentPath?: string;
}) {
  const [open, setOpen] = useState(depth < 1);
  const navigate = useNavigate();
  const f = filter.trim().toLowerCase();

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
        <div
          className="flex items-center gap-1 py-1 px-1.5 rounded cursor-pointer hover:bg-sidebar-accent text-sm select-none"
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
        </div>
      )}
      {(node.path === '' || open) && (
        <>
          {dirs.map((d) => (
            <Node key={d.path} node={d} depth={depth + (node.path === '' ? 0 : 1)} filter={filter} currentPath={currentPath} />
          ))}
          {files.map((x) => (
            <button
              key={x.path}
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
          ))}
        </>
      )}
    </div>
  );
}

export function FileTree({ tree, filter }: { tree: TreeNode; filter: string }) {
  const params = useParams();
  const currentPath = params['*'] ? decodeURIComponent(params['*']) : undefined;
  return (
    <div className="text-sidebar-foreground">
      <Node node={tree} depth={0} filter={filter} currentPath={currentPath} />
      {tree.files.length === 0 && tree.dirs.length === 0 && (
        <div className="text-xs text-muted-foreground p-3">数据源中没有可支持的文件（.md / .json / .doc / .docx）</div>
      )}
    </div>
  );
}
