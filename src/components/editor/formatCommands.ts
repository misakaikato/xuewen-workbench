// 格式工具栏命令层：所有操作都走 CodeMirror 事务改文档（字节精确体系不受影响）。
// 切换逻辑基于语法树（在粗体里再点 B = 取消粗体，而不是叠加星号）。
import { syntaxTree } from '@codemirror/language';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

// ---------- 行内成对标记（粗体/斜体/删除线/行内代码） ----------

const INLINE_KIND = {
  bold: { node: 'StrongEmphasis', mark: 'EmphasisMark', wrap: '**' },
  italic: { node: 'Emphasis', mark: 'EmphasisMark', wrap: '*' },
  strike: { node: 'Strikethrough', mark: 'StrikethroughMark', wrap: '~~' },
  code: { node: 'InlineCode', mark: 'CodeMark', wrap: '`' },
} as const;

export type InlineKind = keyof typeof INLINE_KIND;

function nodeAround(tree: ReturnType<typeof syntaxTree>, pos: number, name: string): SyntaxNode | null {
  let node: SyntaxNode | null = tree.resolveInner(pos, -1);
  while (node && node.name !== name) node = node.parent ?? null;
  return node;
}

export function toggleInline(view: EditorView, kind: InlineKind): void {
  const { state } = view;
  const def = INLINE_KIND[kind];
  const sel = state.selection.main;
  const node = nodeAround(syntaxTree(state), sel.head, def.node);
  if (node) {
    // 取消：删除该节点内的全部记号（如 ** 与 **）
    const marks: { from: number; to: number }[] = [];
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.name === def.mark && c.to > c.from) marks.push({ from: c.from, to: c.to });
    }
    if (marks.length) {
      view.dispatch({
        changes: marks.reverse(),
        selection: EditorSelection.cursor(node.from),
      });
      return;
    }
  }
  // 添加：空选区插入记号对（光标居中），否则包裹选区
  if (sel.empty) {
    view.dispatch({
      changes: { from: sel.from, insert: def.wrap + def.wrap },
      selection: EditorSelection.cursor(sel.from + def.wrap.length),
    });
  } else {
    view.dispatch({
      changes: [
        { from: sel.from, insert: def.wrap },
        { from: sel.to, insert: def.wrap },
      ],
      selection: EditorSelection.range(sel.from + def.wrap.length, sel.to + def.wrap.length),
    });
  }
}

// ---------- 标题（0 = 正文） ----------

