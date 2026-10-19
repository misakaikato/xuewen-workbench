// 文件/文件夹操作对话框：重命名、移动到…（数据源内目录选择）、删除（移入回收站）
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Folder } from 'lucide-react';
import { runEntryAction, type EntryAction } from '@/lib/entryOps';
import type { TreeNode } from '@/lib/types';

export type { EntryAction };

// 结果：newPath 为 null 表示已删除
export type EntryDone = (action: EntryAction, newPath: string | null) => void;

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function flattenDirs(node: TreeNode, out: string[] = []): string[] {
  for (const d of node.dirs) {
    out.push(d.path);
    flattenDirs(d, out);
  }
  return out;
}

export function EntryActionDialogs({
  action, tree, onClose, onDone,
}: { action: EntryAction | null; tree: TreeNode; onClose: () => void; onDone: EntryDone }) {
  const [value, setValue] = useState('');
  const [filter, setFilter] = useState('');
  const [targetDir, setTargetDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!action) return;
    setValue(action.name); setFilter(''); setTargetDir(null); setError(null); setBusy(false);
    if (action.type === 'rename') {
      // 文件默认只选中主体名，便于直接改名
      setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const dot = action.isDir ? -1 : action.name.lastIndexOf('.');
        el.setSelectionRange(0, dot > 0 ? dot : action.name.length);
      }, 30);
    }
  }, [action]);

  const allDirs = useMemo(() => ['', ...flattenDirs(tree)], [tree]);

  // 统一走 runEntryAction：重命名/移动前先 flush 打开中的编辑器，成功后刷新树、
  // 迁移草稿并跟随导航到新路径（wbFollow，编辑页不重置缓冲区）
  async function run(fn: () => Promise<{ newPath: string | null }>, isDelete = false) {
    if (!action) return;
    setBusy(true); setError(null);
    try {
      const r = await fn();
      onDone(action, isDelete ? null : r.newPath ?? null);
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!action) return null;
  const close = (o: boolean) => { if (!o && !busy) onClose(); };
  const errorLine = error && <p className="text-xs text-destructive break-all" role="alert">{error}</p>;

  if (action.type === 'delete') {
    return (
      <AlertDialog open onOpenChange={close}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除{action.isDir ? '文件夹' : '文档'}？</AlertDialogTitle>
            <AlertDialogDescription className="break-all">
              「{action.path}」{action.isDir ? '及其中全部内容' : '及其元数据文件（如有）'}将移到回收站
              （系统废纸篓；不可用时移入知识库内的 .trash/ 文件夹），可从回收站恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {errorLine}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => { e.preventDefault(); run(() => runEntryAction({ ...action }), true); }}
            >
              {busy ? '删除中…' : '移到回收站'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  if (action.type === 'rename') {
    return (
      <Dialog open onOpenChange={close}>
        <DialogContent className="sm:max-w-md">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!value.trim()) { setError('名称不能为空'); return; }
              run(() => runEntryAction({ ...action, newName: value.trim() }));
            }}
          >
            <DialogHeader>
              <DialogTitle>重命名{action.isDir ? '文件夹' : '文档'}</DialogTitle>
              <DialogDescription className="break-all">{action.path}</DialogDescription>
            </DialogHeader>
            <Input ref={inputRef} value={value} onChange={(e) => { setValue(e.target.value); setError(null); }} aria-invalid={!!error} />
            {!action.isDir && <p className="text-xs text-muted-foreground">元数据文件会一起重命名；扩展名省略时自动保留。</p>}
            {errorLine}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
              <Button type="submit" disabled={busy || value.trim() === action.name}>{busy ? '处理中…' : '重命名'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  }

  // 移动到…
  const from = parentOf(action.path);
  const f = filter.trim().toLowerCase();
  const blocked = (d: string) => d === from || (action.isDir && (d === action.path || d.startsWith(action.path + '/')));
  const shown = allDirs.filter((d) => !f || d.toLowerCase().includes(f));
  return (
    <Dialog open onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>移动到…</DialogTitle>
          <DialogDescription className="break-all">{action.path}</DialogDescription>
        </DialogHeader>
        <Input placeholder="过滤目录…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="max-h-64 overflow-auto rounded border border-border p-1">
          {shown.map((d) => (
            <button
              key={d || '/'}
              type="button"
              disabled={blocked(d)}
              onClick={() => { setTargetDir(d); setError(null); }}
              className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-sm text-left disabled:opacity-40 hover:bg-accent ${
                targetDir === d ? 'bg-accent font-medium' : ''
              }`}
              style={{ paddingLeft: 8 + (d ? d.split('/').length - 1 : 0) * 12 }}
              title={d || '知识库根目录'}
            >
              <Folder className="w-4 h-4 shrink-0 text-warning" />
              <span className="truncate">{d ? d.split('/').pop() : '（知识库根目录）'}</span>
            </button>
          ))}
          {shown.length === 0 && <div className="text-xs text-muted-foreground p-2">没有匹配的目录</div>}
        </div>
        {errorLine}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button
            disabled={busy || targetDir === null}
            onClick={() => targetDir !== null && run(() => runEntryAction({ ...action, targetDir }))}
          >
            {busy ? '移动中…' : '移动到此处'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
