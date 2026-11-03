// 安装遮罩：status==='installing' 时覆盖全窗口，半透明底、阻止交互、不可关闭。
// 横幅在此阶段让位（不渲染），因为安装是「每一刻都要看见在发生什么」的关键区间。
// 进出场走 usePresence（DESIGN.md §7/§8），时长/缓动只用 token。
import { useApp } from '@/store/app-context';
import { usePresence } from '@/lib/presence';
import { Progress } from '@/components/ui/progress';
import { installPhaseText, installOverlayHint } from '@/lib/updateText';
import { Loader2 } from 'lucide-react';

export function UpdateInstallOverlay() {
  const { update } = useApp();
  const open = !!update?.enabled && update.status === 'installing';
  const { mounted, state } = usePresence(open);
  if (!mounted) return null;

  const phase = update?.phase ?? null;
  const percent = update?.progress?.percent ?? null;
  const version = update?.info?.version ?? update?.lastInstall?.toVersion ?? '';

  return (
    <div
      data-state={state}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 duration-med ease-signature data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out"
      role="alert"
      aria-busy="true"
    >
      <div
        data-state={state}
        className="w-full max-w-sm mx-4 rounded-lg border border-border bg-card p-5 shadow-[var(--wb-pvshadow)] duration-med ease-signature data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:slide-out-to-bottom-2"
      >
        <div className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />
          <h2 className="text-sm font-semibold">正在安装{version ? ` v${version}` : ''}</h2>
        </div>
        <p className="mt-3 text-sm">{installPhaseText(phase, percent)}</p>
        {phase === 'copying' && (
          <Progress value={percent ?? 0} className="mt-3 h-2" />
        )}
        <p className="mt-3 text-xs text-muted-foreground">{installOverlayHint()}</p>
      </div>
    </div>
  );
}
