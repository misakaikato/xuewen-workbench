// 资料库管理：添加（输入/测试/加载）+ 已打开资料库清单（状态、移除）。
// 移除只移出工作区：停监听、卸内存索引；磁盘文件与草稿/最近记录/集合配置全保留。
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useApp } from '@/store/app';
import { Database, CheckCircle2, XCircle, Loader2, FolderMinus, Plus } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

export default function Setup() {
  const { config, libraries, refreshConfig, removeLib } = useApp();
  const [baseDir, setBaseDir] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; error?: string; writable?: boolean } | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  const navigate = useNavigate();

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      const r = await api.testDir(baseDir);
      setResult(r);
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setSaveMsg(null);
    try {
      await api.saveConfig(baseDir);
      await refreshConfig();
      setSaveMsg('已添加并打开资料库。');
      setBaseDir('');
      setResult(null);
      navigate('/');
    } catch (e) {
      setSaveMsg('添加失败：' + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const libStatusText = (l: (typeof libraries)[number]) => {
    const s = l.status;
    if (s.scanning) return '扫描中…';
    if (!s.scannedAt) return s.baseDir ? '目录不可访问' : '未扫描';
    const c = s.counts;
    return `共 ${c?.files ?? 0} 文件${s.watching ? ' · 自动监听' : ''}`;
  };

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <div className="flex items-center gap-3 mb-1">
        <img src="/logo-64.png" alt="Workbench" className="w-12 h-12 rounded-xl shrink-0 select-none" draggable={false} />
        <div>
          <h1 className="text-lg font-semibold leading-tight">Workbench</h1>
          <p className="text-sm text-muted-foreground">资料库管理</p>
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        资料库是本机的一个语料目录（包含 Markdown、JSON、Word 文件）。可以同时打开多个，随时切换或移出工作区；
        路径支持中文、空格与 Windows 反斜杠，配置在服务端持久化，重启后自动恢复。
      </p>

      {/* 添加资料库 */}
      <section className="bg-card border border-border rounded-lg p-4 mb-6">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
          <Plus className="w-4 h-4 text-primary" /> 添加资料库
        </h2>
        <label className="block text-sm font-medium mb-1">语料根目录</label>
        <input
          value={baseDir}
          onChange={(e) => {
            setBaseDir(e.target.value);
            setResult(null);
          }}
          placeholder={'例如 D:\\语料库 或 /Users/me/corpus'}
          className="w-full px-3 py-2 rounded border border-input bg-background text-sm mono"
        />
        <p className="text-xs text-muted-foreground mt-1">
          路径指向<b>本服务端所在电脑</b>的目录。浏览器本身没有磁盘权限，读写由本应用后端完成。
        </p>
        <div className="flex gap-2 mt-3">
          <Button
            variant="outline"
            onClick={test}
            disabled={testing || !baseDir.trim()}
          >
            {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />} 测试连接
          </Button>
          <Button
            onClick={save}
            disabled={saving || !baseDir.trim()}
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} 添加并打开
          </Button>
        </div>
        {result && (
          <div
            className={`mt-3 text-sm rounded border p-3 flex items-start gap-2 ${
              result.ok
                ? 'border-success/40 bg-success-soft text-success-foreground'
                : 'border-destructive/40 bg-destructive/10 text-destructive'
            }`}
          >
            {result.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5" /> : <XCircle className="w-4 h-4 mt-0.5" />}
            <div>
              {result.ok ? (
                <>
                  目录可访问、可读取。
                  {result.writable ? ' 写入能力正常。' : ' ⚠️ 目录只读：可阅读与检索，但不能编辑保存。'}
                </>
              ) : (
                result.error
              )}
            </div>
          </div>
        )}
        {saveMsg && <div className="mt-3 text-sm text-muted-foreground">{saveMsg}</div>}
      </section>

      {/* 已打开的资料库 */}
      <section className="bg-card border border-border rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
          <Database className="w-4 h-4 text-primary" /> 已打开的资料库（{libraries.length}）
        </h2>
        {libraries.length === 0 ? (
          <div className="text-sm text-muted-foreground">还没有打开任何资料库，先在上方添加一个。</div>
        ) : (
          <ul className="divide-y divide-border">
            {libraries.map((l) => {
              const active = l.id === config?.dsId;
              const errs = l.status.dirErrors.length + l.status.fileErrors.length;
              return (
                <li key={l.id} className="py-2.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm flex items-center gap-2">
                      <span className="font-medium truncate">{l.name}</span>
                      {active && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary shrink-0">当前</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground truncate" title={l.baseDir}>{l.baseDir}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {libStatusText(l)}
                      {errs > 0 && <span className="text-warning"> · {errs} 项访问失败</span>}
                    </div>
                  </div>
                  <button
                    className="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-destructive shrink-0"
                    title="从工作区移除（不删除磁盘文件）"
                    onClick={() => setRemoveTarget({ id: l.id, name: l.name })}
                  >
                    <FolderMinus className="w-4 h-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <AlertDialog open={!!removeTarget} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>从工作区移除「{removeTarget?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              只把它移出本应用的打开列表（停止监听、卸载内存索引），不会删除磁盘上的任何文件；
              最近记录、草稿与集合配置都会保留，重新添加同目录即可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const t = removeTarget;
                setRemoveTarget(null);
                if (t) removeLib(t.id).catch(() => {});
              }}
            >
              移除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
