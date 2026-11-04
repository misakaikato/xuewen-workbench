# 规格：划线笔记引文含格式时原文不出标记

## 背景与目标
阅读页选中一段文字记笔记后，原文上应出现橙色点线下划线（`.cm-note-mark`），悬停提示「此处有笔记，点击查看」，点击跳到笔记锚点。

现在只要选中的文字带格式，笔记照常写进文件，但原文永远不出标记。各平台都一样，重开文档也一样。带格式指的是加粗、斜体、删除线、行内代码、Markdown 链接、wikilink 别名，或 Word/HTML 里跨行内标签的一句话。

根因是坐标系不一致：
- 存进 `.<笔记名>.annotations.json` 的 `quote` 是**渲染后的文字**（选区 `toString()`，格式符号已经去掉）。
- markdown 阅读器拿它去**源码**里逐字找（`src/components/editor/livePreview.ts` 约 1090 行，`slice.indexOf(q)`），源码里带着 `**`、`[..](..)` 等符号，所以找不到。
- Word/HTML/JSON 阅读器只在**单个文本节点**里找（`src/pages/Read.tsx` 约 566 行），选区跨过 `<b>`、`<a>` 就断开了。

**成功标准**：同一段文字，不论是否带格式、选区跨不跨行内标签，记笔记后立即出现标记，重开文档仍在。已经存在的旧笔记（数据格式不变）在修复后打开文档也能出标记。

## 非目标
- 不改后端，不改 `annotations.json` 的数据格式，不新增字段。
- 不处理表格内的引文（表格是整块 widget）、图片 alt 文字、TXT 里跨 wikilink 别名的引文。
- 不改标记样式、点击行为、笔记文件的写法。
- 不改 Ctrl+F 文内查找的行为（只允许为复用而抽出公共函数，行为必须逐字节一致）。
- 不新增依赖。

## 假设（调度方已拍板）
- A1 **在各阅读器的「显示文本」坐标里定位**，统一用现有的 `findAllRanges(source, needle, true)`（`src/lib/searchLocation.ts`，智能模式：忽略空白、全角/半角、大小写，返回 source 坐标区间）。不在保存时记录源码位置——这样旧笔记也能受益，而且只有一条定位通路。
- A2 **定位候选规则统一为一个函数** `noteQueries`，三个阅读器共用。规则见「设计 1」。原来三处规则不一样：md 取首行（≥2 字），DOM 与 TXT 取每行（≥6 字）。新规则允许 2–5 字的短引文（如「克己复礼」）在三种阅读器里都能标。
- A3 **每条笔记**：按候选顺序取第一个**有命中**的候选，标出它的**全部**命中；后面的候选不再试。三种阅读器统一用这条。
- A4 TXT 中笔记区间与链接区间重叠时，**不再整段丢弃**，改为扣掉链接部分，标剩下的部分（链接显示优先的规则不变）。

## 现状
- `src/lib/searchLocation.ts`：
  - `findAllRanges(source, needle, smart)`：文内查找用。智能模式先建「去空白、半角化、小写」的 haystack 与偏移表，命中区间映射回 source 坐标。
  - 本文件**没有任何 import**，node 测试可以直接 `await import('../src/lib/searchLocation.ts')`（见 `scripts/test-retrieval.mjs` 第 13 行）。新增的纯函数放这里，保持零 import。
- `src/lib/domFind.ts`：`markDomFind(root, needle, smart)` 的流程：
  - 收集 root 下的文本节点，跳过 `script, style, button` 内的节点；
  - 把节点文本拼接起来，用 `findAllRanges` 在拼接文本上查找；
  - 逆序把每个命中区间在各节点上的片段 `splitText` 后包进 `<mark class="wb-find-hl">`。
  - `unmarkDomFind` 负责还原。
- `src/components/TxtReadBody.tsx`：
  - 第 40–51 行是本地的 `noteQueries`（≥6 字、截前 80 字、长的优先、60% 下限）。
  - 约 103–113 行用 `text.indexOf(q)` 精确匹配；与链接区间重叠的笔记区间整段丢弃（`if (!linkSpans.some(...))`）。
