// 实时预览扩展（Typora / Obsidian 式）：光标所在“活动块”显示 Markdown 源码，
// 其余行按 Markdown 渲染。所有装饰只影响显示，绝不改动文档字节。
// 重算时机：文档 / 选区 / 视口 / 语法树变化；内联装饰只为可见范围构建，长文档保持轻快。
// 表格的整块替换装饰来自 StateField（块级替换装饰要求如此），点击表格进入源码编辑。
import { syntaxTree } from '@codemirror/language';
import { Facet, StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Range } from '@codemirror/state';
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
  /** 只读实例（阅读视图）：选区不再揭示源码、表格恒渲染、链接单击即开 */
  readOnly?: boolean;
}

// 文档路径以 facet 提供，构建装饰时读取
const lpDocPath = Facet.define<string, string>({ combine: (v) => (v.length ? v[v.length - 1] : '') });
const lpReadOnly = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) });

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
  const ds = getApiScope(); // 编辑器实时预览的图片也要落在当前资料库
  if (ds) url += '&ds=' + encodeURIComponent(ds);
  return url;
}

// ---------- 活动块（显示源码的部分） ----------

// 只有这些块级容器需要下探寻找围栏代码块 / 表格
const BLOCK_CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem']);

function selectionEndpoints(state: EditorState): number[] {
  const out: number[] = [];
  for (const r of state.selection.ranges) out.push(r.from, r.to);
  return out;
}

// 活动行集合：选区覆盖的行；光标在围栏代码块或表格内时扩展为整块。
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
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
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

class TaskWidget extends WidgetType {
  private checked: boolean;

  constructor(checked: boolean) {
    super();
    this.checked = checked;
  }

  eq(other: TaskWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.className = 'cm-lp-task';
    el.checked = this.checked;
    el.disabled = true; // 只读展示，修改请编辑源码
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

// 表格整块渲染：点击后光标进入表格，显示源码
class TableWidget extends WidgetType {
  private pos: number;
  private model: TableModel;
  private readOnly: boolean;

  constructor(pos: number, model: TableModel, readOnly: boolean) {
    super();
    this.pos = pos;
    this.model = model;
    this.readOnly = readOnly;
  }

  eq(other: TableWidget): boolean {
    return other.pos === this.pos && other.readOnly === this.readOnly && JSON.stringify(other.model) === JSON.stringify(this.model);
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-lp-table';
    wrap.title = '点击编辑表格源码';
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    this.model.header.forEach((cell, i) => {
      const th = document.createElement('th');
      th.appendChild(buildCell(cell));
      if (this.model.align[i]) th.style.textAlign = this.model.align[i] as string;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const row of this.model.rows) {
      const tr = document.createElement('tr');
      for (let i = 0; i < this.model.header.length; i++) {
        const td = document.createElement('td');
        td.appendChild(buildCell(row[i] ?? ''));
        if (this.model.align[i]) td.style.textAlign = this.model.align[i] as string;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    if (!this.readOnly) {
      wrap.addEventListener('mousedown', (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: this.pos }, scrollIntoView: true });
      });
    }
    return wrap;
  }
}

// ---------- 装饰构建 ----------

const childrenOf = (node: SyntaxNode): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
};

// ATX 标题：行级样式 + 隐藏 # 记号与其后空格
function decorateHeading(state: EditorState, node: SyntaxNode, active: Set<number>, parts: Range<Decoration>[]) {
  const line = state.doc.lineAt(node.from);
  if (active.has(line.number)) return;
  const m = node.name.match(/^ATXHeading(\d)$/);
  if (!m) return;
  parts.push(Decoration.line({ class: 'cm-lp-h' + m[1] }).range(line.from));
  const mark = childrenOf(node).find((c) => c.name === 'HeaderMark');
  if (!mark) return;
  let to = mark.to;
  if (to < line.to && state.sliceDoc(to, to + 1) === ' ') to++;
  if (to > node.from) parts.push(Decoration.replace({}).range(node.from, to));
}

// 围栏代码：行级样式 + 围栏行内容隐藏（开栏行显示语言细条）
function decorateFence(
  state: EditorState, node: SyntaxNode, active: Set<number>,
  parts: Range<Decoration>[], vFrom: number, vTo: number
) {
  const doc = state.doc;
  const l1 = doc.lineAt(node.from).number;
  const l2 = doc.lineAt(node.to).number;
  for (let ln = l1; ln <= l2; ln++) {
    const line = doc.line(ln);
    if (line.from < vFrom || line.from > vTo || active.has(ln)) continue;
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
  state: EditorState, node: SyntaxNode, active: Set<number>,
  parts: Range<Decoration>[], vFrom: number, vTo: number
) {
  const doc = state.doc;
  const l1 = doc.lineAt(node.from).number;
  const l2 = doc.lineAt(node.to).number;
  for (let ln = l1; ln <= l2; ln++) {
    const line = doc.line(ln);
    if (line.from < vFrom || line.from > vTo || active.has(ln)) continue;
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
  const active = activeLineSet(state);
  const docPath = state.facet(lpDocPath);
  const parts: Range<Decoration>[] = [];
  // 围栏代码区间：空行压缩（cm-lp-blank）不得进入代码块内部
  const codeIntervals: { from: number; to: number }[] = [];
  const hide = (from: number, to: number) => {
    if (to > from) parts.push(Decoration.replace({}).range(from, to));
  };
  const lineActive = (pos: number) => active.has(doc.lineAt(pos).number);

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
          decorateFence(state, node, active, parts, vFrom, vTo);
          return false;
        }
        if (n === 'ATXHeading1' || n === 'ATXHeading2' || n === 'ATXHeading3' ||
            n === 'ATXHeading4' || n === 'ATXHeading5' || n === 'ATXHeading6') {
          decorateHeading(state, node, active, parts);
          return; // 标题内还可有内联标记，继续下探
        }
        if (n === 'Blockquote') {
          decorateQuoteLines(state, node, active, parts, vFrom, vTo);
          return; // 继续下探处理 QuoteMark 与内联标记
        }
        if (n === 'QuoteMark') {
          if (!lineActive(node.from)) hide(node.from, node.to);
          return;
        }
        if (n === 'HorizontalRule') {
          if (!lineActive(node.from) && node.to > node.from) {
            parts.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
          }
          return false;
        }
        if (n === 'Emphasis' || n === 'StrongEmphasis') {
          if (!lineActive(node.from)) decoratePairedMarks(node, 'EmphasisMark', n === 'Emphasis' ? 'cm-lp-em' : 'cm-lp-strong', parts);
          return false;
        }
        if (n === 'Strikethrough') {
          if (!lineActive(node.from)) decoratePairedMarks(node, 'StrikethroughMark', 'cm-lp-strike', parts);
          return false;
        }
        if (n === 'InlineCode') {
          if (!lineActive(node.from)) decoratePairedMarks(node, 'CodeMark', 'cm-lp-code-inline', parts);
          return false;
        }
        if (n === 'Link' || n === 'Autolink') {
          if (!lineActive(node.from)) decorateLink(state, node, parts);
          return false;
        }
        if (n === 'Image') {
          if (!lineActive(node.from)) decorateImage(state, node, docPath, parts);
          return false;
        }
        if (n === 'ListMark') {
          // 无序列表符号替换为圆点部件；有序列表保留编号
          const parent = node.parent;
          const inBullet = parent?.parent?.name === 'BulletList';
          if (inBullet && !lineActive(node.from)) {
            let to = node.to;
            if (to < doc.length && state.sliceDoc(to, to + 1) === ' ') to++;
            parts.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, to));
          }
          return;
        }
        if (n === 'TaskMarker') {
          if (!lineActive(node.from)) {
            const text = state.sliceDoc(node.from, node.to);
            const checked = /\[x\]/i.test(text);
            let to = node.to;
            if (to < doc.length && state.sliceDoc(to, to + 1) === ' ') to++;
            parts.push(Decoration.replace({ widget: new TaskWidget(checked) }).range(node.from, to));
          }
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
  return Decoration.set(parts, true);
}

// 表格块级替换（StateField，全文档扫描，量级为块数而非字符数）
function buildTableDecorations(state: EditorState): DecorationSet {
  const ro = state.facet(lpReadOnly);
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
            parts.push(
              Decoration.replace({ widget: new TableWidget(fromL.from, model, ro), block: true }).range(fromL.from, toL.to)
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
        syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildTableDecorations(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// 视图插件：可见范围装饰 + Cmd/Ctrl+点击链接
function makeLpPlugin(openLink: (href: string) => void) {
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
          const ro = view.state.facet(lpReadOnly);
          if (!(ro || event.metaKey || event.ctrlKey)) return false;
          const el = (event.target as HTMLElement | null)?.closest('[data-lp-href]');
          if (!el) return false;
          event.preventDefault();
          openLink(el.getAttribute('data-lp-href') || '');
          return true;
        },
      },
    }
  );
}

