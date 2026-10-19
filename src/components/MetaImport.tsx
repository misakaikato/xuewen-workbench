// 设置页区块：导入 AI 产出的 JSONL 元数据（预览 → 确认 → 只写 <文件名>.meta.json 旁注，不修改文档本身）
import { useState } from 'react';
import { api } from '@/lib/api';
import type { MetaImportItem, MetaImportResponse } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { useApp } from '@/store/app';

const ACTION_LABEL: Record<MetaImportItem['action'], string> = { create: '新建', update: '更新', skip: '跳过' };

const isChange = (v: unknown): v is { from: unknown; to: unknown } =>
  !!v && typeof v === 'object' && 'from' in v && 'to' in v;

// 字段列内容：新建 → 拟定字段；更新 → 仅变化字段（from → to）；跳过 → 原因
function describeFields(it: MetaImportItem): string {
  if (it.action === 'skip') return it.reason || '';
  if (!it.fields) return '';
  return Object.entries(it.fields)
    .map(([k, v]) =>
      isChange(v)
        ? `${k}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`
        : `${k}: ${JSON.stringify(v)}`)
    .join('；');
}

export default function MetaImport() {
  const { dsId, refreshTree } = useApp();
  const [text, setText] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [preview, setPreview] = useState<MetaImportResponse | null>(null);
  const [applied, setApplied] = useState<MetaImportResponse | null>(null);
  const [dirty, setDirty] = useState(false); // 文本或覆盖开关变化后预览失效
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const onText = (v: string) => {
    setText(v);
    setDirty(true);
  };
  const onOverwrite = (v: boolean) => {
    setOverwrite(v);
    setDirty(true);
  };

  async function runPreview() {
    setBusy(true);
    setError('');
    try {
      const r = await api.importMeta({ dsId, jsonl: text, mode: 'preview', overwrite });
      setPreview(r);
      setApplied(null);
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runApply() {
    setBusy(true);
    setError('');
    try {
      const r = await api.importMeta({ dsId, jsonl: text, mode: 'apply', overwrite });
      setApplied(r);
      setDirty(true); // 导入后当前预览不再反映磁盘状态
      await refreshTree();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const s = preview?.summary;
  const shown = applied ?? preview;
  const canApply = !!preview && !dirty && s !== undefined && s.create + s.update > 0;

  return (
    <section className="bg-card border border-border rounded-lg p-4">
      <h2 className="font-medium text-sm mb-1">导入元数据</h2>
      <p className="text-xs text-muted-foreground mb-3">
        粘贴或选择 AI 产出的 JSONL（每行一个 JSON，含 path 与待导入字段），先预览再写入。只写 <span className="mono">&lt;文件名&gt;.meta.json</span> 旁注，不修改文档。
      </p>
      <div className="space-y-3">
        <input
          type="file"
          accept=".jsonl,.json,.txt"
          className="text-xs text-muted-foreground"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const reader = new FileReader();
            reader.onload = () => onText(String(reader.result || ''));
            reader.readAsText(f);
            e.target.value = ''; // 允许再次选择同一文件
          }}
        />
        <Textarea
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder={'每行一个 JSON 对象，例如：\n{"path": "笔记/第1章.md", "title": "标题", "type": "讲稿", "tags": ["x"], "confidence": {"title": 0.9}}'}
          className="min-h-28 font-mono text-xs"
          spellCheck={false}
        />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={overwrite} onCheckedChange={(v) => onOverwrite(v === true)} />
          覆盖已有元数据（只合并提供的字段，id 不变）
        </label>
        <div className="flex items-center gap-3 flex-wrap">
          <Button size="sm" variant="outline" onClick={runPreview} disabled={busy || !text.trim()}>预览</Button>
          <Button size="sm" disabled={!canApply || busy} onClick={() => setConfirmOpen(true)}>确认导入</Button>
          {s && (
            <span className="text-xs text-muted-foreground">
              共 {s.lines} 行：有效 {s.valid}，错误 {s.errors}；新建 {s.create}，更新 {s.update}，跳过 {s.skip}
              {applied && <>；已写入 {applied.summary.written ?? 0}</>}
            </span>
          )}
          {preview && dirty && <span className="text-xs text-warning">内容已变化，请重新预览</span>}
        </div>
        {error && <p className="text-xs text-destructive break-all" role="alert">{error}</p>}
        {applied && (
          <p className="text-xs text-success">
            已写入 {applied.summary.written ?? 0} 个旁注（新建 {applied.summary.create}，更新 {applied.summary.update}），错误 {applied.summary.errors} 个。
          </p>
        )}
      </div>
      {shown && shown.items.length > 0 && (
        <div className="mt-3 max-h-72 overflow-auto rounded border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">行</TableHead>
                <TableHead>路径</TableHead>
                <TableHead className="w-16">操作</TableHead>
                <TableHead>字段</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.items.map((it) => (
                <TableRow key={it.line}>
                  <TableCell className="text-xs text-muted-foreground">{it.line}</TableCell>
                  <TableCell className="mono text-xs break-all">{it.path}</TableCell>
                  <TableCell className="text-xs">{ACTION_LABEL[it.action]}</TableCell>
                  <TableCell className="text-xs break-all">
                    {describeFields(it)}
                    {it.confidence && (
                      <span className="text-muted-foreground">
                        {' '}（置信度 {Object.entries(it.confidence).map(([k, v]) => `${k} ${v}`).join('、')}）
                      </span>
                    )}
                    {it.notes && <span className="text-muted-foreground"> 备注：{it.notes}</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {shown && shown.errors.length > 0 && (
        <ul className="mt-2 space-y-1 max-h-40 overflow-auto">
          {shown.errors.map((e, i) => (
            <li key={i} className="text-xs text-destructive break-all">
              第 {e.line} 行{e.path ? `（${e.path}）` : ''}：{e.error}
            </li>
          ))}
        </ul>
      )}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认导入 {s ? s.create + s.update : 0} 项元数据？</AlertDialogTitle>
            <AlertDialogDescription>
              只写入各文档的 &lt;文件名&gt;.meta.json 旁注文件，不会修改任何文档内容{overwrite ? '；已有旁注仅合并本次提供的字段，id 不变' : '；已有旁注的文档保持不变'}。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); setConfirmOpen(false); runApply(); }}>
              确认导入
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
