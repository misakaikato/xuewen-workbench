// 实时预览扩展（论坛编辑器式）：全时渲染——所有格式记号（#/**/>/`` 等）
// 恒隐藏，所见即所得；格式调整交给工具栏按钮（formatToolbar）或用户手打语法
// （语法一旦成立即被识别渲染）。装饰只影响显示，绝不改动文档字节。
// 表格为可编辑块级部件：单元格点开即改、增删行列、对齐循环、⌨源码回退；
// 光标在表格源码内（手改/撤销场景）时临时显示源码；
// 光标所在空行保持原行高便于定位。
import { syntaxTree } from '@codemirror/language';
import { EditorState, Facet, StateEffect, StateField } from '@codemirror/state';
import type { Range } from '@codemirror/state';
import { alField } from './autoLinks';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { mdLang } from './mdLanguage';
import { editorBaseThemeSpec } from './setup';
import { getApiScope } from '@/lib/api';

export interface LivePreviewOptions {
  /** 当前文档相对路径（解析相对链接 / 图片用） */
  docPath: string;
  /** Cmd/Ctrl+点击链接时交给上层：内部相对路径应用内导航，http(s) 外开 */
  openLink: (href: string) => void;
  /** 点击划线笔记标记：跳到笔记文件锚点 */
  openNote?: (href: string) => void;
  /** 只读实例（阅读视图）：无光标、链接单击即开 */
  readOnly?: boolean;
  /** 版式几何：page=编辑页全幅（预留页边留白）；card=卡片/面板内（容器即排版列）。
   *  与 readOnly 正交——阅读页原位编辑 = card + 可编辑 */
  geometry?: 'page' | 'card';
  /** 划线笔记标记：正文中匹配到 quote 时加下划线，点击跳到笔记锚点 */
  noteMarks?: { quote: string; href: string }[];
  /** 点击内链词条（表格单元格内）：target 为 {path, heading} */
  openDocLink?: (target: { path: string; heading?: string | null }) => void;
  /** 点击歧义词条（表格单元格内）：弹候选选择 */
  onCandidates?: (term: string, candidates: string[], at: { x: number; y: number }) => void;
}

// 文档路径以 facet 提供，构建装饰时读取
const lpDocPath = Facet.define<string, string>({ combine: (v) => (v.length ? v[v.length - 1] : '') });
const lpReadOnly = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) });
const lpNoteMarks = Facet.define<{ quote: string; href: string }[], { quote: string; href: string }[]>({ combine: (v) => v[v.length - 1] ?? [] });
const lpOnCandidates = Facet.define<((term: string, candidates: string[], at: { x: number; y: number }) => void) | null, ((term: string, candidates: string[], at: { x: number; y: number }) => void) | null>({ combine: (v) => v[v.length - 1] ?? null });
const lpOpenDocLink = Facet.define<((t: { path: string; heading?: string | null }) => void) | null, ((t: { path: string; heading?: string | null }) => void) | null>({ combine: (v) => v[v.length - 1] ?? null });

// 语法树延迟补全后，提醒表格 StateField 重算的空效果
const lpTreeRefresh = StateEffect.define<null>();

// ---------- 路径解析（与 ReadOnlyDoc 同口径） ----------

function joinRel(baseDir: string, rel: string): string {
  const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean);
  for (const seg of rel.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function decodeSrc(u: string): string {
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
}

function resolveAsset(docPath: string, src: string): string {
  if (/^https?:\/\//i.test(src) || src.startsWith('data:')) return src;
  const dir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
  let url = '/api/file/raw?path=' + encodeURIComponent(joinRel(dir, decodeSrc(src)));
  const ds = getApiScope(); // 编辑器实时预览的图片也要落在当前知识库
  if (ds) url += '&ds=' + encodeURIComponent(ds);
  return url;
}

// ---------- 选区所在行（仅用于空行压缩与表格源码揭示） ----------

// 只有这些块级容器需要下探寻找围栏代码块 / 表格
const BLOCK_CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem']);

function selectionEndpoints(state: EditorState): number[] {
  const out: number[] = [];
  for (const r of state.selection.ranges) out.push(r.from, r.to);
  return out;
}

// 选区覆盖的行；光标在围栏代码块或表格内时扩展为整块。
// 只读实例恒为空（装饰全时渲染，选区不揭示源码）。
function activeLineSet(state: EditorState): Set<number> {
  if (state.facet(lpReadOnly)) return new Set();
  const active = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) active.add(n);
  }
  const endpoints = selectionEndpoints(state);
  const scan = (node: SyntaxNode) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.name === 'FencedCode' || c.name === 'Table') {
        if (endpoints.some((p) => p >= c.from && p <= c.to)) {
          const l1 = state.doc.lineAt(c.from).number;
          const l2 = state.doc.lineAt(c.to).number;
          for (let n = l1; n <= l2; n++) active.add(n);
        }
      } else if (BLOCK_CONTAINERS.has(c.name)) {
        scan(c);
      }
    }
  };
  scan(syntaxTree(state).topNode);
  return active;
}

// ---------- 表格模型 ----------

