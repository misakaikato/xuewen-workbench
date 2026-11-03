// 异常事件横幅：插在顶栏上方（UpdateBanner 之后）。上次运行出现异常时提示导出诊断信息。
// 导出期间按钮转圈；导出成功经 notify 给出文件路径并收起横幅，失败经 notify 提示、横幅保留可重试。
import { useEffect, useState } from 'react';
import { api, type DiagnosticsIncident } from '@/lib/api';
import { errorMessage, notify } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { X, Download } from 'lucide-react';

const KIND_LABEL: Record<string, string> = {
  'unclean-exit': '上次没有正常退出',
  'backend-exit': '后台服务意外退出',
  'renderer-gone': '界面进程崩溃',
  'child-gone': '子进程异常退出',
};

export function DiagnosticsBanner() {
  const [pending, setPending] = useState<DiagnosticsIncident | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 横幅只在有待处理异常时出现：状态取不到就不显示，设置页仍可手动导出
    api.diagnosticsState().then((s) => setPending(s.pending)).catch(() => {});
  }, []);

  // 确认已读失败只会让横幅下次启动再出现一次，不打扰当前操作
  const ack = async () => {
    setPending(null);
    try { await api.diagnosticsAck(); } catch { /* 见上 */ }
  };

  const doExport = async () => {
    setBusy(true);
    try {
      const r = await api.exportDiagnostics();
      notify('诊断信息已导出到 ' + r.file, { kind: 'success', durationMs: 10000 });
      await ack();
    } catch (e) {
      notify('导出诊断信息失败：' + errorMessage(e), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (!pending) return null;

  const label = KIND_LABEL[pending.kind] || '异常';
  const time = new Date(pending.at).toLocaleString();

  return (
    <div
      className="h-9 shrink-0 flex items-center gap-2 px-3 text-xs bg-primary/10 border-b border-border text-primary"
      role="status"
    >
      <span>上次运行出现异常：{label}（{time}）。可以导出诊断信息发给开发者。</span>
      <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={doExport} loading={busy}>
        <Download className="w-3 h-3" />导出诊断信息
      </Button>
      <Button size="sm" variant="ghost" className="h-6 w-6 p-0" aria-label="忽略" onClick={ack} disabled={busy}>
        <X className="w-3 h-3" />
      </Button>
    </div>
  );
}
