# 规格：统一 Markdown 渲染为单一 CodeMirror 引擎（方案 B）

## 背景与目标

阅读视图（`MarkdownReader`，react-markdown）与编辑实时预览（`livePreview`，CodeMirror 装饰）是两套实现，靠人工"同口径"约定对齐，实际存在列宽/代码块/链接/间距多处跳变。本规格采用**方案 B：全 CodeMirror 单引擎**——阅读页与编辑预览面板改为渲染**只读 CodeMirror 实例**，挂与编辑器同一套 `livePreview` 扩展栈。从此只有一个 Markdown 呈现者，格式漂移在构造上不可能。

成功标准：

- 阅读页（markdown 类型）与编辑 live / split / preview 模式的正文观感完全一致（同一渲染器）。
- 阅读 ↔ 编辑切换延续滚动位置（比例近似，视口落在同一块级元素附近）。
- 编辑时：live 模式有代码语法高亮与语料引用 chip；split 左右滚动同步。
- 只读实例上复制得到**正文**（富文本 + 纯文本双 flavor），而非 markdown 源码；编辑实例复制行为不变（源码）。
- `react-markdown` / `rehype-highlight` 依赖及 remark 插件链最终删除。

## 非目标

- 不改保存 / 草稿 / 冲突 / 字节精确逻辑与 server API；装饰绝不改动文档字节。
- 不引入 WYSIWYG 框架；不换 CodeMirror 内核。
- 已知并接受的阅读端行为变化：软换行不折叠（源码行 = 显示行）；表格单元格暂只渲染行内格式的常用子集（G5 本期做掉）；无真 h1/a 语义标签。
- 不动 WordReader / JsonViewer / 搜索页 / BacklinksPanel。

## 假设

1. 选中片段复制渲染用 unified 管线（remark-parse + remark-gfm + remark-rehype + rehype-stringify），`unified`/`remark-parse`/`remark-rehype` 已在依赖树（react-markdown 传递依赖），`rehype-stringify` 新增直接依赖。
2. 阅读页滚动仍由页面外层容器（`scrollRef`）承担，CM 自动高度（height auto + scroller overflow visible），全文渲染（与 react-markdown 代价同级）。
3. 阅读页文内查找沿用现有自绘查找条（不走 CM search panel），用 `SearchCursor` 实现；TOC / 锚点 / 高亮滚动统一走 `coordsAtPos` + 外层容器滚动。
4. 普通 md 链接观感取旧 `.reader a`（primary 色 + 下划线）；wikilink / autolink chip 复用 `wb-*` 类（themes.css 已有主题化定义）；语料引用复用 `.corpus-ref` 类。
5. 表格单元格行内格式支持子集：粗体 / 斜体 / 行内代码 / 删除线 / 链接（DOM API 构建，无 innerHTML，天然防注入；按单元格文本缓存）。

## 现状（关键复用）

| 文件 | 复用点 |
| --- | --- |
| `src/components/editor/livePreview.ts` | 装饰渲染核心；需加 `readOnly`（选区不再揭示源码、表格恒渲染、链接可单击） |
| `src/components/editor/autoLinks.ts` | 词条装饰 + 悬停 + 点击；`alField`、`pushDocLinks` 复用；需 `readOnly` 与 `wb-*` 类对齐 |
| `src/components/editor/CodeMirrorEditor.tsx` | 挂载组件；加 `height` 选项支持自动高度 |
| `src/pages/Edit.tsx` | `refNames`/`docLinks` 数据流、`openLink`/`openLinkTarget` 跳转规则直接复用 |
| `src/pages/Read.tsx` | 卡片 chrome / 偏好面板 / `saveReadPos` / 查找条 UI 保留，正文与 TOC/锚点/高亮重接线 |
| `src/lib/remarkRefs.ts` | 命中逻辑（正则构建 + findHits）抄出为 `src/lib/corpusRefMatch.ts`（remark 插件本体最终删除） |
| `src/components/RefChip.tsx` | `extIcon` 迁至 `src/lib/extIcon.tsx`；解析规则（`api.resolveRef`，唯一命中跳转 / 候选列表 / 缺失说明）由共享弹层复刻 |
| `src/lib/api.ts` | `resolveRef` / `linksDoc` / `refNames` / `rawFileUrl` 全部复用 |

## 设计

### 新模块

