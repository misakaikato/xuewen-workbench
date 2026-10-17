// 自动内链词条：点击跳转目标文档（含标题锚点）；歧义词条弹候选；缺失词条说明。
// 渲染层组件，与 RefChip（集合|文件名 显式引用）并存。
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { decodeWblink } from '@/lib/remarkAutoLinks';
import { AlertCircle } from 'lucide-react';

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export function LinkChip({ href, kind, children }: { href: string; kind: 'auto' | 'wiki' | 'wiki-missing'; children?: React.ReactNode }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const info = decodeWblink(href);

  if (!info) return <span>{href}</span>;

  const cls = kind === 'auto' ? 'wb-autolink' : kind === 'wiki' ? 'wb-wikilink' : 'wb-wikilink-missing';

  // 缺失词条：不跳转，样式提示
  if (kind === 'wiki-missing' && !info.path) {
    return (
      <span className={cls} title={'未找到词条：' + info.term}>{children ?? info.term}</span>
    );
  }

  function openTarget(path: string, heading?: string | null) {
    const nav = '/read/' + encPath(path);
    navigate(heading ? nav + '#' + encodeURIComponent(heading) : nav);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <a
          href="#"
          className={cls}
          title={info.path ? info.path + (info.heading ? ' ＃ ' + info.heading : '') : '歧义词条：' + info.term}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (info.path && !info.candidates?.length) openTarget(info.path, info.heading);
            else setOpen(true);
          }}
        >
          {children ?? info.term}
        </a>
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm" align="start">
        {info.candidates?.length ? (
          <div>
            <div className="font-medium mb-2">「{info.term}」指向 {info.candidates.length} 个文档，请选择：</div>
            <ul className="space-y-1 max-h-64 overflow-auto">
              {info.candidates.map((p) => (
                <li key={p}>
                  <button
                    className="w-full text-left px-2 py-1.5 rounded hover:bg-accent truncate mono text-xs"
                    onClick={() => {
                      setOpen(false);
                      openTarget(p);
                    }}
                  >
                    {p}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex items-start gap-2 text-muted-foreground">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
            <span>未找到词条：{info.term}</span>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
