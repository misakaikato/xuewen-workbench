# DESIGN.md — 学问 Workbench 设计约束

本文件是界面审美的单一约束源。token 值的唯一真相源在 `src/styles/themes.css`，本文件只规定**决策与禁令**。
新写或修改任何 UI 代码前必读；与本文冲突的既有代码视为待还的技术债。

## 1. 视觉气质

文人的数字书房：一个长期阅读与整理语料的工作台，不是 SaaS 后台。
安静、克制、有纸张感；信息密度可以高，但视觉噪音必须低。
动效的气质是"翻书"——快、轻、有明确的起止，绝不炫技。

## 2. 色板与角色

三套主题（A 宣纸 / B 现代极简 / C 夜读）+ 深色阅读偏好，全部 token 见 themes.css。

- **primary 配额**：朱砂(A)/靛蓝(B)/鎏金(C) 只用于四处——主按钮、正文链接、选中态、焦点环。其他地方（图标、装饰、背景块）一律不用。
- **中性色**：必须带主题的暖/冷偏移，禁止纯灰、禁止 Tailwind 默认 slate/zinc 原样落地。
- **状态色**：`destructive` 只用于删除与不可恢复操作；warning 统一走 `--warning` token（ amber 硬编码是历史债，见技术债清单）。成功态不单独设色，用 primary 或正文色。
- **硬编码禁令**：组件里禁止出现 `amber-*`、`#xxxxxx`、`rgb(...)` 字面量，一律走 token。

## 3. 字体与字阶

- `--font-ui` 界面（A 衬线 / B·C 无衬线）、`--font-serif` 正文、`--font-mono` 代码与 JSON、`--font-brand` 品牌标题。
- 统计数字必用 `.stat-num`（tabular-nums），禁止等宽以外的数字跳动。
- 正文行宽上限 `--rd-width`（默认 720px），标题 `text-wrap: balance`。

### 字阶（tailwind.config.js，唯一真相源）

中文行高必须放宽，一律走下表，不写 `text-[Npx]`、不手写 `leading-*`（除非行内密排控件）：

| 类 | 字号 / 行高 | 用途 |
|---|---|---|
| `text-lg` | 18px / 1.4 | 页面标题 h1（全站统一，不再出现 xl/2xl 标题） |
| `text-base` | 15px / 1.7 | 内容型大字（对话 Markdown 的 h2、强调块） |
| `text-sm` | 14px / 1.75 | 正文、对话内容、表单说明、列表主体 |
| `text-xs` | 12px / 1.6 | 辅助说明、路径、时间、徒标、次要按钮 |
| 代码/等宽 | 13px | `pre`、JSON、编辑区（跟随 `--rd-code-size`） |

- 字重只用 **400 / 500 / 600**；标题与卡片标题用 `font-semibold`，**禁止 `font-bold`**（中文衬线主题下过重）。
- 卡片区块标题统一 `text-sm font-semibold`；后接说明行时标题 `mb-1`、说明行 `mb-3`；无说明行时标题 `mb-3`。
- 对话 Markdown 的段间距与列表间距统一 `my-2` + `space-y-1`（旧值 2px 已废弃）。
- 例外（允许）：主题预览缩略图内的 9–15px 模拟字、代码块 13px——它们是模拟内容，不是界面类型。

## 4. 组件规格

- **按钮只用 `src/components/ui/button.tsx` 的变体**。禁止在页面里内联拼 `px-? py-? rounded border` 造按钮（Layout/Dashboard/Read 里的存量内联按钮是技术债）。
- 卡片：`bg-card border border-border rounded-lg`；hover 只允许两种反馈：`border-primary/60` 或 `translateY(-1px)` + 投影微变，二选一。
- 圆角走 `--radius`（A 6px / B·C 8px）派生的 sm/md/lg，不引入第四档。

## 5. 布局

