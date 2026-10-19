// 设置页：阅读与外观（与阅读页快捷面板共用配置）、逻辑集合映射、元数据来源映射
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useApp } from '@/store/app';
import { useReadingPrefs, DEFAULT_PREFS } from '@/lib/prefs';
import type { Collection, MetadataMapping, TreeNode } from '@/lib/types';
import { Plus, Trash2, Eye, ShieldBan, RefreshCw } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import MetaImport from '@/components/MetaImport';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import {
  Select as UISelect, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useTheme, type Theme } from '@/lib/theme';
import RagManage from './RagManage';

function collectDirs(node: TreeNode, out: string[]) {
  if (node.path) out.push(node.path);
  node.dirs.forEach((d) => collectDirs(d, out));
}

// 主题卡片元数据：颜色/字体取自原型令牌，仅用于预览色板
const SERIF_STACK = '"Source Han Serif SC","Noto Serif SC","Noto Serif CJK SC","Songti SC","STSong","SimSun",serif';
const SANS_STACK = '-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC","Noto Sans CJK SC",sans-serif';

const THEME_CARDS: { id: Theme; name: string; desc: string; side: string; paper: string; line: string; acc: string; ink: string; faint: string; ui: string }[] = [
  { id: 'A', name: '宣纸 · 书卷', desc: '暖纸色界面，朱砂强调，衬线 UI', side: '#f1e9d8', paper: '#f7f1e3', line: '#ddd0b6', acc: '#b23a24', ink: '#1f1a14', faint: '#a99a82', ui: SERIF_STACK },
  { id: 'B', name: '现代极简', desc: '中性留白，靛蓝强调，无衬线 UI', side: '#f7f7f8', paper: '#ffffff', line: '#e8e8ec', acc: '#4f46e5', ink: '#16171b', faint: '#a3a7b0', ui: SANS_STACK },
  { id: 'C', name: '夜读', desc: '深色夜幕，鎏金强调，衬线正文', side: '#17181c', paper: '#1b1c20', line: '#2a2b31', acc: '#d2ad62', ink: '#efe7d6', faint: '#6a655b', ui: SANS_STACK },
];

