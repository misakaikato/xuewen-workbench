// 只读实例复制为正文：拦截 copy/cut，把选中源文经 unified 管线渲染成
// text/html + text/plain 双 flavor——富文本目标（Word/IM/编辑器）保留
// 粗体/链接/表格，纯文本目标得到无语法符号的正文。
// 编辑实例不挂本扩展：编辑器里复制源码是本色。
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeStringify);

// 选区源文（空选区返回空串，交回默认行为：CM 会复制当前行源码）
function selectionSource(view: EditorView): string {
  const sel = view.state.selection;
  if (sel.ranges.length === 1 && sel.main.empty) return '';
  return sel.ranges.map((r) => view.state.sliceDoc(r.from, r.to)).join('\n');
}

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE',
  'PRE', 'UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TR', 'HR', 'FIGURE',
]);

// 渲染后的 HTML → 纯文本：块级元素换行、表格行内制表符分隔、<br> 换行
function domToText(node: Node): string {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent || '';
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (el.tagName === 'BR') {
        out += '\n';
      } else if (el.tagName === 'TD' || el.tagName === 'TH') {
        out += domToText(el) + '\t';
      } else if (BLOCK_TAGS.has(el.tagName)) {
        out += '\n' + domToText(el) + '\n';
      } else {
        out += domToText(el);
      }
    }
  }
  return out;
}

function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function writeRendered(event: ClipboardEvent, view: EditorView): boolean {
  const src = selectionSource(view);
  if (!src || !event.clipboardData) return false;
  let html: string;
  try {
    html = String(processor.processSync(src));
  } catch {
    return false; // 解析异常（极端片段）回退 CM 默认复制
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const text = normalizeText(domToText(doc.body));
  event.preventDefault();
  event.clipboardData.setData('text/html', html);
  event.clipboardData.setData('text/plain', text);
  return true;
}

export function copyAsRendered(): Extension {
  return EditorView.domEventHandlers({
    copy: (event, view) => writeRendered(event, view),
    cut: (event, view) => writeRendered(event, view),
  });
}
