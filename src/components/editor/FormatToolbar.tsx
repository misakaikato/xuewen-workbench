// 格式工具栏：论坛编辑器式按钮排。所有动作走 formatCommands（CodeMirror 事务）。
// 按钮高亮由光标处语法树探测（在粗体里 B 高亮，再点一次取消）。
// mousedown 一律阻默认：点按钮不抢编辑器焦点、不动光标。
import { useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import {
  Bold, Italic, Strikethrough, Code, Heading2,
  List, ListOrdered, ListTodo, TextQuote, Minus, Link2, Image as ImageIcon,
  SquareCode, Table as TableIcon, Undo2, Redo2, ChevronDown, Check,
} from 'lucide-react';
import {
  toggleInline, setHeading, toggleLinePrefix, insertBlock,
  linkInfoAt, applyLink, removeLink, insertImage, formatStateAt,
  type LinkInfo,
} from './formatCommands';

function TB({
  title, onClick, active, disabled, children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      className={`w-7 h-7 rounded flex items-center justify-center shrink-0 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 ${
        active ? 'bg-accent text-foreground' : ''
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="w-px h-5 bg-border mx-1 shrink-0" />;
}

const inputCls =
  'w-full border border-input bg-background rounded px-2 py-1.5 text-sm outline-none focus:border-ring mb-2';

export function FormatToolbar({ view, version }: { view: EditorView | null; version: number }) {
  void version; // 仅用于触发重渲染（选区/文档变化时由父组件递增）
  const [menu, setMenu] = useState<'h' | 'link' | 'image' | null>(null);
  const [linkInfo, setLinkInfo] = useState<LinkInfo | null>(null);
  const [selText, setSelText] = useState('');
  const [linkText, setLinkText] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [imgAlt, setImgAlt] = useState('');
  const [imgSrc, setImgSrc] = useState('');
  const fs = formatStateAt(view);
  const off = !view;

  const openLinkPopover = () => {
    if (!view) return;
    const info = linkInfoAt(view);
    setLinkInfo(info);
    const sel = view.state.selection.main;
    setSelText(sel.empty ? '' : view.state.sliceDoc(sel.from, sel.to));
    setLinkText(info ? info.text : sel.empty ? '' : view.state.sliceDoc(sel.from, sel.to));
    setLinkUrl(info ? info.href : '');
    setMenu('link');
  };

  const openImagePopover = () => {
    if (!view) return;
    setImgAlt('');
    setImgSrc('');
    setMenu('image');
  };

  return (
    <div className="relative flex items-center gap-0.5 flex-wrap px-2 py-1 border-b border-border bg-card shrink-0" data-wb-fmtbar>
      <TB title="撤销 (⌘Z)" disabled={off} onClick={() => view && undo(view)}><Undo2 className="w-4 h-4" /></TB>
      <TB title="重做 (⇧⌘Z)" disabled={off} onClick={() => view && redo(view)}><Redo2 className="w-4 h-4" /></TB>
      <Sep />
      <TB title="加粗" active={fs.bold} disabled={off} onClick={() => view && toggleInline(view, 'bold')}><Bold className="w-4 h-4" /></TB>
      <TB title="斜体" active={fs.italic} disabled={off} onClick={() => view && toggleInline(view, 'italic')}><Italic className="w-4 h-4" /></TB>
      <TB title="删除线" active={fs.strike} disabled={off} onClick={() => view && toggleInline(view, 'strike')}><Strikethrough className="w-4 h-4" /></TB>
      <TB title="行内代码" active={fs.code} disabled={off} onClick={() => view && toggleInline(view, 'code')}><Code className="w-4 h-4" /></TB>
      <Sep />
      <TB title={fs.heading ? `标题 H${fs.heading}（点击切换级别）` : '标题'} active={fs.heading > 0} disabled={off} onClick={() => setMenu(menu === 'h' ? null : 'h')}>
        <span className="flex items-center"><Heading2 className="w-4 h-4" /><ChevronDown className="w-3 h-3" /></span>
      </TB>
      <TB title="引用" disabled={off} onClick={() => view && toggleLinePrefix(view, 'quote')}><TextQuote className="w-4 h-4" /></TB>
      <TB title="无序列表" disabled={off} onClick={() => view && toggleLinePrefix(view, 'bullet')}><List className="w-4 h-4" /></TB>
      <TB title="有序列表" disabled={off} onClick={() => view && toggleLinePrefix(view, 'ordered')}><ListOrdered className="w-4 h-4" /></TB>
      <TB title="任务清单" disabled={off} onClick={() => view && toggleLinePrefix(view, 'task')}><ListTodo className="w-4 h-4" /></TB>
      <Sep />
      <TB title="链接（光标在链接内时编辑）" active={fs.inLink} disabled={off} onClick={openLinkPopover}><Link2 className="w-4 h-4" /></TB>
      <TB title="图片" disabled={off} onClick={openImagePopover}><ImageIcon className="w-4 h-4" /></TB>
      <Sep />
      <TB title="代码块" disabled={off} onClick={() => view && insertBlock(view, '```\n\n```', 4)}><SquareCode className="w-4 h-4" /></TB>
      <TB title="表格（插入后点击表格编辑内容）" disabled={off} onClick={() => view && insertBlock(view, '| 列1 | 列2 |\n| --- | --- |\n|  |  |')}><TableIcon className="w-4 h-4" /></TB>
      <TB title="分隔线" disabled={off} onClick={() => view && insertBlock(view, '---')}><Minus className="w-4 h-4" /></TB>

      {menu === 'h' && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenu(null)} />
          <div className="absolute left-2 top-full mt-1 z-20 bg-card border border-border rounded-lg shadow-lg p-1 w-36">
            {([0, 1, 2, 3, 4] as const).map((lv) => (
              <button
                key={lv}
                type="button"
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent text-sm text-left"
                onClick={() => {
                  if (view) setHeading(view, lv);
                  setMenu(null);
                }}
              >
                <span className="w-4 flex justify-center">{fs.heading === lv && <Check className="w-3.5 h-3.5 text-primary" />}</span>
                {lv === 0 ? '正文' : `标题 ${lv} 级`}
                {lv > 0 && <span className="ml-auto text-muted-foreground">{'#'.repeat(lv)}</span>}
              </button>
            ))}
          </div>
        </>
      )}

      {menu === 'link' && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenu(null)} />
          <div className="absolute left-2 top-full mt-1 z-20 bg-card border border-border rounded-lg shadow-lg p-3 w-80">
            <div className="text-sm font-medium mb-2">{linkInfo ? '编辑链接' : '插入链接'}</div>
            <input
              autoFocus
              className={inputCls}
              placeholder="链接文字"
              value={linkText}
              onChange={(e) => setLinkText(e.target.value)}
            />
            <input
              className={inputCls}
              placeholder="地址（https://… 或相对路径）"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && view) {
                  applyLink(view, linkInfo, linkText || selText || '链接', linkUrl);
                  setMenu(null);
                }
              }}
            />
            <div className="flex gap-2 justify-end">
              {linkInfo && (
                <button
                  type="button"
                  className="px-2.5 py-1 rounded border border-border text-sm text-destructive hover:bg-accent"
                  onClick={() => {
                    if (view) removeLink(view, linkInfo);
                    setMenu(null);
                  }}
                >
                  移除链接
                </button>
              )}
              <button type="button" className="px-2.5 py-1 rounded border border-border text-sm hover:bg-accent" onClick={() => setMenu(null)}>
                取消
              </button>
              <button
                type="button"
                className="px-2.5 py-1 rounded bg-primary text-primary-foreground text-sm"
                onClick={() => {
                  if (view) applyLink(view, linkInfo, linkText || selText || '链接', linkUrl);
                  setMenu(null);
                }}
              >
                确定
              </button>
            </div>
          </div>
        </>
      )}

      {menu === 'image' && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenu(null)} />
          <div className="absolute left-2 top-full mt-1 z-20 bg-card border border-border rounded-lg shadow-lg p-3 w-80">
            <div className="text-sm font-medium mb-2">插入图片</div>
            <input
              autoFocus
              className={inputCls}
              placeholder="描述（替代文字）"
              value={imgAlt}
              onChange={(e) => setImgAlt(e.target.value)}
            />
            <input
              className={inputCls}
              placeholder="图片地址（https://… 或库内相对路径）"
              value={imgSrc}
              onChange={(e) => setImgSrc(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && view) {
                  insertImage(view, imgAlt, imgSrc);
                  setMenu(null);
                }
              }}
            />
            <div className="flex gap-2 justify-end">
              <button type="button" className="px-2.5 py-1 rounded border border-border text-sm hover:bg-accent" onClick={() => setMenu(null)}>
                取消
              </button>
              <button
                type="button"
                className="px-2.5 py-1 rounded bg-primary text-primary-foreground text-sm"
                onClick={() => {
                  if (view) insertImage(view, imgAlt, imgSrc);
                  setMenu(null);
                }}
              >
                确定
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
