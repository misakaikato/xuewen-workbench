// 更新横幅：插在顶栏上方，渲染 /api/status 的 update 快照（唯一状态来源）。
// idle / checking / not-available / installing（由安装遮罩接管）/ enabled=false 时不渲染。
// 点击后立即进 loading，状态推进靠轮询带回，不由前端假装推进。
// 文案统一来自 src/lib/updateText.ts（平台差异只体现在文案）。
import { useState } from 'react';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import { hasUnsaved } from '@/lib/unsaved';
import { useApp } from '@/store/app-context';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { isMacPlatform, readyStatusLine, fmtEta } from '@/lib/updateText';
import { X, RotateCw, ExternalLink, RefreshCw, PackageOpen } from 'lucide-react';

type InstallIntent = 'install' | null;

export function UpdateBanner() {
  const { update, applyUpdate } = useApp();
  const [dismissed, setDismissed] = useState<string | null>(null);
  // 点击后立即 loading；busyAt 记录触发时的状态，轮询把状态带离后收起（渲染期对账，同 useDelayedFlag）
  const [busyAction, setBusyAction] = useState<'download' | 'install' | 'retry' | 'cancel' | null>(null);
  const [busyAt, setBusyAt] = useState<string | null>(null);
  const [confirmInstall, setConfirmInstall] = useState<InstallIntent>(null);

  const status = update?.status ?? null;
  if (busyAction && busyAt !== status) {
    setBusyAction(null);
    setBusyAt(null);
  }
  const startBusy = (action: 'download' | 'install' | 'retry' | 'cancel') => {
    setBusyAction(action);
    setBusyAt(status);
  };

  if (!update?.enabled) return null;
  if (['idle', 'checking', 'not-available', 'installing'].includes(update.status)) return null;
  if (update.status === 'available' && update.info?.version && update.info.version === dismissed) return null;

  const onDownload = async () => {
    startBusy('download');
    try {
      applyUpdate(await api.updateDownload());
    } catch (e) {
      setBusyAction(null);
      notify('开始下载失败：' + (e instanceof Error ? e.message : String(e)), { kind: 'error' });
    }
  };
  const doInstall = () => {
    startBusy('install');
    // install 会杀掉应用，请求可能中途断开：保持 loading 等状态推进或应用退出
    api.updateInstall().catch(() => {});
  };
  // 安装会关闭应用：有未保存改动时先确认
  const onInstall = () => {
    if (hasUnsaved()) setConfirmInstall('install');
    else doInstall();
  };
  const onCancel = async () => {
    startBusy('cancel');
    try {
      applyUpdate(await api.updateCancel());
    } catch (e) {
      setBusyAction(null);
      notify('取消下载失败：' + (e instanceof Error ? e.message : String(e)), { kind: 'error' });
    }
  };
  const onRetry = async () => {
    startBusy('retry');
    try {
      const s = await api.updateCheck();
      applyUpdate(s);
      if (s.status === 'available') applyUpdate(await api.updateDownload());
    } catch (e) {
      setBusyAction(null);
      notify('重试失败：' + (e instanceof Error ? e.message : String(e)), { kind: 'error' });
    }
  };
  const onOpenRelease = () => { api.openReleasePage().catch(() => {}); };

  const isMac = isMacPlatform();
  let body: React.ReactNode = null;

  if (update.status === 'available') {
    body = (
      <>
        <span>发现新版本 v{update.info?.version ?? '?'}，当前 v{update.currentVersion ?? '?'}</span>
        <Button
          size="sm" variant="outline" className="h-6 px-2 text-xs"
          loading={busyAction === 'download'} onClick={onDownload}
        >
          <RotateCw className="w-3 h-3" />立即更新
        </Button>
        <Button
          size="sm" variant="ghost" className="h-6 w-6 p-0" aria-label="忽略此版本提示"
          onClick={() => setDismissed(update.info?.version ?? null)}
        >
          <X className="w-3 h-3" />
        </Button>
      </>
    );
  } else if (update.status === 'downloading') {
    const p = update.progress;
    const eta = fmtEta(p?.etaSeconds ?? null);
    body = (
      <div className="flex-1 flex items-center gap-3 min-w-0">
        <span className="shrink-0 text-muted-foreground">
          {p && p.total
            ? <>正在下载 <span className="stat-num">{Math.round(p.percent)}%</span>（<span className="stat-num">{`${(p.transferred / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)}`}</span> MB）</>
            : <>正在下载 <span className="stat-num">{((p?.transferred ?? 0) / 1048576).toFixed(1)}</span> MB</>}
          {p && p.bytesPerSecond > 0 && <>，<span className="stat-num">{(p.bytesPerSecond / 1048576).toFixed(1)}</span> MB/s</>}
          {eta && <>，{eta}</>}
        </span>
        <Progress value={p?.percent ?? 0} className="h-1.5 flex-1 max-w-64" />
        {update.canCancel && (
          <Button
            size="sm" variant="ghost" className="h-6 px-2 text-xs"
            loading={busyAction === 'cancel'} onClick={onCancel}
          >
            取消
          </Button>
        )}
      </div>
    );
  } else if (update.status === 'ready') {
    const manual = isMac && update.installMode === 'manual';
    body = (
      <>
        <span className="min-w-0 truncate" title={readyStatusLine(update)}>{readyStatusLine(update)}</span>
        <Button
          size="sm" variant="outline" className="h-6 px-2 text-xs shrink-0"
          loading={busyAction === 'install'} onClick={onInstall}
        >
          {manual ? <PackageOpen className="w-3 h-3" /> : <RotateCw className="w-3 h-3" />}
          {manual ? '打开安装包并退出' : '重启并安装'}
        </Button>
      </>
    );
  } else if (update.status === 'error') {
    body = (
      <>
        <span className="truncate">更新失败：{update.error ?? '未知错误'}</span>
        <Button
          size="sm" variant="outline" className="h-6 px-2 text-xs"
          loading={busyAction === 'retry'} onClick={onRetry}
        >
          <RefreshCw className="w-3 h-3" />重试
        </Button>
        {isMac && update.installMode && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onInstall}>
            <PackageOpen className="w-3 h-3" />手动安装
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onOpenRelease}>
          <ExternalLink className="w-3 h-3" />前往发布页
        </Button>
      </>
    );
  }

  return (
    <div
      className="h-9 shrink-0 flex items-center gap-2 px-3 text-xs bg-primary/10 border-b border-border text-primary"
      role="status"
    >
      {body}
      <Dialog open={confirmInstall !== null} onOpenChange={(open) => { if (!open) setConfirmInstall(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>有未保存的修改</DialogTitle>
            <DialogDescription>有未保存的修改，安装会关闭应用。先保存再安装？</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmInstall(null)}>取消</Button>
            <Button
              size="sm"
              onClick={() => {
                setConfirmInstall(null);
                doInstall();
              }}
            >
              仍然安装
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
