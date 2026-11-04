// 全局后台指示（反馈第 4 批）：顶栏显示当前知识库的扫描/索引进度与 RAG 索引构建，以及嵌入模型的下载/导入进度。
// 状态来自 store 的 /api/status 轮询；持续不到 1 秒不出现（useDelayedFlag），小库不闪。
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApp, type BackendWork } from '@/store/app-context';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { measurablePhase } from '@/lib/api';
import { Loader2 } from 'lucide-react';

export function BackgroundIndicator() {
  const { backend } = useApp();
  return (
    <>
      <LibraryWork backend={backend} />
      <ModelTask backend={backend} />
      <IndexTask backend={backend} />
    </>
  );
}

function LibraryWork({ backend }: { backend: BackendWork }) {
  const phase = backend.indexing?.phase ?? null;
  const active = backend.scanning || phase !== null;
  const shown = useDelayedFlag(active, 1000);
  if (!shown) return null;
  const ix = backend.indexing;
  const text = backend.scanning
    ? '正在扫描 · 已扫 '
    : phase === 'text'
      ? '正在建立索引 '
      : '正在更新链接 ';
  const num = backend.scanning ? backend.scanned : `${ix?.done ?? 0}/${ix?.total ?? 0}`;
  return (
    <span
      className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted-foreground animate-fade-in"
      role="status"
      data-testid="background-indicator"
    >
      <Loader2 className="w-3 h-3 animate-spin" />
      {text}
      <span className="stat-num">{num}</span>
    </span>
  );
}

// 模型任务与 RAG 索引构建的详细进度只在 RAG 管理页：离开那一页后靠这里看进度，点击回去
function RagLink({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <Link
      to="/rag"
      className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors animate-fade-in"
      role="status"
      title="打开 RAG 管理查看详情"
      data-testid={testId}
    >
      <Loader2 className="w-3 h-3 animate-spin" />
      {children}
    </Link>
  );
}

function ModelTask({ backend }: { backend: BackendWork }) {
  const task = backend.ragModel;
  const shown = useDelayedFlag(task !== null, 1000);
  if (!shown || !task) return null;
  const p = task.progress;
  return (
    <RagLink testId="rag-model-indicator">
      {task.state === 'importing' ? '正在导入模型' : '正在下载模型'}
      {measurablePhase(p) && <span className="stat-num">{Math.round(p.percent || 0)}%</span>}
    </RagLink>
  );
}

function IndexTask({ backend }: { backend: BackendWork }) {
  const task = backend.ragIndex;
  const shown = useDelayedFlag(task !== null, 1000);
  if (!shown || !task) return null;
  return (
    <RagLink testId="rag-index-indicator">
      {task.state === 'pausing' ? '正在暂停 RAG 索引' : '正在构建 RAG 索引'}
      {task.total > 0 && <span className="stat-num">{task.done}/{task.total}</span>}
    </RagLink>
  );
}
