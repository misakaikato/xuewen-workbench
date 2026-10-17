// Dashboard 语料概览：统计、目录分布、最近记录、常用入口、主题/概念（有元数据映射时）
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useApp } from '@/store/app';
import type { StatsResponse, TopicEntry, ConceptEntry, FileEntry } from '@/lib/types';
import { extIcon } from '@/components/RefChip';
import { Pin, PinOff, AlertTriangle, RefreshCw } from 'lucide-react';

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function Dashboard() {
  const { config, rescan } = useApp();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [recents, setRecents] = useState<{ path: string; at: number; exists: boolean }[]>([]);
  const [pins, setPins] = useState<{ path: string; at: number; exists: boolean }[]>([]);
  const [topics, setTopics] = useState<TopicEntry[]>([]);
  const [concepts, setConcepts] = useState<ConceptEntry[]>([]);
  const [metaConfigured, setMetaConfigured] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!config?.configured) return;
    let dead = false;
    const myDs = config.dsId;
    Promise.all([api.stats(), api.recents(), api.pins(), api.topics()])
      .then(([s, r, p, t]) => {
        if (dead || s.dsId !== myDs) return; // 旧数据源响应不覆盖
        setStats(s);
        setRecents(r.recents);
        setPins(p.pins);
        setTopics(t.topics);
        setConcepts(t.concepts);
        setMetaConfigured(t.configured);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [config?.configured, config?.dsId, config?.status.scannedAt]);

  if (!config?.configured) {
    return (
      <div className="max-w-xl mx-auto py-16 px-4 text-center">
        <h1 className="text-2xl font-bold mb-3">欢迎使用批量文档语料工作台</h1>
        <p className="text-muted-foreground mb-6">首次使用请先配置语料根目录，应用将自动发现其中的 Markdown、JSON 与 Word 文件。</p>
        <Link to="/setup" className="inline-block px-5 py-2.5 rounded bg-primary text-primary-foreground">
          配置数据源
        </Link>
      </div>
    );
  }

  const openFile = (p: string) => navigate('/read/' + p.split('/').map(encodeURIComponent).join('/'));
  const c = stats?.counts;

  return (
    <div className="max-w-5xl mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold">语料概览</h1>
          <div className="text-xs text-muted-foreground mt-0.5">
            {config.baseDir} · {config.status.scanning ? '扫描中…' : stats ? `扫描于 ${new Date(stats.scannedAt).toLocaleString('zh-CN')}` : '等待扫描'}
            {config.status.watching ? ' · 自动监听已开启' : ' · 可手动重扫'}
          </div>
        </div>
        <button
          className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent flex items-center gap-1"
          onClick={() => rescan()}
        >
          <RefreshCw className="w-3.5 h-3.5" /> 重新扫描
        </button>
      </div>

      {(config.status.dirErrors.length > 0 || config.status.fileErrors.length > 0) && (
        <div className="text-xs rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800 p-3 flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
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
          { label: 'Word (docx)', value: c?.docx, to: '/browse?type=.docx' },
          { label: 'Word (doc)', value: c?.doc, to: '/browse?type=.doc' },
          { label: '目录', value: c?.dirs, to: '/browse' },
        ].map((card) => (
          <Link
            key={card.label}
            to={card.to}
            className="bg-card border border-border rounded-lg p-3 hover:border-primary/60 transition-colors"
          >
            <div className="text-2xl font-bold stat-num">{card.value ?? '—'}</div>
            <div className="text-xs text-muted-foreground mt-1">{card.label}</div>
          </Link>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* 目录分布 */}
        <section className="bg-card border border-border rounded-lg p-4">
          <h2 className="font-medium text-sm mb-3">顶层目录分布</h2>
          {stats && stats.distribution.length > 0 ? (
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
          <h2 className="font-medium text-sm mb-3">最近修改</h2>
          {stats && stats.recentModified.length > 0 ? (
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
          <h2 className="font-medium text-sm mb-3">最近打开</h2>
          {recents.length > 0 ? (
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
          <h2 className="font-medium text-sm mb-1">常用入口</h2>
          <p className="text-xs text-muted-foreground mb-2">在阅读页可将文档固定到这里</p>
          {pins.length > 0 ? (
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
                    onClick={async () => {
                      await api.pin(p.path, 'remove');
                      setPins((await api.pins()).pins);
                    }}
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

      {/* 主题与概念（配置了元数据映射时） */}
      {metaConfigured ? (
        <div className="grid md:grid-cols-2 gap-4">
          <section className="bg-card border border-border rounded-lg p-4">
            <h2 className="font-medium text-sm mb-3">主题分布</h2>
            {topics.length ? (
              <div className="flex flex-wrap gap-1.5">
                {topics.slice(0, 30).map((t) => (
                  <button
                    key={t.topic}
                    className="text-xs px-2 py-1 rounded-full border border-border hover:border-primary hover:text-primary"
                    onClick={() => navigate('/search?q=' + encodeURIComponent(t.topic))}
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
            <h2 className="font-medium text-sm mb-3">概念频次</h2>
            {concepts.length ? (
              <div className="flex flex-wrap gap-1.5">
                {concepts.slice(0, 30).map((t) => (
                  <button
                    key={t.concept}
                    className="text-xs px-2 py-1 rounded-full border border-border hover:border-primary hover:text-primary"
                    onClick={() => navigate('/search?q=' + encodeURIComponent(t.concept))}
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
    </div>
  );
}
