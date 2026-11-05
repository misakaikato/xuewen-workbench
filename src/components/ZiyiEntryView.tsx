// 一条字义：展示 + 原位编辑（释义、出处）。字义库页与阅读页字义侧栏共用。字头、异体字、码位、释义与出处可选中复制（按钮等骨架不可选）。
// 没有条目时显示「暂无字义」与新建入口；保存带版本校验（expectEditedAt），被别处改过时提示重新载入。
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, PenLine, Plus, Trash2 } from 'lucide-react';
import { api, type ZiyiEntry, type ZiyiOrigin } from '@/lib/api';
import { errorMessage, notify } from '@/lib/notify';
import { registerUnsaved } from '@/lib/unsaved';
import { displayZiyiText, isHanChar, refreshZiyiStatus, ZIYI_ORIGIN_LABEL } from '@/lib/ziyi';
import { ZiyiGlyphs } from '@/components/ZiyiGlyphs';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/** 出处标签：课堂讲解用正文色描边，AI 推导与本机新建用弱色，未标注不显示 */
export function ZiyiOriginTag({ origin }: { origin: ZiyiOrigin | null }) {
  if (!origin) return null;
  const strong = origin === 'lecture';
  return (
    <span
      data-wb-ziyi-origin={origin}
      className={`text-xs px-1.5 rounded-sm border whitespace-nowrap ${strong ? 'border-foreground/40 text-foreground' : 'border-border text-muted-foreground'}`}
    >
      {ZIYI_ORIGIN_LABEL[origin]}
    </span>
  );
}

export function ZiyiEntryView({
  char,
  entry,
  resolvedFrom = null,
  compact = false,
  onChange,
  onDeleted,
}: {
  /** 要查的字（没有条目时作为新建的字头） */
  char: string;
  entry: ZiyiEntry | null;
  resolvedFrom?: string | null;
  /** 侧栏用的紧凑排版 */
  compact?: boolean;
  onChange: (entry: ZiyiEntry) => void;
  /** 提供时显示删除按钮 */
  onDeleted?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [meaning, setMeaning] = useState('');
  const [source, setSource] = useState('');
  const [saving, setSaving] = useState(false);
  const [showSource, setShowSource] = useState(!compact);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const han = entry?.han ?? char;
  const dirty = editing && (meaning !== (entry?.meaning ?? '') || source !== (entry?.source ?? ''));

  // 调用方以字头作 key：换字即重新挂载、退出编辑
  useEffect(() => (dirty ? registerUnsaved(() => true) : undefined), [dirty]);

  const startEdit = () => {
    setMeaning(entry?.meaning ?? '');
    setSource(entry?.source ?? '');
    setEditing(true);
  };

  const reload = async () => {
    try {
      const r = await api.ziyiEntry(han);
      onChange(r.entry);
      setMeaning(r.entry.meaning);
      setSource(r.entry.source);
    } catch (e) {
      notify('重新载入失败：' + errorMessage(e), { kind: 'error' });
    }
  };

  const save = async () => {
    if (!meaning.trim()) { notify('释义不能为空', { kind: 'error' }); return; }
    setSaving(true);
    try {
      const r = await api.ziyiSave(entry
        ? { han, meaning, source, expectEditedAt: entry.editedAt }
        : { han, meaning, source, create: true });
      onChange(r.entry);
      setEditing(false);
      void refreshZiyiStatus();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'conflict') {
        notify(`「${han}」已在别处修改过。重新载入会用最新内容替换编辑框（当前输入不保留）。`, {
          kind: 'error', action: { label: '重新载入', run: () => { void reload(); } },
        });
      } else {
        notify('保存字义失败：' + errorMessage(e), { kind: 'error' });
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await api.ziyiDelete(han);
      setConfirmDelete(false);
      void refreshZiyiStatus();
      onDeleted?.();
    } catch (e) {
      notify('删除字义失败：' + errorMessage(e), { kind: 'error' });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div data-wb-ziyi-entry={han} className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`wb-selectable font-serif ${compact ? 'text-2xl' : 'text-3xl'}`}>{han}</span>
        {entry && entry.variants.length > 0 && <span className="wb-selectable font-serif text-sm text-muted-foreground" title="异体字">（{entry.variants.join(' ')}）</span>}
        {entry && <ZiyiOriginTag origin={entry.origin} />}
        {(entry?.unicode ?? null) && <span className="wb-selectable text-xs text-muted-foreground stat-num">U+{entry!.unicode}</span>}
        {resolvedFrom && <span className="text-xs text-muted-foreground">由「{resolvedFrom}」查到</span>}
        {entry?.editedAt && <span className="text-xs text-muted-foreground" title={'本地修改于 ' + new Date(entry.editedAt).toLocaleString()}>本地修改</span>}
        <span className="ml-auto flex items-center gap-1">
          {entry && !editing && (
            <Button variant="ghost" size="sm" onClick={startEdit} title="编辑释义与出处">
              <PenLine /> 编辑
            </Button>
          )}
          {entry && !editing && onDeleted && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} title="删除这条字义">
              <Trash2 /> 删除
            </Button>
          )}
        </span>
      </div>

      {Array.from(han).length === 1 && isHanChar(han) && <ZiyiGlyphs key={han} char={han} compact={compact} />}

      {!entry && !editing && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          暂无字义
          <Button variant="outline" size="sm" onClick={startEdit}><Plus /> 新建</Button>
        </div>
      )}

      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !saving) { e.stopPropagation(); setEditing(false); }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
          }}
        >
          <label className="block text-xs text-muted-foreground">释义</label>
          <Textarea data-wb-ziyi-meaning value={meaning} onChange={(e) => setMeaning(e.target.value)} className="font-serif min-h-40" autoFocus />
          <label className="block text-xs text-muted-foreground">出处</label>
          <Textarea data-wb-ziyi-source value={source} onChange={(e) => setSource(e.target.value)} className="text-xs min-h-16" />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" loading={saving}>{saving ? '保存中…' : entry ? '保存' : '创建'}</Button>
            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setEditing(false)}>取消</Button>
            <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter 保存，Esc 取消</span>
          </div>
        </form>
      ) : entry && (
        <>
          <div data-wb-ziyi-text className="wb-selectable font-serif text-sm whitespace-pre-wrap break-words">{displayZiyiText(entry.meaning)}</div>
          {entry.source && (
            <div className="text-xs text-muted-foreground">
              <button className="flex items-center gap-0.5 hover:text-foreground transition-colors" onClick={() => setShowSource((v) => !v)}>
                {showSource ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} 出处
              </button>
              {showSource && <div data-wb-ziyi-source-text className="wb-selectable mt-1 whitespace-pre-wrap break-words">{displayZiyiText(entry.source)}</div>}
            </div>
          )}
        </>
      )}

      {confirmDelete && (
        <AlertDialog open onOpenChange={(o) => { if (!o && !deleting) setConfirmDelete(false); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除「{han}」的字义？</AlertDialogTitle>
              <AlertDialogDescription>只删除本机字义库里的这一条；之后重新导入字义文件会再出现。</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
              <Button variant="destructive" loading={deleting} onClick={() => { void remove(); }}>删除</Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
