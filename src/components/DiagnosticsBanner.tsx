// 异常事件横幅：插在顶栏上方（UpdateBanner 之后）。上次运行出现异常时提示导出诊断信息。
import { useEffect, useState } from 'react';
import { api, type DiagnosticsIncident } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { X, Download } from 'lucide-react';

const KIND_LABEL: Record<string, string> = {
  'unclean-exit': '上次没有正常退出',
  'backend-exit': '后台服务意外退出',
  'renderer-gone': '界面进程崩溃',
  'child-gone': '子进程异常退出',
};

type ExportResult = { ok: true; file: string } | { ok: false; message: string };

export function DiagnosticsBanner() {
  const [pending, setPending] = useState<DiagnosticsIncident | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.diagnosticsState().then((s) => setPending(s.pending)).catch(() => {});
  }, []);

  const ack = async () => {
    setPending(null);
    setResult(null);
    try { await api.diagnosticsAck(); } catch { /* 忽略 */ }
  };

  const doExport = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.exportDiagnostics();
      setResult({ ok: true, file: r.file });
      try { await api.diagnosticsAck(); } catch { /* 忽略 */ }
    } catch (e) {
      setResult({ ok: false, message: '导出失败：' + (e instanceof Error ? e.message : String(e)) });
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
      {result ? (
        <>
          <span className="truncate">{result.ok ? `已导出到 ${result.file}` : result.message}</span>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" aria-label="忽略" onClick={ack}>
            <X className="w-3 h-3" />
          </Button>
        </>
      ) : (
        <>
          <span>上次运行出现异常：{label}（{time}）。可以导出诊断信息发给开发者。</span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={doExport} disabled={busy}>
            <Download className="w-3 h-3" />导出诊断信息
          </Button>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" aria-label="忽略" onClick={ack}>
            <X className="w-3 h-3" />
          </Button>
        </>
      )}
    </div>
  );
}
