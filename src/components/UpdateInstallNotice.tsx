// 跨重启的安装结果提示：拿到含 lastInstall 的状态后，本次会话只提示一次
// （sessionStorage 键 wb:update-notified:<toVersion> 防止页面重载后重复提示）。
// 成功：可查看更新内容；失败：常驻错误提示，可打开安装包走手动安装。
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import { useApp } from '@/store/app-context';

export function UpdateInstallNotice() {
  const { update } = useApp();
  useEffect(() => {
    const li = update?.lastInstall;
    if (!li?.toVersion) return;
    const key = `wb:update-notified:${li.toVersion}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch {
      // sessionStorage 不可用时仍提示（最多重复一次，优于不提示）
    }
    if (li.result === 'updated') {
      notify(`已更新到 v${li.toVersion}`, {
        kind: 'success',
        action: {
          label: '查看更新内容',
          run: () => {
            api.openReleasePage().catch((e) => {
              notify('打开发布页失败：' + (e instanceof Error ? e.message : String(e)), { kind: 'error' });
            });
          },
        },
      });
    } else {
      notify(`自动安装没有完成：${li.error ?? '未知原因'}`, {
        kind: 'error',
        durationMs: 0, // 常驻，直到手动关闭
        action: {
          label: '打开安装包',
          run: () => {
            api.openInstaller().catch((e) => {
              notify('打开安装包失败：' + (e instanceof Error ? e.message : String(e)), { kind: 'error' });
            });
          },
        },
      });
    }
  }, [update]);
  return null;
}
