// 整体布局：顶栏（概览/数据源/全局搜索/重扫/设置）+ 可折叠侧栏（目录树）+ 内容区
// 小屏幕侧栏变为抽屉；Escape 关闭抽屉。
import { useEffect, useRef, useState } from 'react';
import { Outlet, useNavigate, Link, useLocation } from 'react-router-dom';
import { useApp } from '@/store/app';
import { FileTree } from './FileTree';
import { setEntryContext } from '@/lib/entryOps';
import { LayoutDashboard, RefreshCw, Settings, Database, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';

export function Layout() {
  const { config, tree, rescan, dsId, refreshTree } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [treeFilter, setTreeFilter] = useState('');
  const [q, setQ] = useState('');
  const [rescanning, setRescanning] = useState(false);
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

  const sidebarContent = (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b border-sidebar-border">
        <input
          value={treeFilter}
          onChange={(e) => setTreeFilter(e.target.value)}
          placeholder="过滤目录与文件…"
          className="w-full text-xs px-2 py-1.5 rounded border border-input bg-background"
        />
      </div>
      <div className="flex-1 overflow-auto p-1">
        {tree ? (
          <FileTree tree={tree} filter={treeFilter} />
        ) : (
          <div className="text-xs text-muted-foreground p-3">
            {st?.scanning ? '正在扫描数据源…' : '暂无目录数据'}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-screen flex flex-col">
      {/* 顶栏用主题窗框色（B 主题下无分隔线，见 themes.css） */}
      <header className="h-12 shrink-0 border-b border-border wb-chrome flex items-center gap-2 px-3">
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
        <Link
          to="/setup"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary max-w-[220px] md:max-w-md"
          title={config?.baseDir || '配置数据源'}
        >
          <Database className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{config?.baseDir || '未配置数据源'}</span>
        </Link>
        {st && (
          <span className="text-xs text-muted-foreground hidden lg:inline">
            {st.scanning ? '扫描中…' : st.counts ? `${st.counts.files} 个文件` : ''}
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
          title="重新扫描数据源"
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
    </div>
  );
}