```ts
// src/lib/corpusRefMatch.ts —— 语料引用命中（纯函数，编辑器侧唯一实现）
export interface CorpusRefHit { start: number; end: number; url: string }
export function buildCorpusRefMatcher(
  names: { name: string }[], collections: { name: string }[]
): { find(value: string): CorpusRefHit[] } | null;

// src/components/editor/mdLanguage.ts —— 共用 markdown 语言配置 + 代码高亮
export function mdLang(): Extension[];
// markdown({ base: markdownLanguage, codeLanguages: languages }) + HighlightStyle（github-dark 系 token 色）

// src/components/editor/corpusRefs.ts —— 语料引用装饰扩展
export function corpusRefsExtension(opts: {
  names: RefNameEntry[]; collections: { name: string }[];
  onOpen: (url: string, at: { x: number; y: number }) => void;
  readOnly?: boolean; // 只读：永不因选区隐藏
}): Extension[];
// 语义对齐 remark 版：跳过 FencedCode/Link/Image 内部；InlineCode 整体为文件名 → 代码风 chip；
// 命中与自动内链区间重叠时跳过（读 alField）；文档变更防抖重建

// src/components/editor/copyAsRendered.ts —— 只读实例复制为正文
export function copyAsRendered(): Extension[];
// domEventHandlers copy/cut：选中源文 → unified 管线 → text/html + text/plain 双 flavor

// src/components/CorpusRefPopover.tsx —— 引用解析弹层（Read/Edit 共用）
// api.resolveRef：唯一命中直接跳转；候选列表按钮；缺失说明
```

### `ReadOnlyDoc`（阅读渲染组件，src/components/ReadOnlyDoc.tsx）

只读 CM：`EditorState.readOnly` + `editable false` + `lineWrapping` + `drawSelection`；
扩展栈 = `mdLang()` + `livePreview({ readOnly, plainClick })` + `corpusRefsExtension` + `linksExtensionFor` + `copyAsRendered()` + 高亮词装饰（`?h=`，mark 类 `cm-rd-hl`）+ 只读主题（自动高度、列宽 `min(calc(var(--rd-width) + 28px), 100%)`）。

Props：`content / docPath / refNames / collections / links / highlightTerm? / height? / onReady?(view)`。
暴露的阅读操作（由 Read 页经 view 驱动）：`view.coordsAtPos` + 外层 `scrollRef` 滚动；TOC = 扫描源文 ATX 标题（跳过围栏代码）得 `{pos, text, level}`。

### livePreview / autoLinks 的只读化

- `LivePreviewOptions.readOnly`：`activeLineSet` 恒为空 → 装饰全时渲染；表格 StateField `isActive` 恒 false；`TableWidget` 点击不派发选区。
- 链接点击：编辑态 Cmd/Ctrl+点击（现状）；只读态单击即开（对齐旧阅读页）。
- `autoLinks` 加 `readOnly`：活动行隐藏逻辑关闭；单击即触发 `onOpen`；装饰类改挂 `wb-autolink / wb-wikilink / wb-wikilink-missing`（复用 themes.css 主题化样式，删重复的 cm-lp-* 链接样式）。

### 版式基准（旧 .reader 值迁入 lpTheme，单引擎后 lpTheme 即唯一真相）

- 代码块恒深色：`hsl(30 8% 16%)` 底 / `hsl(40 20% 90%)` 字 / 内距 `0.9em 1.1em` / `--rd-code-size`；token 色取 github-dark 调色板（keyword `#ff7b72`、string `#a5d6ff`、comment `#8b949e`、number `#79c0ff`、function `#d2a8ff`、tag `#7ee787` 等）。
- 普通 md 链接：primary 色 + underline + offset 3px（新 `.md-link` 类，index.css；C 主题覆盖为 wb-link）。
- 引用块补竖直内距 `0.2em 1em`、去斜体；标题上距按旧 .reader 节奏放宽；表格单元格内距 `0.4em 0.8em`。

### 表格单元格行内格式（G5）

`TableWidget` 单元格改用迷你行内渲染器（DOM API 构建，支持 `**粗**` `*斜*` `~~删~~` `` `码` `` `[字](址)`，链接带 `data-lp-href` 可点击导航），按文本 LRU 缓存。

### 滚动延续与 split 同步

- Read→Edit：navigate 带 `state.wbScrollRatio`（外层 scrollRef 比例）；Edit 挂载完成后按比例设 `.cm-scroller`。
- Edit→Read（保存并返回 / 返回阅读）：带编辑器 scroller 比例；Read 恢复优先级 `state.ratio > 锚点 > loadReadPos`。
- split：左右按 `scrollTop/(scrollHeight-clientHeight)` 比例互相同步，150ms 防回环锁，rAF 节流。

## 边界情况