interface TableModel {
  header: string[];
  align: (string | null)[];
  rows: string[][];
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  // 只按未转义的 | 分列（GFM 允许单元格里用 \\| 表示字面竖线）
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

// 单元格文本的显示态（去转义）与写回态（补转义）
const unescapeCell = (t: string) => t.replace(/\\\|/g, '|');
const escapeCell = (t: string) => t.replace(/(?<!\\)\|/g, '\\|');

function cloneModel(m: TableModel): TableModel {
  return { header: [...m.header], align: [...m.align], rows: m.rows.map((r) => [...r]) };
}

function colCount(m: TableModel): number {
  return Math.max(1, m.header.length, m.align.length, ...m.rows.map((r) => r.length));
}

// 整表序列化（写回源文用）：规范化为 `| a | b |` 形态，对齐写入分隔行冒号；
// lineBreak 跟随文档实际行分隔符（CRLF 文档不引入混杂换行）
function serializeTable(m: TableModel, lineBreak: string): string {
  const n = colCount(m);
  const row = (cells: string[]) =>
    '| ' + Array.from({ length: n }, (_, i) => escapeCell(cells[i] ?? '')).join(' | ') + ' |';
  const delim =
    '| ' +
    Array.from({ length: n }, (_, i) => {
      const a = m.align[i];
      return a === 'left' ? ':---' : a === 'center' ? ':---:' : a === 'right' ? '---:' : '---';
    }).join(' | ') +
    ' |';
  return [row(m.header), delim, ...m.rows.map(row)].join(lineBreak);
}

function parseTable(src: string): TableModel | null {
  const lines = src.split(/\r\n|\n/).filter((l) => l.trim());
  if (lines.length < 2) return null;
  const delim = lines[1];
  if (!delim.includes('-') || !/^\s*\|?[\s:|-]*\|[\s:|-]*$/.test(delim)) return null;
  const align = splitRow(delim).map((d) => {
    const l = d.startsWith(':');
    const r = d.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
  });
  return { header: splitRow(lines[0]), align, rows: lines.slice(2).map(splitRow) };
}

// ---------- 表格单元格行内格式（常用子集，DOM API 构建防注入） ----------

const INLINE_RE = /(\*\*(?:[^*]|\*(?!\*))+\*\*)|(~~[^~]+~~)|(`[^`]+`)|(\[[^\]]*\]\([^)\s]*(?:\s+"[^"]*")?\))|(\*(?:[^*]|\*(?=\S))+\*)/g;

const cellCache = new Map<string, HTMLElement>();

function renderInlineInto(parent: HTMLElement, text: string) {
  INLINE_RE.lastIndex = 0;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > pos) parent.appendChild(document.createTextNode(text.slice(pos, m.index)));
    const tok = m[0];
    if (tok.startsWith('**')) {
      const s = document.createElement('strong');
      s.textContent = tok.slice(2, -2);
      parent.appendChild(s);
    } else if (tok.startsWith('~~')) {
      const s = document.createElement('s');
      s.className = 'cm-lp-strike';
      s.textContent = tok.slice(2, -2);
      parent.appendChild(s);
    } else if (tok.startsWith('`')) {
      const c = document.createElement('code');
      c.className = 'cm-lp-code-inline';
      c.textContent = tok.slice(1, -1);
      parent.appendChild(c);
    } else if (tok.startsWith('[')) {
      const mm = /^\[([^\]]*)\]\(([^)\s]*)/.exec(tok);
      const a = document.createElement('a');
      a.className = 'md-link';
      if (mm) a.setAttribute('data-lp-href', mm[2]);
      a.textContent = mm ? mm[1] : tok;
      parent.appendChild(a);
    } else {
      const e = document.createElement('em');
      e.textContent = tok.slice(1, -1);
      parent.appendChild(e);
    }
    pos = m.index + tok.length;
  }
  if (pos < text.length) parent.appendChild(document.createTextNode(text.slice(pos)));
}

// 单元格内联渲染 + 内链标记：links 为 cell 内相对偏移；点击走 openDocLink
function buildLinkedCell(text: string,
  links: { from: number; to: number; target: { path: string; heading?: string | null } | null; term?: string; candidates?: string[] | null }[],
  openDocLink: ((t: { path: string; heading?: string | null }) => void) | null,
  onCandidates?: ((term: string, candidates: string[], at: { x: number; y: number }) => void) | null): HTMLElement {
  if (!links.length || (!openDocLink && !onCandidates)) return buildCell(text);
  const span = document.createElement('span');
  const sorted = [...links].sort((a, b) => a.from - b.from);
  let last = 0;
  for (const l of sorted) {
    if (l.from < last || l.to > text.length) continue;
    if (l.from > last) {
      const seg = document.createElement('span');
      renderInlineInto(seg, text.slice(last, l.from));
      span.appendChild(seg);
    }
    const a = document.createElement('span');
    a.className = l.target ? 'wb-autolink' : 'wb-autolink wb-al-candidates';
    a.style.cursor = 'pointer';
    a.textContent = text.slice(l.from, l.to);
    a.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (l.target) openDocLink?.(l.target);
      else if (l.candidates?.length) onCandidates?.(l.term || text.slice(l.from, l.to), l.candidates, { x: e.clientX, y: e.clientY });
    });
    span.appendChild(a);
    last = l.to;
  }
  if (last < text.length) {
    const seg = document.createElement('span');
    renderInlineInto(seg, text.slice(last));
    span.appendChild(seg);
  }
  return span;
}

function buildCell(text: string): HTMLElement {
  const cached = cellCache.get(text);
  if (cached) return cached.cloneNode(true) as HTMLElement;
  const el = document.createElement('span');
  renderInlineInto(el, text);
  if (cellCache.size > 2000) cellCache.delete(cellCache.keys().next().value as string);
  cellCache.set(text, el);
  return el.cloneNode(true) as HTMLElement;
}

// ---------- 部件（Widget） ----------

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-lp-bullet';
    span.textContent = '•';
    return span;
  }
}

// 任务勾选：编辑态可点击切换（写回 [ ]/[x] 源文，只改这两个字节）；只读态纯展示
class TaskWidget extends WidgetType {
  private checked: boolean;
  private markFrom: number;
  private markTo: number;
  private editable: boolean;

  constructor(checked: boolean, markFrom: number, markTo: number, editable: boolean) {
    super();
    this.checked = checked;
    this.markFrom = markFrom;
    this.markTo = markTo;
    this.editable = editable;
  }

  eq(other: TaskWidget): boolean {
    // 位置必须参与比较：否则文档在别处变动后部件被复用，写回用陈旧坐标
    return other.checked === this.checked && other.markFrom === this.markFrom && other.markTo === this.markTo;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.className = 'cm-lp-task';
    el.checked = this.checked;
    if (!this.editable) {
      el.disabled = true;
      return el;
    }
    el.title = '切换完成状态';
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!view.state.facet(EditorView.editable)) return;
      view.dispatch({
        changes: { from: this.markFrom, to: this.markTo, insert: this.checked ? '[ ]' : '[x]' },
        selection: { anchor: this.markTo },
      });
    });
    return el;
  }
}

class ImgWidget extends WidgetType {
  private src: string;
  private alt: string;

  constructor(src: string, alt: string) {
    super();
    this.src = src;
    this.alt = alt;
  }

  eq(other: ImgWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const img = document.createElement('img');
    img.className = 'cm-lp-img';
    img.src = this.src;
    img.alt = this.alt;
    img.loading = 'lazy';
    return img;
  }
}

class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-lp-hr-w';
    return span;
  }
}

// 围栏行细条：开栏行显示语言标签
class FenceBarWidget extends WidgetType {
  private label: string;

  constructor(label: string) {
    super();
    this.label = label;
  }

  eq(other: FenceBarWidget): boolean {
    return other.label === this.label;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-lp-fence';
    if (this.label) {
      const lab = document.createElement('span');
      lab.className = 'cm-lp-fence-lang';
      lab.textContent = this.label;
      span.appendChild(lab);
    }
    return span;
  }
}

// 表格可编辑部件：单元格点开即改、悬浮工具条增删行列、表头循环对齐、⌨回源码。
// 所有写回都是「整表序列化替换源文」的单次事务（可撤销、可触发脏检测/草稿）。
// 部件实例随文档重建：跨重建的接力（Tab 到下一格/新增行后自动进入编辑）
// 经 pendingCellEdit + liveTables 完成——新实例的 toDOM 消费 pending 继续打开输入。
interface PendingCellEdit {
  from: number; // 表首位置（重建后不变，作为接力对账键）
  r: number; // -1 = 表头
  c: number;
  at: number; // 毫秒时间戳，过期作废（位置漂移防误接力）
}

