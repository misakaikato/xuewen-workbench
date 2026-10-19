// 富输入框：引用块（chips）+ 文本块交替排列，支持多引用、多行、引用间穿插文字
// 加号附件：图片走 images 通道；文本类文件读成引用块；其他类型提示不支持
import { useEffect, useRef, useState } from 'react';
import { Send, Square, AtSign, Plus, X, Quote, FileText, Image as ImageIcon, Paperclip } from 'lucide-react';
import { api } from '@/lib/api';
import type { TreeNode } from '@/lib/types';
import {
  type Block, type TextBlock,
  initialBlocks, appendQuote, removeBlock, blocksEmpty,
} from './blocks';

interface FlatFile { name: string; path: string }
const flatten = (n: TreeNode, out: FlatFile[] = []): FlatFile[] => {
  for (const f of n.files) out.push({ name: f.name, path: f.path });
  for (const d of n.dirs) flatten(d, out);
  return out;
};

const SLASH_COMMANDS = [
  { cmd: '/clear', desc: '开始新对话' },
  { cmd: '/skills', desc: '列出 skills' },
  { cmd: '/mcp', desc: 'MCP 状态' },
  { cmd: '/model', desc: '打开设置面板' },
  { cmd: '/status', desc: '语料库状态' },
  { cmd: '/export', desc: '导出 Markdown' },
  { cmd: '/help', desc: '显示所有命令' },
];

export interface AttachedImage { data: string; mimeType: string; name: string }

