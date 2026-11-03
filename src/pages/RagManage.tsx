// RAG 管理页：模型（下载/导入/取消/进度）、索引（构建/暂停/重建/阶段进度）、检索测试台、生成端点配置。
// 阶段与进度全部来自后端 status；模型任务、运行时加载、索引构建期间 1s 轮询，其余 5s。
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import type { RagStatus, RagConfig, RagModelProgress } from '@/lib/api';
import { useApp } from '@/store/app-context';
import { usePolling } from '@/hooks/usePolling';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { extIcon } from '@/lib/extIcon';
import { notify } from '@/lib/notify';
import { Download, FolderInput, Play, Pause, RotateCcw, Cpu, Zap, FlaskConical, CheckCircle2, AlertTriangle, SlidersHorizontal, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { InlineLoading } from '@/components/ui-states';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

const fmtBytes = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : String(n));

const fmtEta = (s: number | null) => {
  if (s == null) return '';
  if (s < 60) return `约 ${s} 秒`;
  return `约 ${Math.ceil(s / 60)} 分钟`;
};

// 模型任务阶段文字（与后端 progress.phase 一一对应；无法计量阶段的进度条用不确定态）
function modelPhaseText(p: RagModelProgress): string {
  switch (p.phase) {
    case 'env-extract': return '准备 Python 环境：' + (p.phaseDetail || '解压运行时');
    case 'env-install': return '准备 Python 环境：' + (p.phaseDetail || '安装依赖');
    case 'probe': return '探测下载源';
    case 'download': return `下载 ${p.file || '…'}（第 ${Math.min(p.done + 1, p.files)}/${p.files} 个文件）`;
    case 'verify': return `校验 ${p.file || '…'}`;
    case 'copy': return `复制 ${p.file || '…'}`;
    default: return p.phaseDetail || '准备中…';
  }
}

// 阶段能否按字节计量：只有下载/复制/校验有量可算，解压/装依赖/探测没有
const measurablePhase = (p: RagModelProgress) => ['download', 'copy', 'verify'].includes(p.phase) && p.percent != null;

const EP_LABEL: Record<string, string> = { dml: 'DirectML（GPU）', cpu: 'CPU' };

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  let parts: (string | React.ReactNode)[] = [text];
  for (const t of terms) {
    const next: (string | React.ReactNode)[] = [];
    for (const p of parts) {
      if (typeof p !== 'string') {
        next.push(p);
        continue;
      }
      let rest = p;
      let idx = rest.toLowerCase().indexOf(t.toLowerCase());
      let k = 0;
      while (idx >= 0) {
        if (idx > 0) next.push(rest.slice(0, idx));
        next.push(<mark key={t + k++}>{rest.slice(idx, idx + t.length)}</mark>);
        rest = rest.slice(idx + t.length);
        idx = rest.toLowerCase().indexOf(t.toLowerCase());
      }
      if (rest) next.push(rest);
    }
    parts = next;
  }
  return <>{parts}</>;
}

const BACKEND_LABEL: Record<string, string> = { mlx: 'MLX（Apple GPU）', onnx: 'ONNX runtime', mock: 'Mock（测试）' };

