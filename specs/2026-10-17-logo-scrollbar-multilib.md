# 规格：学问 Workbench — 应用 Logo、原生控件主题化、多资料库工作区

日期：2026-10-17 ｜ 状态：已定待施 ｜ 读者：施工者（无对话上下文也可施工）

## 背景与目标

学问 Workbench（Electron + React19/Vite/Tailwind + Express，本地语料工作台）目前：① 全项目没有任何图标；② 有三套外观主题（A 宣纸 / B 极简 / C 夜读，`src/styles/themes.css`），但滚动条等浏览器原生控件仍是默认样式，与主题脱节；③ 后端是单数据源架构（`server/data/config.json` 存单个 baseDir，scanner/indexer/linkIndex 均为单例），一次只能打开一个数据源。

本任务做成三件事：
1. 为应用设计并生成 Logo，集成到 favicon、Electron 窗口图标、安装包、界面顶栏与资料库管理页。
2. 全局统一原生控件样式：滚动条（上下/左右）、::selection、range 滑杆、checkbox/radio 的 accent、Settings 页两处原生 select 换成 shadcn Select——全部跟随三套主题令牌。
3. 把「数据源」升级为「资料库」：可同时打开多个、可从工作区移除、界面提供切换器；UI 文案统一改称「资料库」。

成功标准：`npm run build`、`node scripts/acceptance.mjs`（含新增多资料库章节）、`npm run test:e2e` 全部通过；三主题下滚动条与原生控件颜色随主题；mac 打包产物带应用图标。

## 非目标

- 不做跨资料库的联合检索、合并目录树、跨库跳转（每库数据天然按 dsId 隔离，保持）。
- 不做资料库重命名、自定义图标、排序管理。
- 不改 `.meta.json` 旁注、扫描算法、自动内链（links.js/linkMatch.js）的任何逻辑。
- 不引入任何新 npm 依赖（shadcn `ui/select.tsx`、`ui/dropdown-menu.tsx`、`ui/alert-dialog.tsx` 已在库中）。
- 移除资料库时**不删除** `server/data/sources/<dsId>/` 下的任何派生数据（最近记录/草稿缓存/集合/备份），也不碰语料磁盘文件。
- Logo 不做多主题变体，单一 mark 三主题通用；不做启动画面。

## 假设（拍板项，用户可否决）

1. **Logo 方向**：宣纸底 + 朱砂印风格，印文「学问」，平色、无渐变，与主题 A 调性一致（朱砂 #b23a24 / 纸 #f7f1e3）。AI 生图产出，不满意可迭代重生成。
2. **"添加 logo 后应用到 APP 中"** = 集成到：浏览器 favicon、Electron 窗口图标、mac/win 安装包图标、顶栏左侧、资料库管理页头部。窗口标题维持「学问 Workbench」。
3. **多资料库交互模型**：顶栏资料库切换器 + 「当前资料库」作用域。所有页面（树/检索/阅读/编辑/设置）作用于当前库；切换库即导航回概览页。"同时打开" = 所有已打开库的 chokidar 监听与索引常驻内存，切换即时无重扫。
4. **"从工作区删除"** = 从打开列表移除（停监听、卸内存索引、写回 config），磁盘语料与派生数据全保留；重新添加同目录时因 dsId（路径哈希，`server/store.js dsIdFor`）不变，最近记录/集合/草稿自动回归。
5. **文案改称**：用户可见文案「数据源」→「资料库」；后端 API 路径、字段名（dsId/ds/baseDir）与数据库形状**不变**，保证 acceptance/e2e 脚本向后兼容。

## 现状（侦察结论）