export function ChatInput({
  blocks,
  onBlocksChange,
  onSend,
  onStop,
  busy,
  disabled,
  placeholder,
  onCommand,
  images,
  onImagesChange,
}: {
  blocks: Block[];
  onBlocksChange: (b: Block[]) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  placeholder: string;
  onCommand: (cmd: string) => void;
  images: AttachedImage[];
  onImagesChange: (imgs: AttachedImage[]) => void;
}) {
  const [files, setFiles] = useState<FlatFile[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [showCommands, setShowCommands] = useState(false);
  const [cmdIdx, setCmdIdx] = useState(0);
  const [attachOpen, setAttachOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const composingRef = useRef(false);

  useEffect(() => { api.tree().then((r) => setFiles(flatten(r.tree))).catch(() => {}); }, []);

  const textBlocks = blocks.filter((b): b is TextBlock => b.type === 'text');
  const focused = textBlocks.find((b) => b.id === focusedId) || textBlocks[textBlocks.length - 1];
  const value = focused?.value || '';

  const mentionMatches = mentionQuery !== null
    ? files.filter((f) => f.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 8)
    : [];
  const cmdMatches = showCommands ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(value.trim())).slice(0, 6) : [];

  const setBlockValue = (id: string, v: string) =>
    onBlocksChange(blocks.map((b) => (b.id === id && b.type === 'text' ? { ...b, value: v } : b)));

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(200, el.scrollHeight) + 'px';
  };

  const handleInput = (id: string, v: string) => {
    setBlockValue(id, v);
    if (v.startsWith('/') && !v.includes(' ')) { setShowCommands(true); setCmdIdx(0); }
    else setShowCommands(false);

    const el = taRefs.current.get(id);
    const pos = el?.selectionStart ?? v.length;
    const before = v.slice(0, pos);
    const at = before.lastIndexOf('@');
    if (at >= 0 && at < pos) {
      const q = before.slice(at + 1);
      if (!q.includes(' ') && q.length <= 40) { setMentionQuery(q); setMentionIdx(0); return; }
    }
    setMentionQuery(null);
  };

  const insertMention = (f: FlatFile) => {
    const id = focused.id;
    const el = taRefs.current.get(id);
    const pos = el?.selectionStart ?? value.length;
    const before = value.slice(0, pos);
    const at = before.lastIndexOf('@');
    if (at < 0) return;
    const next = value.slice(0, at) + '@' + f.name + value.slice(pos);
    setBlockValue(id, next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      const np = at + 1 + f.name.length;
      el?.setSelectionRange(np, np);
      el?.focus();
    });
  };

  // 加号附件：图片 → images；文本类 → 引用块；其他 → 提示
  const handleFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const imgs = [...images];
    let blocksNext = blocks;
    const rejected: string[] = [];
    for (const f of Array.from(list)) {
      if (f.type.startsWith('image/')) {
        if (imgs.length >= 4) { rejected.push(`${f.name}（图片最多 4 张）`); continue; }
        if (f.size > 8 * 1024 * 1024) { rejected.push(`${f.name}（超过 8MB）`); continue; }
        const dataUrl = await new Promise<string>((res) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result || ''));
          r.readAsDataURL(f);
        });
        imgs.push({ data: dataUrl, mimeType: f.type, name: f.name });
        continue;
      }
      const name = f.name.toLowerCase();
      const isText = /\.(md|markdown|txt|json|csv|tsv|yaml|yml|xml|html?)$/.test(name) || f.type.startsWith('text/');
      if (isText) {
        if (f.size > 2 * 1024 * 1024) { rejected.push(`${f.name}（文本超过 2MB）`); continue; }
        const text = await f.text();
        blocksNext = appendQuote(blocksNext, text.slice(0, 20000), f.name);
        continue;
      }
      rejected.push(`${f.name}（暂不支持此类型）`);
    }
    onImagesChange(imgs);
    if (blocksNext !== blocks) onBlocksChange(blocksNext);
    if (rejected.length) alert('以下文件未添加：\n' + rejected.join('\n'));
    setAttachOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (composingRef.current || (e.nativeEvent as KeyboardEvent).isComposing) return;
      e.preventDefault();
      if (mentionQuery !== null && mentionMatches[mentionIdx]) { insertMention(mentionMatches[mentionIdx]); return; }
      if (showCommands && cmdMatches[cmdIdx]) { onCommand(cmdMatches[cmdIdx].cmd); setShowCommands(false); return; }
      if (value.trim().startsWith('/') && !value.includes(' ')) { onCommand(value.trim()); setBlockValue(id, ''); setShowCommands(false); return; }
      if (!disabled && !busy) onSend();
      return;
    }
    if (e.key === 'Tab' && mentionQuery !== null && mentionMatches[mentionIdx]) { e.preventDefault(); insertMention(mentionMatches[mentionIdx]); return; }
    if (e.key === 'ArrowDown' && (mentionQuery !== null || showCommands)) {
      e.preventDefault();
      if (mentionQuery !== null) setMentionIdx((i) => Math.min(i + 1, mentionMatches.length - 1));
      else setCmdIdx((i) => Math.min(i + 1, cmdMatches.length - 1));
      return;
    }
    if (e.key === 'ArrowUp' && (mentionQuery !== null || showCommands)) {
      e.preventDefault();
      if (mentionQuery !== null) setMentionIdx((i) => Math.max(0, i - 1));
      else setCmdIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'Escape') { setMentionQuery(null); setShowCommands(false); setAttachOpen(false); }
  };

  const empty = blocksEmpty(blocks) && images.length === 0;

  return (
    <div className="relative">
      {cmdMatches.length > 0 && showCommands && (
        <div className="absolute bottom-full left-0 right-0 mb-1 bg-card border border-border rounded-lg shadow-lg p-1 z-20">
          {cmdMatches.map((c, i) => (
            <button key={c.cmd} className={`w-full flex items-center gap-2 px-3 py-1.5 rounded text-sm text-left ${i === cmdIdx ? 'bg-accent text-primary' : 'hover:bg-accent'}`}
              onClick={() => { onCommand(c.cmd); onBlocksChange(initialBlocks()); setShowCommands(false); }}>
              <code className="text-xs font-mono text-primary">{c.cmd}</code>
              <span className="text-muted-foreground text-xs">{c.desc}</span>
            </button>
          ))}
        </div>
      )}

      {mentionQuery !== null && mentionMatches.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-1 bg-card border border-border rounded-lg shadow-lg p-1 z-20 max-h-56 overflow-auto">
          {mentionMatches.map((f, i) => (
            <button key={f.path} className={`w-full flex items-center gap-2 px-3 py-1.5 rounded text-sm text-left ${i === mentionIdx ? 'bg-accent text-primary' : 'hover:bg-accent'}`}
              onClick={() => insertMention(f)}>
              <AtSign className="w-3 h-3 text-muted-foreground shrink-0" />
              <span className="truncate">{f.name}</span>
              <span className="text-muted-foreground text-xs truncate ml-auto">{f.path}</span>
            </button>
          ))}
        </div>
      )}

      {/* 附件选择菜单 */}
      {attachOpen && (
        <div className="absolute bottom-full left-0 mb-1 bg-card border border-border rounded-lg shadow-lg p-1 z-30 w-56">
          <button className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-left hover:bg-accent" onClick={() => fileRef.current?.click()}>
            <Paperclip className="w-4 h-4 text-muted-foreground" />选择文件…
          </button>
          <div className="px-3 py-1 text-[10px] text-muted-foreground leading-relaxed">
            图片 → 作为视觉输入（≤4 张）<br />
            文本类（md/txt/json/csv…）→ 作为引用<br />
            其他类型暂不支持
          </div>
        </div>
      )}

      {/* 图片预览 */}
      {images.length > 0 && (
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          {images.map((im, i) => (
            <div key={i} className="relative group">
              <img src={im.data} alt={im.name} className="h-16 w-16 object-cover rounded-lg border border-border" />
              <button className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-white flex items-center justify-center opacity-0 group-hover:opacity-100"
                title="移除" onClick={() => onImagesChange(images.filter((_, j) => j !== i))}>
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 输入框：左侧加号 + 右侧块序列 */}
      <div className="flex items-end gap-1.5">
        <button className="mb-1 p-1.5 rounded-lg border border-border hover:bg-accent text-muted-foreground shrink-0"
          title="添加附件（图片 / 文本文件）" onClick={() => setAttachOpen((v) => !v)} disabled={disabled}>
          <Plus className="w-4 h-4" />
        </button>
        <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { void handleFiles(e.target.files); e.target.value = ''; }} />
      <div className="flex-1 min-w-0 rounded-xl border border-input bg-card px-2 py-2 space-y-1.5">
        {blocks.map((b) => b.type === 'quote' ? (
          <div key={b.id} className="group relative flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1.5">
            <Quote className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-primary/80 mb-0.5 flex items-center gap-1">
                <FileText className="w-2.5 h-2.5" />{b.source}
              </div>
              <div className="text-xs text-foreground/80 line-clamp-2 whitespace-pre-wrap">{b.text.slice(0, 160)}{b.text.length > 160 ? '…' : ''}</div>
            </div>
            <button className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-background shrink-0" title="移除引用"
              onClick={() => onBlocksChange(removeBlock(blocks, b.id))}>
              <X className="w-3 h-3" />
            </button>
          </div>
        ) : (
          <textarea
            key={b.id}
            ref={(el) => { if (el) taRefs.current.set(b.id, el); }}
            value={b.value}
            disabled={disabled}
            rows={1}
            onFocus={() => setFocusedId(b.id)}
            onChange={(e) => { handleInput(b.id, e.target.value); autoGrow(e.target); }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(e) => handleKeyDown(e, b.id)}
            placeholder={blocks.length === 1 ? placeholder : '继续输入…'}
            className="w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
        ))}
      </div>
      </div>

      {/* 底部工具行 */}
      <div className="flex items-center gap-1.5 mt-2">
        <span className="text-[11px] text-muted-foreground hidden sm:inline">
          {images.length > 0 && <><ImageIcon className="w-3 h-3 inline" /> {images.length} 图 · </>}
          Enter 发送 · Shift+Enter 换行
        </span>
        <span className="flex-1" />
        {busy ? (
          <button className="px-3 py-2 rounded-lg border border-border hover:bg-accent flex items-center gap-1 text-sm" onClick={onStop}>
            <Square className="w-3.5 h-3.5" />停止
          </button>
        ) : (
          <button className="px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 flex items-center gap-1 text-sm"
            disabled={disabled || empty} onClick={onSend}>
            <Send className="w-3.5 h-3.5" />发送
          </button>
        )}
      </div>
    </div>
  );
}
