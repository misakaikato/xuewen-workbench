// 编辑器通用扩展与主题基座：行号 / 撤销 / 补全 / 检索等基础能力，
// 以及走应用 CSS 变量的基础主题（A/B/C 三主题与阅读偏好即时生效）。
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import {
  crosshairCursor, drawSelection, dropCursor, highlightActiveLine,
  highlightActiveLineGutter, highlightSpecialChars,
  keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';

// 与 CodeMirror 默认特殊字符集一致，但排除 \r：显式行分隔符下孤立 \r 是行内普通字符，
// 不能画成占位符，否则视觉上像凭空多了一个字符
// eslint-disable-next-line no-control-regex
const SPECIALS_NO_CR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u2028\u2029\u202d\u202e\u2066\u2067\u2069\ufeff\ufff9-\ufffc]/gu;

// 基础主题（编辑器底色 / 字体走阅读偏好变量），实时预览主题在此之上叠加
export const editorBaseThemeSpec = {
  '&': { color: 'hsl(var(--foreground))', backgroundColor: 'hsl(var(--background))' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--rd-font)', fontSize: 'var(--rd-size)', lineHeight: 'var(--rd-line)' },
  '.cm-line': { padding: '0 14px' },
  '.cm-content': { caretColor: 'hsl(var(--foreground))', paddingBottom: '20vh' },
};

export function editorBaseExtensions(opts: { lineNumbers: boolean; foldGutter: boolean }): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    highlightSpecialChars({ specialChars: SPECIALS_NO_CR }),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    ...(opts.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
    ...(opts.foldGutter ? [foldGutter()] : []),
  ];
}
