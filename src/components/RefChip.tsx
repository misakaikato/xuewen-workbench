// 引用链接组件：点击时实时解析目标；唯一命中直接打开，重名展示候选，缺失说明原因
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/lib/api';
import type { RefResolution } from '@/lib/types';
import { FileText, FileJson, FileType, AlertCircle } from 'lucide-react';

export function extIcon(ext: string) {
  if (ext === '.json') return <FileJson className="w-3.5 h-3.5 inline" />;
  if (ext === '.doc' || ext === '.docx') return <FileType className="w-3.5 h-3.5 inline" />;
  return <FileText className="w-3.5 h-3.5 inline" />;
}

export function RefChip({
  href,
  children,
  inlineCode,
}: {
  href: string;
  children: React.ReactNode;
  inlineCode?: boolean;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<RefResolution | null>(null);
  const [busy, setBusy] = useState(false);

  const isCollectionRef = href.startsWith('refc://');
  const payload = decodeURIComponent(href.replace(/^refc?:\/\//, ''));
  const [collection, name] = isCollectionRef ? payload.split('|').map(decodeURIComponent) : [null, payload];

  async function onClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.resolveRef(name!, collection);
      if (r.status === 'unique') {
        navigate('/read/' + r.targets[0].path.split('/').map(encodeURIComponent).join('/'));
      } else {
        setRes(r);
        setOpen(true);
      }
    } catch (err) {
      setRes({ status: 'missing', targets: [], reason: '解析请求失败: ' + (err as Error).message });
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <a
          href="#"
          onClick={onClick}
          className={inlineCode ? 'corpus-ref corpus-ref-inline-code' : 'corpus-ref'}
          title={collection ? `集合引用：${collection} | ${name}` : `引用：${name}`}
        >
          {children}
        </a>
      </PopoverTrigger>
      <PopoverContent className="w-96 text-sm" align="start">
        {!res ? (
          <div className="text-muted-foreground">解析中…</div>
        ) : res.status === 'candidates' ? (
          <div>
            <div className="font-medium mb-2">找到 {res.targets.length} 个同名目标，请选择：</div>
            <ul className="space-y-1 max-h-64 overflow-auto">
              {res.targets.map((t) => (
                <li key={t.path}>
                  <button
                    className="w-full text-left px-2 py-1.5 rounded hover:bg-accent flex items-center gap-2"
                    onClick={() => {
                      setOpen(false);
                      navigate('/read/' + t.path.split('/').map(encodeURIComponent).join('/'));
                    }}
                  >
                    {extIcon(t.ext)}
                    <span className="truncate">{t.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div>
            <div className="flex items-start gap-2 text-muted-foreground">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
              <span>{res.reason || '未解析的引用'}</span>
            </div>
            {res.suggestions && res.suggestions.length > 0 && (
              <div className="mt-2">
                <div className="text-xs text-muted-foreground mb-1">全库中存在同名文件（不会自动跳转）：</div>
                <ul className="space-y-1">
                  {res.suggestions.map((t) => (
                    <li key={t.path}>
                      <button
                        className="w-full text-left px-2 py-1 rounded hover:bg-accent flex items-center gap-2"
                        onClick={() => {
                          setOpen(false);
                          navigate('/read/' + t.path.split('/').map(encodeURIComponent).join('/'));
                        }}
                      >
                        {extIcon(t.ext)}
                        <span className="truncate">{t.path}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
