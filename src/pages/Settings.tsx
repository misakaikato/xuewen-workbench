// 设置页：阅读与外观（与阅读页快捷面板共用配置）、逻辑集合映射、元数据来源映射
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useApp } from '@/store/app';
import { useReadingPrefs, DEFAULT_PREFS } from '@/lib/prefs';
import type { Collection, MetadataMapping, TreeNode } from '@/lib/types';
import { Plus, Trash2, Eye } from 'lucide-react';

function collectDirs(node: TreeNode, out: string[]) {
  if (node.path) out.push(node.path);
  node.dirs.forEach((d) => collectDirs(d, out));
}

export default function Settings() {
  const { prefs, update, reset } = useReadingPrefs();
  const { tree, dsId } = useApp();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [mappings, setMappings] = useState<MetadataMapping[]>([]);
  const [msg, setMsg] = useState('');
  const [inspect, setInspect] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!dsId) return;
    api.collections().then((r) => setCollections(r.collections)).catch(() => {});
    api.metadata().then((r) => setMappings(r.mappings)).catch(() => {});
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
      <h1 className="text-lg font-bold">设置</h1>
      {msg && <div className="text-xs text-green-700 dark:text-green-400">{msg}</div>}

      {/* 阅读与外观 */}
      <section className="bg-card border border-border rounded-lg p-4">
        <h2 className="font-medium text-sm mb-3">阅读与外观</h2>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <label className="flex items-center gap-2">
            <span className="w-24 text-muted-foreground">正文字体</span>
            <select
              value={prefs.font}
              onChange={(e) => update({ font: e.target.value as typeof prefs.font })}
              className="flex-1 px-2 py-1.5 rounded border border-input bg-background text-sm"
            >
              <option value="serif">衬线（宋体系）</option>
              <option value="sans">无衬线（黑体系）</option>
              <option value="mono">等宽</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 text-muted-foreground">主题</span>
            <select
              value={prefs.theme}
              onChange={(e) => update({ theme: e.target.value as typeof prefs.theme })}
              className="flex-1 px-2 py-1.5 rounded border border-input bg-background text-sm"
            >
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
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
          <button className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent" onClick={reset}>
            恢复默认（{DEFAULT_PREFS.fontSize}px / {DEFAULT_PREFS.lineHeight} 行距 / 浅色）
          </button>
          <span className="text-xs text-muted-foreground">仅影响界面呈现，不修改源文件，不清除数据源与草稿。</span>
        </div>
      </section>

      {/* 逻辑集合 */}
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
                  <span className="text-xs text-amber-700 dark:text-amber-400">
                    ⚠️ 失效目录：{c.missingDirs.join('、')}（请在下方重新选择）
                  </span>
                )}
                <div className="flex-1" />
                <button
                  className="p-1 rounded hover:bg-accent text-muted-foreground"
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
                        on ? 'border-primary text-primary bg-primary/5' : 'border-border text-muted-foreground hover:bg-accent'
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
        <button
          className="mt-3 text-xs px-3 py-1.5 rounded border border-border hover:bg-accent flex items-center gap-1"
          onClick={() => persistCollections([...collections, { name: '', dirs: [] }])}
        >
          <Plus className="w-3.5 h-3.5" /> 新增集合
        </button>
      </section>

      {/* 元数据映射 */}
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
                <button
                  className="text-xs px-2 py-1 rounded border border-border hover:bg-accent flex items-center gap-1"
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
                </button>
                <div className="flex-1" />
                <button
                  className="p-1 rounded hover:bg-accent text-muted-foreground"
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
        <button
          className="mt-3 text-xs px-3 py-1.5 rounded border border-border hover:bg-accent flex items-center gap-1"
          onClick={() =>
            persistMappings([...mappings, { file: '', itemPath: '', fields: { file: '', topics: '', concepts: '' } }])
          }
        >
          <Plus className="w-3.5 h-3.5" /> 新增元数据来源
        </button>
      </section>
    </div>
  );
}
