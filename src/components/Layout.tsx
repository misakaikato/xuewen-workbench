// 整体布局：顶栏（logo、概览、知识库切换、全局搜索、重扫、设置）+ 可折叠侧栏（目录树）+ 内容区
// 小屏幕侧栏变为抽屉；Escape 关闭抽屉。多知识库：切换器列出全部已打开库，可添加/移除。
import { useEffect, useRef, useState } from 'react';
import { Outlet, useNavigate, Link, useLocation } from 'react-router-dom';
import { useApp } from '@/store/app';
import { UpdateBanner } from './UpdateBanner';
import { FileTree } from './FileTree';
import { setEntryContext } from '@/lib/entryOps';
import { EmptyState } from './ui-states';
import { CommandPalette } from './CommandPalette';
import { QuickAgent } from './QuickAgent';
import { Kbd } from '@/components/ui/kbd';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  LayoutDashboard, RefreshCw, Settings, Database, PanelLeftClose, PanelLeftOpen, Search,
  ChevronsUpDown, Check, Plus, FolderMinus, Bot } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export function Layout() {
  const { config, libraries, tree, rescan, dsId, refreshTree, activateLib, removeLib } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [treeFilter, setTreeFilter] = useState('');
  const [rescanning, setRescanning] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false);
      // ⌘K / Ctrl+K：命令面板（全局检索 + 导航 + 动作）
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      // ⌘J / Ctrl+J：任意位置唤出浮层智能助手（不离开当前页面）
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setQuickOpen((v) => !v);
      }
      // Esc 关闭浮层（输入框内的 Esc 由组件自己处理，这里兜底）
      if (e.key === 'Escape') setQuickOpen(false);
      // ?：快捷键清单（输入框内不触发）
      if (e.key === '?' && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) {
        setShortcutsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => setDrawer(false), [location.pathname]);

  // 登记条目操作（重命名/移动/删除）的应用上下文：刷新树与跟随导航
  const locRef = useRef(location);
  locRef.current = location;
  useEffect(() => {
    setEntryContext({
      dsId,
      refreshTree,
      navigate,
      getLocation: () => locRef.current,
    });
    return () => setEntryContext(null);
  }, [dsId, refreshTree, navigate]);

  const st = config?.status;
  // macOS 下 Electron 用 hiddenInset 标题栏：顶栏整体作为拖拽区，左端让出红绿灯按钮
  const isMacElectron = /Electron/.test(navigator.userAgent) && /Mac/.test(navigator.platform || '');
  const currentName = config?.baseDir
    ? (libraries.find((l) => l.id === dsId)?.name ?? config.baseDir)
    : '未打开知识库';

  // 侧栏宽度：可拖拽调整并持久化（仅桌面侧栏；抽屉固定宽）
  const [sideW, setSideW] = useState(() => {
    const n = Number(localStorage.getItem('wb.sidebar.w'));
    return Number.isFinite(n) && n >= 200 && n <= 480 ? n : 256;
  });
  const sideWRef = useRef(sideW);
  sideWRef.current = sideW;
  const [dragging, setDragging] = useState(false);
  const onResizeDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const start = e.clientX;
    const w0 = sideWRef.current;
    const move = (ev: MouseEvent) => {
      setSideW(Math.max(200, Math.min(480, w0 + (ev.clientX - start))));
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  // 宽度防抖持久化：拖完 200ms 无变化后落盘，避免依赖 up 回调的渲染时序
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem('wb.sidebar.w', String(Math.round(sideW))); } catch { /* 忽略 */ }
    }, 200);
    return () => clearTimeout(t);
  }, [sideW]);

  const sidebarContent = (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b border-sidebar-border">
        <input
          value={treeFilter}
          onChange={(e) => setTreeFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setTreeFilter('');
              if (!treeFilter) (e.target as HTMLInputElement).blur();
            }
            // 前缀语法：>关键词 回车直达全文检索
            if (e.key === 'Enter') {
              const v = treeFilter.trim();
              if (v.startsWith('>')) {
                const qs = v.slice(1).trim();
                if (qs) navigate('/search?q=' + encodeURIComponent(qs));
              }
            }
          }}
          placeholder="过滤目录与文件…（Esc 清空，> 转全文）"
          className="w-full text-xs px-2 py-1.5 rounded border border-input bg-background"
        />
      </div>
      <div className="flex-1 min-h-0">
        {tree ? (
          <FileTree tree={tree} filter={treeFilter} onFilterChange={setTreeFilter} />
        ) : st?.scanning ? (
          // 扫描中骨架屏：代替干巴巴的一行字
          <div className="p-2 space-y-1.5" aria-label="正在扫描知识库">
            <div className="h-6 rounded bg-sidebar-accent/70 animate-pulse w-3/5" />
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className="h-7 rounded bg-sidebar-accent/60 animate-pulse" style={{ width: `${92 - (i % 4) * 14}%` }} />
            ))}
          </div>
        ) : (
          <div className="p-3"><EmptyState compact title="暂无目录数据" /></div>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-screen flex flex-col">
      <UpdateBanner />
      {/* 顶栏用主题窗框色（B 主题下无分隔线，见 themes.css） */}
      <header className={`h-12 shrink-0 border-b border-border wb-chrome flex items-center gap-2 px-3 ${isMacElectron ? 'wb-drag pl-[78px]' : ''}`}>
        <img src="/logo-32.png" alt="Workbench" className="w-6 h-6 rounded-[5px] shrink-0 select-none" draggable={false} />
        <button
          className="p-1.5 rounded hover:bg-accent transition-colors md:hidden"
          onClick={() => setDrawer(true)}
          aria-label="打开目录"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
        <button
          className="p-1.5 rounded hover:bg-accent transition-colors hidden md:block"
          onClick={() => setCollapsed(!collapsed)}
          aria-label="折叠侧栏"
        >
          {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        </button>
        <Link to="/" className="flex items-center gap-1.5 text-sm font-medium hover:text-primary transition-colors px-1">
          <LayoutDashboard className="w-4 h-4" />
          <span className="hidden sm:inline">知识库概览</span>
        </Link>
        <Link to="/agent" className="flex items-center gap-1.5 text-sm font-medium hover:text-primary transition-colors px-1" title="智能助手：多轮对话 · 工具 · skills/MCP">
          <Bot className="w-4 h-4" />
          <span className="hidden sm:inline">智能助手</span>
        </Link>
        <span className="text-border">|</span>
        {/* 知识库切换器：列出全部已打开库；添加/移除入口 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors min-w-0 px-1.5 py-1 rounded hover:bg-accent/50"
              title={config?.baseDir || '打开知识库'}
            >
              <Database className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate max-w-[120px] md:max-w-[240px]">{currentName}</span>
              <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-96">
            <DropdownMenuLabel>知识库（{libraries.length} 个已打开）</DropdownMenuLabel>
            {libraries.map((l) => (
              <DropdownMenuItem
                key={l.id}
                onClick={() => {
                  if (l.id !== dsId) {
                    activateLib(l.id).catch(() => {});
                    navigate('/');
                  }
                }}
              >
                <Check className={`w-4 h-4 shrink-0 ${l.id === dsId ? 'opacity-100' : 'opacity-0'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{l.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{l.baseDir}</div>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {l.status.scanning ? '扫描中…' : l.status.counts ? `${l.status.counts.files} 文件` : '未扫描'}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate('/setup')}>
              <Plus className="w-4 h-4 shrink-0" /> 添加知识库…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!config?.configured}
              onClick={() => setConfirmRemove(true)}
              className="text-destructive focus:text-destructive"
            >
              <FolderMinus className="w-4 h-4 shrink-0" /> 从工作区移除当前知识库…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {st && config?.configured && (
          <span className="text-xs text-muted-foreground hidden lg:inline">
            {st.scanning ? '扫描中…' : st.counts ? '' : ''}
            {st.watching && (
              <span className="inline-flex items-center gap-1">
                {'· '}
                <span className="w-1.5 h-1.5 rounded-full bg-success inline-block shrink-0" />
                自动监听
              </span>
            )}
          </span>
        )}
        <div className="flex-1" />
        {/* ⌘K 命令面板触发器（视觉上是搜索框，点击/快捷键都进面板） */}
        <button
          className="flex items-center gap-2 text-xs px-2 py-1.5 rounded border border-input bg-background w-40 md:w-64 text-muted-foreground hover:border-primary/40 transition-colors"
          onClick={() => setPaletteOpen(true)}
          id="global-search"
        >
          <Search className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1 text-left truncate">全局检索…</span>
          <Kbd className="shrink-0">⌘K</Kbd>
        </button>
        <button
          className="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-primary disabled:opacity-40"
          title="重新扫描知识库"
          disabled={rescanning || !config?.configured}
          onClick={async () => {
            setRescanning(true);
            try {
              await rescan();
            } finally {
              setRescanning(false);
            }
          }}
        >
          <RefreshCw className={`w-4 h-4 ${rescanning || st?.scanning ? 'animate-spin' : ''}`} />
        </button>
        <Link to="/settings" className="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-primary" title="设置">
          <Settings className="w-4 h-4" />
        </Link>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* 侧栏常驻渲染，折叠用宽度动画（med 档 + 签名缓动）；拖拽期间关掉过渡避免跟手延迟 */}
        <aside
          className={`hidden md:block shrink-0 bg-sidebar overflow-hidden relative ${
            collapsed ? '' : 'border-r border-sidebar-border'
          } ${dragging ? '' : 'transition-[width] duration-med ease-signature'}`}
          style={{ width: collapsed ? 0 : sideW }}
          aria-hidden={collapsed}
        >
          {/* 内层固定宽度：折叠动画期间内容不回流、不挤压 */}
          <div className="h-full" style={{ width: sideW }}>
            {sidebarContent}
          </div>
          {!collapsed && (
            <div
              onMouseDown={onResizeDown}
              className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 transition-colors hover:bg-primary/30 ${
                dragging ? 'bg-primary/40' : ''
              }`}
              title="拖拽调整侧栏宽度"
              aria-hidden
            />
          )}
        </aside>
        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={() => setDrawer(false)} />
            <aside className="absolute left-0 top-0 bottom-0 w-72 bg-sidebar shadow-xl animate-drawer-in">{sidebarContent}</aside>
          </div>
        )}
        <main className="flex-1 min-w-0 overflow-auto">
          {/* 路由过渡：按顶级 section key 重挂载，fade + 4px 上移；同路由内参数变化不触发 */}
          <div key={location.pathname.split('/')[1] ?? ''} className="animate-page-enter h-full">
            <Outlet />
          </div>
        </main>
      </div>

      {/* ⌘K 命令面板与快捷键清单 */}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <QuickAgent open={quickOpen} onClose={() => setQuickOpen(false)} />
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>快捷键</DialogTitle>
            <DialogDescription>全局与阅读/编辑页的键盘操作</DialogDescription>
          </DialogHeader>
          <div className="text-sm space-y-1.5">
            {[
              ['⌘K / Ctrl+K', '命令面板（全局检索 / 导航 / 动作）'],
              ['⌘J / Ctrl+J', '浮层智能助手（任意页面，不离开当前页）'],
              ['?', '本快捷键清单'],
              ['Esc', '关闭浮层 / 清空侧栏过滤'],
              ['Ctrl+F', '阅读页文内查找'],
              ['Ctrl+E', '阅读页进入 / 结束编辑'],
              ['Ctrl+S', '保存（编辑态）'],
              ['Alt+← / Alt+→ 或 ⌘[ / ⌘]', '阅读历史后退 / 前进'],
              ['侧栏过滤框输入 > 后回车', '转全文检索'],
            ].map(([keys, desc]) => (
              <div key={keys} className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">{desc}</span>
                <Kbd className="shrink-0">{keys}</Kbd>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* 移除当前知识库确认：只移出工作区（停监听/卸索引），不动磁盘文件与草稿/最近记录 */}
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>从工作区移除「{currentName}」？</AlertDialogTitle>
            <AlertDialogDescription>
              只把它移出本应用的打开列表（停止监听、卸载内存索引），不会删除磁盘上的任何文件；
              最近记录、草稿与集合配置都会保留，重新添加同目录即可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const id = dsId;
                setConfirmRemove(false);
                if (id) removeLib(id).catch(() => {});
                navigate('/');
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
