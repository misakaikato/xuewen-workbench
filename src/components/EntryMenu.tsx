// 条目右键菜单的共享动作组：目录树与浏览页列表共用。
// 复制类动作直接写剪贴板；创建副本走 /api/file/duplicate；重命名/移动/删除交给 EntryActionDialogs。
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, FolderInput, Trash2, Copy, Quote, ExternalLink, Files, FolderOpen } from 'lucide-react';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { api } from '@/lib/api';
import type { Collection } from '@/lib/types';
import type { EntryAction } from '@/lib/entryOps';

export type Entry = Omit<EntryAction, 'type'>;

const copyText = (t: string) => navigator.clipboard.writeText(t).catch(() => {});

const dirOf = (p: string) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

// 集合引用：文件目录落在某集合目录（或其子目录）内时给出「集合|文件名」；
// 语义与 /api/refs/resolve 的集合范围一致（按 col.dirs 匹配）
function useCollectionRefOf() {
  const [collections, setCollections] = useState<Collection[]>([]);
  useEffect(() => {
    let dead = false;
    api.collections().then((r) => { if (!dead) setCollections(r.collections); }).catch(() => {});
    return () => { dead = true; };
  }, []);
  return useCallback((filePath: string): string | null => {
    const dir = dirOf(filePath);
    for (const c of collections) {
      for (const d of c.dirs) {
        if (dir === d || dir.startsWith(d + '/')) return `${c.name}|${filePath.split('/').pop()}`;
      }
    }
    return null;
  }, [collections]);
}

export function ActionItems({
  entry,
  onAction,
  dsId,
  onDuplicated,
}: {
  entry: Entry;
  onAction: (a: EntryAction) => void;
  /** 文件所属集合给出的「集合|文件名」引用（内部自动计算；目录或在集合外为 null） */
  dsId: string | null;
  /** 创建副本成功后的回调（刷新树） */
  onDuplicated?: (path: string) => void;
}) {
  const navigate = useNavigate();
  const colRefOf = useCollectionRefOf();
  const colRef = entry.isDir ? null : colRefOf(entry.path);
  const fire = (type: EntryAction['type']) => setTimeout(() => onAction({ ...entry, type }), 0);
  const dup = async () => {
    try {
      const r = await api.duplicateEntry({ dsId, path: entry.path });
      onDuplicated?.(r.path);
    } catch (e) {
      alert((e as Error).message);
    }
  };
  return (
    <>
      <ContextMenuItem onSelect={() => fire('rename')}><Pencil />重命名</ContextMenuItem>
      <ContextMenuItem onSelect={() => fire('move')}><FolderInput />移动到…</ContextMenuItem>
      <ContextMenuItem onSelect={() => { dup(); }}><Files />创建副本</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => copyText(entry.name)}><Copy />复制文件名</ContextMenuItem>
      <ContextMenuItem onSelect={() => copyText(entry.path)}><Copy />复制相对路径</ContextMenuItem>
      {colRef && (
        <ContextMenuItem onSelect={() => copyText(colRef)}><Quote />复制集合引用「{colRef.split('|')[0]}」</ContextMenuItem>
      )}
      <ContextMenuItem
        onSelect={() => navigate('/browse?dir=' + encodeURIComponent(entry.isDir ? entry.path : dirOf(entry.path)))}
      >
        <FolderOpen />{entry.isDir ? '在浏览页打开' : '在浏览页打开所在目录'}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => { api.revealInSystem(entry.path).catch(() => {}); }}>
        <ExternalLink />在系统中显示
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onSelect={() => fire('delete')}><Trash2 />删除</ContextMenuItem>
    </>
  );
}