const liveTablesByView = new WeakMap<EditorView, Map<number, TableWidget>>();
const pendingByView = new WeakMap<EditorView, PendingCellEdit | null>();

function liveTablesFor(view: EditorView): Map<number, TableWidget> {
  let m = liveTablesByView.get(view);
  if (!m) {
    m = new Map();
    liveTablesByView.set(view, m);
  }
  return m;
}

function setPending(view: EditorView, p: PendingCellEdit | null) {
  pendingByView.set(view, p);
}

function takePending(view: EditorView, from: number): PendingCellEdit | null {
  const p = pendingByView.get(view);
  if (p && p.from === from && Date.now() - p.at < 2000) {
    pendingByView.set(view, null);
    return p;
  }
  return null;
}

class TableWidget extends WidgetType {
  private from: number;
  private to: number;
  private model: TableModel;
  private readOnly: boolean;
  private links: { from: number; to: number; target: { path: string; heading?: string | null } | null; term?: string; candidates?: string[] | null }[];
  private openDocLink: ((target: { path: string; heading?: string | null }) => void) | null;
  private onCandidates: ((term: string, candidates: string[], at: { x: number; y: number }) => void) | null;
  private view: EditorView | null = null; // toDOM 时记录，destroy 注销用

  constructor(from: number, to: number, model: TableModel, readOnly: boolean,
    links: { from: number; to: number; target: { path: string; heading?: string | null } | null; term?: string; candidates?: string[] | null }[] = [],
    openDocLink: ((target: { path: string; heading?: string | null }) => void) | null = null,
    onCandidates: ((term: string, candidates: string[], at: { x: number; y: number }) => void) | null = null) {
    super();
    this.from = from;
    this.to = to;
    this.model = model;
    this.readOnly = readOnly;
    this.links = links;
    this.openDocLink = openDocLink;
    this.onCandidates = onCandidates;
  }

  eq(other: TableWidget): boolean {
    // 首尾位置参与比较：文档在到处变动后部件不复用，写回不用陈旧坐标
    return other.from === this.from && other.to === this.to && other.readOnly === this.readOnly &&
      JSON.stringify(other.model) === JSON.stringify(this.model) &&
      JSON.stringify(other.links) === JSON.stringify(this.links);
  }

  // 写回：整表替换源文一次事务；重算后部件以新模型重建
  private applyModel(view: EditorView, m: TableModel) {
    view.dispatch({ changes: { from: this.from, to: this.to, insert: serializeTable(m, view.state.lineBreak) } });
  }

  private cellText(r: number, c: number): string {
    return r < 0 ? (this.model.header[c] ?? '') : (this.model.rows[r]?.[c] ?? '');
  }

  // 单元格在源文档中的偏移区间（r=-1 为表头）。源文逐行扫描定位 trim 后内容；
  // 含转义符的单元格（\\|）显示文本与源文长度不一致，返回 null 跳过链接渲染。
  private cellSrcRange(view: EditorView, r: number, c: number): { from: number; to: number } | null {
    try {
      const firstLine = view.state.doc.lineAt(this.from);
      const line = view.state.doc.line(firstLine.number + (r < 0 ? 0 : r + 2));
      const cells = splitRow(line.text);
      if (c >= cells.length) return null;
      const cell = cells[c];
      if (!cell) return null;
      let pos = 0;
      for (let i = 0; i < c; i++) {
        const idx = line.text.indexOf(cells[i], pos);
        if (idx < 0) return null;
        pos = idx + cells[i].length;
      }
      const idx = line.text.indexOf(cell, pos);
      if (idx < 0) return null;
      return { from: line.from + idx, to: line.from + idx + cell.length };
    } catch {
      return null;
    }
  }

  // 该单元格内的内链（换算为显示文本的相对偏移；含转义时放弃）
  private cellLinks(view: EditorView, r: number, c: number): { from: number; to: number; target: { path: string; heading?: string | null } | null; term?: string; candidates?: string[] | null }[] {
    if (!this.links.length) return [];
    const range = this.cellSrcRange(view, r, c);
    if (!range) return [];
    const raw = view.state.sliceDoc(range.from, range.to);
    const disp = unescapeCell(raw);
    if (raw !== disp) return []; // 含转义：偏移不可直接换算
    return this.links
      .filter((l) => l.from >= range.from && l.to <= range.to)
      .map((l) => ({ from: l.from - range.from, to: l.to - range.from, target: l.target, term: l.term, candidates: l.candidates }));
  }

  // 在当前视口 DOM 里定位本表某单元格（部件可能已随文档重建，经 data 属性查）
  private cellIn(view: EditorView, r: number, c: number): HTMLTableCellElement | null {
    return view.dom.querySelector(`.cm-lp-table[data-tbl-from="${this.from}"] [data-r="${r}"][data-c="${c}"]`);
  }

  private ownerWrap(view: EditorView): HTMLElement | null {
    return view.dom.querySelector(`.cm-lp-table[data-tbl-from="${this.from}"]`);
  }

