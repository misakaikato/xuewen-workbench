// 文件列表浏览：按目录/类型筛选，面包屑，路径可辨认同名文件
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useApp } from '@/store/app';
import type { TreeNode, FileEntry } from '@/lib/types';
import { extIcon } from '@/lib/extIcon';

function collect(node: TreeNode, dirPrefix: string, out: FileEntry[]) {
  const inScope = (p: string) => !dirPrefix || p === dirPrefix || p.startsWith(dirPrefix + '/');
  if (inScope(node.path)) out.push(...node.files);
  for (const d of node.dirs) collect(d, dirPrefix, out);
}

export default function Browse() {
  const { tree } = useApp();
  const [params] = useSearchParams();
  const dir = params.get('dir') || '';
  const type = params.get('type') || '';
  const [localFilter, setLocalFilter] = useState('');
  const navigate = useNavigate();

  const files = useMemo(() => {
    if (!tree) return [];
    const out: FileEntry[] = [];
    collect(tree, dir, out);
    let list = out;
    if (type) list = list.filter((f) => f.ext === type);
    if (localFilter.trim()) {
      const f = localFilter.trim().toLowerCase();
      list = list.filter((x) => x.name.toLowerCase().includes(f) || x.path.toLowerCase().includes(f));
    }
    return list;
  }, [tree, dir, type, localFilter]);

  const crumbs = dir ? dir.split('/') : [];

  return (
    <div className="max-w-4xl mx-auto py-6 px-4">
      <nav className="text-xs text-muted-foreground mb-3 flex items-center gap-1 flex-wrap">
        <Link to="/" className="hover:text-primary">概览</Link>
        <span>/</span>
        <Link to="/browse" className="hover:text-primary">全部文件</Link>
        {crumbs.map((seg, i) => (
          <span key={i} className="flex items-center gap-1">
            <span>/</span>
            <Link
              to={'/browse?dir=' + encodeURIComponent(crumbs.slice(0, i + 1).join('/'))}
              className="hover:text-primary"
            >
              {seg}
            </Link>
          </span>
        ))}
        {type && <span className="ml-2 px-1.5 py-0.5 rounded bg-secondary">类型 {type}</span>}
      </nav>

      <div className="flex items-center gap-2 mb-4">
        <h1 className="text-lg font-bold">{dir || '全部文件'}</h1>
        <span className="text-xs text-muted-foreground stat-num">{files.length} 个文件</span>
        <div className="flex-1" />
        <input
          value={localFilter}
          onChange={(e) => setLocalFilter(e.target.value)}
          placeholder="在当前范围过滤…"
          className="text-xs px-2 py-1.5 rounded border border-input bg-card w-52"
        />
      </div>

      {files.length === 0 ? (
        <div className="text-sm text-muted-foreground border border-dashed border-border rounded-lg p-6 text-center">
          当前范围没有匹配的文件
        </div>
      ) : (
        <ul className="bg-card border border-border rounded-lg divide-y divide-border">
          {files.map((f) => (
            <li key={f.path}>
              <button
                className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-accent/60 text-left"
                onClick={() => navigate('/read/' + f.path.split('/').map(encodeURIComponent).join('/'))}
              >
                {extIcon(f.ext)}
                <span className="font-medium text-sm">{f.name}</span>
                <span className="text-xs text-muted-foreground truncate flex-1">{f.dir || '(根目录)'}</span>
                <span className="text-xs text-muted-foreground stat-num shrink-0">
                  {(f.size / 1024).toFixed(1)} KB
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
