// 文档标签栏：浏览器式多标签，激活态跟随 URL，右键提供批量关闭
import { useEffect, useState } from 'react';
import { X, FileText } from 'lucide-react';
import { tabTitle } from '@/lib/tabs';

interface MenuAt { x: number; y: number; path: string }

export function DocTabs({
  tabs,
  active,
  onActivate,
  onClose,
  onCloseMany,
}: {
  tabs: string[];
  active: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onCloseMany: (paths: string[]) => void;
}) {
  const [menu, setMenu] = useState<MenuAt | null>(null);

  // 点击任意处关闭菜单
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  if (!tabs.length) return null;

  const idxOf = (p: string) => tabs.indexOf(p);
  const menuItems = menu
    ? [
        { label: '关闭', act: () => onClose(menu.path), disabled: false },
        { label: '关闭其他标签', act: () => onCloseMany(tabs.filter((p) => p !== menu.path)), disabled: tabs.length <= 1 },
        { label: '关闭左侧标签', act: () => onCloseMany(tabs.slice(0, idxOf(menu.path))), disabled: idxOf(menu.path) <= 0 },
        { label: '关闭右侧标签', act: () => onCloseMany(tabs.slice(idxOf(menu.path) + 1)), disabled: idxOf(menu.path) >= tabs.length - 1 },
        { label: '全部关闭', act: () => onCloseMany([...tabs]), disabled: false },
      ]
    : [];

  return (
    <div className="flex items-end gap-0.5 overflow-x-auto shrink-0 px-1 pt-1 select-none bg-background border-b border-border" role="tablist">
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
                : 'bg-muted border-transparent text-muted-foreground hover:bg-accent')
            }
            onClick={() => onActivate(p)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(p); } }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, path: p });
            }}
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

      {menu && (
        <div
          className="fixed z-[80] min-w-[140px] bg-card border border-border rounded-lg shadow-xl py-1"
          style={{ left: Math.min(menu.x, window.innerWidth - 160), top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {menuItems.map((it) => (
            <button
              key={it.label}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent"
              disabled={it.disabled}
              onClick={() => { setMenu(null); it.act(); }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
