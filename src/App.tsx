import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useApp } from '@/store/app';
import { Layout } from '@/components/Layout';
import Setup from '@/pages/Setup';
import Dashboard from '@/pages/Dashboard';
import Browse from '@/pages/Browse';
import Read from '@/pages/Read';
import Edit from '@/pages/Edit';
import Search from '@/pages/Search';
import Settings from '@/pages/Settings';
import RagManage from './pages/RagManage';
import AgentChat from './pages/AgentChat';
import { PageLoading } from '@/components/ui-states';

function RequireSource({ children }: { children: React.ReactNode }) {
  const { config, loading } = useApp();
  const loc = useLocation();
  if (loading) return <PageLoading />;
  if (!config?.configured && loc.pathname !== '/setup') return <Navigate to="/setup" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <RequireSource>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/browse" element={<Browse />} />
          <Route path="/read/*" element={<Read />} />
          <Route path="/edit/*" element={<Edit />} />
          <Route path="/search" element={<Search />} />
          <Route path="/rag" element={<RagManage />} />
          <Route path="/agent" element={<AgentChat />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </RequireSource>
  );
}
