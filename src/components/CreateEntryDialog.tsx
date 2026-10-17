// 新建文档 / 文件夹对话框：名称就地校验并显示服务端错误；成功后回调新路径
import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, type DocType } from '@/lib/api';
import { useApp } from '@/store/app';

export type CreateKind = 'md' | 'folder';
export interface CreateTarget { dir: string; kind: CreateKind }

const DOC_TYPES: DocType[] = ['文章', '讲稿', '知乎'];
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[/\\<>:"|?*\u0000-\u001f\u007f]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// 与后端一致的名称规则（后端为最终校验）
function checkEntryName(raw: string): string | null {
  const n = raw.trim();
  if (!n) return '名称不能为空';
  if (n === '.' || n === '..') return '名称无效';
  if (BAD_CHARS.test(n)) return '名称不能包含 / \\ < > : " | ? * 或控制字符';
  if (n.startsWith('.')) return '名称不能以点开头';
  if (/[. ]$/.test(n)) return '名称不能以点或空格结尾';
  if (RESERVED.test(n)) return '名称为 Windows 保留名';
  return null;
}

export function CreateEntryDialog({
  target,
  onClose,
  onCreated,
}: {
  target: CreateTarget | null;
  onClose: () => void;
  onCreated: (path: string, kind: CreateKind) => void;
}) {
  const { dsId } = useApp();
  const [title, setTitle] = useState('');
  const [fileName, setFileName] = useState('');
  const [docType, setDocType] = useState<DocType>('文章');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (target) {
      setTitle(''); setFileName(''); setDocType('文章'); setError(null); setBusy(false);
    }
  }, [target]);

  const isDoc = target?.kind === 'md';
  const rawName = isDoc ? fileName.trim() || title.trim() : title.trim();
  const finalName = isDoc && rawName && !/\.md$/i.test(rawName) ? rawName + '.md' : rawName;
  const where = target?.dir ? target.dir + '/' : '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    const err = checkEntryName(rawName);
    if (err) { setError(isDoc && !rawName ? '请输入标题' : err); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api.createEntry({
        dsId, dir: target.dir, kind: target.kind, name: rawName,
        ...(isDoc ? { title: title.trim() || undefined, docType } : {}),
      });
      onCreated(r.path, target.kind);
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o) onClose(); }}>
      {target && (
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{isDoc ? '新建文档' : '新建文件夹'}</DialogTitle>
              <DialogDescription>位置：{target.dir || '数据源根目录'}</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="ce-title">{isDoc ? '标题' : '文件夹名称'}</Label>
              <Input
                id="ce-title"
                autoFocus
                value={title}
                onChange={(e) => { setTitle(e.target.value); setError(null); }}
                placeholder={isDoc ? '如：论语讲稿' : '如：草稿'}
                aria-invalid={!!error}
              />
            </div>
            {isDoc && (
              <>
                <div className="space-y-1.5">
                  <Label>类型</Label>
                  <Select value={docType} onValueChange={(v) => setDocType(v as DocType)}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DOC_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ce-name">文件名（可选，默认同标题）</Label>
                  <Input
                    id="ce-name"
                    value={fileName}
                    onChange={(e) => { setFileName(e.target.value); setError(null); }}
                    placeholder={title.trim() ? title.trim() + '.md' : '自动追加 .md'}
                    aria-invalid={!!error}
                  />
                </div>
              </>
            )}
            {finalName && !error && (
              <p className="text-xs text-muted-foreground break-all">
                将创建：{where}{finalName}{isDoc ? '（及元数据 ' + finalName + '.meta.json）' : '/'}
              </p>
            )}
            {error && <p className="text-xs text-destructive break-all" role="alert">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
              <Button type="submit" disabled={busy}>{busy ? '创建中…' : '创建'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