export function setHeading(view: EditorView, level: number): void {
  const { state } = view;
  const sel = state.selection.main;
  const l1 = state.doc.lineAt(sel.from).number;
  const l2 = state.doc.lineAt(sel.to).number;
  const changes: { from: number; to: number; insert: string }[] = [];
  let newAnchor: number | null = null;
  for (let n = l1; n <= l2; n++) {
    const line = state.doc.line(n);
    const m = /^(#{1,6})(\s+)?/.exec(line.text);
    const cur = m ? m[0] : '';
    const want = level > 0 ? '#'.repeat(level) + ' ' : '';
    // 同级再点 = 降为正文
    const next = cur === want ? '' : want;
    if (cur === next) continue;
    changes.push({ from: line.from, to: line.from + cur.length, insert: next });
    if (n === l1) newAnchor = line.from + next.length;
  }
  if (changes.length) {
    view.dispatch({
      changes,
      selection: EditorSelection.cursor(newAnchor ?? sel.from),
    });
  }
}

// ---------- 行前缀（引用 / 列表 / 任务） ----------

export type PrefixKind = 'quote' | 'bullet' | 'ordered' | 'task';

const PREFIX_RE: Record<PrefixKind, RegExp> = {
  quote: /^>\s?/,
  bullet: /^-\s(?!\[)/,
  ordered: /^\d+\.\s/,
  task: /^-\s\[( |x|X)\]\s/,
};

export function toggleLinePrefix(view: EditorView, kind: PrefixKind): void {
  const { state } = view;
  const sel = state.selection.main;
  const l1 = state.doc.lineAt(sel.from).number;
  const l2 = state.doc.lineAt(sel.to).number;
  const changes: { from: number; to: number; insert: string }[] = [];
  let anyOn = false;
  for (let n = l1; n <= l2; n++) {
    const line = state.doc.line(n);
    if (PREFIX_RE[kind].test(line.text)) anyOn = true;
  }
  const add = (kind === 'quote' ? '> ' : kind === 'bullet' ? '- ' : kind === 'ordered' ? '1. ' : '- [ ] ');
  for (let n = l1; n <= l2; n++) {
    const line = state.doc.line(n);
    // 先剥掉任意已知前缀（同类互斥，近似论坛行为），再按目标状态统一加
    let text = line.text;
    let cut = 0;
    let m: RegExpExecArray | null;
    while ((m = /^(>\s?|-\s\[( |x|X)\]\s|-\s(?!\[)|\d+\.\s)/.exec(text))) {
      cut += m[0].length;
      text = text.slice(m[0].length);
    }
    const next = anyOn ? '' : add;
    const insert = next + text;
    if (insert !== line.text) changes.push({ from: line.from, to: line.to, insert });
  }
  if (changes.length) view.dispatch({ changes });
}

// ---------- 块插入（分隔线 / 代码块 / 表格） ----------

export function insertBlock(view: EditorView, block: string, cursorOffset?: number): void {
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.from);
  const lead = line.text.trim() ? '\n\n' : '';
  const insert = lead + block;
  view.dispatch({
    changes: { from: line.to, insert },
    selection: EditorSelection.cursor(line.to + (cursorOffset ?? insert.length)),
  });
}

// ---------- 链接 / 图片 ----------

export interface LinkInfo {
  from: number;
  to: number;
  text: string;
  href: string;
}

export function linkInfoAt(view: EditorView): LinkInfo | null {
  const { state } = view;
  const node = nodeAround(syntaxTree(state), state.selection.main.head, 'Link');
  if (!node) return null;
  const textOf = (from: number, to: number) => state.sliceDoc(from, to);
  let text = '';
  let href = '';
  // 子节点遍历：文字在 '[' 与 ']' 记号之间；目标取 URL 子节点
  let bracketOpen: { from: number; to: number } | null = null;
  let urlNode: { from: number; to: number } | null = null;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'LinkMark') {
      const t = textOf(c.from, c.to);
      if (t.startsWith('[')) bracketOpen = { from: c.from, to: c.to };
      else if (t === ']' && bracketOpen) text = textOf(bracketOpen.to, c.from);
    } else if (c.name === 'URL') {
      urlNode = { from: c.from, to: c.to };
    }
  }
  if (urlNode) href = textOf(urlNode.from, urlNode.to);
  if (!text && !href) return null;
  return { from: node.from, to: node.to, text: text || href, href };
}

// 应用链接：编辑既有节点，或以选区文字为链接文字新建
export function applyLink(view: EditorView, existing: LinkInfo | null, text: string, href: string): void {
  const { state } = view;
  const sel = state.selection.main;
  const md = `[${text}](${href})`;
  if (existing) {
    view.dispatch({
      changes: { from: existing.from, to: existing.to, insert: md },
      selection: EditorSelection.cursor(existing.from + md.length),
    });
  } else {
    const t = sel.empty ? text : state.sliceDoc(sel.from, sel.to) || text;
    const ins = `[${t}](${href})`;
    view.dispatch({
      changes: sel.empty
        ? { from: sel.from, insert: ins }
        : [
            { from: sel.from, insert: '[' },
            { from: sel.to, insert: `](${href})` },
          ],
      selection: EditorSelection.cursor(sel.from + ins.length),
    });
  }
}

export function removeLink(view: EditorView, info: LinkInfo): void {
  view.dispatch({
    changes: { from: info.from, to: info.to, insert: info.text },
    selection: EditorSelection.cursor(info.from + info.text.length),
  });
}

export function insertImage(view: EditorView, alt: string, src: string): void {
  const { state } = view;
  const sel = state.selection.main;
  const ins = `![${alt}](${src})`;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: ins },
    selection: EditorSelection.cursor(sel.from + ins.length),
  });
}

// ---------- 工具栏状态探测（按钮高亮用） ----------

export interface FormatState {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  heading: number; // 0-6
  inLink: boolean;
}

export function formatStateAt(view: EditorView | null): FormatState {
  const st: FormatState = { bold: false, italic: false, strike: false, code: false, heading: 0, inLink: false };
  if (!view) return st;
  const head = view.state.selection.main.head;
  let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(head, -1);
  while (node) {
    switch (node.name) {
      case 'StrongEmphasis': st.bold = true; break;
      case 'Emphasis': st.italic = true; break;
      case 'Strikethrough': st.strike = true; break;
      case 'InlineCode': st.code = true; break;
      case 'Link': st.inLink = true; break;
      default: {
        const m = /^ATXHeading(\d)$/.exec(node.name);
        if (m) st.heading = Number(m[1]);
      }
    }
    node = node.parent ?? null;
  }
  return st;
}
