// 更新界面文案的唯一出处：横幅、安装遮罩、设置页共用，平台差异只体现在这里的文案上。
// 状态语义来自 electron/updater.js（单一真相源是 /api/status），本文件只做「翻译成人话」。
import type { UpdateState, UpdatePhase } from './types';

export function isMacPlatform(): boolean {
  return navigator.userAgent.includes('Macintosh');
}

// mac 手动安装的统一操作指引（预检回退与准备失败回退共用）
export const MANUAL_INSTALL_STEPS =
  '打开安装包后，把 Xuewen Workbench 拖到 Applications 并选择替换，然后重新打开。';

// installModeReason 枚举 → 人话（electron/macInstall.js 的预检结果 + prepare-failed）
export function installReasonText(reason: string | null): string {
  switch (reason) {
    case 'app-translocation':
      return '应用正运行在系统临时位置（App 随机化），无法自动替换';
    case 'on-dmg-volume':
      return '应用正在安装包卷上运行，无法自动替换';
    case 'dir-not-writable':
      return '应用所在目录没有写入权限，无法自动替换';
    case 'bundle-not-writable':
      return '应用本体没有写入权限，无法自动替换';
    case 'not-in-bundle':
      return '应用不在标准的 .app 结构中，无法自动替换';
    case 'prepare-failed':
      return '自动安装准备没有完成';
    default:
      return '当前环境无法自动替换';
  }
}

// installing 期间各阶段的说明文字（遮罩标题下方）
export function installPhaseText(phase: UpdatePhase | null, percent: number | null): string {
  switch (phase) {
    case 'preparing':
      return '正在打开安装包…';
    case 'copying':
      return percent != null ? `正在复制新版本… ${Math.round(percent)}%` : '正在复制新版本…';
    case 'verifying':
      return '正在校验…';
    case 'restarting':
      return '即将关闭并重新打开…';
    case 'launching-installer':
      return '正在启动安装程序…';
    default:
      return '正在安装…';
  }
}

// 遮罩底部说明：Windows 有安装器进度窗口，mac 是后台脚本替换
export function installOverlayHint(): string {
  return isMacPlatform()
    ? '完成后会自动重新打开，请勿手动打开应用'
    : '应用关闭后会出现安装进度窗口，完成后自动重新打开，请勿手动打开应用';
}

export function fmtMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export function fmtSpeed(bytesPerSecond: number): string {
  return `${fmtMB(bytesPerSecond)} MB/s`;
}

export function fmtEta(etaSeconds: number | null): string | null {
  if (etaSeconds == null) return null;
  if (etaSeconds >= 60) return `约剩 ${Math.floor(etaSeconds / 60)} 分 ${etaSeconds % 60} 秒`;
  return `约剩 ${etaSeconds} 秒`;
}

// 下载中的一行状态文字（横幅与设置页共用口径）
export function downloadingStatusLine(update: UpdateState): string {
  const p = update.progress;
  if (!p) return '正在下载…';
  const parts: string[] = [];
  if (p.total) parts.push(`正在下载 ${Math.round(p.percent)}%（${fmtMB(p.transferred)} / ${fmtMB(p.total)} MB）`);
  else parts.push(`正在下载 ${fmtMB(p.transferred)} MB`);
  if (p.bytesPerSecond > 0) parts.push(fmtSpeed(p.bytesPerSecond));
  const eta = fmtEta(p.etaSeconds);
  if (eta) parts.push(eta);
  return parts.join('，');
}

// ready 的一行状态文字（横幅与设置页共用口径）；平台差异只在文案
export function readyStatusLine(update: UpdateState): string {
  const version = update.info?.version ?? '?';
  if (isMacPlatform()) {
    if (update.installMode === 'manual') {
      const reason = update.installModeReason === 'prepare-failed'
        ? `自动安装没有完成：${update.error ?? '未知原因'}`
        : installReasonText(update.installModeReason);
      return `v${version} 已下载。${reason}。${MANUAL_INSTALL_STEPS}`;
    }
    return `v${version} 已下载，安装完成后会自动重新打开`;
  }
  return `v${version} 已下载，安装时会显示安装进度，完成后自动重新打开`;
}

// 设置页「关于与更新」的状态行：只在 downloading / ready 时给出，与横幅同口径
export function updateStatusLine(update: UpdateState): string | null {
  if (update.status === 'downloading') return downloadingStatusLine(update);
  if (update.status === 'ready') return readyStatusLine(update);
  return null;
}