- `src/components/editor/livePreview.ts`：
  - `buildInlineDecorations(view)`（约 980–1107 行）把所有内联装饰收进 `parts`。隐藏 Markdown 符号用 `Decoration.replace({})`；子弹、分割线、图片、围栏条用带 widget 的 `Decoration.replace`。
  - 末尾「划线笔记标记」段落按 `view.visibleRanges` 切片后 `indexOf(首行前 80 字)`。
  - wikilink 的 `[[`、`name|`、`]]` 由 `src/components/editor/autoLinks.ts` 的 `alField`（StateField，值的 `.deco` 是 DecorationSet）用 `Decoration.replace({})` 隐藏，**不在** `parts` 里。livePreview 已经 import 了 `alField`（`buildTableDecorations` 在用）。
  - `makeLpPlugin` 的 `update` 只在 `docChanged / selectionSet / viewportChanged / treeChanged / marksChanged` 时重算。
- `src/pages/Read.tsx` 约 546–589 行：Word/JSON/HTML（`file.type !== 'text'` 且非 markdown）的笔记标记。逐个候选、逐个文本节点 `t.data.indexOf(q)`，命中就把那一段换成：
  ```html
  <a class="cm-note-mark" data-note-href href title="此处有笔记，点击查看">
  ```
  并挂 click → `navigate(mk.href)`。父元素是 `SCRIPT/STYLE/MARK/A` 的节点跳过。
- `@codemirror/state` 的 `RangeValue.point` 是公开字段：replace/widget/line 装饰为 `true`，mark 装饰为 `false`。replace 装饰的区间 `from < to`，line 和 widget 装饰 `from === to`。
- 端到端测试模式：`scripts/e2e-reader-regress.mjs`（Electron + 子进程起后端 + `executeJavaScript`）。R4 段落演示了如何选区、点「记笔记」、保存，以及如何检查 `.cm-note-mark`。

## 设计

### 1. 共享定位函数（`src/lib/searchLocation.ts` 新增，保持零 import）
```ts
/** 笔记定位候选：引文按行拆分，去首尾空白，去掉空白后不足 2 字的行丢弃；
 *  每行截前 80 字，按长度降序。最长者 ≥6 字时，只保留长度 ≥ max(6, floor(最长*0.6)) 的行；
 *  最长者 <6 字时，只保留与最长者等长的行。无可用行返回 []。 */
export function noteQueries(quote: string): string[]

/** 在显示文本里定位一条笔记：按 noteQueries 的顺序，返回第一个在 display 中
 *  （findAllRanges 智能模式）有命中的候选的全部命中区间（display 坐标，左闭右开）；都不命中返回 []。 */
export function locateNote(display: string, quote: string): { from: number; to: number }[]
```

### 2. DOM 公共件（`src/lib/domFind.ts`）
抽出两个导出函数，`markDomFind` 改为用它们实现，行为不变：
```ts
/** root 下参与匹配的文本节点及其在拼接文本中的区间；跳过 script/style/button 内的节点（与 markDomFind 现有口径一致） */
export function collectTextNodes(root: HTMLElement): { node: Text; from: number; to: number }[]

/** 把拼接文本坐标中的区间逐节点包起来：区间逆序、节点逆序处理（与 markDomFind 现有算法一致）。
 *  make(rangeIndex, node) 返回包装元素；返回 null 表示这个节点片段不包、也不 split。 */
export function wrapTextRanges(
  nodes: { node: Text; from: number; to: number }[],
  ranges: { from: number; to: number }[],
  make: (rangeIndex: number, node: Text) => HTMLElement | null,
): void
```

### 3. markdown 阅读器（`livePreview.ts` 的 `buildInlineDecorations`）
替换末尾「划线笔记标记」段落。对每个 `visibleRange [vFrom, vTo)`：
1. **算隐藏区间**，取两部分的并集，并裁剪到 `[vFrom, vTo)`：
   - 本函数已收进 `parts` 的、`value.point === true` 且 `to > from` 的区间；
   - `state.field(alField, false)?.deco` 在 `[vFrom, vTo)` 内（`.between`）、`value.point === true` 且 `to > from` 的区间。
