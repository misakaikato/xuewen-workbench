// Dashboard 知识库概览：统计、目录分布、最近记录、常用入口、主题/概念（有元数据映射时）。
// 首次加载显示骨架；只有加载完成且确实为空才显示「暂无数据」；加载失败显示错误与重试。
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import type { TagEntry, ConceptItem } from '@/lib/api';
import { ConceptCard } from '@/components/ConceptCard';
import { useApp } from '@/store/app-context';
import type { StatsResponse, TopicEntry, ConceptEntry, FileEntry } from '@/lib/types';
import { extIcon } from '@/lib/extIcon';
import { Pin, PinOff, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage, notify } from '@/lib/notify';

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function Dashboard() {
  const { config, rescan, scanning } = useApp();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [recents, setRecents] = useState<{ path: string; at: number; exists: boolean }[]>([]);
  const [pins, setPins] = useState<{ path: string; at: number; exists: boolean }[]>([]);
  const [topics, setTopics] = useState<TopicEntry[]>([]);
  const [concepts, setConcepts] = useState<ConceptEntry[]>([]);
  const [tags, setTags] = useState<TagEntry[]>([]);
  const [derivedConcepts, setDerivedConcepts] = useState<ConceptItem[]>([]);
  const [openConcept, setOpenConcept] = useState<string | null>(null);
  const [metaConfigured, setMetaConfigured] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const navigate = useNavigate();

  // 重扫（scannedAt 变化）后静默重取：已有数据先保留，失败时才换成错误态
  useEffect(() => {
    if (!config?.configured) return;
    let dead = false;
    const myDs = config.dsId;
    // 主题词与概念表是可选的加工数据：缺失或读取失败时对应区块显示「尚无…」，不影响概览其余部分
    Promise.all([api.stats(), api.recents(), api.pins(), api.topics(), api.tags().catch(() => null), api.concepts().catch(() => null)])
      .then(([s, r, p, t, tg, cp]) => {
        if (dead || s.dsId !== myDs) return; // 旧数据源响应不覆盖
        setLoadError(null);
        setStats(s);
        setRecents(r.recents);
        setPins(p.pins);
        setTopics(t.topics);
        setConcepts(t.concepts);
        setMetaConfigured(t.configured);
        if (tg && tg.dsId === myDs) setTags(tg.tags);
        if (cp && cp.dsId === myDs) setDerivedConcepts(cp.concepts);
      })
      .catch((e) => {
        if (!dead) setLoadError(errorMessage(e));
      });
    return () => {
      dead = true;
    };
  }, [config?.configured, config?.dsId, config?.status.scannedAt, reloadKey]);

  if (!config?.configured) {
    return (
      <div className="max-w-xl mx-auto py-16 px-4 text-center">
        <h1 className="text-lg font-semibold mb-3">欢迎使用Workbench</h1>
        <p className="text-muted-foreground mb-6">先打开一个知识库（本机的知识库目录），应用将自动发现其中的 Markdown、JSON 与 Word 文件；之后可以同时打开多个。</p>
        <Button asChild>
          <Link to="/setup">打开知识库</Link>
        </Button>
      </div>
    );
  }

  const openFile = (p: string) => navigate('/read/' + p.split('/').map(encodeURIComponent).join('/'));
  const c = stats?.counts;
  // 首次加载的三态：loading 骨架 / error 只显示上方错误条 / ready 才区分有数据与确实为空
  const phase: 'loading' | 'error' | 'ready' = stats ? 'ready' : loadError ? 'error' : 'loading';
  const loading = phase === 'loading';
  const placeholder = loading ? (
    <div className="space-y-2" aria-label="加载中">
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-3/5" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  ) : (
    <div className="text-xs text-muted-foreground">加载失败</div>
  );
  const removePin = async (path: string) => {
    try {
      await api.pin(path, 'remove');
      setPins((await api.pins()).pins);
    } catch (e) {
      notify('移除常用入口失败：' + errorMessage(e), { kind: 'error' });
    }
  };

  return (
    <div className="max-w-5xl mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-semibold">知识库概览</h1>
          <div className="text-xs text-muted-foreground mt-0.5">
            {config.baseDir} · {config.status.scanning ? '扫描中…' : stats ? `扫描于 ${new Date(stats.scannedAt).toLocaleString('zh-CN')}` : loading ? '加载中…' : '等待扫描'}
            {config.status.unreachable ? ' · 目录不可访问' : config.status.watching ? ' · 自动监听已开启' : ' · 可手动重扫'}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          loading={scanning}
          onClick={() => rescan()}
        >
          <RefreshCw className="w-3.5 h-3.5" /> 重新扫描
        </Button>
      </div>

      {loadError && (
        <div className="text-xs rounded border border-destructive/40 bg-destructive/10 text-destructive p-3 flex items-center gap-2" role="alert">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1 break-all">概览数据加载失败：{loadError}</span>
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => setReloadKey((k) => k + 1)}>
            重试
          </Button>
        </div>
      )}

      {config.status.unreachable && (
        <div className="text-xs rounded border border-destructive/40 bg-destructive/10 text-destructive p-3 flex items-center gap-2" role="alert">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1">
            知识库目录暂时无法访问：{config.status.unreachable.reason}。目录恢复后会自动重新扫描，也可以点「重新扫描」。
            {(config.status.counts?.files ?? 0) > 0 && '下面显示的是上次扫描的结果。'}
          </span>
        </div>
      )}

      {!config.status.unreachable && (config.status.dirErrors.length > 0 || config.status.fileErrors.length > 0) && (
        <div className="text-xs rounded border border-warning/40 bg-warning-soft text-warning-foreground p-3 flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 text-warning" />
          <div>
            {config.status.dirErrors.length + config.status.fileErrors.length} 项扫描失败（其余内容正常）：
            {[...config.status.dirErrors, ...config.status.fileErrors].slice(0, 3).map((e) => (
              <div key={e.path} className="mt-0.5">{e.path} — {e.reason}</div>
            ))}
          </div>
        </div>
      )}

      {/* 统计卡片：点击按类型筛选 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: '全部文档', value: c?.total, to: '/browse' },
          { label: 'Markdown', value: c?.md, to: '/browse?type=.md' },
          { label: 'JSON', value: c?.json, to: '/browse?type=.json' },
          { label: 'TXT', value: c?.txt, to: '/browse?type=.txt' },
          { label: 'Word (docx)', value: c?.docx, to: '/browse?type=.docx' },
          { label: 'Word (doc)', value: c?.doc, to: '/browse?type=.doc' },
          { label: 'HTML', value: c?.html, to: '/browse?type=.html' },
          { label: '目录', value: c?.dirs, to: '/browse' },
        ].map((card) => (
          <Link
            key={card.label}
            to={card.to}
            className="bg-card border border-border rounded-lg p-3 hover:border-primary/60 transition-colors"
          >
            {loading ? <Skeleton className="h-7 w-12" /> : <div className="text-lg font-semibold stat-num">{card.value ?? '—'}</div>}
            <div className="text-xs text-muted-foreground mt-1">{card.label}</div>
          </Link>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* 目录分布 */}
        <section className="bg-card border border-border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3">顶层目录分布</h2>
          {phase !== 'ready' ? placeholder : stats && stats.distribution.length > 0 ? (
            <ul className="space-y-1.5">
              {stats.distribution.slice(0, 10).map((d) => (
                <li key={d.dir}>
                  <button
                    className="w-full flex items-center gap-2 text-sm hover:text-primary"
                    onClick={() => navigate('/browse?dir=' + encodeURIComponent(d.dir === '(根目录)' ? '' : d.dir))}
                  >
                    <span className="truncate flex-1 text-left">{d.dir}</span>
                    <span className="stat-num text-muted-foreground">{d.count}</span>
                    <span className="h-1.5 rounded bg-primary/70" style={{ width: Math.max(6, (d.count / stats.distribution[0].count) * 90) }} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-muted-foreground">暂无数据</div>
          )}
        </section>

        {/* 最近修改 */}
        <section className="bg-card border border-border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3">最近修改</h2>
          {phase !== 'ready' ? placeholder : stats && stats.recentModified.length > 0 ? (
            <ul className="space-y-1">
              {stats.recentModified.slice(0, 8).map((f: FileEntry) => (
                <li key={f.path}>
                  <button className="w-full flex items-center gap-2 text-sm hover:text-primary py-0.5" onClick={() => openFile(f.path)}>
                    {extIcon(f.ext)}
                    <span className="truncate flex-1 text-left">{f.path}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{fmtTime(f.mtimeMs)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-muted-foreground">暂无数据</div>
          )}
        </section>

        {/* 最近打开 */}
        <section className="bg-card border border-border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3">最近打开</h2>
          {phase !== 'ready' ? placeholder : recents.length > 0 ? (
            <ul className="space-y-1">
              {recents.slice(0, 8).map((r) => (
                <li key={r.path} className="flex items-center gap-2 text-sm py-0.5">
                  {r.exists ? (
                    <button className="flex items-center gap-2 hover:text-primary truncate" onClick={() => openFile(r.path)}>
                      <span className="truncate">{r.path}</span>
                    </button>
                  ) : (
                    <span className="text-muted-foreground line-through truncate" title="文件已移动或删除">
                      {r.path}（已失效）
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-muted-foreground">还没有阅读记录</div>
          )}
        </section>

        {/* 常用入口 */}
        <section className="bg-card border border-border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-1">常用入口</h2>
          <p className="text-xs text-muted-foreground mb-3">在阅读页可将文档固定到这里</p>
          {phase !== 'ready' ? placeholder : pins.length > 0 ? (
            <ul className="space-y-1">
              {pins.map((p) => (
                <li key={p.path} className="flex items-center gap-1 text-sm py-0.5">
                  {p.exists ? (
                    <button className="flex-1 text-left truncate hover:text-primary" onClick={() => openFile(p.path)}>
                      {p.path}
                    </button>
                  ) : (
                    <span className="flex-1 text-muted-foreground line-through truncate">{p.path}（已失效）</span>
                  )}
                  <button
                    className="p-1 rounded hover:bg-accent text-muted-foreground"
                    title="移除"
                    onClick={() => { void removePin(p.path); }}
                  >
                    <PinOff className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Pin className="w-3.5 h-3.5" /> 暂无固定入口
            </div>
          )}
        </section>
      </div>

      {/* 主题与概念：优先用 .xuewen 加工数据与人工标签，退化到元数据映射 */}
      {phase !== 'ready' ? null : tags.length || derivedConcepts.length ? (
        <div className="grid md:grid-cols-2 gap-4">
          <section className="bg-card border border-border rounded-lg p-4">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              主题分布 <span className="text-[10px] font-normal text-muted-foreground">{tags.length} 个主题</span>
            </h2>
            {tags.length ? (
              <div className="flex flex-wrap gap-1.5">
                {tags.slice(0, 40).map((t) => (
                  <button
                    key={t.tag}
                    className="text-xs px-2 py-1 rounded-full border border-border hover:border-primary hover:text-primary flex items-center gap-1"
                    onClick={() => navigate('/search?q=' + encodeURIComponent(t.tag) + '&mode=exact')}
                    title={t.files.slice(0, 5).map((f) => f.title).join('\n')}
                  >
                    {t.tag} <span className="stat-num text-muted-foreground">{t.count}</span>
                    {t.source === 'ai' && <span className="text-[9px] text-muted-foreground">AI</span>}
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">尚无主题标注（.xuewen/topics.jsonl 或文档 tags）</div>
            )}
          </section>
          <section className="bg-card border border-border rounded-lg p-4">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              概念 <span className="text-[10px] font-normal text-muted-foreground">{derivedConcepts.length} 条</span>
            </h2>
            {derivedConcepts.length ? (
              <div className="flex flex-wrap gap-1.5">
                {derivedConcepts.slice(0, 40).map((c) => (
                  <button
                    key={c.name}
                    className="text-xs px-2 py-1 rounded-full border border-border hover:border-primary hover:text-primary"
                    onClick={() => setOpenConcept(c.name)}
                    title={c.def.slice(0, 120)}
                  >
                    {c.name}
                    {c.aliases.length > 0 && <span className="text-[9px] text-muted-foreground ml-1">+{c.aliases.length}</span>}
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">尚无概念表（.xuewen/concepts.jsonl）</div>
            )}
          </section>
        </div>
      ) : metaConfigured ? (
        <div className="grid md:grid-cols-2 gap-4">
          <section className="bg-card border border-border rounded-lg p-4">
            <h2 className="text-sm font-semibold mb-3">主题分布</h2>
            {topics.length ? (
              <div className="flex flex-wrap gap-1.5">
                {topics.slice(0, 30).map((t) => (
                  <button
                    key={t.topic}
                    className="text-xs px-2 py-1 rounded-full border border-border hover:border-primary hover:text-primary"
                    onClick={() => navigate('/search?q=' + encodeURIComponent(t.topic) + '&mode=exact')}
                    title={t.files.slice(0, 5).join('\n')}
                  >
                    {t.topic} <span className="stat-num text-muted-foreground">{t.count}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">映射已配置但未识别到主题</div>
            )}
          </section>
          <section className="bg-card border border-border rounded-lg p-4">
            <h2 className="text-sm font-semibold mb-3">概念频次</h2>
            {concepts.length ? (
              <div className="flex flex-wrap gap-1.5">
                {concepts.slice(0, 30).map((t) => (
                  <button
                    key={t.concept}
                    className="text-xs px-2 py-1 rounded-full border border-border hover:border-primary hover:text-primary"
                    onClick={() => navigate('/search?q=' + encodeURIComponent(t.concept) + '&mode=exact')}
                    title={t.files.slice(0, 5).join('\n')}
                  >
                    {t.concept} <span className="stat-num text-muted-foreground">{t.count}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">映射已配置但未识别到概念</div>
            )}
          </section>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground border border-dashed border-border rounded-lg p-3">
          未配置元数据映射。可在 <Link to="/settings" className="text-primary underline">设置</Link> 中选择索引/词表 JSON 并指定字段，以启用主题、概念与集合视图；基础阅读、检索与保存不受影响。
        </div>
      )}

      {openConcept && (
        <ConceptCard
          key={openConcept}
          name={openConcept}
          onClose={() => setOpenConcept(null)}
          onOpenDoc={(p2) => { setOpenConcept(null); navigate('/read/' + p2.split('/').map(encodeURIComponent).join('/')); }}
          onOpenConcept={(n) => setOpenConcept(n)}
        />
      )}
    </div>
  );
}
