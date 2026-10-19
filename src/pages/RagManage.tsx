// RAG 管理页：模型（下载/导入/状态）、索引（构建/暂停/重建/进度/统计）、检索测试台、生成端点配置。
// 状态 5s 轮询（与扫描状态同模式）；构建中进度实时刷新。
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import type { RagStatus, RagConfig } from '@/lib/api';
import { useApp } from '@/store/app';
import { extIcon } from '@/lib/extIcon';
import { Download, FolderInput, Play, Pause, RotateCcw, Cpu, Zap, FlaskConical, CheckCircle2, AlertTriangle, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';

const fmtBytes = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : String(n));

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

  useEffect(() => {
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [poll, dsId]);

  useEffect(() => {
    api.ragConfigGet().then((r) => setCfg(r.config)).catch(() => {});
  }, [dsId]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      await poll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const doSmart = async () => {
    if (!q.trim()) return;
    try {
      setSmart(await api.ragSearch(q, 100));
    } catch (e) {
      setSmart({ dsId: '', hits: [], took: 0, backend: '' } as Awaited<ReturnType<typeof api.ragSearch>>);
      setErr((e as Error).message);
    }
  };

  const m = st?.model;
  const ix = st?.index;
  const modelReady = m?.state === 'ready';
  const indexPct = ix && ix.total > 0 ? Math.round((ix.done / ix.total) * 100) : null;

  return (
    <div>
      <h1 className="text-lg font-bold flex items-center gap-2">
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
          <div><div className="text-muted-foreground">状态</div>
            <div className="font-medium flex items-center gap-1">
              {modelReady ? <><CheckCircle2 className="w-3.5 h-3.5 text-success" />就绪</> :
                m?.state === 'downloading' ? '下载中…' : m?.state === 'error' ? '失败' : '未下载'}
            </div>
          </div>
          <div><div className="text-muted-foreground">权重 sha256</div><div className="font-mono truncate" title={m?.sha || ''}>{m?.sha ? m.sha.slice(0, 12) + '…' : '—'}</div></div>
        </div>
        {m?.state === 'downloading' && m.progress && (
          <div className="text-xs mb-3">
            <div className="flex justify-between text-muted-foreground mb-1">
              <span className="truncate">{m.progress.file}</span>
              <span>{m.progress.done}/{m.progress.files} 文件 · {fmtBytes(m.progress.bytes)}{m.progress.total ? ' / ' + fmtBytes(m.progress.total) : ''}</span>
            </div>
            <div className="h-1.5 rounded bg-muted overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: m.progress.total ? Math.min(100, (m.progress.bytes / m.progress.total) * 100) + '%' : '30%' }} />
            </div>
          </div>
        )}
        {m?.error && <div className="text-xs text-destructive mb-3">{m.error}</div>}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            disabled={busy !== null || m?.state === 'downloading'}
            onClick={() => run('download', () => api.ragModelDownload())}
          >
            <Download className="w-3.5 h-3.5" />{modelReady ? '重新下载' : '下载模型（约 1.1 GB，hf-mirror 自动回退）'}
          </Button>
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
              disabled={!importDir.trim() || busy !== null}
              onClick={() => run('import', () => api.ragModelImport(importDir.trim()))}
            >导入</Button>
          </span>
        </div>
      </section>

      {/* 索引区 */}
      <section className="bg-card border border-border rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Zap className="w-4 h-4" /> 语义索引 <span className="text-xs text-muted-foreground font-normal">（当前资料库）</span>
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs mb-3">
          <div><div className="text-muted-foreground">状态</div><div className="font-medium">
            {ix?.state === 'building' ? `构建中（${ix.phase}）` : ix?.state === 'ready' ? '就绪' : ix?.state === 'paused' ? '已暂停' : ix?.state === 'error' ? '失败' : '未构建'}
          </div></div>
          <div><div className="text-muted-foreground">文件 / 块</div><div className="font-medium stat-num">{ix?.filesDone ?? 0}/{ix?.files ?? 0} · {ix?.chunks ?? 0} 块</div></div>
          <div><div className="text-muted-foreground">向量覆盖</div><div className="font-medium stat-num">{ix?.vecs ?? 0}/{ix?.chunks ?? 0}</div></div>
          <div><div className="text-muted-foreground">库体积</div><div className="font-medium">{fmtBytes(ix?.dbBytes || 0)}{ix?.updatedAt ? ' · ' + new Date(ix.updatedAt).toLocaleString('zh-CN') : ''}</div></div>
        </div>
        {ix?.state === 'building' && (
          <div className="text-xs mb-3">
            <div className="flex justify-between text-muted-foreground mb-1"><span>{ix.phase}</span><span>{ix.done}/{ix.total}</span></div>
            <div className="h-1.5 rounded bg-muted overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: (indexPct || 0) + '%' }} />
            </div>
          </div>
        )}
        {ix?.error && <div className="text-xs text-destructive mb-3">{ix.error}</div>}
        {ix?.ftsError && (
          <div className="text-xs border border-destructive/40 bg-destructive/10 text-destructive rounded p-2 mb-3 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            关键词索引查询失败（检索退化为仅语义路）：{ix.ftsError}
          </div>
        )}
        {ix?.configChanged && (
          <div className="text-xs border border-warning/40 bg-warning-soft text-warning-foreground rounded p-2 mb-3 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            切块/嵌入参数与建库时不同，现有索引按旧参数生成。
            <button className="underline" disabled={busy !== null} onClick={() => run('rebuild', () => api.ragIndexBuild(true))}>立即重建</button>
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            className="text-xs"
            disabled={busy !== null || ix?.state === 'building' || !modelReady}
            title={modelReady ? undefined : '请先就绪嵌入模型'}
            onClick={() => run('build', () => api.ragIndexBuild(false))}
          >
            <Play className="w-3.5 h-3.5" />{ix?.files ? '继续构建 / 增量更新' : '构建索引'}
          </Button>
          {ix?.state === 'building' && (
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={busy !== null}
              onClick={() => run('pause', () => api.ragIndexPause())}
            >
              <Pause className="w-3.5 h-3.5" />暂停
            </Button>
          )}
          {ix && ix.files > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={busy !== null || ix.state === 'building'}
              onClick={() => { if (window.confirm('清空当前库的语义索引并全量重建？')) run('rebuild', () => api.ragIndexBuild(true)); }}
            >
              <RotateCcw className="w-3.5 h-3.5" />重建
            </Button>
          )}
          <span className="text-[11px] text-muted-foreground">索引存于本机应用数据目录，删除后可随时重建；文件改动后自动增量更新。</span>
        </div>
      </section>

      {/* 参数配置 */}
      <section className="bg-card border border-border rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4" /> 切块与检索参数
          <span className="text-xs text-muted-foreground font-normal">（按当前资料库；改切块/嵌入后需重建索引）</span>
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
                disabled={busy !== null}
                onClick={async () => {
                  const r = await api.ragConfigSave(cfg);
                  setCfg(r.config);
                  setCfgSaved('已保存' + (ix?.files ? '——切块/嵌入参数变化需重建索引生效' : ''));
                  await poll();
                }}
              >保存参数</Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={busy !== null}
                onClick={async () => {
                  const r = await api.ragConfigSave({ chunk: { maxChars: 600, jsonValueLimit: 1500, headingContext: true, fileNameContext: true, hardSplitOversize: false }, embed: { maxLength: 1024 }, search: { topN: 30, rrfK: 60, rrfMin: 0.0105, cosFloor: 0.25, cosSigma: 2.0, semanticWeight: 1.2 } });
                  setCfg(r.config);
                  setCfgSaved('已恢复默认');
                  await poll();
                }}
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
          <Button className="text-xs" onClick={doSmart}>测试</Button>
        </div>
        {smart && (
          <div className="space-y-2">
            <div className="text-[11px] text-muted-foreground">共 {smart.total ?? smart.hits.length} 段（显示 {smart.hits.length}）· {smart.took}ms · {BACKEND_LABEL[smart.backend || ''] || smart.backend}
              <Link to={'/search?q=' + encodeURIComponent(q) + '&mode=smart'} className="ml-2 text-primary underline">去检索页</Link>
            </div>
            {smart.hits.map((h, i) => (
              <div key={i} className="border border-border rounded p-2 text-xs">
                <div className="flex items-center gap-2 font-medium">
                  {extIcon('.' + (h.name.split('.').pop() || ''))}
                  <span className="truncate">{h.name}</span>
                  {h.headingPath && <span className="text-muted-foreground font-normal truncate">{h.headingPath}</span>}
                  <span className="ml-auto flex gap-1 shrink-0 text-[10px] text-muted-foreground">
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