| 文件 | 说明 |
|---|---|
| `index.html` | 无 favicon 链接、无 public/ 目录 |
| `electron/main.js` | BrowserWindow 无 icon 选项；package.json build 无 icon 配置 |
| `src/styles/themes.css` | 三套主题令牌（shadcn HSL 三元组 + --wb-* 原始值），`.dark` 深色阅读覆盖层 |
| `src/index.css` | 无任何 scrollbar/selection/accent 规则；全项目 `overflow-auto` 容器（侧栏/主区/reader/pre/.table-scroll/对话框）全用浏览器默认滚动条 |
| `src/pages/Settings.tsx` L127/L139 | 两处原生 `<select>`（正文字体/阅读主题）；L150-174 与 `src/pages/Read.tsx` L335-349 共 9 处原生 `<input type="range">`（默认蓝色滑杆） |
| `server/store.js` | `getConfig()/saveConfig(baseDir)` 单库；`dsIdFor()` 路径 sha1 前 12 位；`getState/setState/cacheDir/backupDir` 已按 dsId 隔离 |
| `server/index.js` | 模块级单例 `scanner/indexer/linkIndex` + `currentDsId`；约 40 条路由直接引用这些全局量；`resolveWithin/findFile/requireSource/rescanAndIndex` 均隐式用全局 scanner |
| `server/scanner.js` | Scanner 类已有 `stopWatch()`（chokidar close）与 `generation` 计数 |
| `src/lib/api.ts` | 全部前端请求收口在 `req()` + `rawFileUrl()`；无 ds 参数（依赖服务端 currentDsId） |
| `src/components/editor/livePreview.ts` L50 | 直接拼 `/api/file/raw?path=` URL（图片预览），也需带 ds |
| `src/store/app.tsx` | AppProvider：config/tree/loading/dsId + 5 秒轮询 `/api/status`；`generation` 变化即重取树 |
| `src/pages/Setup.tsx` | 单数据源配置页（输入/测试/保存加载） |
| `src/lib/drafts.ts` | 草稿/阅读位置已按 `wb:draft:<dsId>:<path>` 隔离 ✓ |
| `scripts/acceptance.mjs` | 43+ 项 API 验收；§16 已有"独立服务+临时数据目录"模式可仿照；§14 检查 themes.css 变量清单 |
| `scripts/e2e-editor.mjs` | 多次 `POST /api/config {baseDir}` 切换数据集后跑编辑器场景——**新语义必须保持该用法不变** |

必须复用的现有设施：`ui/select.tsx`、`ui/dropdown-menu.tsx`、`ui/alert-dialog.tsx`、`extIcon`、主题令牌体系、`dsIdFor`、按 dsId 隔离的 store 层、Scanner.stopWatch。

## 设计

### A. Logo

