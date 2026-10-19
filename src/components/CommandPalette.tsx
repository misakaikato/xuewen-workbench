// ⌘K 命令面板（P3）：全局检索入口 + 页面导航 + 最近/固定 + 快捷动作。
// 打开时拉取最近/固定；文件清单来自已加载的目录树（客户端展平，cmdk 负责过滤）。
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator,
} from '@/components/ui/command';
import { useApp } from '@/store/app';
import { useTheme, type Theme } from '@/lib/theme';
import { api } from '@/lib/api';
import { extIcon } from '@/lib/extIcon';
import type { FileEntry, TreeNode } from '@/lib/types';
import {
  LayoutDashboard, FolderOpen, Search, DatabaseZap, Bot, Settings, Database,
  RefreshCw, Palette, Clock, SearchCode,
} from 'lucide-react';

function flatten(t: TreeNode | null, out: FileEntry[] = []): FileEntry[] {
  if (!t) return out;
  out.push(...t.files);
  for (const d of t.dirs) flatten(d, out);
  return out;
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const THEME_LABEL: Record<Theme, string> = { A: 'A 宣纸', B: 'B 极简', C: 'C 夜读' };
const NEXT_THEME: Record<Theme, Theme> = { A: 'B', B: 'C', C: 'A' };

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { tree, rescan, config } = useApp();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [recents, setRecents] = useState<string[]>([]);
  const [pins, setPins] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    api.recents().then((r) => setRecents(r.recents.filter((x) => x.exists).map((x) => x.path))).catch(() => {});
    api.pins().then((r) => setPins(r.pins.filter((x) => x.exists).map((x) => x.path))).catch(() => {});
  }, [open]);

  const files = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = flatten(tree);
    if (!needle) return [];
    return all.filter((f) => f.path.toLowerCase().includes(needle)).slice(0, 50);
  }, [tree, q]);
  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };
  const openFile = (p: string) => go('/read/' + enc(p));
  const fullText = () => go('/search?q=' + encodeURIComponent(q.trim()));

  const fileItem = (p: string, key: string) => (
    <CommandItem key={key} value={p} onSelect={() => openFile(p)}>
      <span className="shrink-0 text-muted-foreground">{extIcon('.' + (p.split('.').pop() || ''))}</span>
      <span className="truncate">{p}</span>
    </CommandItem>
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="命令面板"
      description="检索文件、页面与动作"
      showCloseButton={false}
    >
      <CommandInput
        value={q}
        onValueChange={setQ}
        placeholder="检索文件、页面、动作…"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && q.trim() && !files.some((f) => f.path.includes(q.trim()))) fullText();
        }}
      />
      <CommandList>
        <CommandEmpty>
          {q.trim() ? (
            <button className="text-primary hover:underline" onClick={fullText}>
              无匹配文件，回车全文检索「{q.trim()}」
            </button>
          ) : (
            '输入以检索'
          )}
        </CommandEmpty>

        {q.trim() && (
          <CommandGroup heading="全文检索">
            <CommandItem value={`__fts ${q}`} onSelect={fullText}>
              <SearchCode className="shrink-0" />
              <span>全文检索「{q.trim()}」</span>
            </CommandItem>
          </CommandGroup>
        )}

        {q.trim() && files.length > 0 && (
          <CommandGroup heading="文件">
            {files.map((f) => fileItem(f.path, 'f:' + f.path))}
          </CommandGroup>
        )}

        {!q.trim() && pins.length > 0 && (
          <CommandGroup heading="固定入口">
            {pins.map((p) => fileItem(p, 'pin:' + p))}
          </CommandGroup>
        )}
        {!q.trim() && recents.length > 0 && (
          <CommandGroup heading="最近打开">
            {recents.slice(0, 8).map((p) => (
              <CommandItem key={'r:' + p} value={p} onSelect={() => openFile(p)}>
                <Clock className="shrink-0 text-muted-foreground" />
                <span className="truncate">{p}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandSeparator />
        <CommandGroup heading="页面">
          <CommandItem value="知识库概览 dashboard" onSelect={() => go('/')}><LayoutDashboard />知识库概览</CommandItem>
          <CommandItem value="浏览全部 browse" onSelect={() => go('/browse')}><FolderOpen />浏览全部</CommandItem>
          <CommandItem value="检索 search" onSelect={() => go('/search')}><Search />检索</CommandItem>
          <CommandItem value="智能助手 agent" onSelect={() => go('/agent')}><Bot />智能助手</CommandItem>
          <CommandItem value="RAG 管理 rag" onSelect={() => go('/rag')}><DatabaseZap />RAG 管理</CommandItem>
          <CommandItem value="设置 settings" onSelect={() => go('/settings')}><Settings />设置</CommandItem>
          <CommandItem value="知识库管理 setup" onSelect={() => go('/setup')}><Database />知识库管理</CommandItem>
        </CommandGroup>

        <CommandGroup heading="动作">
          <CommandItem
            value="重新扫描 rescan"
            disabled={!config?.configured}
            onSelect={() => {
              onOpenChange(false);
              rescan();
            }}
          >
            <RefreshCw />重新扫描知识库
          </CommandItem>
          <CommandItem
            value="切换外观主题 theme"
            onSelect={() => {
              setTheme(NEXT_THEME[theme]);
              onOpenChange(false);
            }}
          >
            <Palette />切换外观主题（当前 {THEME_LABEL[theme]} → {THEME_LABEL[NEXT_THEME[theme]]}）
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
