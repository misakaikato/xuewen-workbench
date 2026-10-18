// 元数据旁注问题提示：只列出，不自动修复。issues 由 FileTree 统一拉取后传入，避免重复请求
import { AlertTriangle } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { MetaIssue } from '@/lib/api';

const LABEL: Record<MetaIssue['kind'], string> = {
  orphan: '孤立元数据',
  moved: '疑似在应用外移动',
  duplicateId: '重复 id',
  invalid: '无效 JSON',
};

export function MetaIssuesBadge({ issues }: { issues: MetaIssue[] }) {
  if (!issues.length) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="ml-auto flex items-center gap-1 text-xs px-1.5 py-1 rounded text-amber-700 hover:bg-sidebar-accent"
          title="元数据文件问题"
        >
          <AlertTriangle className="w-3.5 h-3.5" />{issues.length}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-h-80 overflow-auto text-xs space-y-2">
        <div className="font-medium">元数据文件问题（不会自动处理）</div>
        {issues.map((it, i) => (
          <div key={i} className="border-t border-border pt-1.5 break-all">
            <div className="font-medium text-amber-700">{LABEL[it.kind] ?? it.kind}</div>
            <div className="text-muted-foreground">{it.message}</div>
            {it.sidecar && <div>元数据：{it.sidecar}</div>}
            {it.sidecars && <div>元数据：{it.sidecars.join('，')}</div>}
            {it.candidates && it.candidates.length > 0 && <div>可能的文档：{it.candidates.join('，')}</div>}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
