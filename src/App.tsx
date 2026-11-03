import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useApp } from '@/store/app-context';
import { useAgentEnabled } from '@/lib/theme-context';
import { notify } from '@/lib/notify';
import { Layout } from '@/components/Layout';
import { Toaster } from '@/components/Toaster';
import { UpdateInstallOverlay } from '@/components/UpdateInstallOverlay';
import { UpdateInstallNotice } from '@/components/UpdateInstallNotice';
import Dashboard from '@/pages/Dashboard';
import { PageLoading, PageSkeleton } from '@/components/ui-states';

// 概览是落地页保持同步加载；其余页面懒加载，首包只留路由骨架。
// Read 与 Edit 共用的编辑器模块由 Rollup 自动落进两者共享的 chunk。
const Setup = lazy(() => import('@/pages/Setup'));
const Browse = lazy(() => import('@/pages/Browse'));
const Read = lazy(() => import('@/pages/Read'));
const Edit = lazy(() => import('@/pages/Edit'));
const Search = lazy(() => import('@/pages/Search'));
const RagManage = lazy(() => import('@/pages/RagManage'));
const AgentChat = lazy(() => import('@/pages/AgentChat'));
const Settings = lazy(() => import('@/pages/Settings'));

function RequireSource({ children }: { children: React.ReactNode }) {
  const { config, loading } = useApp();
  const loc = useLocation();
  if (loading) return <PageLoading />;
  if (!config?.configured && loc.pathname !== '/setup') return <Navigate to="/setup" replace />;
  return <>{children}</>;
}

// /agent：助手关闭时（地址栏、旧链接，或停留在该页时被关闭）回到概览并说明在哪里打开；
// 开关还没读到时先显示骨架，不误判为关闭
function AgentRoute() {
  const agentEnabled = useAgentEnabled();
  if (agentEnabled === null) return <PageSkeleton />;
  if (!agentEnabled) return <AgentDisabledRedirect />;
  return <Suspense fallback={<PageSkeleton />}><AgentChat /></Suspense>;
}

function AgentDisabledRedirect() {
  useEffect(() => {
    notify('智能助手已关闭，可在 设置 → 智能助手 中打开', { id: 'agent-disabled' });
  }, []);
  return <Navigate to="/" replace />;
}

export default function App() {
  return (
    <RequireSource>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="setup" element={<Suspense fallback={<PageSkeleton />}><Setup /></Suspense>} />
          <Route path="browse" element={<Suspense fallback={<PageSkeleton />}><Browse /></Suspense>} />
          <Route path="read/*" element={<Suspense fallback={<PageSkeleton />}><Read /></Suspense>} />
          <Route path="edit/*" element={<Suspense fallback={<PageSkeleton />}><Edit /></Suspense>} />
          <Route path="search" element={<Suspense fallback={<PageSkeleton />}><Search /></Suspense>} />
          <Route path="rag" element={<Suspense fallback={<PageSkeleton />}><RagManage /></Suspense>} />
          <Route path="agent" element={<AgentRoute />} />
          <Route path="settings" element={<Suspense fallback={<PageSkeleton />}><Settings /></Suspense>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Toaster />
      <UpdateInstallOverlay />
      <UpdateInstallNotice />
    </RequireSource>
  );
}
