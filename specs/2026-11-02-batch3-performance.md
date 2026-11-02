# 规格：第 3 批——性能与流畅度

日期：2026-11-02 ｜ 状态：施工中 ｜ 读者：施工者（无对话上下文也可施工）

## 背景与目标

实测（M5 Max，1714 文件 / 657MB 真实规模语料）与代码审查发现若干会在普通 Windows 笔记本（单核慢 4–8 倍）上造成明显卡顿的热点。本批逐项优化，每项给出可测量的前后对比。成功标准：下列验收项的量化指标达标，功能与既有测试不退化。

## 非目标
- 不改检索、内链、RAG 的算法结果（只改何时算、算多少、怎么渲染）。
- 不做包体积拆分、依赖清理与动效（第 4 批）。

## 设计

### P1 全局每 5 秒整树重渲（`src/store/app.tsx`）
- `Ctx.Provider` 的 value 用 `useMemo`；`setUpdate` 前做内容比较（status、版本、进度字段相同则不 set）。
- 所有轮询（`app.tsx` 状态 5s、助手状态、RAG 管理页 1s/5s、`FileTree.tsx:489` 的延迟重拉等）在 `document.visibilityState === 'hidden'` 时暂停，`visibilitychange` 回到 visible 时立即补拉一次再恢复。抽一个 `usePolling(fn, ms, { enabled })` hook 统一实现，所有轮询改用它。
- `Read.tsx:1183/1191` 传给 `TxtReadBody` 等 memo 组件的内联回调改为 `useCallback`。

### P2 引用扫描与内链字段（`src/components/editor/corpusRefs.ts`、`autoLinks.ts`、`livePreview.ts`）
- `alField` 的值带 `version`：只在 `setDocLinks` 效果到达时自增；文档变更只做位置映射、不改 version；**选区变化不重建 alField**（删掉 `autoLinks.ts:98` 一类 `if (tr.selection) rebuild = true`，装饰与选区无关）。
- `corpusRefs.ts:141` 比较 `version` 而不是对象身份；全文 `scanHits` 只在 version 变化或防抖（250ms）到期时执行，按键只做映射。
- `livePreview.ts:1142` 表格字段：只读态忽略选区变化。

### P3 Word 预览图片外置（`server/word.js`、`server/index.js`、`src/components/WordReader.tsx`）
- mammoth `convertToHtml` 用 `convertImage` 把图片写到 `cacheDir(dsId)/word-assets/<文件路径哈希>-<mtimeMs>/img-<n>.<ext>`，HTML 中 `src` 改为 `/api/word/asset?ds=<dsId>&key=<目录名>&name=img-<n>.<ext>`，并加 `loading="lazy"` 与 `decoding="async"`。
- 新接口 `GET /api/word/asset`：key、name 只允许 `[A-Za-z0-9._-]`，路径必须位于 `word-assets` 下（复用 `isWithin`），按扩展名设 Content-Type，`Cache-Control: private, max-age=31536000, immutable`。
- 文件 mtime 变化时旧资产目录可被下次转换覆盖或清理（同一路径哈希只保留最新 mtime 的目录）。
- WordReader 的 DOMPurify 配置保留这些相对 URL。

### P4 检索结果分批渲染（`src/pages/Search.tsx`）
- 精确与智能两种结果都先渲染前 50 个文件分组，底部放「再显示 50 个（剩余 N）」按钮，并用 IntersectionObserver 在接近底部时自动加载下一批；已加载的不卸载。命中片段高亮逻辑不变。

### P5 大 TXT / JSON（`TxtReadBody`、`JsonViewer.tsx`、`domFind.ts`）
- TXT：正文按每 200 行分块，每块容器加 `content-visibility: auto; contain-intrinsic-size: auto 2000px`（视口外跳过布局与绘制），不改变文本与链接结构。
- JSON：`JsonNode` 用 `memo`；默认展开规则改为「层级 < 2 且子项数 ≤ 100」；子项超过 200 的数组/对象分页显示（「显示更多 200（已显示 x / 共 n）」）；过滤输入 200ms 防抖并用 `useDeferredValue`；实现注释中写了但没实现的「按后代过滤容器」：容器只在自身键或任一后代匹配时显示。
- 文内查找（`domFind.ts:24`、`searchLocation.ts:57`、`Read.tsx:711/738`）：按（文档 id + 版本）缓存归一化文本与命中结果；输入 150ms 防抖；回车在已有命中间跳转，不重算。