export default function Settings() {
  const [tab, setTab] = useState<string>('appearance');
  const { prefs, update, reset } = useReadingPrefs();
  const { tree, dsId, update: updateState, applyUpdate } = useApp();
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState('');

  useEffect(() => {
    api.getUiSettings().then((s) => setAutoUpdate(s.autoUpdate)).catch(() => {});
  }, []);
  const { theme, setTheme } = useTheme();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [mappings, setMappings] = useState<MetadataMapping[]>([]);
  const [msg, setMsg] = useState('');
  const [inspect, setInspect] = useState<Record<string, string>>({});
  const [blocklistRaw, setBlocklistRaw] = useState('');
  const [ignoredCount, setIgnoredCount] = useState<number | null>(null);

  useEffect(() => {
    if (!dsId) return;
    api.collections().then((r) => setCollections(r.collections)).catch(() => {});
    api.metadata().then((r) => setMappings(r.mappings)).catch(() => {});
    api.linksBlocklist()
      .then((r) => {
        setBlocklistRaw(r.terms.join('\n'));
        setIgnoredCount(r.ignoredCount);
      })
      .catch(() => setBlocklistRaw(''));
  }, [dsId]);

  const allDirs = useMemo(() => {
    const out: string[] = [];
    if (tree) collectDirs(tree, out);
    return out;
  }, [tree]);

  async function persistCollections(cols: Collection[]) {
    setCollections(cols);
    await api.saveCollections(cols.map(({ name, dirs }) => ({ name, dirs })));
    setMsg('集合映射已保存');
    setTimeout(() => setMsg(''), 2000);
  }

  async function persistMappings(ms: MetadataMapping[]) {
    setMappings(ms);
    await api.saveMetadata(ms);
    setMsg('元数据映射已保存');
    setTimeout(() => setMsg(''), 2000);
  }

  return (
    <div className="max-w-3xl mx-auto py-6 px-4 space-y-8">
      <div className="flex items-center gap-1 mb-4 border-b border-border pb-2 flex-wrap">
        {[['appearance','外观'],['reading','阅读'],['collections','集合'],['metadata','元数据'],['rag','RAG 检索'],['about','关于']].map(([id,label]) => (
          <button key={id} className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${tab === id ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      <h1 className="text-lg font-bold">设置</h1>
      {msg && <div className="text-xs text-success">{msg}</div>}

      {tab === 'appearance' && (
      <section className="bg-card border border-border rounded-lg p-4">
        <h2 className="font-medium text-sm mb-1">外观主题</h2>
        <p className="text-xs text-muted-foreground mb-3">界面整体配色与字体，保存在本机并随应用重启保留。</p>
        <RadioGroup
          value={theme}
          onValueChange={(v) => setTheme(v as Theme)}
          aria-label="外观主题"
          className="grid sm:grid-cols-3 gap-3"
        >
          {THEME_CARDS.map((t) => {
            const on = theme === t.id;
            return (
              <Label
                key={t.id}
                className={`block rounded-lg border p-2 cursor-pointer transition-colors focus-within:ring-1 focus-within:ring-ring ${
                  on ? 'border-primary ring-1 ring-primary' : 'border-border hover:bg-accent transition-colors'
                }`}
              >
                <RadioGroupItem value={t.id} className="sr-only" />
                {/* 预览色板：迷你侧栏 + 纸面 + 强调色 + 字样 */}
                <div className="rounded-md overflow-hidden border" style={{ borderColor: t.line }}>
                  <div className="flex h-[74px]" style={{ background: t.paper }}>
                    <div className="w-7 shrink-0" style={{ background: t.side, borderRight: `1px solid ${t.line}` }} />
                    <div className="flex-1 min-w-0 px-2 py-1.5">
                      <div className="text-[9px] leading-none" style={{ color: t.faint }}>论语 · 卷第六</div>
                      <div className="mt-1 text-[15px] leading-tight truncate" style={{ color: t.ink, fontFamily: SERIF_STACK }}>颜渊第十二</div>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <span className="h-1.5 w-8 rounded-full" style={{ background: t.acc }} />
                        <span className="text-[9px]" style={{ color: t.faint, fontFamily: t.ui }}>Aa 文</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-sm font-medium" style={{ fontFamily: t.ui }}>{t.name}</span>
                  {on && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">当前</span>}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">{t.desc}</div>
              </Label>
            );
          })}
        </RadioGroup>
      </section>
      )}

      {tab === 'rag' && <RagManage />}

      {tab === 'about' && (
      <section className="bg-card border border-border rounded-lg p-4">
        <h2 className="font-medium text-sm mb-1">关于与更新</h2>
        <p className="text-xs text-muted-foreground mb-3">
          当前版本 v{updateState?.currentVersion ?? '—'}。更新包从 GitHub Releases 获取（Windows 支持差量下载）。
        </p>
        {!updateState?.enabled ? (
          <p className="text-xs text-muted-foreground">开发模式不支持更新（仅打包版可用）。</p>
        ) : (
          <div className="flex items-center gap-3 text-sm">
            <Button
              size="sm" variant="outline" disabled={checking}
              onClick={async () => {
                setChecking(true);
                setCheckMsg('');
                try {
                  const s = await api.updateCheck();
                  applyUpdate(s);
                  setCheckMsg(s.status === 'available' ? `发现新版本 v${s.info?.version}，点击页顶横幅更新` : s.status === 'error' ? `检查失败：${s.error}` : '已是最新版本');
                } catch (e) {
                  setCheckMsg(`检查失败：${e instanceof Error ? e.message : e}`);
                } finally {
                  setChecking(false);
                }
              }}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} />
              检查更新
            </Button>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={autoUpdate}
                onCheckedChange={async (v) => {
                  setAutoUpdate(v);
                  try { await api.saveUiSettings({ autoUpdate: v }); } catch { setAutoUpdate(!v); }
                }}
              />
              启动时自动检查更新
            </label>
            {checkMsg && <span className="text-xs text-muted-foreground">{checkMsg}</span>}
          </div>
        )}
      </section>
      )}

      {tab === 'reading' && (
      <section className="bg-card border border-border rounded-lg p-4">
        <h2 className="font-medium text-sm mb-3">阅读与外观</h2>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <label className="flex items-center gap-2">
            <span className="w-24 text-muted-foreground">正文字体</span>
            <UISelect value={prefs.font} onValueChange={(v) => update({ font: v as typeof prefs.font })}>
              <SelectTrigger className="flex-1 h-8 w-auto text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="serif">衬线（宋体系）</SelectItem>
                <SelectItem value="sans">无衬线（黑体系）</SelectItem>
                <SelectItem value="mono">等宽</SelectItem>
              </SelectContent>
            </UISelect>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 text-muted-foreground">主题</span>
            <UISelect value={prefs.theme} onValueChange={(v) => update({ theme: v as typeof prefs.theme })}>
              <SelectTrigger className="flex-1 h-8 w-auto text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">浅色</SelectItem>
                <SelectItem value="dark">深色</SelectItem>
              </SelectContent>
            </UISelect>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 text-muted-foreground">字号 (px)</span>
            <input type="range" min={14} max={32} step={1} value={prefs.fontSize}
              onChange={(e) => update({ fontSize: Number(e.target.value) })} className="flex-1" />
            <span className="stat-num w-10 text-right">{prefs.fontSize}</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 text-muted-foreground">行距</span>
            <input type="range" min={1.4} max={2.4} step={0.05} value={prefs.lineHeight}
              onChange={(e) => update({ lineHeight: Number(e.target.value) })} className="flex-1" />
            <span className="stat-num w-10 text-right">{prefs.lineHeight.toFixed(2)}</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 text-muted-foreground">段落间距</span>
            <input type="range" min={0} max={2} step={0.1} value={prefs.paraSpacing}
              onChange={(e) => update({ paraSpacing: Number(e.target.value) })} className="flex-1" />
            <span className="stat-num w-10 text-right">{prefs.paraSpacing.toFixed(1)}em</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 text-muted-foreground">正文宽度</span>
            <input type="range" min={560} max={1080} step={20} value={prefs.width}
              onChange={(e) => update({ width: Number(e.target.value) })} className="flex-1" />
            <span className="stat-num w-12 text-right">{prefs.width}px</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 text-muted-foreground">代码字号</span>
            <input type="range" min={12} max={20} step={1} value={prefs.codeFontSize}
              onChange={(e) => update({ codeFontSize: Number(e.target.value) })} className="flex-1" />
            <span className="stat-num w-10 text-right">{prefs.codeFontSize}</span>
          </label>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button variant="outline" size="sm" className="text-xs" onClick={reset}>
            恢复默认（{DEFAULT_PREFS.fontSize}px / {DEFAULT_PREFS.lineHeight} 行距 / 浅色）
          </Button>
          <span className="text-xs text-muted-foreground">仅影响界面呈现，不修改源文件，不清除资料库与草稿。</span>
        </div>
      </section>
      )}

      {tab === 'reading' && (
      <section className="bg-card border border-border rounded-lg p-4">
        <h2 className="font-medium text-sm mb-1 flex items-center gap-1.5">
          <ShieldBan className="w-3.5 h-3.5" /> 屏蔽词表
        </h2>
        <p className="text-xs text-muted-foreground mb-3">
          列在表中的词条不再自动加链接（[[…]] 显式链接不受影响）。每行一个词，保存后立即生效，只影响显示，不修改源文件。
        </p>
        <textarea
          className="w-full h-28 px-2 py-1.5 rounded border border-input bg-background text-sm mono resize-y"
          value={blocklistRaw}
          placeholder={'例如：\n天\n道\n心'}
          onChange={(e) => setBlocklistRaw(e.target.value)}
        />
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={async () => {
              try {
                const terms = blocklistRaw.split('\n').map((s) => s.trim()).filter(Boolean);
                const r = await api.saveLinksBlocklist(terms);
                setBlocklistRaw(r.terms.join('\n'));
                setMsg('屏蔽词表已保存（重建链接后生效）');
                setTimeout(() => setMsg(''), 2000);
              } catch (e) {
                setMsg('保存失败：' + (e as Error).message);
              }
            }}
          >
            保存屏蔽词表
          </Button>
          {ignoredCount != null && ignoredCount > 0 && (
            <>
              <span className="text-xs text-muted-foreground">已忽略链接 {ignoredCount} 条（仅本篇生效）</span>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={async () => {
                  try {
                    const r = await api.linksIgnore({ clearAll: true });
                    setIgnoredCount(r.ignoredCount);
                    window.dispatchEvent(new CustomEvent('wb-links-updated'));
                    setMsg('已清除全部忽略');
                    setTimeout(() => setMsg(''), 2000);
                  } catch (e) {
                    setMsg('清除失败：' + (e as Error).message);
                  }
                }}
              >
                清除忽略
              </Button>
            </>
          )}
        </div>
      </section>
      )}

      {tab === 'collections' && (
      <section className="bg-card border border-border rounded-lg p-4">
        <h2 className="font-medium text-sm mb-1">逻辑集合</h2>
        <p className="text-xs text-muted-foreground mb-3">
          集合是「名称 → 一组目录范围」的映射，用于「集合名|文件名」引用形式。多个集合可指向同一目录。目录改名后可在此重新关联。
        </p>
        <div className="space-y-3">
          {collections.map((c, i) => (
            <div key={i} className="border border-border rounded p-3">
              <div className="flex items-center gap-2 mb-2">
                <input
                  value={c.name}
                  placeholder="集合名"
                  className="px-2 py-1 rounded border border-input bg-background text-sm w-40"
                  onChange={(e) => {
                    const next = [...collections];
                    next[i] = { ...c, name: e.target.value };
                    setCollections(next);
                  }}
                  onBlur={() => persistCollections(collections)}
                />
                {c.missingDirs && c.missingDirs.length > 0 && (
                  <span className="text-xs text-warning">
                    失效目录：{c.missingDirs.join('、')}（请在下方重新选择）
                  </span>
                )}
                <div className="flex-1" />
                <button
                  className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground"
                  onClick={() => persistCollections(collections.filter((_, j) => j !== i))}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5 max-h-28 overflow-auto">
                {allDirs.map((d) => {
                  const on = c.dirs.includes(d);
                  return (
                    <button
                      key={d}
                      className={`text-xs px-2 py-0.5 rounded-full border ${
                        on ? 'border-primary text-primary bg-primary/5' : 'border-border text-muted-foreground hover:bg-accent transition-colors'
                      }`}
                      onClick={() => {
                        const next = [...collections];
                        next[i] = { ...c, dirs: on ? c.dirs.filter((x) => x !== d) : [...c.dirs, d] };
                        persistCollections(next);
                      }}
                    >
                      {d}
                    </button>
                  );
                })}
                {allDirs.length === 0 && <span className="text-xs text-muted-foreground">（扫描后此处列出实际目录）</span>}
              </div>
            </div>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-3 text-xs"
          onClick={() => persistCollections([...collections, { name: '', dirs: [] }])}
        >
          <Plus className="w-3.5 h-3.5" /> 新增集合
        </Button>
      </section>
      )}

      {/* 元数据映射 */}
      {tab === 'metadata' && (
      <section className="bg-card border border-border rounded-lg p-4">
        <h2 className="font-medium text-sm mb-1">元数据来源</h2>
        <p className="text-xs text-muted-foreground mb-3">
          从已扫描的 JSON 文件识别主题/概念/文件关联。指定：来源文件、条目数组路径（如 items，留空表示顶层数组）、各字段名。不假定固定 Schema。
        </p>
        <div className="space-y-3">
          {mappings.map((m, i) => (
            <div key={i} className="border border-border rounded p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap text-sm">
                <input
                  value={m.file}
                  placeholder="来源 JSON 相对路径"
                  className="px-2 py-1 rounded border border-input bg-background text-sm w-64 mono"
                  onChange={(e) => {
                    const next = [...mappings];
                    next[i] = { ...m, file: e.target.value };
                    setMappings(next);
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={async () => {
                    try {
                      const r = await api.inspectMetadata(m.file);
                      setInspect({ ...inspect, [i]: JSON.stringify(r.shape, null, 2) });
                    } catch (e) {
                      setInspect({ ...inspect, [i]: '解析失败：' + (e as Error).message });
                    }
                  }}
                >
                  <Eye className="w-3 h-3" /> 预览结构
                </Button>
                <div className="flex-1" />
                <button
                  className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground"
                  onClick={() => persistMappings(mappings.filter((_, j) => j !== i))}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                {(
                  [
                    ['itemPath', '条目数组路径'],
                    ['file', '文件名字段'],
                    ['topics', '主题字段'],
                    ['concepts', '概念字段'],
                  ] as const
                ).map(([field, label]) => (
                  <label key={field} className="block">
                    <span className="text-muted-foreground">{label}</span>
                    <input
                      value={field === 'itemPath' ? m.itemPath : m.fields[field]}
                      className="mt-0.5 w-full px-2 py-1 rounded border border-input bg-background mono"
                      onChange={(e) => {
                        const next = [...mappings];
                        next[i] =
                          field === 'itemPath'
                            ? { ...m, itemPath: e.target.value }
                            : { ...m, fields: { ...m.fields, [field]: e.target.value } };
                        setMappings(next);
                      }}
                      onBlur={() => persistMappings(mappings)}
                    />
                  </label>
                ))}
              </div>
              {inspect[i] && (
                <pre className="text-xs bg-muted rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap">{inspect[i]}</pre>
              )}
            </div>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-3 text-xs"
          onClick={() =>
            persistMappings([...mappings, { file: '', itemPath: '', fields: { file: '', topics: '', concepts: '' } }])
          }
        >
          <Plus className="w-3.5 h-3.5" /> 新增元数据来源
        </Button>
      </section>
      )}

      {tab === 'metadata' && <MetaImport />}
    </div>
  );
}