1. 用 UniAPI 文生图（`~/.claude/skills/image-gen/gen.py`）生成 1024×1024 PNG，prompt 要点（文字加引号防乱码）：
   > Flat minimalist app icon, rounded square, warm cream paper background (#f7f1e3), centered bold cinnabar red (#b23a24) Chinese seal-stamp carving with the two characters "学问", subtle paper grain, no gradients, no drop shadow, clean sharp edges, generous margin, centered composition
   产出候选 ≥2 张，人选一张（印文字形清晰、小尺寸可辨）。
2. 尺寸派生（macOS `sips`，源文件 `assets/logo-master.png`）：
   - `build/icon.png`（1024 原尺寸，electron-builder 图标源）
   - `public/logo-512.png`、`public/logo-192.png`、`public/logo-64.png`、`public/logo-32.png`
3. 集成点：
   - `index.html` `<head>` 加：`<link rel="icon" type="image/png" sizes="32x32" href="/logo-32.png">`、`<link rel="apple-touch-icon" sizes="180x180" href="/logo-192.png">`（Vite 会把 public/ 拷进 dist 根，打包模式服务端托管 dist 时同样生效）。
   - `electron/main.js` BrowserWindow 选项加 `icon: path.join(ROOT, 'build', 'icon.png')`。
   - `package.json` `build` 加 `"icon": "build/icon.png"`（electron-builder 自动转 icns/ico）。
   - `src/components/Layout.tsx` 顶栏最左（折叠按钮之前）加 `<img src="/logo-32.png" alt="学问 Workbench" className="w-6 h-6 rounded-[5px] shrink-0" />`。
   - `src/pages/Setup.tsx`（改造后的资料库管理页）头部展示 `logo-64.png` + 产品名「学问 Workbench」。

### B. 原生控件主题化

全部追加在 `src/index.css` 的 `@layer base` 内，**只引用既有主题令牌**（hsl(var(--...))），令牌随 A/B/C/.dark 级联自动变色，不新增变量：

```css
* { scrollbar-width: thin; scrollbar-color: hsl(var(--muted-foreground) / 0.35) transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner, ::-webkit-scrollbar-button { background: transparent; display: none; }
::-webkit-scrollbar-thumb {
  background: hsl(var(--muted-foreground) / 0.35);
  border: 3px solid transparent; background-clip: padding-box;
  border-radius: 9999px; min-height: 32px;
}
::-webkit-scrollbar-thumb:hover { background-color: hsl(var(--muted-foreground) / 0.6); }
::selection { background: hsl(var(--primary) / 0.22); }
input[type="checkbox"], input[type="radio"], input[type="range"] { accent-color: hsl(var(--primary)); }
```

覆盖面：全局所有滚动容器（含侧栏、阅读区、`.reader pre`、`.table-scroll`、CodeMirror `.cm-scroller`、shadcn 对话框/下拉内部滚动）——webkit 伪元素作用于一切 overflow 容器，无需逐个改。Firefox 走 `scrollbar-width/scrollbar-color`。

`src/pages/Settings.tsx` 两处原生 `<select>` 换成 `ui/select.tsx`（Select/SelectTrigger/SelectValue/SelectContent/SelectItem），选项值不变（font: serif/sans/mono；theme: light/dark），样式与同页其他控件一致（h-8 文字 sm）。

审计结论（其余项已达标，不动）：shadcn 组件（dialog/tooltip/progress 等）走令牌 ✓；代码高亮已有 `highlight.js/styles/github-dark.css` ✓；reader 内 checkbox 已有 accent-color（全局规则后冗余但无害）✓。

### C. 多资料库 — 后端

**配置文件 v2**（`server/data/config.json`，由 `server/store.js` 管理）：

```json
{ "version": 2,
  "libraries": [ { "id": "<dsId>", "baseDir": "/abs/path", "name": "ds-a", "addedAt": "ISO" } ],
  "activeId": "<dsId|null>" }
```

- 读：v1 `{baseDir,savedAt}` 自动迁移为单库 v2（内存迁移，下次保存落盘 v2）；损坏回退空。
- `store.js` 新增：`listLibs()` / `upsertLib(baseDir)`（存在同 id 则只置 active；否则追加+置 active）/ `removeLib(id)`（移除条目；若 activeId==id 则回落剩余第一项或 null）/ `setActiveLib(id)`。`saveConfig(baseDir)` 保留为 `upsertLib` 的别名（老调用点兼容）。

**运行时**（`server/index.js` 重构）：

- `class Lib { id, name, baseDir, scanner, indexer, linkIndex, indexing }`；`libs = new Map<id, Lib>`；`activeId`。
- 每个 Lib 构造时挂自己的 `scanner.on('scan-done')` → 依次 `indexer.build(snapshot)`、`linkIndex.rebuild(snapshot, indexer)`（逻辑照抄现全局版）。
- `resolveLib(req)`：`req.query.ds || req.body?.dsId || req.body?.dataSourceId || activeId`；找不到且提供了 ds → `404 {error:'资料库未打开'}`；无任何库 → 409（现状文案不变）。**所有既有路由**改为 `const lib = resolveLib(req)` 后用 `lib.scanner/lib.indexer/lib.linkIndex/lib.id`，helper（`resolveWithin/findFile/requireSource/rescanAndIndex/checkDsId`）加 lib 入参。路由路径、响应字段名一律不变；响应中的 `dsId` = 目标库 id。
- `POST /api/config {baseDir}`：= 添加或激活（同目录重复添加 → 仅激活）。若该 id 已在 libs 中：置 active 即可；否则 new Lib + 首扫 + startWatch + 写配置。响应 `{ok, ...getConfigResponse()}`。
- 新路由：
  - `GET /api/libraries` → `{ libraries:[{id,name,baseDir,status}], activeId, generation }`
  - `POST /api/library/activate {ds}` → `{ok}`（未知 ds 404）
  - `POST /api/library/remove {ds}` → 停 `lib.scanner.stopWatch()`、从 Map 与配置删除 → `{ok, activeId}`
- `GET /api/config` 响应在旧字段（configured/baseDir/dsId/status/generation）基础上**新增** `libraries`、`activeId`。`generation = libVersion * 1000000 + 当前库 scanner.generation`（libVersion 在任何增/删/激活时 +1）。
- `GET /api/status`：旧字段（=当前库）+ 新增 `libs: { <id>: {scanning, watching, scannedAt} }`。
- `boot()`：恢复**全部**库（逐个 new Lib + rescan + startWatch）；某库目录不可访问时记日志、其 status 呈现错误但不阻塞其他库；activeId 失效则回落第一项。
- 注意：`parseWord(lib.id, ...)`、`backupDir(lib.id)`、`getState(lib.id, ...)` 均已按 id 隔离，直接换引用即可。

### D. 多资料库 — 前端

- `src/lib/api.ts`：模块级 `let scopeDs: string | null = null`；新增 `setScope(ds)`（同时供 `rawFileUrl` 与 `src/components/editor/livePreview.ts` 导入使用的 `getScope()`）。`req()` 与 `rawFileUrl()` 统一追加 `ds=<scopeDs>` 查询参数（有参数拼 `&`，没有拼 `?`；scopeDs 为 null 时不追加，回落服务端 active——兼容启动首拉）。
- `src/lib/types.ts`：`ConfigResponse` 新增 `libraries?: LibraryInfo[]`、`activeId?: string | null`；`export interface LibraryInfo { id: string; name: string; baseDir: string; status: ScanStatus }`。
- `src/store/app.tsx`：
  - state 增加 `libraries: LibraryInfo[]`；`config` 不变（描述当前库）。
  - `refreshConfig`：拉 `/api/config` 后 `setApiScope(cfg.dsId)`；树重取条件改为 `cfg.generation !== prevGen || cfg.dsId !== prevDsId`。
  - 新增 `activateLib(id)`：`api.activateLibrary(id)` → `refreshConfig()`；`removeLib(id)`：`api.removeLibrary(id)` → `refreshConfig()`（若移除的是当前库，服务端已回落 activeId，前端跟随）。
  - 轮询 `/api/status`：比较 `libs[active].scannedAt` 变化则 `refreshConfig()`。
- `src/components/Layout.tsx` 顶栏：原「baseDir 文字链接」替换为资料库切换器（`ui/dropdown-menu.tsx`）：触发器 = `Database` 图标 + 当前库名（truncate）+ 文件数（沿用原 status 文案）；菜单 = 各库条目（Check 标当前，显示 name+文件数，点击 `activateLib`）+ 分隔线 + 「添加资料库…」（→ /setup）+「从工作区移除当前资料库…」（`ui/alert-dialog.tsx` 确认：说明不删磁盘文件、停监听；确认后 `removeLib` 并 `navigate('/')`）。顶栏最左加 logo（见 A）。移除后 0 库时 RequireSource 自然导去 /setup。
- `src/pages/Setup.tsx` 改造为「资料库管理」：保留输入/测试/「添加资料库」流程（`api.saveConfig` 语义已是添加+激活）；新增已打开资料库列表（name、baseDir、扫描状态、文件数、移除按钮带确认）；头部 logo + 「学问 Workbench」。文案「数据源」→「资料库」。
- 文案替换（用户可见字符串，含 `title` 属性；代码注释顺手改，API 字段名不动）：Layout/Dashboard/Setup/Settings/Read/Edit/Search/FileTree/CreateEntryDialog/EntryActionDialogs/app.tsx 等文件中的「数据源」→「资料库」，措辞按上下文微调（如"尚未配置数据源"→"尚未打开资料库"）。
- 路由不变（/、/setup、/browse、/read/*、/edit/*、/search、/settings），全部作用于当前库；库切换后由切换器统一 `navigate('/')`。Read/Edit 已有 `f.dsId !== dsId` 旧响应丢弃守卫，天然兼容。

### 核心流程

- **添加**：/setup 输入目录 → 测试 → `POST /api/config`（服务端 upsert+激活+首扫+监听）→ 前端 refreshConfig（scope 切到新库、拉树）→ 若从 /setup 发起则 `navigate('/')`。已在库内 → 仅激活，不重扫。
- **切换**：切换器点选 → `POST /api/library/activate` → refreshConfig → navigate('/')。旧库监听与索引保留。
- **移除**：确认框 → `POST /api/library/remove` → 服务端停监听、卸 Map、写配置、activeId 回落 → 前端 refreshConfig（scope 跟随新 active）→ navigate('/')（0 库则去 /setup）。
- **重启恢复**：boot() 逐库恢复扫描+监听；activeId 或首库为当前。
- **并发/过期**：前端所有响应守卫比较 `dsId`（现状机制），切库后旧库响应被丢弃；服务端每请求显式定位 lib，无跨请求状态。

## 边界情况

- 移除正被编辑的当前库：前端先走 Edit 页 useBlocker 未保存拦截的常规导航语义（确认后丢弃）；服务端不感知编辑态，直接卸载。可接受。
- 同一目录（大小写规范化后同 id）重复添加：激活既有，不建重复实例。
- 库根目录运行中被移除/拔盘：chokidar watch-error → 该库 status 呈现不可用，config 仍列出可手动移除；不自动摘除。
- `?ds=` 指向未打开库：404 `{'error':'资料库未打开'}`。
- 0 库：`/api/tree` 等维持 409「尚未配置数据源或扫描未完成」（文案改「尚未打开资料库」）。
- 旧 v1 config.json：读取自动迁移，行为等同单库已打开。
- 打开库数量无硬上限（每库一个 chokidar 实例；文档注明重度场景内存代价）。
- acceptance/e2e 的 `POST /api/config` 连续切换：每次 upsert+激活，最终累积多库但行为与旧"切换"一致（当前库总是最新指定者）。

## 实施步骤（每步验收通过后 git 提交一次）

0. **基线整理**：跑 `node scripts/acceptance.mjs` 确认工作区既有未提交改动（自动内链功能）测试通过，单独提交入库，获得干净基线。
1. **Logo**：生成图 → `assets/logo-master.png` 人选 → 派生 5 个尺寸 → 集成 5 个点（index.html / electron main / package.json / Layout / Setup 预留位）→ `npm run build` + 视觉确认。
2. **原生控件主题化**：index.css 全局规则 + Settings 两处 select 换 shadcn → 三主题人工目检（A/B/C 下滚动条/滑杆/下拉/选区变色）+ build。
3. **后端多资料库**：store.js v2 配置 + index.js Lib 化重构 + 新路由 + boot 恢复 + acceptance 新增 §17（多库增删切换/隔离/状态恢复/v1 迁移）→ 全量 acceptance 通过。
4. **前端多资料库**：api scope / types / store / Layout 切换器 / Setup 改造 / 文案替换 → build + `npm run test:e2e`。
5. **收尾**：README 与 docs/ARCHITECTURE.md 增补（多资料库语义、logo、滚动条）→ mac 打包验证图标（`npm run electron:build:mac`，检查 .app 内 icon.icns 与 zip 产物）。

## 验收标准（机械判定）

1. `npm run build` 退出码 0。
2. `node scripts/acceptance.mjs` 全部通过，且包含新增多资料库章节，至少覆盖：
   a. 临时数据目录+独立端口起服（仿 §16）；v1 `{baseDir}` 预写 → 首次 GET /api/config 迁移为 1 库且 configured=true；
   b. 添加 A、B 两库 → GET /api/config `libraries.length===2`、activeId 指向 B；
   c. `/api/tree?ds=<A>` 与 `/api/tree`（=B）内容互不串库（各自独有文件只在各自树中）；
   d. `/api/status` 的 `libs` 含两库扫描状态；
   e. `/api/search?q=…&ds=<A>` 只命中 A 库内容；
   f. `/api/recents`（ds=A）写入 → `POST /api/library/remove {ds:A}` → libraries.length===1、activeId===B、`/api/tree?ds=<A>` 404 → 重新 POST /api/config {A} → recents 恢复（ getState 未被清除）；
   g. `POST /api/library/activate {ds:B}` 后 GET /api/config.dsId===B。
3. `npm run test:e2e` 通过（证明 `POST /api/config` 切换语义向后兼容、编辑器场景无回归）。
4. 主题与控件（源码级断言，写进 acceptance §14）：`src/index.css` 含 `::-webkit-scrollbar`、`scrollbar-width`、`accent-color`、`::selection` 四个关键字；`src/pages/Settings.tsx` 不再含原生 `<select`。
5. Logo（源码级断言 + 构建级）：`build/icon.png` 与 `public/logo-{512,192,64,32}.png` 存在且尺寸正确（`sips -g pixelWidth`）；`index.html` 含 `logo-32.png`；`electron/main.js` 含 `icon:`；`package.json` build 含 `"icon"`；Layout 顶栏渲染 `<img` 引 logo（grep）。
6. 文案：`grep -rn "数据源" src --include='*.tsx' --include='*.ts'` 仅剩代码注释或无用户可见字符串（人工复核列表为空或均为注释）。
7. mac 打包：`release/` 下生成 `*.app`（zip 解开或直接检查）内 `Contents/Resources/icon.icns` 存在。

## 明确禁止

- 禁止新增 npm 依赖或改 package.json 的 dependencies（build.icon 配置项除外）。
- 禁止改名/删除任何既有 `/api/*` 路由或其响应字段（只允许新增字段与新路由）。
- 禁止改动 `server/meta.js`、`server/scanner.js` 扫描算法、`server/linkMatch.js`、`server/links.js` 内部逻辑（links.js 仅允许因 Lib 化换调用点）。
- 禁止顺手重构无关代码、改格式化风格；diff 只做规格内的事。
- Logo 素材不得带渐变、投影、边框装饰（平色印章风）；不得引入字体文件。