### P6 编辑时按键不引起整页重渲（`Read.tsx` 原位编辑、`Edit.tsx`、`ReadOnlyDoc.tsx:141`、`CodeMirrorEditor.tsx:33`）
- 编辑缓冲区不放进页面组件 state：只在「干净 → 脏」时 set 一次 dirty 标志；需要内容时从 view 读取（保存、草稿防抖写入时）。
- 两个 updateListener 合并为一个。
- 格式工具栏的激活态由工具栏自己订阅 view（`useSyncExternalStore` 或局部 state），去掉 `Read.tsx:1156` 每次光标移动的 `setFmtVer`。

### P7 冗余请求
- `AgentChat.tsx:785` 每个「@文件」引用不再各自请求 `/api/tree`，改用 store 中已有的 tree。
- `FileTree.tsx:489`：目录树变化时的 3 个请求合并去重，删掉 2.5 秒后的无条件重发（如确有必要，改为仅在上一轮失败时重试）。

### P8 后端建索引分片让出（`server/indexer.js`、`server/links.js`）
- `indexer.build` 的同步读文件循环与 `linkIndex._rebuildNow` 的逐文件计算：每处理完一个文件检查已用时间，超过 30ms 就 `await new Promise(setImmediate)` 让出事件循环。结果与顺序不变。

## 验收标准
通用：`npx tsc -b`；`npx eslint .` 错误数不增加；既有 `scripts/test-*.mjs` 全过；`npm run build`；`npm run test:e2e`、`e2e-filetree`、`test:retrieval:e2e` 不退化。

新增 `scripts/e2e-perf.mjs`（Electron，后端用临时数据目录 + 脚本生成的夹具库：一个 1.5MB 的 md、一个 3MB 的 txt、一个 2 万条记录的 json、一个含 5 张图片的 docx（python-docx 不可用时用 mammoth 可读的最小手写 docx）、以及 1000 个含常用字的小 md），用 16ms 定时器漂移法测帧间隔（与现有做法一致：`setInterval` 16ms，记录超过 50ms 的间隔），每项打印改动后的数值；与改动前的对照数值写在交付报告里（施工者先在开工前用同一脚本测一次基线）：
- E1（P1）打开 2 万条 json 后空闲 12 秒：最大帧间隔 < 50ms（改前每 5 秒一次卡顿）。
- E2（P2）1.5MB md 阅读态用 `webContents.sendInputEvent` 拖选 60 步：最大帧间隔 < 50ms，且 `scanHits` 调用次数（可在开发构建里经 `window.__wbPerf` 计数，计数器仅在 `import.meta.env.DEV` 下存在）≤ 1。
- E3（P3）docx 的 `/api/file` 响应不含 `data:image`，体积小于原来的 1/5；页面中图片可见且 `naturalWidth > 0`。
- E4（P4）在 1000 个小 md 中检索高频字：首屏 DOM 节点数 < 2500，滚动到底能继续加载。
- E5（P5）3MB txt 打开后折叠/展开侧栏 3 次：最大帧间隔 < 80ms；JSON 首屏 DOM 节点 < 3000。
- E6（P6）1.5MB md 原位编辑连续输入 40 字：最大帧间隔 < 50ms；React 提交次数（开发构建的 Profiler 计数）不超过 3。
- E7（P7、P1）概览页空闲 15 秒的 `/api/*` 请求数 ≤ 4；窗口隐藏 15 秒期间请求数为 0。
- E8（P8）`WORKBENCH_LAG_THRESHOLD_MS=150` 下对夹具库（复制 5 份达到约 5000 文件）冷启动，backend.log 中「建文本索引」「算内链」标签的 `[lag]` 行数为 0。

## 明确禁止
- 不新增 npm 依赖；不改算法结果；不修改既有测试断言。
- 性能计数器只能存在于开发构建（`import.meta.env.DEV`），生产包中不得出现。
- 产物无过程叙事注释；新文件超过 150 行分块写。
