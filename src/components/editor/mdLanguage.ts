// 共用 markdown 语言配置与代码高亮：live / source / 只读实例同一份。
// 代码 token 色取 github-dark 调色板（与旧阅读页 rehype-highlight 观感一致），
// 代码块底色由 lpTheme 的 cm-lp-code 提供（恒深色，见 livePreview.ts）。
// languages 的语法解析器全部按需动态加载，首屏包不增大。
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';

const githubDark = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: '#ff7b72' },
  { tag: [t.string, t.special(t.string)], color: '#a5d6ff' },
  { tag: [t.lineComment, t.blockComment], color: '#8b949e', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#79c0ff' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: '#d2a8ff' },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: '#ffa657' },
  { tag: t.tagName, color: '#7ee787' },
  { tag: [t.attributeName, t.attributeValue], color: '#79c0ff' },
  { tag: t.meta, color: '#79c0ff' },
]);

/** markdown 语言 + 围栏代码语法高亮（多语言，懒加载） */
export function mdLang(): Extension[] {
  return [markdown({ base: markdownLanguage, codeLanguages: languages }), syntaxHighlighting(githubDark)];
}