- 只读文件：Edit 页重定向回阅读页（现状），滚动传递失效无害。
- JSON / Word：完全不经新组件（现状分支不动）。
- 空数据：names/collections 空 → matcher null → 扩展空转；links 未就绪 → chip 延迟出现（现状）。
- 巨型文档：CM 自动高度全文渲染（与 react-markdown 同级代价）；corpusRefs 防抖 300ms 重建；表格/缓存按块计。
- 复制片段：半标记选中（如 `**粗` 无闭合）按段落解析原样输出星号，与任何编辑器一致；选区跨表格 widget 时按源文渲染回真 `<table>`。
- 三主题 + 深浅色：`wb-*`、`.md-link`、`.corpus-ref`、`cm-lp-*` 全部走既有变量；token 色恒定（代码块恒深色，同旧阅读页）。
- CRLF：装饰/滚动基于行号与像素，`lineSeparator` 现状不变。
- `?h=` 高亮词与装饰隐藏区重叠：标记照打（隐藏区不可见，无害）；查找从当前选区向后循环。

## 实施步骤（每步可构建、独立提交）

1. 🔧 依赖：+ `@codemirror/language-data` `unified` `remark-parse` `remark-rehype` `rehype-stringify`。
2. ✨ `mdLanguage.ts` + livePreview/Edit 接入（live 与 source 模式获得代码高亮）+ lpTheme 版式基准迁移（代码块深色、链接样式、引用/标题/表格内距）。
3. ✨ `corpusRefMatch.ts` + `corpusRefs.ts` + `CorpusRefPopover.tsx`，Edit live 模式接线（Cmd+点击解析跳转）。
4. ✨ `copyAsRendered.ts`（unified 双 flavor 管线）。
5. ✨ `ReadOnlyDoc.tsx`（含 `?h=` 高亮扩展、`CodeMirrorEditor` 加 height 支持、livePreview/autoLinks 只读化、表格单元格行内渲染）。
6. ✨ Read 页切换：markdown 分支换 `ReadOnlyDoc`，TOC/锚点/查找/滚动恢复重接线；编辑入口带滚动比例。
7. ✨ Edit 页：preview/split 面板换 `ReadOnlyDoc`；split 滚动同步；返回阅读带滚动比例。
8. 🔥 删除 `MarkdownReader` / `RefChip` / `LinkChip` / `remarkRefs` / `remarkAutoLinks` / `.reader` 样式 / `react-markdown` + `rehype-highlight` 依赖（`extIcon` 已先迁 `src/lib/extIcon.tsx`）。
9. ✅ `npm run lint` + `npm run build` + `npm run test:e2e` + 三主题人工抽查。

## 验收标准

- A1 同一 md 文档：阅读页 / 编辑 live / split 右栏 / preview 四处观感一致（同一组件栈，逐屏对照）。
- A2 阅读页选中一段含粗体与链接的文字复制：粘贴到纯文本框无 `**`/`[]()` 符号；粘贴到富文本编辑器保留粗体与超链接。编辑器内复制仍是源码。
- A3 live 模式代码块有色高亮且与阅读页同配色（恒深色底）；`bash`/`js`/`json` 三语言抽查。
- A4 语料引用：正文文件名与「集合|文件名」在阅读页与 live 模式都显示 chip；单击（阅读）/ Cmd+点击（编辑）唯一命中跳转 `/read/<目标>`，重名弹候选，缺失有说明。
- A5 TOC/锚点/`?h=`：目录点按与 `#锚点` 滚动到对应标题；搜索跳转（backlinks 的 `?h=`）自动滚到首个命中并高亮。
- A6 滚动延续：阅读 60% 处进编辑 → 视口含切换前最后块级元素；编辑器某标题处保存返回 → 阅读视口含该标题。
- A7 split：左滚右跟、右滚左跟（±5%），无回环抖动；输入后右栏 300ms 内更新。
- A8 字节零污染：live 模式对标题/表格/引用/代码块各做一次编辑后保存，除预期改动外字节不变（e2e 现有断言）。
- A9 `npm run lint` / `build` / `test:e2e` 全绿；`rg react-markdown src/` 无命中；package.json 无 react-markdown / rehype-highlight。

## 明确禁止

- 禁止改保存/草稿/冲突/字节精确路径与 server API。
- 新依赖仅第 1 步列出的五个；禁止升级 CodeMirror 系其他包。
- 禁止引入 WYSIWYG 框架或把装饰逻辑改成改写文档字节。
- 禁止顺手重构无关模块；Word/Json/搜索/反链面板不动。