- 顶栏 h-12，用窗框色 `wb-chrome`；侧栏宽 200–480px 可拖拽持久化。
- 内容容器两档：**内容型页面 `max-w-5xl`**（概览/浏览/阅读），**表单型页面 `max-w-3xl`**（设置/检索/资料库/RAG）。
- 页面纵向节奏统一 `space-y-6`；卡片内边距统一 `p-4`（工具栏/内联小面板 `p-3`，弹窗 `p-5`，阅读正文 `p-6~8`）。
- 间距只用 4px 刻度（p-2/3/4/6、gap-2/3/4），禁止 5px/7px 这类刻度外值。

## 6. 层次与投影

- 浅色主题：实体层用 `--wb-shadow`（极浅），浮层用 `--wb-pvshadow`。
- 深色与 C 主题：**禁用投影，靠描边分层**（`--wb-shadow: none`）。新增浮层组件必须遵守。

## 7. 动效

动效 token 定义在 themes.css `:root`（`--dur-*` / `--ease-*`），Tailwind 侧注册为 `duration-fast|med|slow` 与 `ease-signature`。

- **时长刻度（三档，禁止刻度外取值）**：
  - `fast` 120ms — hover 变色、微交互
  - `med` 200ms — 侧栏折叠、抽屉、路由过渡、展开收起
  - `slow` 320ms — 弹窗、横幅等大块面入场
- **缓动**：签名曲线 `--ease-signature: cubic-bezier(0.22, 1, 0.36, 1)`（签名 token）。入场一律 ease-out 系；禁止 ease-in、bounce、弹性过冲。
- **路由过渡**：fade + translateY(4px)，med。
- **列表入场**：stagger 20–30ms 逐级，总时长不超 slow。
- **降级**：`prefers-reduced-motion` 全局压到 ~0（index.css 已落地）。
- **禁令**：界面过渡不得超过 320ms；入场位移不得超过 8px；能用透明度解决的不用位移。

## 8. Do / Don't

**Do**
- 新组件自带空 / 加载 / 错误三态（用统一 `<EmptyState>` / 骨架屏，禁止裸文字"加载中…"）。
- hover 反馈必带 `transition-colors`（或 fast 档过渡）。
- 图标用 lucide；语义色走 token。

**Don't**
- 禁止硬编码色值、emoji 当图标、lorem/占位空话、紫蓝渐变。
- 禁止可动画元素的瞬时挂载/卸载（折叠、抽屉、弹窗）。
- 禁止卡片左侧强调色竖条、三栏等宽 feature grid 这类模板构图。
- 禁止在深色主题加投影。

## 9. 响应式

- Electron 桌面优先；`md` 以下侧栏变抽屉（overlay fade + 面板 slide-in）。
- 移动端只保证可用，不做独立设计。

## 10. Agent 指引

生成或修改 UI 时逐条自查：
1. 颜色是否全部来自 token？2. 按钮是否用了 button.tsx？3. hover 是否有过渡？
4. 空/加载/错误态是否设计过？5. 动效时长是否在三档刻度内？6. 深色下有没有偷加投影？

## 技术债清单（改造计划见各期方案）

- ~~P2：内联按钮收敛到 button.tsx；amber 硬编码 → `--warning` token；统一空/加载态组件。~~（2026-10-19 已还：新增 `--warning/--success` 四主题 token，新增 `src/components/ui-states.tsx`，主要行动按钮已收敛）
- P2 余量：阅读偏好面板里的步进小按钮（A−/A＋）与 chip 类控件仍为非 Button 的自定义控件，视觉一致即可，不强制收敛。
- ~~P3：⌘K 命令面板；macOS `titleBarStyle: 'hiddenInset'`；快捷键清单。~~（2026-10-19 已还：`src/components/CommandPalette.tsx`，顶栏搜索框为面板触发器；`?` 唤出快捷键清单；macOS 顶栏作拖拽区并让位红绿灯）