  // 打开单元格内联输入：Enter 提交 / Esc 取消 / Tab 接力下一格 / 失焦提交
  private openInput(td: HTMLTableCellElement, view: EditorView) {
    if (td.querySelector('input')) return;
    const wrap = td.closest('.cm-lp-table') as HTMLElement | null;
    if (!wrap) return;
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    const display = td.querySelector('.wb-tc-display') as HTMLElement | null;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'wb-tc-input';
    input.value = unescapeCell(this.cellText(r, c));
    if (display) display.style.display = 'none';
    td.classList.add('wb-tc-editing');
    td.insertBefore(input, display ?? null);
    input.focus();
    input.select();
    let done = false;
    const close = (commit: boolean, thenEdit?: { r: number; c: number }) => {
      if (done) return;
      done = true;
      delete (wrap as { _wbClose?: unknown })._wbClose;
      const val = escapeCell(input.value.trim());
      input.remove();
      td.classList.remove('wb-tc-editing');
      if (display) display.style.display = '';
      if (thenEdit) setPending(view, { from: this.from, r: thenEdit.r, c: thenEdit.c, at: Date.now() });
      if (commit && val !== this.cellText(r, c)) {
        const m = cloneModel(this.model);
        if (r < 0) m.header[c] = val;
        else {
          const row = m.rows[r] ?? (m.rows[r] = []);
          row[c] = val;
        }
        this.applyModel(view, m); // 文档变化 → 部件重建 → 新 toDOM 消费 pending 接力
        return;
      }
      if (thenEdit) {
        // 无变化不重建：旧 DOM 仍相连，直接在旧实例上打开下一格
        requestAnimationFrame(() => {
          if (!wrap.isConnected) return;
          const p = takePending(view, this.from);
          if (!p) return;
          const el = this.cellIn(view, p.r, p.c);
          if (el) this.openInput(el, view);
        });
      }
    };
    (wrap as { _wbClose?: (c: boolean) => void })._wbClose = (commit: boolean) => close(commit);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 输入框拥有键盤，不给 CM 键映射拦截
      if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
        view.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
        view.focus();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const n = colCount(this.model);
        let nr = r;
        let nc = c + 1;
        if (nc >= n) {
          nc = 0;
          nr = r + 1;
        }
        if (nr >= this.model.rows.length) {
          close(true);
          view.focus(); // 末格：停留（不自动增行）
        } else {
          close(true, { r: nr, c: nc });
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        close(false);
        view.focus(); // 撤销交给编辑器：再按一次 Ctrl+Z 撤销上一次表格写回
      }
    });
    input.addEventListener('blur', () => close(true));
  }

  // 结构操作入口：先提交进行中的单元格编辑；提交可能触发重建，
  // 操作经 liveTables 落到最新实例上执行（绝不用陈旧模型计算）
  private run(view: EditorView, fn: (w: TableWidget) => void) {
    const from = this.from;
    const wrap = this.ownerWrap(view);
    const closer = (wrap as { _wbClose?: (c: boolean) => void } | null)?._wbClose;
    const go = () => {
      const w = liveTablesFor(view).get(from);
      if (w) fn(w);
    };
    if (closer) {
      closer(true);
      requestAnimationFrame(go);
    } else go();
  }

  // 点击单元格：若他格正在编辑则先提交再接力；否则直接打开
  private editCell(view: EditorView, r: number, c: number) {
    const from = this.from;
    const wrap = this.ownerWrap(view);
    const closer = (wrap as { _wbClose?: (c: boolean) => void } | null)?._wbClose;
    if (closer) {
      setPending(view, { from, r, c, at: Date.now() });
      closer(true);
      requestAnimationFrame(() => {
        // 旧 DOM 仍相连 = 未触发重建：直接打开（重建路径由新 toDOM 的 pending 接力）
        if (!wrap || !wrap.isConnected) return;
        const p = takePending(view, from);
        if (!p) return;
        const el = this.cellIn(view, p.r, p.c);
        if (el) this.openInput(el, view);
      });
      return;
    }
    const el = this.cellIn(view, r, c);
    if (el) this.openInput(el, view);
  }

  private addRow(view: EditorView) {
    const m = cloneModel(this.model);
    m.rows.push(Array.from({ length: colCount(m) }, () => ''));
    setPending(view, { from: this.from, r: m.rows.length - 1, c: 0, at: Date.now() }); // 新行直接进入编辑
    this.applyModel(view, m);
  }

  private addCol(view: EditorView) {
    const m = cloneModel(this.model);
    m.header.push('');
    m.align.push(null);
    for (const row of m.rows) row.push('');
    setPending(view, { from: this.from, r: -1, c: m.header.length - 1, at: Date.now() });
    this.applyModel(view, m);
  }

  private delRow(view: EditorView, r: number) {
    if (r < 0 || r >= this.model.rows.length) return;
    const m = cloneModel(this.model);
    m.rows.splice(r, 1);
    setPending(view, null);
    this.applyModel(view, m);
  }

  private delCol(view: EditorView, c: number) {
    if (colCount(this.model) <= 1) return;
    const m = cloneModel(this.model);
    m.header.splice(c, 1);
    m.align.splice(c, 1);
    for (const row of m.rows) row.splice(c, 1);
    setPending(view, null);
    this.applyModel(view, m);
  }

  private cycleAlign(view: EditorView, c: number) {
    const order: (string | null)[] = [null, 'left', 'center', 'right'];
    const cur = this.model.align[c] ?? null;
    const m = cloneModel(this.model);
    m.align[c] = order[(order.indexOf(cur) + 1) % order.length];
    setPending(view, null);
    this.applyModel(view, m);
  }

  // 光标移入表格源码：部件隐藏显示源码，可手改（原有「点击进源码」的替代入口）
  private showSource(view: EditorView) {
    setPending(view, null);
    const closer = (this.ownerWrap(view) as { _wbClose?: (c: boolean) => void } | null)?._wbClose;
    if (closer) closer(false);
    view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
  }

  toDOM(view: EditorView): HTMLElement {
    const ro = this.readOnly;
    const n = colCount(this.model);
    this.view = view;
    liveTablesFor(view).set(this.from, this);
    const wrap = document.createElement('div');
    wrap.className = 'cm-lp-table' + (ro ? '' : ' wb-tbl-edit');
    wrap.setAttribute('data-tbl-from', String(this.from));

    // 悬浮工具条：＋行 ＋列 ⌨源码（只读实例无）
    if (!ro) {
      const bar = document.createElement('div');
      bar.className = 'wb-tbl-bar';
      const mkBtn = (label: string, title: string, fn: (w: TableWidget) => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wb-tbl-btn';
        b.textContent = label;
        b.title = title;
        b.addEventListener('mousedown', (e) => {
          e.preventDefault(); // 不抢单元格输入焦点
          e.stopPropagation();
        });
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.run(view, fn);
        });
        return b;
      };
      bar.appendChild(mkBtn('＋行', '在末尾添加一行（新行直接进入编辑）', (w) => w.addRow(view)));
      bar.appendChild(mkBtn('＋列', '在末尾添加一列', (w) => w.addCol(view)));
      bar.appendChild(mkBtn('⌨ 源码', '显示表格 Markdown 源码，可直接手改（点击表格外部恢复渲染）', (w) => w.showSource(view)));
      wrap.appendChild(bar);
    }

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (let c = 0; c < n; c++) {
      const th = document.createElement('th');
      th.dataset.r = '-1';
      th.dataset.c = String(c);
      const a = this.model.align[c];
      if (a) th.style.textAlign = a;
      const disp = document.createElement('span');
      disp.className = 'wb-tc-display';
      disp.appendChild(buildLinkedCell(unescapeCell(this.model.header[c] ?? ''), this.cellLinks(view, -1, c), this.openDocLink, this.onCandidates));
      th.appendChild(disp);
      if (!ro) {
        const ops = document.createElement('span');
        ops.className = 'wb-th-ops';
        const glyph = (al: string | null) => (al === 'left' ? '⇤' : al === 'center' ? '⇔' : al === 'right' ? '⇥' : '≡');
        const nextName = (al: string | null) =>
          al === null ? '左' : al === 'left' ? '中' : al === 'center' ? '右' : '默认';
        const alBtn = document.createElement('button');
        alBtn.type = 'button';
        alBtn.className = 'wb-th-op';
        alBtn.textContent = glyph(a ?? null);
        alBtn.title = `对齐：${a ?? '默认'}（点击切为${nextName(a ?? null)}）`;
        alBtn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        alBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.run(view, (w) => w.cycleAlign(view, c));
        });
        ops.appendChild(alBtn);
        if (n > 1) {
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'wb-th-op wb-th-del';
          delBtn.textContent = '✕';
          delBtn.title = '删除此列';
          delBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
          });
          delBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.run(view, (w) => w.delCol(view, c));
          });
          ops.appendChild(delBtn);
        }
        th.appendChild(ops);
        th.addEventListener('mousedown', (e) => {
          if ((e.target as HTMLElement).closest('.wb-th-ops')) return;
          e.preventDefault(); // 不让 CM 抢焦点/移动光标
          e.stopPropagation();
          this.editCell(view, -1, c);
        });
      }
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    this.model.rows.forEach((row, r) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < n; c++) {
        const td = document.createElement('td');
        td.dataset.r = String(r);
        td.dataset.c = String(c);
        const a = this.model.align[c];
        if (a) td.style.textAlign = a;
        const disp = document.createElement('span');
        disp.className = 'wb-tc-display';
        disp.appendChild(buildLinkedCell(unescapeCell(row[c] ?? ''), this.cellLinks(view, r, c), this.openDocLink, this.onCandidates));
        td.appendChild(disp);
        if (!ro) {
          td.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.editCell(view, r, c);
          });
        }
        tr.appendChild(td);
      }
      if (!ro) {
        const rop = document.createElement('td');
        rop.className = 'wb-tb-rop';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'wb-rop-btn';
        del.textContent = '✕';
        del.title = '删除此行';
        del.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        del.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.run(view, (w) => w.delRow(view, r));
        });
        rop.appendChild(del);
        tr.appendChild(rop);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    // 编辑接力：重建后继续打开 pending 单元格（Tab/新增行后自动进入编辑）
    const pend = takePending(view, this.from);
    if (pend && !ro) {
      requestAnimationFrame(() => {
        const el = this.cellIn(view, pend.r, pend.c);
        if (el) this.openInput(el, view);
      });
    }
    return wrap;
  }

  destroy(): void {
    // 部件从 DOM 撤下：若仍是本表的在册实例则注销（防陈旧实例被 run() 捡到）
    const v = this.view;
    if (v) {
      const m = liveTablesByView.get(v);
      if (m?.get(this.from) === this) m.delete(this.from);
      if (pendingByView.get(v)?.from === this.from) pendingByView.set(v, null);
    }
  }
}

