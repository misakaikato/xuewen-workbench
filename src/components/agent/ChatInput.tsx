// 聊天输入框：@-mention 文件自动补全 + 斜杠命令提示
import { useEffect, useRef, useState } from 'react';
import { Send, Square, AtSign, ImagePlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { TreeNode } from '@/lib/types';

const SLASH_COMMANDS = [
  { cmd: '/clear', desc: '开始新对话' },
  { cmd: '/skills', desc: '列出可用 skills' },
  { cmd: '/mcp', desc: 'MCP 服务器状态' },
  { cmd: '/model', desc: '当前模型与端点' },
  { cmd: '/status', desc: '语料库与索引状态（发给 agent）' },
  { cmd: '/help', desc: '显示所有命令' },
  { cmd: '/export', desc: '导出对话为 Markdown' },
];

interface FlatFile {
  name: string;
  path: string;
}

function flatten(n: TreeNode, out: FlatFile[] = []): FlatFile[] {
  for (const f of n.files) out.push({ name: f.name, path: f.path });
  for (const d of n.dirs) flatten(d, out);
  return out;
}

export function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  disabled,
  placeholder,
  onCommand,
  images = [],
  onImagesChange,
  visionEnabled = true,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  placeholder: string;
  onCommand: (cmd: string) => void;
  images?: { data: string; mimeType: string; name: string }[];
  onImagesChange?: (imgs: { data: string; mimeType: string; name: string }[]) => void;
  visionEnabled?: boolean;
}) {
  const [files, setFiles] = useState<FlatFile[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [showCommands, setShowCommands] = useState(false);
  const [cmdIdx, setCmdIdx] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  // 读图：转 dataURL 后存 base64（发送时再剥前缀）
  const pickImages = async (files: FileList | null) => {
    if (!files?.length || !onImagesChange) return;
    const next = [...images];
    for (const f of Array.from(files).slice(0, 4 - images.length)) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > 8 * 1024 * 1024) { alert(`${f.name} 超过 8MB`); continue; }
      const dataUrl = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.readAsDataURL(f);
      });
      next.push({ data: dataUrl, mimeType: f.type, name: f.name });
    }
    onImagesChange(next);
  };
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    api.tree().then((r) => setFiles(flatten(r.tree))).catch(() => {});
  }, []);

  const mentionMatches = mentionQuery !== null
    ? files.filter((f) => f.name.toLowerCase().includes(mentionQuery.toLowerCase()) || f.path.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 8)
    : [];
  const cmdMatches = showCommands
    ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(value.trim())).slice(0, 6)
    : [];

  const handleInput = (v: string) => {
    onChange(v);
    // 斜杠命令
    if (v.startsWith('/') && !v.includes(' ')) {
      setShowCommands(true);
      setCmdIdx(0);
    } else {
      setShowCommands(false);
    }
    // @-mention：光标前最近的 @ 后的词
    const pos = taRef.current?.selectionStart ?? v.length;
    const before = v.slice(0, pos);
    const at = before.lastIndexOf('@');
    if (at >= 0 && at < pos) {
      const q = before.slice(at + 1);
      if (!q.includes(' ') && q.length <= 40) {
        setMentionQuery(q);
        setMentionIdx(0);
        return;
      }
    }
    setMentionQuery(null);
  };

  const insertMention = (f: FlatFile) => {
    const v = value;
    const pos = taRef.current?.selectionStart ?? v.length;
    const before = v.slice(0, pos);
    const at = before.lastIndexOf('@');
    if (at >= 0) {
      const next = v.slice(0, at) + '@' + f.name + v.slice(pos);
      onChange(next);
      setMentionQuery(null);
      requestAnimationFrame(() => {
        if (taRef.current) {
          const np = at + 1 + f.name.length;
          taRef.current.setSelectionRange(np, np);
          taRef.current.focus();
        }
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // 中文输入法组合中：Enter 确认候选词，不发送
      if (composingRef.current || (e.nativeEvent as KeyboardEvent).isComposing) return;
      e.preventDefault();
      if (mentionQuery !== null && mentionMatches[mentionIdx]) {
        insertMention(mentionMatches[mentionIdx]);
        return;
      }
      if (showCommands && cmdMatches[cmdIdx]) {
        onCommand(cmdMatches[cmdIdx].cmd);
        setShowCommands(false);
        return;
      }
      if (value.trim().startsWith('/') && !value.includes(' ')) {
        onCommand(value.trim());
        onChange('');
        setShowCommands(false);
        return;
      }
      onSend();
      return;
    }
    if (e.key === 'Tab' && mentionQuery !== null && mentionMatches[mentionIdx]) {
      e.preventDefault();
      insertMention(mentionMatches[mentionIdx]);
      return;
    }
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
    if (e.key === 'Escape') {
      setMentionQuery(null);
      setShowCommands(false);
    }
  };

  return (
    <div className="relative">
      {/* 斜杠命令面板 */}
      {cmdMatches.length > 0 && showCommands && (
        <div className="absolute bottom-full left-0 right-0 mb-1 bg-card border border-border rounded-lg shadow-lg p-1 z-20">
          {cmdMatches.map((c, i) => (
            <button
              key={c.cmd}
              className={`w-full flex items-center gap-2 px-3 py-1.5 rounded text-sm text-left ${i === cmdIdx ? 'bg-accent text-primary' : 'hover:bg-accent'}`}
              onClick={() => { onCommand(c.cmd); onChange(''); setShowCommands(false); }}
            >
              <code className="text-xs font-mono text-primary">{c.cmd}</code>
              <span className="text-muted-foreground text-xs">{c.desc}</span>
            </button>
          ))}
        </div>
      )}

      {/* @-mention 面板 */}
      {mentionQuery !== null && mentionMatches.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-1 bg-card border border-border rounded-lg shadow-lg p-1 z-20 max-h-56 overflow-auto">
          {mentionMatches.map((f, i) => (
            <button
              key={f.path}
              className={`w-full flex items-center gap-2 px-3 py-1.5 rounded text-sm text-left ${i === mentionIdx ? 'bg-accent text-primary' : 'hover:bg-accent'}`}
              onClick={() => insertMention(f)}
            >
              <AtSign className="w-3 h-3 text-muted-foreground shrink-0" />
              <span className="truncate">{f.name}</span>
              <span className="text-muted-foreground text-xs truncate ml-auto">{f.path}</span>
            </button>
          ))}
        </div>
      )}

      {/* 图片预览 */}
      {images.length > 0 && (
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          {images.map((im, i) => (
            <div key={i} className="relative group">
              <img src={im.data} alt={im.name} className="h-16 w-16 object-cover rounded-lg border border-border" />
              <button
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-white flex items-center justify-center opacity-0 group-hover:opacity-100"
                title="移除"
                onClick={() => onImagesChange?.(images.filter((_, j) => j !== i))}
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        {visionEnabled && onImagesChange && (
          <>
            <button
              className="p-2 rounded-lg border border-border hover:bg-accent text-muted-foreground shrink-0"
              title="添加图片（需模型支持视觉）"
              onClick={() => fileRef.current?.click()}
              disabled={disabled || images.length >= 4}
            >
              <ImagePlus className="w-4 h-4" />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => { void pickImages(e.target.files); e.target.value = ''; }}
            />
          </>
        )}
        <textarea
          ref={taRef}
          value={value}
          disabled={disabled}
          onChange={(e) => handleInput(e.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={handleKeyDown}
          rows={2}
          placeholder={placeholder}
          className="flex-1 resize-none px-3 py-2 rounded-lg border border-input bg-card text-sm disabled:opacity-50"
        />
        {busy ? (
          <Button variant="outline" className="rounded-lg" onClick={onStop}>
            <Square className="w-3.5 h-3.5" />停止
          </Button>
        ) : (
          <Button className="rounded-lg" disabled={disabled || (!value.trim() && images.length === 0)} onClick={onSend}>
            <Send className="w-3.5 h-3.5" />发送
          </Button>
        )}
      </div>
    </div>
  );
}
