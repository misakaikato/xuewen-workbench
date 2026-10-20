// 文档标签栏：浏览器式多标签，激活态跟随 URL，点关闭跳相邻标签
import { X, FileText } from 'lucide-react';
import { tabTitle } from '@/lib/tabs';

export function DocTabs({
  tabs,
  active,
  onActivate,
  onClose,
}: {
  tabs: string[];
  active: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  if (!tabs.length) return null;
  return (
    <div className="flex items-end gap-0.5 overflow-x-auto shrink-0 px-1 pt-1 select-none" role="tablist">
      {tabs.map((p) => {
        const isActive = p === active;
        return (
          <div
            key={p}
            role="tab"
            aria-selected={isActive}
            title={p}
            className={
              'group flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-t-md text-xs cursor-pointer max-w-[180px] shrink-0 border border-b-0 transition-colors ' +
              (isActive
                ? 'bg-card border-border text-foreground font-medium'
                : 'bg-muted/40 border-transparent text-muted-foreground hover:bg-muted')
            }
            onClick={() => onActivate(p)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(p); } }}
          >
            <FileText className="w-3 h-3 shrink-0 opacity-60" />
            <span className="truncate">{tabTitle(p)}</span>
            <button
              className={
                'p-0.5 rounded hover:bg-accent shrink-0 transition-opacity ' +
                (isActive ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100')
              }
              title="关闭标签（中键点击标签也可关闭）"
              onClick={(e) => { e.stopPropagation(); onClose(p); }}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