// ---------- 装饰构建 ----------

const childrenOf = (node: SyntaxNode): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
};

// ATX 标题：行级样式 + 隐藏 # 记号与其后空格（全时渲染，不再因光标显源码）
function decorateHeading(state: EditorState, node: SyntaxNode, parts: Range<Decoration>[]) {
  const line = state.doc.lineAt(node.from);
  const m = node.name.match(/^ATXHeading(\d)$/);
  if (!m) return;
  parts.push(Decoration.line({ class: 'cm-lp-h' + m[1] }).range(line.from));
  const mark = childrenOf(node).find((c) => c.name === 'HeaderMark');
  if (!mark) return;
  let to = mark.to;
  if (to < line.to && state.sliceDoc(to, to + 1) === ' ') to++;
  if (to > node.from) parts.push(Decoration.replace({}).range(node.from, to));
}

// 围栏代码：行级样式 + 围栏行内容隐藏（开栏行显示语言细条）；
// 光标在代码块内部不揭示围栏行（内容本就是字面文本，直接编辑）
function decorateFence(
  state: EditorState, node: SyntaxNode,
  parts: Range<Decoration>[], vFrom: number, vTo: number
) {
  const doc = state.doc;
  const l1 = doc.lineAt(node.from).number;
  const l2 = doc.lineAt(node.to).number;
  for (let ln = l1; ln <= l2; ln++) {
    const line = doc.line(ln);
    if (line.from < vFrom || line.from > vTo) continue;
    const cls = ['cm-lp-code'];
    if (ln === l1) cls.push('cm-lp-code-first');
    if (ln === l2) cls.push('cm-lp-code-last');
    parts.push(Decoration.line({ class: cls.join(' ') }).range(line.from));
    if (ln === l1 && line.to > line.from) {
      const info = childrenOf(node).find((c) => c.name === 'CodeInfo');
      const label = info ? state.sliceDoc(info.from, info.to) : '';
      parts.push(Decoration.replace({ widget: new FenceBarWidget(label) }).range(line.from, line.to));
    } else if (ln === l2 && line.to > line.from) {
      parts.push(Decoration.replace({}).range(line.from, line.to));
    }
  }
}

// 引用块：行级样式（'>' 记号由 enter 里的 QuoteMark 分支隐藏）
function decorateQuoteLines(
  state: EditorState, node: SyntaxNode,
  parts: Range<Decoration>[], vFrom: number, vTo: number
) {
  const doc = state.doc;
  const l1 = doc.lineAt(node.from).number;
  const l2 = doc.lineAt(node.to).number;
  for (let ln = l1; ln <= l2; ln++) {
    const line = doc.line(ln);
    if (line.from < vFrom || line.from > vTo) continue;
    parts.push(Decoration.line({ class: 'cm-lp-quote' }).range(line.from));
  }
}

// 成对记号（强调 / 粗体 / 删除线 / 行内代码）：隐藏记号，内容加样式
function decoratePairedMarks(node: SyntaxNode, markName: string, cls: string, parts: Range<Decoration>[]) {
  const kids = childrenOf(node);
  const marks = kids.filter((c) => c.name === markName);
  for (const m of marks) {
    if (m.to > m.from) parts.push(Decoration.replace({}).range(m.from, m.to));
  }
  const first = marks[0];
  const last = marks[marks.length - 1];
  if (first && last && last.from >= first.to && last.from > first.to) {
    parts.push(Decoration.mark({ class: cls }).range(first.to, last.from));
  }
}

