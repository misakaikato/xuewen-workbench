// 助手活动指示（三个对话界面共用，替代各自的三点动画）：
// 图标 + 一句话 + 已用秒数；秒数每秒刷新，活动持续超过 2 秒才显示，避免一闪而过。
// 进出场走 usePresence（med 档），离场动画期间保留最后一个活动态渲染。
import { useState } from 'react';
import { Brain, Layers, Loader2, ShieldAlert, Wrench } from 'lucide-react';
import type { AgentActivity as Activity } from '@/lib/agentReducer';
import { usePresence } from '@/lib/presence';
import { useNow } from '@/hooks/useNow';

function activityText(a: Activity): string {
  switch (a.kind) {
    case 'connecting': return '连接中…';
    case 'thinking': return '思考中…';
    case 'tool': return `正在运行 ${a.name}…`;
    case 'compacting': return '正在压缩上下文…';
    case 'confirm': return `等待你确认：${a.tool}`;
    case 'generating': return '正在生成回答…';
  }
}

function ActivityIcon({ a }: { a: Activity }) {
  const cls = 'w-3.5 h-3.5 shrink-0';
  switch (a.kind) {
    case 'thinking': return <Brain className={`${cls} animate-pulse text-primary`} />;
    case 'tool': return <Wrench className={`${cls} text-primary`} />;
    case 'compacting': return <Layers className={`${cls} animate-pulse text-primary`} />;
    case 'confirm': return <ShieldAlert className={`${cls} text-warning`} />;
    default: return <Loader2 className={`${cls} animate-spin`} />;
  }
}

export function AgentActivity({ activity }: { activity: Activity | null }) {
  const { mounted, state } = usePresence(!!activity);
  // 离场期间保留最后一个活动态（对账写法与 useDelayedFlag 一致）
  const [prev, setPrev] = useState<Activity | null>(null);
  const [shown, setShown] = useState<Activity | null>(null);
  if (activity !== prev) {
    setPrev(activity);
    if (activity) setShown(activity);
  }
  const now = useNow(!!activity, 1000);
  const a = shown;
  if (!mounted || !a) return null;
  const elapsed = now ? Math.floor((now - a.startedAt) / 1000) : 0;
  return (
    <div
      data-state={state}
      data-agent-activity
      data-kind={a.kind}
      role="status"
      className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground duration-med ease-signature data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out"
    >
      <ActivityIcon a={a} />
      <span>{activityText(a)}</span>
      {elapsed >= 2 && <span className="tabular-nums text-muted-foreground/70">{elapsed}s</span>}
    </div>
  );
}