// 编辑器主题：全部走应用 CSS 变量，A/B/C 三主题（含 C 深色）与阅读偏好即时生效
const lpTheme = EditorView.theme({
  ...editorBaseThemeSpec,

  // 正文列与阅读页同版式：同一套 --rd-* 变量、
  // 同一上限（--rd-width）并居中；calc(100% - 96px) 对应阅读页容器的水平留白
  // （max-w-5xl 容器 px-4 共 32px + 正文卡片 p-8 共 64px），窄窗口下两列同宽收缩
  // 正文列与阅读页同版式：同一套 --rd-* 变量、同一上限并居中。
  // 阅读页文字列 = min(--rd-width, 卡片内宽)（卡片在 max-w-5xl 容器内，页边留白共 96px）；
  // 这里 .cm-content 上限取 min(rd-width + 28px, 100% - 68px)，减去 .cm-line 左右 14px
  // padding 后文字列与阅读页逐像素对齐（窄窗口下两列同宽收缩）
  '.cm-content': {
    caretColor: 'hsl(var(--foreground))',
    paddingBottom: '20vh',
    maxWidth: 'min(calc(var(--rd-width) + 28px), calc(100% - 68px))',
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
  // 单元格内折行规则与阅读页一致（break-word 而非继承的 break-spaces）
  '.cm-lp-table': {
    display: 'block',
    margin: '0.4em 0',
    cursor: 'pointer',
    maxWidth: '100%',
    overflowX: 'auto',
    whiteSpace: 'normal',
    wordBreak: 'normal',
    overflowWrap: 'break-word',
  },
  '.cm-lp-table table': { borderCollapse: 'collapse', fontSize: '0.92em', lineHeight: '1.5' },
  '.cm-lp-table th, .cm-lp-table td': { border: '1px solid hsl(var(--border))', padding: '0.4em 0.8em', textAlign: 'left' },
  '.cm-lp-table th': { background: 'hsl(var(--muted))', fontWeight: '600' },
});

// 实时预览扩展入口
export function livePreview(opts: LivePreviewOptions) {
  return [
    ...mdLang(),
    lpDocPath.of(opts.docPath),
    lpReadOnly.of(!!opts.readOnly),
    lpTableField,
    makeLpPlugin(opts.openLink),
    lpTheme,
  ];
}