// 链接 [文字](目标) 与 <自动链接>：只显示文字，样式为链接，Ctrl/Cmd+点击可打开
function decorateLink(state: EditorState, node: SyntaxNode, parts: Range<Decoration>[]) {
  const kids = childrenOf(node);
  const marks = kids.filter((c) => c.name === 'LinkMark');
  const textOf = (c: SyntaxNode) => state.sliceDoc(c.from, c.to);
  const urlNode = kids.find((c) => c.name === 'URL');
  let href = urlNode ? textOf(urlNode) : '';
  if (!urlNode) {
    const label = kids.find((c) => c.name === 'LinkLabel');
    if (label) href = textOf(label);
  }
  for (const m of marks) {
    if (m.to > m.from) parts.push(Decoration.replace({}).range(m.from, m.to));
  }
  // 行内链接：从 '(' 记号到 ')' 记号整段隐藏（目标与标题）
  const open = marks.find((m) => textOf(m) === '(');
  if (open) {
    const close = marks.filter((m) => m.from > open.from).pop();
    if (close && close.to > open.from) parts.push(Decoration.replace({}).range(open.from, close.to));
  }
  // 可见文字：'[' 与 ']' 之间；自动链接则是 URL 本身
  let labelFrom = node.from;
  let labelTo = node.to;
  const bracket = marks.find((m) => textOf(m).startsWith('['));
  if (bracket) {
    const closeBracket = marks.find((m) => m.from > bracket.to && textOf(m) === ']');
    labelFrom = bracket.to;
    labelTo = closeBracket ? closeBracket.from : node.to;
  } else if (urlNode) {
    labelFrom = urlNode.from;
    labelTo = urlNode.to;
  }
  if (labelTo > labelFrom) {
    parts.push(
      Decoration.mark({ class: 'md-link', attributes: { 'data-lp-href': href } }).range(labelFrom, labelTo)
    );
  }
}

// 图片 ![替代](来源)：整节点替换为 <img> 部件
function decorateImage(state: EditorState, node: SyntaxNode, docPath: string, parts: Range<Decoration>[]) {
  const kids = childrenOf(node);
  const textOf = (c: SyntaxNode) => state.sliceDoc(c.from, c.to);
  const urlNode = kids.find((c) => c.name === 'URL');
  const src = urlNode ? textOf(urlNode) : '';
  let alt = '';
  const open = kids.find((c) => c.name === 'LinkMark' && textOf(c).startsWith('!'));
  const close = kids.find((c) => c.name === 'LinkMark' && textOf(c) === ']');
  if (open && close && close.from > open.to) alt = state.sliceDoc(open.to, close.from);
  parts.push(Decoration.replace({ widget: new ImgWidget(resolveAsset(docPath, src), alt) }).range(node.from, node.to));
}

// 主构建：遍历可见范围内的语法树，产出行级 / 内联 / 部件装饰
function buildInlineDecorations(view: EditorView): DecorationSet {
  const state = view.state;
  const doc = state.doc;
  const active = activeLineSet(state); // 仅用于空行压缩与表格源码揭示（见下）
  const docPath = state.facet(lpDocPath);
  const parts: Range<Decoration>[] = [];
  // 围栏代码区间：空行压缩（cm-lp-blank）不得进入代码块内部
  const codeIntervals: { from: number; to: number }[] = [];
  const hide = (from: number, to: number) => {
    if (to > from) parts.push(Decoration.replace({}).range(from, to));
  };

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: vFrom,
      to: vTo,
      enter: (ref) => {
        const node = ref.node;
        const n = node.name;
        if (n === 'Table') return false; // 整表由 StateField 的块级替换接管
        if (n === 'FencedCode') {
          codeIntervals.push({ from: node.from, to: node.to });
          decorateFence(state, node, parts, vFrom, vTo);
          return false;
        }
        if (n === 'ATXHeading1' || n === 'ATXHeading2' || n === 'ATXHeading3' ||
            n === 'ATXHeading4' || n === 'ATXHeading5' || n === 'ATXHeading6') {
          decorateHeading(state, node, parts);
          return; // 标题内还可有内联标记，继续下探
        }
        if (n === 'Blockquote') {
          decorateQuoteLines(state, node, parts, vFrom, vTo);
          return; // 继续下探处理 QuoteMark 与内联标记
        }
        if (n === 'QuoteMark') {
          hide(node.from, node.to);
          return;
        }
        if (n === 'HorizontalRule') {
          if (node.to > node.from) {
            parts.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
          }
          return false;
        }
        if (n === 'Emphasis' || n === 'StrongEmphasis') {
          decoratePairedMarks(node, 'EmphasisMark', n === 'Emphasis' ? 'cm-lp-em' : 'cm-lp-strong', parts);
          return false;
        }
        if (n === 'Strikethrough') {
          decoratePairedMarks(node, 'StrikethroughMark', 'cm-lp-strike', parts);
          return false;
        }
        if (n === 'InlineCode') {
          decoratePairedMarks(node, 'CodeMark', 'cm-lp-code-inline', parts);
          return false;
        }
        if (n === 'Link' || n === 'Autolink') {
          decorateLink(state, node, parts);
          return false;
        }
        if (n === 'Image') {
          decorateImage(state, node, docPath, parts);
          return false;
        }
        if (n === 'ListMark') {
          // 无序列表符号替换为圆点部件；有序列表保留编号
          const parent = node.parent;
          const inBullet = parent?.parent?.name === 'BulletList';
          if (inBullet) {
            let to = node.to;
            if (to < doc.length && state.sliceDoc(to, to + 1) === ' ') to++;
            parts.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, to));
          }
          return;
        }
        if (n === 'TaskMarker') {
          const checked = /\[x\]/i.test(state.sliceDoc(node.from, node.to));
          let to = node.to;
          if (to < doc.length && state.sliceDoc(to, to + 1) === ' ') to++;
          parts.push(
            Decoration.replace({
              widget: new TaskWidget(checked, node.from, node.to, !state.facet(lpReadOnly)),
            }).range(node.from, to)
          );
          return;
        }
        return; // 其余节点继续下探
      },
    });
  }
  // 空行（段落分隔）表现为与阅读页段间距等高的间隙而非整行空白：
  // 行高 = --rd-para（见 .cm-lp-blank），使实时预览段落节奏与阅读视图一致；
  // 光标所在的空行（活动行）保持原行高，便于编辑定位
  const inCode = (pos: number) => codeIntervals.some((iv) => pos >= iv.from && pos <= iv.to);
  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    const l1 = doc.lineAt(vFrom).number;
    const l2 = doc.lineAt(Math.min(vTo, doc.length)).number;
    for (let ln = l1; ln <= l2; ln++) {
      const line = doc.line(ln);
      if (line.text === '' && !active.has(ln) && !inCode(line.from)) {
        parts.push(Decoration.line({ class: 'cm-lp-blank' }).range(line.from));
      }
    }
  }
  // 划线笔记标记：正文中出现做过的笔记的原文 → 加下划线 + data-note-href（点击跳笔记锚点）
  const marks = state.facet(lpNoteMarks);
  if (marks.length) {
    for (const { from: vFrom, to: vTo } of view.visibleRanges) {
      const slice = doc.sliceString(vFrom, vTo);
      for (const mk of marks) {
        const q = mk.quote.split('\n')[0].slice(0, 80); // 用首行前 80 字定位
        if (q.length < 2) continue;
        let idx = slice.indexOf(q);
        while (idx >= 0) {
          const at = vFrom + idx;
          parts.push(
            Decoration.mark({
              class: 'cm-note-mark',
              attributes: { 'data-note-href': mk.href, title: '此处有笔记，点击查看' },
            }).range(at, at + q.length)
          );
          idx = slice.indexOf(q, idx + q.length);
        }
      }
    }
  }
  return Decoration.set(parts, true);
}

