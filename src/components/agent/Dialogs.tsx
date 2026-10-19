// 应用内对话框：替代 window.prompt（Electron 不支持 prompt，会静默返回 null）
import { useEffect, useRef, useState } from 'react';
import { X, Check, Folder } from 'lucide-react';

/** 文本输入对话框 */
export function InputDialog({
  title,
  description,
  defaultValue = '',
  placeholder,
  confirmText = '确定',
  onConfirm,
  onCancel,
}: {
  title: string;
  description?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onConfirm(v);
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-card border border-border rounded-2xl shadow-2xl p-5 w-96 max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button className="p-1 rounded hover:bg-accent" onClick={onCancel}><X className="w-4 h-4" /></button>
        </div>
        {description && <p className="text-xs text-muted-foreground mb-2">{description}</p>}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            if (e.key === 'Escape') onCancel();
          }}
          placeholder={placeholder}
          className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm mb-3"
        />
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-accent" onClick={onCancel}>取消</button>
          <button className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-40 flex items-center gap-1" disabled={!value.trim()} onClick={submit}>
            <Check className="w-3.5 h-3.5" />{confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 文件夹选择对话框（用于移动对话） */
export function FolderPickerDialog({
  title,
  folders,
  currentId,
  onPick,
  onCancel,
}: {
  title: string;
  folders: { id: string; name: string }[];
  currentId?: string | null;
  onPick: (folderId: string | null) => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-card border border-border rounded-2xl shadow-2xl p-5 w-96 max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button className="p-1 rounded hover:bg-accent" onClick={onCancel}><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-1 max-h-72 overflow-auto">
          <button
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left ${!currentId ? 'bg-accent text-primary font-medium' : 'hover:bg-accent'}`}
            onClick={() => onPick(null)}
          >
            <Folder className="w-4 h-4 text-muted-foreground" />
            （根目录）
          </button>
          {folders.map((f) => (
            <button
              key={f.id}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left ${currentId === f.id ? 'bg-accent text-primary font-medium' : 'hover:bg-accent'}`}
              onClick={() => onPick(f.id)}
            >
              <Folder className="w-4 h-4 text-muted-foreground" />
              {f.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
