// 更新横幅：插在顶栏上方，按 /api/update/state 的快照渲染。
// idle / checking / not-available / enabled=false 时不渲染任何 DOM（不占高度）。
// 忽略（×）只隐藏当次发现的版本，不持久化。
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { X, RotateCw, ExternalLink, RefreshCw } from 'lucide-react';

function fmtMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export function UpdateBanner() {
  const { update, applyUpdate } = useApp();
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (!update?.enabled) return null;
  if (['idle', 'checking', 'not-available'].includes(update.status)) return null;
  if (update.status === 'available' && update.info?.version && update.info.version === dismissed) return null;

  const onDownload = async () => {
    try { applyUpdate(await api.updateDownload()); } catch { /* 轮询会带回最新状态 */ }
  };
  // install 会杀掉应用，请求可能中途断开，必须吞错
  const onInstall = () => { api.updateInstall().catch(() => {}); };
  const onRetry = async () => {
    try {
      const s = await api.updateCheck();
      applyUpdate(s);
      if (s.status === 'available') applyUpdate(await api.updateDownload());
    } catch { /* 轮询会带回最新状态 */ }
  };
  const onOpenRelease = () => { api.openReleasePage().catch(() => {}); };

  const isMac = navigator.userAgent.includes('Macintosh');
  let body: React.ReactNode = null;

  if (update.status === 'available') {
    body = (
      <>
        <span>发现新版本 v{update.info?.version ?? '?'}，当前 v{update.currentVersion ?? '?'}</span>
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onDownload}>
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
    body = (
      <div className="flex-1 flex items-center gap-3 min-w-0">
        <span className="shrink-0 text-muted-foreground">
          正在下载 {p && p.total ? `${Math.round(p.percent)}%（${fmtMB(p.transferred)} / ${fmtMB(p.total)} MB）` : `${fmtMB(p?.transferred ?? 0)} MB`}
        </span>
        <Progress value={p?.percent ?? 0} className="h-1.5 flex-1 max-w-64" />
      </div>
    );
  } else if (update.status === 'ready') {
    body = (
      <>
        <span>v{update.info?.version ?? ''} 已就绪{isMac ? '，打开安装包后请将应用拖入 Applications' : ''}</span>
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onInstall}>
          <RotateCw className="w-3 h-3" />{isMac ? '打开安装包并退出' : '重启并安装'}
        </Button>
      </>
    );
  } else if (update.status === 'installing') {
    body = <span className="text-muted-foreground">正在安装，即将退出…</span>;
  } else if (update.status === 'error') {
    body = (
      <>
        <span className="truncate">更新失败：{update.error ?? '未知错误'}</span>
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onRetry}>
          <RefreshCw className="w-3 h-3" />重试
        </Button>
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
    </div>
  );
}