// 表格块级替换（StateField，全文档扫描，量级为块数而非字符数）
function buildTableDecorations(state: EditorState): DecorationSet {
  const ro = state.facet(lpReadOnly);
  const openDocLink = state.facet(lpOpenDocLink);
  // 内链（来自 autoLinks 的 alField；未加载到时为空数组）
  const onCandidates = state.facet(lpOnCandidates);
  const docLinks = (state.field(alField, false)?.links ?? []).filter((l) => !l.ignored && (l.target?.path || l.candidates?.length));
  const endpoints = selectionEndpoints(state);
  const parts: Range<Decoration>[] = [];
  const scan = (node: SyntaxNode) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.name === 'Table') {
        const isActive = !ro && endpoints.some((p) => p >= c.from && p <= c.to);
        if (!isActive) {
          const fromL = state.doc.lineAt(c.from);
          const toL = state.doc.lineAt(c.to);
          const model = parseTable(state.sliceDoc(fromL.from, toL.to));
          if (model) {
            const inTable = docLinks.filter((l) => l.from >= fromL.from && l.to <= toL.to)
              .map((l) => ({ from: l.from, to: l.to, target: l.target ? l.target as { path: string; heading?: string | null } : null, term: l.term, candidates: l.candidates || null }));
            parts.push(
              Decoration.replace({ widget: new TableWidget(fromL.from, toL.to, model, ro, inTable, openDocLink, onCandidates), block: true }).range(fromL.from, toL.to)
            );
          }
        }
      } else if (BLOCK_CONTAINERS.has(c.name)) {
        scan(c);
      }
    }
  };
  scan(syntaxTree(state).topNode);
  return Decoration.set(parts, true);
}

const lpTableField = StateField.define<DecorationSet>({
  create(state) {
    return buildTableDecorations(state);
  },
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(lpTreeRefresh)) ||
        syntaxTree(tr.state) !== syntaxTree(tr.startState) ||
        tr.state.field(alField, false) !== tr.startState.field(alField, false)) {
      return buildTableDecorations(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// 视图插件：可见范围装饰 + Cmd/Ctrl+点击链接
function makeLpPlugin(openLink: (href: string) => void, openNote: (href: string) => void) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private refreshSchedule: (() => void) | undefined;

      constructor(view: EditorView) {
        this.decorations = buildInlineDecorations(view);
        this.refreshSchedule = () => view.dispatch({ effects: lpTreeRefresh.of(null) });
      }

      destroy() {
        this.refreshSchedule = undefined;
      }

      update(u: ViewUpdate) {
        const treeChanged = syntaxTree(u.view.state) !== syntaxTree(u.startState);
        if (u.docChanged || u.selectionSet || u.viewportChanged || treeChanged) {
          this.decorations = buildInlineDecorations(u.view);
        }
        if (treeChanged && !u.docChanged) {
          // 语法树补全不产生事务：安排微任务空效果，让表格 StateField 重算
          if (this.refreshSchedule) Promise.resolve().then(this.refreshSchedule);
        }
      }
    },
    {
      decorations: (v: { decorations: DecorationSet }) => v.decorations,
      eventHandlers: {
        mousedown(event: MouseEvent, view: EditorView) {
          const target = event.target as HTMLElement | null;
          // 划线笔记标记：只读实例单击即开（不受 Cmd 约束）
          const noteEl = target?.closest('[data-note-href]');
          if (noteEl) {
            event.preventDefault();
            openNote(noteEl.getAttribute('data-note-href') || '');
            return true;
          }
          const ro = view.state.facet(lpReadOnly);
          if (!(ro || event.metaKey || event.ctrlKey)) return false;
          const el = target?.closest('[data-lp-href]');
          if (!el) return false;
          event.preventDefault();
          openLink(el.getAttribute('data-lp-href') || '');
          return true;
        },
      },
    }
  );
}

