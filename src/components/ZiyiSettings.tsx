// 设置 → 字义库：导入字义文件（.json，或装着它的 .zip）、导出、移除。字义文件不随程序分发，数据只存本机数据目录的 ziyi/。
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileArchive, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { errorMessage, notify } from '@/lib/notify';
import { refreshZiyiStatus, useZiyiStatus, ZIYI_ORIGIN_LABEL } from '@/lib/ziyi';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export default function ZiyiSettings() {
  const status = useZiyiStatus();
  const fileRef = useRef<HTMLInputElement>(null);
  const [keepEdited, setKeepEdited] = useState(true);
  const [busy, setBusy] = useState<null | 'import' | 'export' | 'remove'>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const installed = status?.installed === true;
  const edited = status?.editedCount ?? 0;

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy('import');
    try {
      const r = await api.ziyiImport(f, f.name, keepEdited);
      const parts = [`共 ${r.count} 字`, `新增 ${r.added}`, `更新 ${r.updated}`];
      if (r.removed) parts.push(`移除 ${r.removed}`);
      if (r.keptEdited) parts.push(`保留本地修改 ${r.keptEdited}`);
      if (r.invalidCount) parts.push(`${r.invalidCount} 条格式不对已跳过（如 ${r.invalid.slice(0, 3).join('、')}）`);
      notify('字义文件已导入：' + parts.join('，'), { kind: 'success', durationMs: r.invalidCount ? 0 : undefined });
      await refreshZiyiStatus();
    } catch (e) {
      notify('导入字义文件失败：' + errorMessage(e), { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const onExport = async () => {
    setBusy('export');
    try {
      const r = await api.ziyiExport();
      notify('已导出字义文件：' + r.file, { kind: 'success' });
    } catch (e) {
      notify('导出失败：' + errorMessage(e), { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const onRemove = async () => {
    setBusy('remove');
    try {
      const r = await api.ziyiUninstall();
      setConfirmRemove(false);
      notify('字义库已移除' + (r.backup ? '，备份在 ' + r.backup : ''), { kind: 'success' });
      await refreshZiyiStatus();
    } catch (e) {
      notify('移除失败：' + errorMessage(e), { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="bg-card border border-border rounded-lg p-4" data-wb-ziyi-settings>
      <h2 className="text-sm font-semibold mb-1">字义库</h2>
      <p className="text-xs text-muted-foreground mb-3">
        字义文件是一个 JSON（也可以压成 .zip），每条字义标有出处：课堂讲解或 AI 推导。可用
        <code className="text-xs">scripts/build-ziyi-pack.mjs</code> 把课堂讲解与 AI 推导两个目录合并生成。
        字义文件不随程序分发，导入后只保存在本机数据目录的 <code className="text-xs">ziyi/</code> 下；
        导入后可在顶栏「字义」检索编辑，阅读时选中字或按住 Alt（⌥）点击字查看。
      </p>

      <div className="text-sm mb-3" data-wb-ziyi-status>
        {status === null ? (
          <span className="text-muted-foreground">正在读取…</span>
        ) : installed ? (
          <span>
            已导入 <span className="stat-num">{status.count}</span> 字
            {(['lecture', 'ai', 'local'] as const).some((o) => status.origins[o]) && (
              <>（{(['lecture', 'ai', 'local'] as const).filter((o) => status.origins[o]).map((o) => `${ZIYI_ORIGIN_LABEL[o]} ${status.origins[o]}`).join('，')}）</>
            )}
            {edited > 0 && <>，其中本地修改或新建 <span className="stat-num">{edited}</span> 字</>}
            {status.sourceName && <span className="text-xs text-muted-foreground">（来自 {status.sourceName}{status.importedAt ? '，' + new Date(status.importedAt).toLocaleString() : ''}）</span>}
            <Link to="/ziyi" className="ml-2 text-xs text-primary hover:underline">打开字义库</Link>
          </span>
        ) : (
          <span className="text-muted-foreground">尚未导入字义库</span>
        )}
      </div>

      {installed && edited > 0 && (
        <label className="flex items-center gap-2 text-xs mb-3">
          <Checkbox checked={keepEdited} onCheckedChange={(v) => setKeepEdited(v === true)} />
          再次导入时保留我改过或新建的 {edited} 个字（不勾选则以字义文件为准）
        </label>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" loading={busy === 'import'} disabled={busy !== null} onClick={() => fileRef.current?.click()}>
          <FileArchive /> {busy === 'import' ? '导入中…' : installed ? '导入字义文件（替换）' : '导入字义文件（.json / .zip）'}
        </Button>
        <input
          ref={fileRef}
          data-wb-ziyi-file
          type="file"
          accept=".json,.zip,application/json,application/zip"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void onFile(f); }}
        />
        {installed && (
          <>
            <Button variant="outline" size="sm" loading={busy === 'export'} disabled={busy !== null} onClick={() => { void onExport(); }}>
              <Download /> 导出（含本地修改）
            </Button>
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
              <Trash2 /> 移除字义库
            </Button>
          </>
        )}
      </div>
      {installed && <p className="text-xs text-muted-foreground mt-2">每次替换或移除前会自动备份到数据目录的 <code className="text-xs">ziyi/backups/</code>（保留最近 5 份）。</p>}

      {confirmRemove && (
        <AlertDialog open onOpenChange={(o) => { if (!o && busy !== 'remove') setConfirmRemove(false); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>移除字义库？</AlertDialogTitle>
              <AlertDialogDescription>
                本机的 {status?.count ?? 0} 条字义将被移除（含本地修改），移除前会备份到 ziyi/backups/。之后阅读页与顶栏的字义入口会隐藏。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy === 'remove'}>取消</AlertDialogCancel>
              <Button variant="destructive" loading={busy === 'remove'} onClick={() => { void onRemove(); }}>移除</Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </section>
  );
}
