// 整体布局：顶栏（logo、概览、资料库切换、全局搜索、重扫、设置）+ 可折叠侧栏（目录树）+ 内容区
// 小屏幕侧栏变为抽屉；Escape 关闭抽屉。多资料库：切换器列出全部已打开库，可添加/移除。
import { useEffect, useRef, useState } from 'react';
import { Outlet, useNavigate, Link, useLocation } from 'react-router-dom';
import { useApp } from '@/store/app';
import { FileTree } from './FileTree';
import { setEntryContext } from '@/lib/entryOps';
import {
  LayoutDashboard, RefreshCw, Settings, Database, PanelLeftClose, PanelLeftOpen, Search,
  ChevronsUpDown, Check, Plus, FolderMinus,
} from 'lucide-react';
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
  const [treeFilter, setTreeFilter] = useState('');
  const [q, setQ] = useState('');
  const [rescanning, setRescanning] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false);
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
  const currentName = config?.baseDir
    ? (libraries.find((l) => l.id === dsId)?.name ?? config.baseDir)
    : '未打开资料库';

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
          }}
          placeholder="过滤目录与文件…（Esc 清空）"
          className="w-full text-xs px-2 py-1.5 rounded border border-input bg-background"
        />
      </div>
      <div className="flex-1 overflow-auto p-1">
        {tree ? (
          <FileTree tree={tree} filter={treeFilter} onFilterChange={setTreeFilter} />
        ) : (
          <div className="text-xs text-muted-foreground p-3">
            {st?.scanning ? '正在扫描资料库…' : '暂无目录数据'}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-screen flex flex-col">
      {/* 顶栏用主题窗框色（B 主题下无分隔线，见 themes.css） */}
      <header className="h-12 shrink-0 border-b border-border wb-chrome flex items-center gap-2 px-3">
        <img src="/logo-32.png" alt="学问 Workbench" className="w-6 h-6 rounded-[5px] shrink-0 select-none" draggable={false} />
        <button
          className="p-1.5 rounded hover:bg-accent md:hidden"
          onClick={() => setDrawer(true)}
          aria-label="打开目录"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
        <button
          className="p-1.5 rounded hover:bg-accent hidden md:block"
          onClick={() => setCollapsed(!collapsed)}
          aria-label="折叠侧栏"
        >
          {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        </button>
        <Link to="/" className="flex items-center gap-1.5 text-sm font-medium hover:text-primary px-1">
          <LayoutDashboard className="w-4 h-4" />
          <span className="hidden sm:inline">语料概览</span>
        </Link>
        <span className="text-border">|</span>
        {/* 资料库切换器：列出全部已打开库；添加/移除入口 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary min-w-0 px-1.5 py-1 rounded hover:bg-accent/50"
              title={config?.baseDir || '打开资料库'}
            >
              <Database className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate max-w-[120px] md:max-w-[240px]">{currentName}</span>
              <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-96">
            <DropdownMenuLabel>资料库（{libraries.length} 个已打开）</DropdownMenuLabel>
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
                  <div className="text-[11px] text-muted-foreground truncate">{l.baseDir}</div>
                </div>
                <span className="text-[11px] text-muted-foreground shrink-0">
                  {l.status.scanning ? '扫描中…' : l.status.counts ? `${l.status.counts.files} 文件` : '未扫描'}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate('/setup')}>
              <Plus className="w-4 h-4 shrink-0" /> 添加资料库…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!config?.configured}
              onClick={() => setConfirmRemove(true)}
              className="text-destructive focus:text-destructive"
            >
              <FolderMinus className="w-4 h-4 shrink-0" /> 从工作区移除当前资料库…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {st && config?.configured && (
          <span className="text-xs text-muted-foreground hidden lg:inline">
            {st.scanning ? '扫描中…' : st.counts ? '' : ''}
            {st.watching ? ' · 自动监听' : ''}
          </span>
        )}
        <div className="flex-1" />
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) navigate('/search?q=' + encodeURIComponent(q.trim()));
          }}
        >
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="全局检索（Ctrl+K）"
            className="text-xs pl-7 pr-2 py-1.5 rounded border border-input bg-background w-40 md:w-64"
            id="global-search"
          />
        </form>
        <button
          className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-primary disabled:opacity-40"
          title="重新扫描资料库"
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
        <Link to="/settings" className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-primary" title="设置">
          <Settings className="w-4 h-4" />
        </Link>
      </header>

      <div className="flex-1 flex min-h-0">
        {!collapsed && (
          <aside className="hidden md:block w-64 shrink-0 border-r border-sidebar-border bg-sidebar overflow-hidden">
            {sidebarContent}
          </aside>
        )}
        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
            <aside className="absolute left-0 top-0 bottom-0 w-72 bg-sidebar shadow-xl">{sidebarContent}</aside>
          </div>
        )}
        <main className="flex-1 min-w-0 overflow-auto">
          <Outlet />
        </main>
      </div>

      {/* 移除当前资料库确认：只移出工作区（停监听/卸索引），不动磁盘文件与草稿/最近记录 */}
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