// 编辑器主题：全部走应用 CSS 变量，A/B/C 三主题（含 C 深色）与阅读偏好即时生效。
// 正文列宽：编辑页无卡片，100%-68px 复刻阅读页页边留白（减 28px 行内 padding 后与
// 阅读页文字列对齐）；只读实例渲染在卡片/面板内，容器本身就是排版列，不再减。
function makeLpTheme(card: boolean) {
  return EditorView.theme({
    ...editorBaseThemeSpec,
    ...(card
      ? {
          '&': { backgroundColor: 'transparent', height: 'auto' },
          '.cm-scroller': { ...editorBaseThemeSpec['.cm-scroller'], overflow: 'visible' },
          // 卡片内无行内槽：文字列 = min(--rd-width, 容器宽)，与旧 .reader 同语义
          '.cm-line': { padding: '0' },
          '.cm-content': { paddingBottom: '12vh' },
        }
      : {}),

  // 正文列与阅读页同版式：同一套 --rd-* 变量、
  // 同一上限（--rd-width）并居中；calc(100% - 96px) 对应阅读页容器的水平留白
  // （max-w-5xl 容器 px-4 共 32px + 正文卡片 p-8 共 64px），窄窗口下两列同宽收缩
  '.cm-content': {
    maxWidth: card
      ? 'min(var(--rd-width), 100%)'
      : 'min(calc(var(--rd-width) + 28px), calc(100% - 68px))',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  // 空行间隙 = 阅读页段间距 --rd-para（设下限避免段间距为 0 时空行无法点入）
  '.cm-lp-blank': { lineHeight: 'max(var(--rd-para), 0.6)' },

  '.cm-lp-h1': { fontSize: '1.7em', fontWeight: '700', lineHeight: '1.35', paddingTop: '0.75em' },
  '.cm-lp-h2': { fontSize: '1.4em', fontWeight: '700', lineHeight: '1.4', paddingTop: '0.65em', paddingBottom: '0.25em', borderBottom: '1px solid hsl(var(--border))' },
  '.cm-lp-h3': { fontSize: '1.2em', fontWeight: '600', paddingTop: '0.5em' },
  '.cm-lp-h4': { fontSize: '1.08em', fontWeight: '600', paddingTop: '0.4em' },
  '.cm-lp-h5, .cm-lp-h6': { fontSize: '1em', fontWeight: '600', paddingTop: '0.35em' },

  '.cm-lp-quote': {
    borderLeft: '3px solid hsl(var(--primary) / 0.5)',
    padding: '0.15em 1em',
    color: 'hsl(var(--muted-foreground))',
    background: 'hsl(var(--muted) / 0.5)',
    borderRadius: '0 6px 6px 0',
  },

  // 代码块恒深色（同旧阅读页 pre）：token 色由 mdLanguage 的高亮样式提供
  '.cm-lp-code': {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--rd-code-size)',
    background: 'hsl(30 8% 16%)',
    color: 'hsl(40 20% 90%)',
    lineHeight: '1.6',
    padding: '0 1.1em',
  },
  '.cm-lp-code-first': { borderRadius: '8px 8px 0 0', marginTop: '0.6em', paddingTop: '0.9em' },
  '.cm-lp-code-last': { borderRadius: '0 0 8px 8px', marginBottom: '0.6em', paddingBottom: '0.9em' },
  '.cm-lp-fence': { display: 'inline-block', color: 'hsl(40 20% 90% / 0.55)', fontSize: '11px', lineHeight: '1.4', letterSpacing: '0.05em' },
  '.cm-lp-fence-lang': { display: 'inline-block', padding: '0 6px', borderLeft: '2px solid hsl(40 20% 90% / 0.25)' },

  '.cm-note-mark': { textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: '3px', textDecorationColor: 'hsl(38 92% 50% / 0.8)', cursor: 'pointer' },
  '.cm-lp-em': { fontStyle: 'italic' },
  '.cm-lp-strong': { fontWeight: '700' },
  '.cm-lp-strike': { textDecoration: 'line-through', opacity: '0.7' },
  '.cm-lp-code-inline': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.88em',
    background: 'hsl(var(--muted))',
    borderRadius: '4px',
    padding: '0.1em 0.35em',
  },
  '.cm-lp-bullet': { color: 'hsl(var(--primary))', fontWeight: '600', display: 'inline-block', minWidth: '0.9em' },
  '.cm-lp-task': { accentColor: 'hsl(var(--primary))', margin: '0 0.4em 0 0', pointerEvents: 'none', verticalAlign: 'middle' },
  '.cm-lp-img': { maxWidth: '100%', verticalAlign: 'middle', borderRadius: '6px' },
  '.cm-lp-hr-w': { display: 'inline-block', width: '100%', height: 0, borderTop: '1px solid hsl(var(--border))', margin: '1.2em 0', verticalAlign: 'middle' },

  // 表格部件：自身携带横向滚动（窄列内长表格不把整个编辑器撑宽），
  // 单元格内折行规则与阅读页一致（break-word 而非继承的 break-spaces）；
  // 可编辑部件另有悬浮工具条/表头操作/行尾删行（样式见下）
  '.cm-lp-table': {
    display: 'block',
    margin: '0.4em 0',
    maxWidth: '100%',
    overflowX: 'auto',
    whiteSpace: 'normal',
    wordBreak: 'normal',
    overflowWrap: 'break-word',
  },
  '.cm-lp-table table': { borderCollapse: 'collapse', fontSize: '0.92em', lineHeight: '1.5' },
  '.cm-lp-table th, .cm-lp-table td': { border: '1px solid hsl(var(--border))', padding: '0.4em 0.8em', textAlign: 'left' },
  '.cm-lp-table th': { background: 'hsl(var(--muted))', fontWeight: '600', position: 'relative' },

  // ---- 可编辑表格 ----
  '.cm-lp-table.wb-tbl-edit td': { cursor: 'text' },
  '.wb-tbl-bar': { display: 'flex', gap: '4px', opacity: '0', transition: 'opacity 0.12s', marginBottom: '2px' },
  '.cm-lp-table:hover .wb-tbl-bar': { opacity: '1' },
  '.wb-tbl-btn': {
    fontSize: '11px',
    lineHeight: '1',
    padding: '3px 8px',
    borderRadius: '5px',
    border: '1px solid hsl(var(--border))',
    background: 'hsl(var(--card))',
    color: 'hsl(var(--muted-foreground))',
    cursor: 'pointer',
  },
  '.wb-tbl-btn:hover': { background: 'hsl(var(--accent))', color: 'hsl(var(--accent-foreground))' },
  '.wb-th-ops': { position: 'absolute', top: '2px', right: '3px', display: 'inline-flex', gap: '2px', opacity: '0' },
  '.cm-lp-table th:hover .wb-th-ops': { opacity: '1' },
  '.wb-th-op': {
    width: '16px',
    height: '16px',
    lineHeight: '14px',
    padding: '0',
    borderRadius: '4px',
    border: 'none',
    background: 'hsl(var(--card))',
    color: 'hsl(var(--muted-foreground))',
    fontSize: '11px',
    cursor: 'pointer',
  },
  '.wb-th-op:hover': { background: 'hsl(var(--accent))', color: 'hsl(var(--accent-foreground))' },
  '.wb-th-del:hover': { background: 'hsl(var(--destructive) / 0.15)', color: 'hsl(var(--destructive))' },
  '.wb-tb-rop': {
    borderLeft: 'none',
    borderRight: 'none',
    padding: '0 2px',
    width: '1%',
    whiteSpace: 'nowrap',
  },
  '.wb-rop-btn': {
    width: '16px',
    height: '16px',
    lineHeight: '14px',
    padding: '0',
    borderRadius: '4px',
    border: 'none',
    background: 'transparent',
    color: 'hsl(var(--destructive))',
    fontSize: '11px',
    cursor: 'pointer',
    visibility: 'hidden',
  },
  '.cm-lp-table tr:hover .wb-rop-btn': { visibility: 'visible' },
  '.wb-rop-btn:hover': { background: 'hsl(var(--destructive) / 0.15)' },
  '.wb-tc-editing': { outline: '2px solid hsl(var(--primary) / 0.55)', outlineOffset: '-2px' },
  '.wb-tc-input': {
    width: '100%',
    font: 'inherit',
    color: 'inherit',
    background: 'transparent',
    border: 'none',
    outline: 'none',
    padding: '0',
    margin: '0',
  },
  });
}

// 实时预览扩展入口
export function livePreview(opts: LivePreviewOptions) {
  return [
    ...mdLang(),
    lpDocPath.of(opts.docPath),
    lpReadOnly.of(!!opts.readOnly),
    lpNoteMarks.of(opts.noteMarks ?? []),
    lpOpenDocLink.of(opts.openDocLink ?? null),
    lpOnCandidates.of(opts.onCandidates ?? null),
    lpTableField,
    makeLpPlugin(opts.openLink, opts.openNote ?? (() => {})),
    makeLpTheme(opts.geometry === 'card'),
  ];
}
