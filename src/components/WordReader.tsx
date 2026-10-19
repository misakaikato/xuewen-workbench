// Word 阅读器：默认工作台内预览（服务端解析为 HTML）。
// 提供「原版式」（缩放/适应宽度）与「重排阅读」（应用阅读偏好）两种模式。
// Word 为只读：提供下载原文件与「另存为 Markdown 副本」入口，不伪装可编辑。
import { useState } from 'react';
import { api, rawFileUrl } from '@/lib/api';
import { useApp } from '@/store/app';
import { Download, FilePlus2, AlertCircle, ZoomIn, ZoomOut } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';

export function WordReader({
  path,
  name,
  html,
  text,
  warning,
  engine,
}: {
  path: string;
  name: string;
  html: string;
  text: string;
  warning?: string | null;
  engine?: string;
}) {
  const [mode, setMode] = useState<'original' | 'reflow'>('reflow');
  const [zoom, setZoom] = useState(100);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const { dsId } = useApp();
  const navigate = useNavigate();

  async function saveAsMarkdown() {
    if (!dsId) return;
    const target = path.replace(/\.(docx?|DOCX?)$/, '') + '（转换副本）.md';
    setSaving(true);
    setMsg(null);
    try {
      const md = `# ${name.replace(/\.(docx?|DOCX?)$/, '')}\n\n> 本文件由 Word 文档「${name}」转换生成，仅保留正文文本；原文件保持不变。\n\n${text}`;
      await api.saveAs(target, md, dsId);
      setMsg('已另存为 Markdown 副本：' + target);
      setTimeout(() => navigate('/read/' + target.split('/').map(encodeURIComponent).join('/')), 600);
    } catch (e) {
      setMsg('另存失败：' + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      {warning && (
        <div className="flex items-start gap-2 text-sm text-warning-foreground bg-warning-soft border border-warning/40 rounded p-3 mb-3">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{warning}</span>
        </div>
      )}
      <div className="flex items-center gap-2 mb-3 flex-wrap text-xs">
        <div className="inline-flex rounded border border-border overflow-hidden">
          <button
            className={`px-2.5 py-1 ${mode === 'original' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent transition-colors'}`}
            onClick={() => setMode('original')}
            title="保留服务端转换的原始排版，可缩放"
          >
            原版式
          </button>
          <button
            className={`px-2.5 py-1 ${mode === 'reflow' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent transition-colors'}`}
            onClick={() => setMode('reflow')}
            title="应用阅读偏好（字体/字号/行距）"
          >
            重排阅读
          </button>
        </div>
        {mode === 'original' && (
          <div className="flex items-center gap-1">
            <button className="p-1 rounded hover:bg-accent transition-colors" onClick={() => setZoom((z) => Math.max(50, z - 10))}>
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="stat-num w-10 text-center">{zoom}%</span>
            <button className="p-1 rounded hover:bg-accent transition-colors" onClick={() => setZoom((z) => Math.min(200, z + 10))}>
              <ZoomIn className="w-4 h-4" />
            </button>
          </div>
        )}
        <span className="text-muted-foreground">解析引擎：{engine || '未知'}</span>
        <span className="flex-1" />
        <a
          href={rawFileUrl(path)}
          className={buttonVariants({ variant: 'outline', size: 'sm', className: 'text-xs' })}
        >
          <Download className="w-3.5 h-3.5" /> 下载原文件
        </a>
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          disabled={saving}
          onClick={saveAsMarkdown}
          title="将提取的正文另存为新的 Markdown 文件，不修改原文件"
        >
          <FilePlus2 className="w-3.5 h-3.5" /> {saving ? '另存中…' : '另存为 Markdown 副本'}
        </Button>
      </div>
      {msg && <div className="text-xs text-muted-foreground mb-2">{msg}</div>}
      <div className="text-xs text-muted-foreground mb-3 border border-dashed border-border rounded p-2">
        Word 文档在工作台中为只读预览。如需修改，请下载后用 Word/WPS 编辑并覆盖原文件，或另存为 Markdown 副本在工作台中编辑。
      </div>
      {mode === 'reflow' ? (
        <div className="reader" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="overflow-x-auto">
          <div
            className="word-original bg-white text-black rounded-lg shadow-sm border border-border p-8 max-w-3xl"
            style={{ zoom: zoom / 100 }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )}
    </div>
  );
}
