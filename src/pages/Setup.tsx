// 数据源设置：输入/测试/保存加载/重扫；显示访问与扫描状态
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useApp } from '@/store/app';
import { Database, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

export default function Setup() {
  const { config, refreshConfig } = useApp();
  const [baseDir, setBaseDir] = useState(config?.baseDir || '');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; error?: string; writable?: boolean } | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
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
      setSaveMsg('已保存并加载数据源。');
      navigate('/');
    } catch (e) {
      setSaveMsg('保存失败：' + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-bold mb-1 flex items-center gap-2">
        <Database className="w-6 h-6 text-primary" /> 数据源设置
      </h1>
      <p className="text-sm text-muted-foreground mb-6">
        指定本机语料根目录（包含 Markdown、JSON、Word 文件的目录）。路径支持中文、空格与 Windows 反斜杠。配置在服务端持久化，刷新或重启后自动恢复。
      </p>

      <label className="block text-sm font-medium mb-1">语料根目录 baseDir</label>
      <input
        value={baseDir}
        onChange={(e) => {
          setBaseDir(e.target.value);
          setResult(null);
        }}
        placeholder={'例如 D:\\语料库 或 /Users/me/corpus'}
        className="w-full px-3 py-2 rounded border border-input bg-card text-sm mono"
      />
      <p className="text-xs text-muted-foreground mt-1">
        路径指向<b>本服务端所在电脑</b>的目录。浏览器本身没有磁盘权限，读写由本应用后端完成。
      </p>

      <div className="flex gap-2 mt-4">
        <button
          className="px-4 py-2 rounded border border-border text-sm hover:bg-accent flex items-center gap-1.5 disabled:opacity-50"
          onClick={test}
          disabled={testing || !baseDir.trim()}
        >
          {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />} 测试连接
        </button>
        <button
          className="px-4 py-2 rounded bg-primary text-primary-foreground text-sm hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
          onClick={save}
          disabled={saving || !baseDir.trim()}
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} 保存并加载
        </button>
      </div>

      {result && (
        <div
          className={`mt-4 text-sm rounded border p-3 flex items-start gap-2 ${
            result.ok
              ? 'border-green-300 bg-green-50 text-green-800 dark:bg-green-950/40 dark:border-green-800 dark:text-green-300'
              : 'border-red-300 bg-red-50 text-red-800 dark:bg-red-950/40 dark:border-red-800 dark:text-red-300'
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

      {config?.configured && (
        <div className="mt-8 border-t border-border pt-4 text-sm">
          <div className="font-medium mb-2">当前数据源状态</div>
          <ul className="text-muted-foreground space-y-1 text-xs">
            <li>目录：{config.baseDir}</li>
            <li>
              扫描：
              {config.status.scanning
                ? '正在进行…'
                : config.status.scannedAt
                  ? `上次成功扫描 ${new Date(config.status.scannedAt).toLocaleString()}`
                  : '尚未扫描'}
              {config.status.watching ? '（文件监听已开启，变更会自动合并重扫）' : '（监听未开启，可手动重扫）'}
            </li>
            {config.status.counts && (
              <li>
                文件：共 {config.status.counts.files}（MD {config.status.counts.md} / JSON {config.status.counts.json} / DOC{' '}
                {config.status.counts.doc} / DOCX {config.status.counts.docx}），目录 {config.status.counts.dirs}
              </li>
            )}
            {(config.status.dirErrors.length > 0 || config.status.fileErrors.length > 0) && (
              <li className="text-amber-700 dark:text-amber-400">
                {config.status.dirErrors.length} 个目录、{config.status.fileErrors.length} 个文件访问失败（不影响其余内容）
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