2. **建显示文本**：逐字符遍历 `doc.sliceString(vFrom, vTo)`，跳过隐藏位置，得到 `display` 字符串与偏移表 `pos[i]`（display 第 i 个字符对应的文档位置）。用布尔数组标记隐藏位置即可，复杂度 O(区间长度)。
3. 对每条 mark：`locateNote(display, mk.quote)`。每个命中 `{from, to}` 映射为文档区间 `[pos[from], pos[to-1]+1)`，生成：
   ```ts
   Decoration.mark({ class: 'cm-note-mark', attributes: { 'data-note-href': mk.href, title: '此处有笔记，点击查看' } })
   ```
   属性与现在一致。
4. 笔记标记的计算放在所有语法装饰都已 push 进 `parts` 之后。最后仍是 `Decoration.set(parts, true)`。
5. `makeLpPlugin.update`：当 `u.state.field(alField, false) !== u.startState.field(alField, false)` 时也重算内联装饰。原因是 wikilink 数据晚到会改变显示文本。

### 4. Word/JSON/HTML 阅读器（`Read.tsx` 约 546–589 行）
替换原有的候选循环：
```
nodes = collectTextNodes(el)
display = nodes.map(n => n.node.data).join('')
for mk of noteMarks:
  ranges = locateNote(display, mk.quote)
  wrapTextRanges(nodes, ranges, (_, node) =>
    node.parentElement?.closest('a') ? null : 创建 <a class="cm-note-mark" ...>
  )
```
- 创建的 `<a>` 的属性和 click 行为与现在一致。
- 片段已经在某个 `<a>` 内（原文超链接或已经打过的笔记标记）时不包。这样不会嵌套 `<a>`，effect 重跑时也不会重复包装。
- 每条笔记处理完后要**重新** `collectTextNodes`，因为上一条包装后节点已被 split。

### 5. TXT 阅读器（`TxtReadBody.tsx`）
- 删除本地 `noteQueries`，改用 `locateNote(text, mk.quote)` 得到区间。
- 对每个区间，扣掉与 `linkSpans` 重叠的部分，把剩下的非空片段作为 `noteSpans`（`href` 相同）。
- 其余分段与渲染逻辑不动。

## 边界情况
| 情况 | 期望 |
|---|---|
| `quote` 为空，或全是空白 | 不标，不报错 |
| 引文只有 1 个字 | 不标 |
| 引文 2–5 字（如「克己复礼」） | 三种阅读器都标出所有出现处 |
| 多行引文：首行短（如「第一章」），后面有长行 | 用长行定位，不去标所有「第一章」 |
| 引文跨 `**加粗**`、`*斜体*`、`~~删除~~`、`` `代码` ``、`[文字](url)`、`[[名|别名]]` | md 阅读器标出，下划线覆盖显示出来的文字 |
| 引文跨 HTML/Word 的 `<b>`、`<i>`、`<span>` | 标出，可能由多个相邻 `<a>` 拼成 |
| 引文跨原文超链接 `<a>` | 超链接以外的部分标出，超链接内部不包 |
| TXT 引文含自动内链词 | 链接以外的部分标出，链接仍可点 |
| 同一引文在文中出现多次 | 全部标出（A3） |
| 引文在当前视口外（md） | 滚动到视口内时标出（沿用 visibleRanges 机制） |
| CRLF、BOM、混合换行、GBK 文档 | 与 LF 文档表现一致 |
| 老笔记（修复前存的、`quote` 是渲染文本） | 打开文档即标出 |
| 同一文档的 noteMarks 更新（新存一条） | 立即出现新标记，旧标记不消失、不重复 |

## 实施步骤
1. `searchLocation.ts` 加 `noteQueries` / `locateNote`；新建 `scripts/test-note-marks.mjs`（node + `node:assert/strict`，风格参照 `scripts/test-retrieval.mjs`）覆盖设计 1 的规则与边界表中的纯函数部分。可单独验证。
2. `domFind.ts` 抽出 `collectTextNodes` / `wrapTextRanges`，`markDomFind` 改为调用它们。
3. `livePreview.ts` 按设计 3 改。
4. `Read.tsx` 按设计 4 改。
5. `TxtReadBody.tsx` 按设计 5 改。
6. 新建 `scripts/e2e-note-marks.mjs`（Electron，结构照抄 `scripts/e2e-reader-regress.mjs` 的启动/选区/保存方式，用独立端口如 7536 与临时目录），覆盖验收标准 V3 的全部用例。

