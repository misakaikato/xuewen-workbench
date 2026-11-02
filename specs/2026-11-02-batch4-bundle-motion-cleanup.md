# 规格：第 4 批——包体积、依赖、动效与清理

日期：2026-11-02 ｜ 状态：待施工（第 3 批落地后） ｜ 读者：施工者（无对话上下文也可施工）

## 背景与目标
前端只有一个 1.81MB（gzip 577kB）的入口包；生产包里被 `kimi-plugin-inspect-react` 注入了源码位置字符串；12 个前端依赖与约 30 个 shadcn 组件从未被应用代码引用；前端依赖放在 `dependencies` 里会被原样打进安装包；侧栏折叠动画改 width 引起每帧重排，多处面板瞬时挂载违反 `DESIGN.md` §7/§8；CI 打的 mac 包缺离线 MLX 环境；仓库里有旧副本与脚手架残留。本批收尾，目标：主包 < 1.3MB（未压缩），安装包明显变小，动效符合 DESIGN.md，eslint 0 错误。

## 非目标
- 不改功能行为与业务逻辑；不改视觉设计（颜色、字体、间距）。

## 设计
### K1 代码拆分
- `src/App.tsx` 对 Dashboard 以外的页面（Setup、Browse、Read、Edit、Search、RagManage、AgentChat、Settings）用 `React.lazy`，`Suspense` 的 fallback 用现有骨架屏组件（禁止裸「加载中」文字，见 DESIGN §8）。Read 与 Edit 共用的编辑器模块放同一 chunk。
- `copyAsRendered.ts` 的 unified/remark 改为 `import()`：阅读/编辑页挂载后空闲时（`requestIdleCallback`，不支持则 `setTimeout 1500`）预热；复制时若未加载完成，退回复制纯文本。
- `@codemirror/lang-html` 只在打开 html 文件时动态加载。
- 去掉 `vite.config.ts` 的 `kimi-plugin-inspect-react`（并从 devDependencies 删除）。
### K2 依赖
- 删除应用代码未引用的依赖：recharts、date-fns、react-day-picker、embla-carousel-react、input-otp、vaul、react-hook-form、@hookform/resolvers、zod、@uiw/react-codemirror、sonner、next-themes、react-resizable-panels、tw-animate-css（逐个先 grep 确认 `src/`（不含 `src/components/ui/`）、`server/`、`electron/`、`scripts/` 均无引用）；同时删除只被这些依赖使用且应用未引用的 `src/components/ui/*.tsx`（逐个 grep 确认无引用）。
- 依赖分类：后端/主进程运行时需要的保留在 `dependencies`（含动态 import 的：`@huggingface/transformers`、`onnxruntime-node`、`electron-updater` 等；以 `server/`、`electron/` 的静态与动态 import 为准），并显式加入目前靠间接依赖存在的 `adm-zip`（与 lock 中现版本一致）；仅前端构建用的（react、radix、codemirror、tailwind 相关、lucide-react、dompurify 等）移到 `devDependencies`。改完 `npm install` 更新 lock。
- 用 `npx electron-builder --mac dir --arm64 --publish never` 打包，对比改动前后 `.app` 体积，并启动产物确认能完成启动、打开文档、检索。
### K3 动效（`DESIGN.md` §7 时长 fast/med/slow、`ease-signature`、reduced-motion）
- `Layout.tsx:278` 侧栏折叠：主区宽度一次到位，侧栏内层用 `transform: translateX` + `opacity` 做 med 档过渡；不再动画 width。
- 侧栏与阅读页侧栏拖拽调宽（`Layout.tsx:101`、`Read.tsx:167-175`）：拖动中用 rAF 节流写 CSS 变量，mouseup 时才 setState 与写 localStorage。
- 阅读页 AI 侧栏、目录侧栏、文内查找条、阅读偏好面板：改为带过渡的挂载/卸载（opacity + ≤8px 位移，med 档；卸载等过渡结束再移除，可用 `data-state` + CSS 或现有 tailwindcss-animate 类）；查找条与偏好面板改为浮层，不推挤正文。
- 所有新过渡遵守 `prefers-reduced-motion`。
### K4 清理
- `index.html` 的 `<title>` 改为「学问 Workbench」。
- 删除根目录的旧副本 `linkMatch.js`（确认无引用）与脚手架说明 `template-info.md`。
- `scripts/acceptance.mjs` 中写死的备份路径改为按 `WORKBENCH_DATA_DIR`/数据目录计算。
- eslint 清零：把 `src/lib/prefs.tsx`、`src/lib/theme.tsx`、`src/store/app.tsx`、`src/components/ReadOnlyDoc.tsx` 中与组件同文件导出的非组件（常量、hook、函数）拆到独立文件；`src/components/ui/` 中保留文件的 fast-refresh 报错同样处理或在该目录的 eslint 覆盖规则中关闭 `react-refresh/only-export-components`（shadcn 惯例，二选一并说明）；其余 warning 按提示修。
### K5 CI 的 mac MLX 离线环境（`.github/workflows/release.yml`）
- mac 构建 job 在 `npm ci` 之后、`npm run release:mac` 之前：安装 uv（`astral-sh/setup-uv`，固定主版本）与 Python 3.12，运行 `node scripts/fetch-mlx-env.mjs`，并加一步校验 `resources-mlx/python.tar.gz` 与 `resources-mlx/wheels/` 存在，否则失败。
### K6 文档
- README：删掉已完成的「首次启用」占位符一节；数据目录与备份路径改为 `~/.xuewen-workbench/knowledge/<dsId>/…`；模型下载描述与实现一致（不再写「sha256 校验」，写「记录 sha256」）；补充日志与诊断导出位置。
- `docs/ARCHITECTURE.md`：同步第 1–4 批带来的变化（安全措施、CSP、Host 校验、编码只读、助手默认 confirm 与模式持久化、RAG 一致性、性能措施、依赖分类、CI MLX），更新「已知缺口」：删掉已修复项。

## 验收标准
- `npm run build` 输出中最大的 chunk < 1300kB（未压缩）；生产包 grep 不到 `src/components/` 一类源码位置字符串。
- `npx eslint .` 0 错误。
- `npx tsc -b`；全部 `scripts/test-*.mjs`；`npm run test:e2e`、`e2e-filetree`、`test:retrieval:e2e`、第 3 批的 `e2e-perf.mjs` 全过且指标不退化。
- 打包产物 `.app` 体积对比（改前/改后）写入报告；产物能启动并完成：概览 → 打开 md → 打开 docx → 检索 → 设置页导出诊断。
- 侧栏折叠时主区 `ResizeObserver` 回调次数 ≤ 2（e2e 中测）；查找条打开前后正文第一行的 `getBoundingClientRect().top` 不变。
- release.yml 通过 `actionlint`（若本机没有则用 `npx --yes @action-validator/cli` 或在报告中说明未能本地校验）；`node scripts/fetch-mlx-env.mjs` 本地可运行。

## 明确禁止
- 不改业务逻辑与视觉设计；不新增运行时依赖（`adm-zip` 显式声明除外，版本与 lock 现有一致）。
- 删除任何文件或依赖前必须 grep 确认无引用，并在报告中列出确认命令。
- 产物无过程叙事注释。
