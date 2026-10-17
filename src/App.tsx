import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useApp } from '@/store/app';
import { Layout } from '@/components/Layout';
import Setup from '@/pages/Setup';
import Dashboard from '@/pages/Dashboard';
import Browse from '@/pages/Browse';
import Read from '@/pages/Read';
import Edit from '@/pages/Edit';
import Search from '@/pages/Search';
import Settings from '@/pages/Settings';

function RequireSource({ children }: { children: React.ReactNode }) {
  const { config, loading } = useApp();
  const loc = useLocation();
  if (loading) return <div className="py-20 text-center text-sm text-muted-foreground">加载中…</div>;
  if (!config?.configured && loc.pathname !== '/setup') return <Navigate to="/setup" replace />;
  return <>{children}</>;
}

function GlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.getElementById('global-search')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}

export default function App() {
  return (
    <RequireSource>
      <GlobalShortcuts />
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/browse" element={<Browse />} />
          <Route path="/read/*" element={<Read />} />
          <Route path="/edit/*" element={<Edit />} />
          <Route path="/search" element={<Search />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </RequireSource>
  );
}