步骤 2–5 互不依赖，但都依赖步骤 1；步骤 6 依赖全部。

## 验收标准
- V1 `node scripts/test-note-marks.mjs` 退出码 0，至少覆盖以下用例：
  - `noteQueries('')` → `[]`；`noteQueries(' 仁 ')` → `[]`；`noteQueries('克己复礼')` → `['克己复礼']`；
  - `noteQueries('第一章\n这是一段足够长的正文内容')` 结果不含 `'第一章'`；
  - `locateNote('前文加粗的词后文，这是带格式的一句话。', '前文加粗的词后文，这是带格式的一句话')` 命中 1 处；
  - `locateNote('甲乙丙丁甲乙丙丁', '甲乙丙丁')` 命中 2 处；
  - `locateNote('前文\n加粗', '前文 加粗')` 命中 1 处（忽略空白）。
- V2 `npx tsc -b` 与 `npm run lint` 无新增错误（与基线 main@84a0459 比较）。
- V3 `npm run build` 后，`timeout 300 node_modules/.bin/electron scripts/e2e-note-marks.mjs` 退出码 0。用例全部走「选区 → 记笔记 → 保存」的真实 UI 流程，每条断言**保存后 1.5 秒内**和**重开文档后**都存在 `.cm-note-mark`，且标记的 `textContent` 拼起来包含引文的主体文字：
  - md：`前文**加粗的词**后文，这是带格式的一句话。` 选整句；
  - md：`参见[孔子家语](孔子家语.md)这一篇里的说法很重要。` 选整句；
  - md：`` 运行 `npm run dev` 即可启动开发服务器。 `` 选整句；
  - md：含 wikilink 别名 `[[论语|那本经典]]` 的句子选整句（语料里要有 `论语.md`，等内链就绪再选）；
  - md：纯文本里选 4 字「克己复礼」；
  - md（CRLF 换行）：跨两段的选区，第二段含加粗；
  - html：`<p>前文<b>加粗的词</b>后文，这是带格式的一句话。</p>` 选整句；
  - html：`<p>参见<a href="x.md">某篇</a>这一篇里的说法很重要。</p>` 选整句，断言标记存在且没有 `a a`（嵌套锚点）；
  - txt：选 4 字短语；
  - txt：选含自动内链词（语料里另有同名 md 文档）的整句，断言标记存在且 `.wb-autolink` 仍在；
  - 老笔记：启动前预置 `阅读笔记/<名>.md` 与 `.<名>.annotations.json`（`{ at, source, quote: '前文加粗的词后文，这是带格式的一句话', note: '', anchor: '2026-11-01 10:00 · 1' }`），打开对应 md 源文档即出现标记。
- V4 回归：以下三条命令各自退出码 0（每条用 `timeout 600` 包住）：
  - `node_modules/.bin/electron scripts/e2e-reader-regress.mjs`
  - `node_modules/.bin/electron scripts/e2e-retrieval.mjs`
  - `node scripts/test-retrieval.mjs`

  若某条在基线 main@84a0459 上本来就失败，在报告里写明基线输出，不算本次回归。
- V5 `git diff --stat` 只涉及：
  - `src/lib/searchLocation.ts`
  - `src/lib/domFind.ts`
  - `src/components/editor/livePreview.ts`
  - `src/pages/Read.tsx`
  - `src/components/TxtReadBody.tsx`
  - `scripts/test-note-marks.mjs`
  - `scripts/e2e-note-marks.mjs`

## 明确禁止
- 不许改 `server/` 下任何文件，不许改 annotations 数据格式。
- 不许引入新依赖，不许改 `package.json`。
- 不许改 `markDomFind` 的外部行为与签名。
- 不许重构上述文件中与笔记标记无关的代码。
- 不许留下 `console.log` 调试输出、注释掉的旧代码，或「此处已修复」之类的过程注释。
