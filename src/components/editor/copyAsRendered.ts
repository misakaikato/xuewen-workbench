// 只读实例复制为正文：拦截 copy/cut，把选中源文经 unified 管线渲染成
// text/html + text/plain 双 flavor——富文本目标（Word/IM/编辑器）保留
// 粗体/链接/表格，纯文本目标得到无语法符号的正文。
// 编辑实例不挂本扩展：编辑器里复制源码是本色。
// unified 管线按需加载（unified/remark 系体积可观，不值得常驻）：
// 文档挂载后空闲时预热；复制时未就绪则交回 CM 默认行为（复制源文纯文本）。
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

// 最小结构类型：unified 链式泛型随插件变化，这里只声明复制路径用到的 processSync
type MdProcessor = { processSync: (doc: string) => { toString(): string } };

let processorPromise: Promise<MdProcessor> | null = null;
let processor: MdProcessor | null = null;

function loadProcessor(): Promise<MdProcessor> {
  processorPromise ??= Promise.all([
    import('unified'),
    import('remark-parse'),
    import('remark-gfm'),
    import('remark-rehype'),
    import('rehype-stringify'),
  ]).then(([u, parse, gfm, rehype, stringify]) => {
    const p: MdProcessor = u
      .unified()
      .use(parse.default)
      .use(gfm.default)
      .use(rehype.default)
      .use(stringify.default);
    processor = p;
    return p;
  }).catch((e) => {
    // 动态 import 失败（如 chunk 未取到）：置回 null 允许下次重试，并吞掉 rejection——
    // 复制会退回纯文本，行为不变
    processorPromise = null;
    throw e;
  });
  return processorPromise;
}

// 挂载后空闲预热（requestIdleCallback 不可用时退 1.5s 定时）
export function scheduleCopyRenderWarmup(): void {
  if (processorPromise) return;
  const start = () => { loadProcessor().catch(() => {}); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 3000 });
  else setTimeout(start, 1500);
}

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
  // 管线未就绪时不拦截：CM 默认复制源文，即纯文本
  if (!src || !processor || !event.clipboardData) return false;
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