export default function RagManage() {
  const { dsId } = useApp();
  const [st, setSt] = useState<RagStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [importDir, setImportDir] = useState('');
  const [q, setQ] = useState('');
  const [smart, setSmart] = useState<Awaited<ReturnType<typeof api.ragSearch>> | null>(null);
  const [smartBusy, setSmartBusy] = useState(false);
  const [cfg, setCfg] = useState<RagConfig | null>(null);
  const [cfgSaved, setCfgSaved] = useState<string | null>(null);

  const poll = useCallback(async () => {
    if (!dsId) return;
    try {
      const r = await api.ragStatus();
      setSt(r);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [dsId]);

  const m = st?.model;
  const ix = st?.index;
  const fast =
    m?.state === 'downloading' || m?.state === 'importing' || m?.runtime?.state === 'loading' ||
    ix?.state === 'building' || ix?.state === 'pausing' || smartBusy;
  useEffect(() => {
    poll();
  }, [poll, dsId]);
  usePolling(() => { poll(); }, fast ? 1000 : 5000, { enabled: !!dsId });

  useEffect(() => {
    api.ragConfigGet().then((r) => setCfg(r.config)).catch(() => {});
  }, [dsId]);

  // 动作统一入口：读取返回体，{ok:false,error} 不许被吞——页内错误条 + notify 双通道
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && (r as { ok?: boolean }).ok === false) {
        const msg = String((r as { error?: string }).error || '操作失败');
        setErr(msg);
        notify(msg, { kind: 'error' });
      }
      await poll();
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      notify(msg, { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const doSmart = async () => {
    if (!q.trim() || smartBusy) return;
    setSmartBusy(true);
    poll(); // 立即拉一次状态：首次加载模型时能尽快拿到 runtime 阶段
    try {
      setSmart(await api.ragSearch(q, 100));
    } catch (e) {
      setSmart(null);
      const msg = (e as Error).message;
      setErr(msg);
      notify(msg, { kind: 'error' });
    } finally {
      setSmartBusy(false);
    }
  };

  const modelReady = m?.state === 'ready';
  const indexPct = ix && ix.total > 0 ? Math.round((ix.done / ix.total) * 100) : null;
  const runtimeLoading = m?.runtime?.state === 'loading';
  const rtElapsed = m?.runtime?.startedAt ? Math.max(0, Math.round((Date.now() - m.runtime.startedAt) / 1000)) : 0;
  const showSmartLoading = useDelayedFlag(smartBusy, 150);
  const p = m?.progress || null;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold flex items-center gap-2">
        RAG 管理
        <span className="text-xs text-muted-foreground font-normal">智能检索与本地问答</span>
      </h1>
      {err && (
        <div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded p-2 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {err}
        </div>
      )}

      {/* 模型区 */}
      <section className="bg-card border border-border rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Cpu className="w-4 h-4" /> 嵌入模型
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs mb-3">
          <div><div className="text-muted-foreground">模型</div><div className="font-medium">{m?.id || '—'}（{m?.dim} 维）</div></div>
          <div><div className="text-muted-foreground">后端</div><div className="font-medium">{m ? BACKEND_LABEL[m.backend] || m.backend : '—'}</div></div>
          <div><div className="text-muted-foreground">执行设备</div><div className="font-medium">{m?.ep ? EP_LABEL[m.ep] || m.ep : '—'}</div></div>
          <div><div className="text-muted-foreground">状态</div>
            <div className="font-medium flex items-center gap-1">
              {modelReady ? <><CheckCircle2 className="w-3.5 h-3.5 text-success" />就绪</> :
                m?.state === 'downloading' ? '下载中…' :
                m?.state === 'importing' ? '导入中…' :
                m?.state === 'error' ? '失败' : '未下载'}
            </div>
          </div>
          <div className="sm:col-span-2"><div className="text-muted-foreground">权重 sha256</div><div className="font-mono truncate" title={m?.sha || ''}>{m?.sha ? m.sha.slice(0, 12) + '…' : '—'}</div></div>
        </div>
        {(m?.state === 'downloading' || m?.state === 'importing') && p && (
          <div className="text-xs mb-3 space-y-2" data-rag-model-progress>
            <div className="text-muted-foreground truncate" data-rag-phase>{modelPhaseText(p)}</div>
            <div>
              <div className="flex justify-between text-muted-foreground mb-1">
                <span>
                  总体 {measurablePhase(p) ? <><span className="stat-num">{Math.round(p.percent || 0)}%</span>{p.estimated ? '（估算）' : ''}</> : ''}
                </span>
                <span className="stat-num">
                  {fmtBytes(p.overallBytes)}{p.overallTotal ? ' / ' + fmtBytes(p.overallTotal) : ''}
                  {p.speedBps ? ' · ' + (p.speedBps / 1048576).toFixed(1) + ' MB/s' : ''}
                  {p.etaSeconds != null ? ' · 剩余 ' + fmtEta(p.etaSeconds) : ''}
                </span>
              </div>
              <Progress
                value={measurablePhase(p) ? p.percent || 0 : undefined}
                indeterminate={!measurablePhase(p)}
                className="h-1.5"
              />
            </div>
            {p.total > 0 && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="shrink-0">当前文件</span>
                <Progress value={(p.bytes / p.total) * 100} className="h-1 flex-1" />
                <span className="shrink-0 stat-num">{p.done}/{p.files}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                loading={busy === 'cancel'}
                disabled={busy !== null}
                onClick={() => run('cancel', () => api.ragModelCancel())}
              >
                <XCircle className="w-3.5 h-3.5" />取消
              </Button>
              <span className="text-muted-foreground">已处理 {p.done}/{p.files} 个文件{p.host ? `，源 ${p.host}` : ''}{p.attempt > 1 ? `，第 ${p.attempt} 次尝试` : ''}</span>
            </div>
          </div>
        )}
        {m?.error && <div className="text-xs text-destructive mb-3">{m.error}</div>}
        <div className="flex items-center gap-2 flex-wrap">
          {modelReady ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  loading={busy === 'download'}
                  disabled={busy !== null || m?.state === 'downloading' || m?.state === 'importing'}
                >
                  <Download className="w-3.5 h-3.5" />重新下载
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>重新下载嵌入模型？</AlertDialogTitle>
                  <AlertDialogDescription>
                    将重新下载约 1.1 GB 的模型文件并替换现有模型。下载完成前旧模型继续可用，可随时取消。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={() => run('download', () => api.ragModelDownload(true))}>重新下载</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              loading={busy === 'download'}
              disabled={busy !== null || m?.state === 'downloading' || m?.state === 'importing'}
              onClick={() => run('download', () => api.ragModelDownload())}
            >
              <Download className="w-3.5 h-3.5" />下载模型（约 1.1 GB，hf-mirror 自动回退）
            </Button>
          )}
          <span className="flex items-center gap-1 text-xs">
            <FolderInput className="w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={importDir}
              onChange={(e) => setImportDir(e.target.value)}
              placeholder="手动导入模型目录路径"
              className="px-2 py-1 rounded border border-input bg-card w-56"
            />
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              loading={busy === 'import'}
              disabled={!importDir.trim() || busy !== null || m?.state === 'downloading' || m?.state === 'importing'}
              onClick={() => { run('import', () => api.ragModelImport(importDir.trim())); }}
            >导入</Button>
          </span>
        </div>
      </section>

      {/* 索引区 */}
      <section className="bg-card border border-border rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Zap className="w-4 h-4" /> 语义索引 <span className="text-xs text-muted-foreground font-normal">（当前知识库）</span>
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs mb-3">
          <div><div className="text-muted-foreground">状态</div><div className="font-medium">
            {ix?.state === 'building' ? '构建中' : ix?.state === 'pausing' ? '正在暂停…' : ix?.state === 'ready' ? '就绪' : ix?.state === 'paused' ? '已暂停' : ix?.state === 'error' ? '失败' : ix?.state === 'stale' ? '待更新' : '未构建'}
          </div></div>
          <div><div className="text-muted-foreground">文件 / 块</div><div className="font-medium stat-num">{ix?.filesDone ?? 0}/{ix?.files ?? 0} · {ix?.chunks ?? 0} 块</div></div>
          <div><div className="text-muted-foreground">向量覆盖</div><div className="font-medium stat-num">{ix?.vecs ?? 0}/{ix?.chunks ?? 0}</div></div>
          <div><div className="text-muted-foreground">库体积</div><div className="font-medium">{fmtBytes(ix?.dbBytes || 0)}{ix?.updatedAt ? ' · ' + new Date(ix.updatedAt).toLocaleString('zh-CN') : ''}</div></div>
        </div>
        {(ix?.state === 'building' || ix?.state === 'pausing') && (
          <div className="text-xs mb-3 space-y-2" data-rag-index-progress>
            <div className="flex justify-between text-muted-foreground mb-1">
              <span data-rag-phase>{ix.phase || '构建中'}{ix.state === 'pausing' ? '（正在暂停…）' : ''}</span>
              <span className="stat-num">{ix.done}/{ix.total} 个文件</span>
            </div>
            {ix.phase === '加载模型' ? (
              <div data-rag-load-model>
                <div className="mb-1">首次加载嵌入模型，可能需要几十秒（已用 {rtElapsed} 秒）</div>
                <Progress indeterminate className="h-1.5" />
              </div>
            ) : ix.phase === '清理旧索引' ? (
              ix.clearing
                ? <Progress value={(ix.clearing.done / Math.max(1, ix.clearing.total)) * 100} className="h-1.5" />
                : <Progress indeterminate className="h-1.5" />
            ) : ix.phase === '切块' || ix.phase === '嵌入' ? (
              <Progress value={indexPct || 0} className="h-1.5" />
            ) : (
              <Progress indeterminate className="h-1.5" />
            )}
            {ix.currentFile && (
              <div className="text-muted-foreground truncate" data-rag-current-file>
                当前文件：{ix.currentFile}
                {ix.fileChunksTotal > 0 ? `（块 ${ix.fileChunksDone}/${ix.fileChunksTotal}）` : ''}
              </div>
            )}
            {ix.chunksPerSec != null && (
              <div className="text-muted-foreground">
                <span className="stat-num">{ix.chunksPerSec}</span> 块/秒{ix.etaSeconds != null && ix.etaSeconds > 0 ? ' · 剩余 ' + fmtEta(ix.etaSeconds) : ''}
              </div>
            )}
          </div>
        )}
        {ix?.error && <div className="text-xs text-destructive mb-3">{ix.error}</div>}
        {ix?.ftsError && (
          <div className="text-xs border border-destructive/40 bg-destructive/10 text-destructive rounded p-2 mb-3 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            关键词索引查询失败（检索退化为仅语义路）：{ix.ftsError}
          </div>
        )}
        {ix?.state === 'stale' && (
          <div className="text-xs border border-warning/40 bg-warning-soft text-warning-foreground rounded p-2 mb-3 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            索引与当前文件不完全一致，有待更新。
            <Button variant="link" className="text-xs h-auto p-0" loading={busy === 'update'} disabled={busy !== null} onClick={() => run('update', () => api.ragIndexBuild(false))}>立即更新</Button>
          </div>
        )}
        {ix?.configChanged && (
          <div className="text-xs border border-warning/40 bg-warning-soft text-warning-foreground rounded p-2 mb-3 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            切块/嵌入参数与建库时不同，现有索引按旧参数生成。
            <Button variant="link" className="text-xs h-auto p-0" loading={busy === 'rebuild'} disabled={busy !== null} onClick={() => run('rebuild', () => api.ragIndexBuild(true))}>立即重建</Button>
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            className="text-xs"
            loading={busy === 'build'}
            disabled={busy !== null || ix?.state === 'building' || ix?.state === 'pausing' || !modelReady}
            title={modelReady ? undefined : '请先就绪嵌入模型'}
            onClick={() => run('build', () => api.ragIndexBuild(false))}
          >
            <Play className="w-3.5 h-3.5" />{ix?.files ? '继续构建 / 增量更新' : '构建索引'}
          </Button>
          {(ix?.state === 'building' || ix?.state === 'pausing') && (
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              loading={busy === 'pause' || ix?.state === 'pausing'}
              disabled={busy !== null || ix?.state === 'pausing'}
              onClick={() => run('pause', () => api.ragIndexPause())}
            >
              <Pause className="w-3.5 h-3.5" />{ix?.state === 'pausing' ? '正在暂停…' : '暂停'}
            </Button>
          )}
          {ix && ix.files > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              loading={busy === 'rebuild'}
              disabled={busy !== null || ix.state === 'building' || ix.state === 'pausing'}
              onClick={() => { if (window.confirm('清空当前库的语义索引并全量重建？')) run('rebuild', () => api.ragIndexBuild(true)); }}
            >
              <RotateCcw className="w-3.5 h-3.5" />重建
            </Button>
          )}
          <span className="text-xs text-muted-foreground">索引存于本机应用数据目录，删除后可随时重建；文件改动后自动增量更新。</span>
        </div>
      </section>

      {/* 参数配置 */}
      <section className="bg-card border border-border rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4" /> 切块与检索参数
          <span className="text-xs text-muted-foreground font-normal">（按当前知识库；改切块/嵌入后需重建索引）</span>
        </h2>
        {cfg && (
          <>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs mb-3">
              {([
                ['chunk.maxChars', '目标块上限（字符）', 60], ['chunk.jsonValueLimit', 'JSON 单值截断', 60],
                ['embed.maxLength', '嵌入截断（token）', 60], ['search.topN', '每路 Top-N', 10],
                ['search.rrfK', 'RRF k', 10], ['search.rrfMin', '最低融合分', 0.001],
                ['search.cosFloor', '余弦下限', 0.01], ['search.cosSigma', '余弦 σ 倍数', 0.1],
                ['search.semanticWeight', 'RRF 语义权重', 0.1],
              ] as const).map(([key, label, step]) => {
                const [sec, k] = key.split('.') as [keyof RagConfig, string];
                return (
                  <label key={key} className="flex flex-col gap-1">
                    <span className="text-muted-foreground">{label}</span>
                    <input
                      type="number"
                      step={step}
                      value={(cfg[sec] as unknown as Record<string, number>)[k]}
                      onChange={(e) => setCfg((p) => p ? { ...p, [sec]: { ...(p[sec] as object), [k]: Number(e.target.value) } } : p)}
                      className="px-2 py-1.5 rounded border border-input bg-card"
                    />
                  </label>
                );
              })}
              {([
                ['chunk.headingContext', '标题路径拼入嵌入文本（提供语境）'],
                ['chunk.hardSplitOversize', '超长单元硬切（默认独立成块）'],
                ['chunk.fileNameContext', '文件名拼入块文本（仅文件名含词也能被智能命中）'],
              ] as const).map(([key, label]) => {
                const [sec, k] = key.split('.') as [keyof RagConfig, string];
                return (
                  <label key={key} className="flex items-center gap-2 sm:col-span-2 lg:col-span-1">
                    <input
                      type="checkbox"
                      checked={(cfg[sec] as unknown as Record<string, boolean>)[k]}
                      onChange={(e) => setCfg((p) => p ? { ...p, [sec]: { ...(p[sec] as object), [k]: e.target.checked } } : p)}
                    />
                    <span>{label}</span>
                  </label>
                );
              })}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                className="text-xs"
                loading={busy === 'save'}
                disabled={busy !== null}
                onClick={() => run('save', async () => {
                  const r = await api.ragConfigSave(cfg);
                  setCfg(r.config);
                  setCfgSaved('已保存' + (ix?.files ? '——切块/嵌入参数变化需重建索引生效' : ''));
                })}
              >保存参数</Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                loading={busy === 'defaults'}
                disabled={busy !== null}
                onClick={() => run('defaults', async () => {
                  const r = await api.ragConfigSave({ chunk: { maxChars: 600, jsonValueLimit: 1500, headingContext: true, fileNameContext: true, hardSplitOversize: false }, embed: { maxLength: 1024 }, search: { topN: 30, rrfK: 60, rrfMin: 0.0105, cosFloor: 0.25, cosSigma: 2.0, semanticWeight: 1.2 } });
                  setCfg(r.config);
                  setCfgSaved('已恢复默认');
                })}
              >恢复默认</Button>
              {cfgSaved && <span className="text-xs text-muted-foreground">{cfgSaved}</span>}
            </div>
          </>
        )}
      </section>

      {/* 检索测试台 */}
      <section className="bg-card border border-border rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2"><FlaskConical className="w-4 h-4" /> 检索测试台</h2>
        <div className="flex gap-2 mb-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doSmart()}
            placeholder="输入问题测试混合检索（与检索页「智能」tab 同链路）"
            className="flex-1 px-3 py-2 rounded-lg border border-input bg-card text-sm"
          />
          <Button className="text-xs" loading={smartBusy} disabled={!q.trim()} onClick={doSmart}>测试</Button>
        </div>
        {smartBusy && showSmartLoading && (
          <div className="mb-3" data-rag-test-loading>
            <InlineLoading text={runtimeLoading ? `首次加载嵌入模型…（已用 ${rtElapsed} 秒）` : '正在检索…'} />
          </div>
        )}
        {smart && !smartBusy && (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">共 {smart.total ?? smart.hits.length} 段（显示 {smart.hits.length}）· {smart.took}ms · {BACKEND_LABEL[smart.backend || ''] || smart.backend}
              <Link to={'/search?q=' + encodeURIComponent(q) + '&mode=smart'} className="ml-2 text-primary underline">去检索页</Link>
            </div>
            {smart.hits.map((h, i) => (
              <div key={i} className="border border-border rounded p-2 text-xs">
                <div className="flex items-center gap-2 font-medium">
                  {extIcon('.' + (h.name.split('.').pop() || ''))}
                  <span className="truncate">{h.name}</span>
                  {h.headingPath && <span className="text-muted-foreground font-normal truncate">{h.headingPath}</span>}
                  <span className="ml-auto flex gap-1 shrink-0 text-xs text-muted-foreground">
                    {h.bm25 && <span className="px-1 rounded bg-muted">关键词</span>}
                    {h.cos != null && <span className="px-1 rounded bg-muted">语义 {h.cos.toFixed(2)}</span>}
                    <span className="px-1 rounded bg-muted">融合 {h.score}</span>
                  </span>
                </div>
                <div className="mt-1 text-muted-foreground leading-relaxed">
                  <Highlight text={h.snippet} terms={q.split(/\s+/).filter(Boolean)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

    </div>
  );
}
