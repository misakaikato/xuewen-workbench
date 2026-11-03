// 跨重启安装结果的判定（纯函数，不碰 fs/electron，便于单测 scripts/test-update-pending.mjs）。
// 输入当前版本与 pending.json / install-result.json 的内容，输出界面要用的 lastInstall 与文件处置。

// 脚本失败 reason → 人话；新 reason 落到这里即可被界面复用
export function humanizeInstallFailure(reason, detail) {
  switch (reason) {
    case 'move-old-failed':
      return '系统阻止了替换应用，可在 系统设置 → 隐私与安全性 → App 管理 中允许 Xuewen Workbench，或把安装包里的应用拖到 Applications';
    case 'move-new-failed':
      return '新版本未能写入应用目录，已还原为旧版本，可重试或手动安装';
    case 'restore-failed':
      return `替换失败且无法自动还原，旧版本备份保留在 ${detail || '备份目录'}，请联系维护者`;
    case 'wait-exit-timeout':
      return '等待应用退出超时，未执行替换';
    default:
      return detail ? `${reason || '未知原因'}：${detail}` : (reason || '未知原因');
  }
}

// 判定规则（规格「边界情况」表）：
// - 版本已是 toVersion → 更新成功
// - 版本仍是 fromVersion 且有失败 result → 更新失败（带人话与安装包路径）
// - 版本仍是 fromVersion 且无 result（用户取消安装器/尚未安装）→ 保留 pending，不提示
// - 版本既非 from 也非 to（跨版本手动安装过）→ 清理，不提示
export function consumeInstallOutcome({ currentVersion, pending, result }) {
  if (!pending || typeof pending !== 'object') return { lastInstall: null, clear: false, keep: false };
  const { fromVersion, toVersion } = pending;
  if (typeof toVersion !== 'string' || typeof fromVersion !== 'string') return { lastInstall: null, clear: false, keep: false };
  if (currentVersion === toVersion) {
    return { lastInstall: { result: 'updated', fromVersion, toVersion }, clear: true, keep: false };
  }
  if (currentVersion === fromVersion) {
    if (result && typeof result === 'object' && result.ok === false) {
      return {
        lastInstall: {
          result: 'failed',
          fromVersion,
          toVersion,
          error: humanizeInstallFailure(result.reason, result.detail),
          ...(typeof pending.dmgPath === 'string' && pending.dmgPath ? { dmgPath: pending.dmgPath } : {}),
        },
        clear: true,
        keep: false,
      };
    }
    return { lastInstall: null, clear: false, keep: true };
  }
  return { lastInstall: null, clear: true, keep: false };
}
