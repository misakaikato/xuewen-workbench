// 库外链接确认框：文档内相对链接解析后越过知识库根时弹出，
// 用户确认后才调 /api/open-external 用系统默认应用打开（绝不静默打开库外文件）。
import { useState } from 'react';
import { api } from '@/lib/api';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';

export function ExternalLinkDialog({ path, onClose }: { path: string | null; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const open = async () => {
    if (!path) return;
    setOpening(true);
    setError(null);
    try {
      await api.openExternal(path);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOpening(false);
    }
  };

  return (
    <AlertDialog open={!!path} onOpenChange={(v) => { if (!v) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>打开知识库外部的链接？</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>该链接指向当前知识库之外的位置，将使用系统默认应用打开：</p>
              <p className="mono text-xs bg-muted rounded px-2 py-1.5 break-all select-all">{path}</p>
              {error && <p className="text-destructive text-xs">打开失败：{error}</p>}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={(e) => { e.preventDefault(); open(); }} disabled={opening}>
            {opening ? '打开中…' : '打开'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
