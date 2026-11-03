# 规格：反馈第 4 批——扫描与索引可见、文件操作与其余入口

## 背景与目标
统一口径见 `specs/2026-11-03-feedback-overview.md`，本批对应其中「第 4 批」清单。

两个核心问题：
1. **后台的扫描、文本索引和内链重建对用户不可见**，而且结果会悄悄缺漏：
   - 索引重建期间，精确检索静默返回不全的结果；
   - 反链面板 12 秒后放弃，给出假的空结果；
   - 扫描本身同步阻塞后端，期间所有轮询停摆。
2. **大量文件操作与杂项入口没有忙碌态，失败也不提示。**

本批分上、下两部分施工：
- 上半部分：扫描与索引状态可见。
- 下半部分：文件操作与其余入口的反馈。

成功标准：
- 任何时刻都能从界面看出后台在扫描还是在建索引，进行到哪了。
- 受影响的结果会标明「可能不完整」。
- 所有入口都有忙碌态，失败都有提示。

## 非目标
- 不改扫描规则、索引算法、内链算法和检索排序。
- 不改文件操作的接口语义：写操作仍然要等「立即可检索」之后才返回（`rescanAndIndex` 的约定保持不变）。
- 不新增依赖。

## 前置
在第 1 批基础件之上施工：`notify`、`Button loading`、`useDelayedFlag`。

## 现状
- `server/index.js` 的 `Lib`：
  - `scan-done` 之后后台依次执行 `indexer.build`、`linkIndex.rebuild`，再调用 `ragManager.onScanComplete`。
  - `this.indexing` 保存当前这次的 Promise。
  - `rescanAndIndex()` 的流程：等待扫描结束 → 重扫 → `await this.indexing`。
- `server/scanner.js` 的 `start()`：在 `setImmediate` 里**同步**调用 `scanTree`。
- `server/indexer.js`（`build` 一开始就清空 `texts`）、`server/links.js`：已经每 30ms 让出一次事件循环，但不报进度。
- `GET /api/status`：
  - 每个库返回 `scanning`、`watching`、`scannedAt`；
  - 没有 indexing 信息。
- `GET /api/links/*` 的响应里带有 `ready`、`building` 等字段，前端只拿来决定是否重试。
- `electron/startup.html`：只显示「正在扫描资料库：X」。多个库同时扫描时只显示最后一个，也没有计数。
- 前端涉及的入口文件见总览「第 4 批」，以下 `src/` 路径均以实际代码为准：
  - `Layout.tsx`（顶栏重扫图标、知识库切换）
  - `Search.tsx`（精确检索）
  - `BacklinksPanel.tsx`
  - `Dashboard.tsx`
  - `Setup.tsx`
  - `Settings.tsx`（屏蔽词表、清除忽略、元数据开关、诊断导出、预览结构、映射保存）
  - `FileTree.tsx` / `EntryMenu.tsx` / `entryOps.ts`（副本、粘贴）
  - `CreateEntryDialog.tsx` / `EntryActionDialogs.tsx`
  - `MetaImport.tsx`
  - `Read.tsx` / `Edit.tsx`（保存）
  - `WordReader.tsx`
  - `TxtReadBody.tsx` / `JsonViewer.tsx`
  - `editor/autoLinks.ts`（悬停卡片）
  - `editor/copyAsRendered.ts`
  - `AgentChat.tsx` 的导出对话
  - `DiagnosticsBanner.tsx`

## 设计（上）：扫描与索引状态可见
1. **扫描不再同步阻塞**：`scanTree` 改为分片执行的异步版本，每遍历约 30ms 就用 `setImmediate` 让出一次。
   - 扫描期间维护 `scanned`，即已遍历的文件数。
   - 结果必须与现有同步版本**完全一致**：同样的文件列表与顺序、同样的字段。
   - 同步版本如果还有其他调用方，就保留同步版本，并让两者共用同一份逐项处理逻辑，不能复制出两份规则。
2. **索引状态**：`Lib` 维护一个 `indexState` 对象：
   ```
   { phase: null | 'text' | 'links', done, total, startedAt }
   ```
   - `indexer.build`、`linkIndex.rebuild` 通过进度回调更新它。
   - 结束、或失败后，`phase` 都要回到 null；失败另记 `indexError`。
3. **`/api/status` 新增字段**：每个库增加 `scanned` 和 `indexing: { phase, done, total, startedAt }`；当前活动库在顶层也带一份。
4. **启动页**
   - 后端在扫描期间按库推送 boot 步骤，内容为库名和已扫描文件数，节流到 250ms 一次。
   - 有多个库时，显示「正在扫描 N 个资料库：A（1234 个文件）、B（…）」。
   - 扫描完成后进入应用，后续的索引由第 5 条的全局指示接手。
5. **全局后台指示**：在顶栏重扫图标旁边加一个小指示（新增组件，放在 `Layout.tsx` 顶栏）。
   - 扫描中显示「正在扫描 · 已扫 N」，建文本索引显示「正在建立索引 i/N」，算内链显示「正在更新链接 i/N」。
   - 用 `useDelayedFlag`，状态持续不到 1 秒的不显示。
   - 状态来自 `/api/status` 的轮询。有后台任务进行时，轮询节奏为 1 秒；第 1 批已经让轮询节奏可以变化，这里沿用同一个机制，不新增请求循环。
   - 顶栏重扫图标在扫描和索引期间都保持转圈。`rescan()` 失败时用 `notify` 提示，失败分支不再被 `finally` 静默吞掉。
6. **不完整结果标注**
   - **精确检索**：当前库处于索引中（`phase` 为 text）时，结果区顶部显示提示：「索引更新中（i/N），结果可能不完整」，并在索引完成后自动重新查询一次。
   - **反链面板**：不再在 12 秒后给出假的空结果。
     - 只要 `building` 或 `ready === false`，就显示 `InlineLoading`，文字为「正在建立链接索引…」，并持续轮询；每 2 秒一次，上限 5 分钟。
     - 超过上限时显示「链接索引尚未就绪」，并提供「重试」按钮。
     - 只有 `ready === true` 且列表为空，才显示「还没有其他文档提到本篇」。
   - 阅读页自动链接、文件树引用计数这类「索引未就绪就只重试一次」的地方，统一改为：未就绪时订阅全局状态，等到就绪后再取一次，不再固定重试 N 次。可以写一个共用的小 hook，比如 `useWhenIndexReady`。
7. **添加并打开知识库**（`Setup.tsx`）：按钮 `loading`，下方显示「正在扫描… 已扫 N 个文件」。这需要扫描异步化之后状态可以被轮询到，否则不成立。

## 设计（下）：文件操作与其余入口
8. **耗时写操作的统一模式**：创建、重命名、移动、删除、创建副本、粘贴、元数据导入、保存屏蔽词表等。
   - 按钮用 `loading`，或对话框锁定。
   - 等待超过 1.5 秒时，次要文字切换为「正在更新索引…」：用 `useDelayedFlag(active, 1500)` 实现，不需要后端提供阶段信息。
   - 完成后：对话框类操作关闭即可；没有对话框的操作（副本、粘贴、悬停卡片）用 `notify` 提示完成。
   - 失败一律用 `notify` 加 `kind:'error'`；原来的 `window.alert` 也换成 `notify`。
9. **复制文件夹**：`fs.cpSync` 改为 `fs.promises.cp`。
10. **Word 首次打开**、**大 TXT / JSON**
    - 在 `PageLoading` 上增加可选参数 `slowText` 和 `slowAfterMs`，在组件内部实现，不另造组件。
    - Word 设为 `slowText = '正在转换 Word 文档，首次打开较慢…'`，`slowAfterMs = 1500`。
    - 大 JSON 的 `JSON.parse` 和 TXT 分段都推迟到加载态完成首帧绘制之后再执行（用 `setTimeout(0)` 或 `requestAnimationFrame` 之后）。CSS 转圈动画在主线程忙时仍会继续转。
11. **其余**
    - 诊断导出（设置页和异常横幅）：按钮 `loading`，完成后用 `notify` 提示路径。
    - 清除忽略、预览结构、映射保存、RAG 无关的各类设置保存：按钮 `loading`，并补上 catch，失败时 `notify`。
    - 「显示元数据文件」开关：保存后由第 5 条的全局指示显示重扫过程，提示文案改为「正在刷新文件树…」，刷新完成后再提示一次「已显示」。
    - 切换知识库：顶栏的库名旁显示转圈，直到新库的 config 和 tree 都加载完；期间内容区不显示旧库的数据，用 `PageSkeleton`。
    - 概览页：加载中用骨架屏；只有加载完成且确实为空，才显示「暂无数据」；错误要显示，不再被吞掉。
    - 复制为渲染格式：渲染管线尚未就绪、退回纯文本时，用 `notify` 加 `kind:'info'` 说明「已复制为纯文本（格式渲染尚未就绪，稍后再试可保留格式）」。
    - 导出对话：`notify` 提示「已在浏览器中打开导出页」。
    - 悬停卡片的「忽略此链接」和「加入屏蔽词表」：成功和失败都要 `notify`。
    - 保存（阅读页原位编辑、编辑页）：「保存中…」前加转圈；保存成功的提示保持现状。

## 边界情况
| 情况 | 期望 |
|---|---|
| 扫描中途目录被删除或不可读 | 扫描失败进入错误，`scanning` 复位，指示消失，`notify` 报错 |
| 连续多次触发重扫 | 状态正确合并，指示不闪烁，最终停在完成态 |
| 索引期间切换知识库 | 指示切到新库的状态，旧库的进度不串到新库 |
| 索引失败 | 指示消失；顶栏显示一次错误 `notify`；精确检索的提示不能一直挂着 |
| 极小的库（索引 < 1 秒） | 什么指示都不出现，不闪 |
| 大库首扫 | 启动页计数持续增长；进入应用后，顶栏指示接着显示索引进度 |

## 实施步骤
- **上半部分**：
  1. 扫描异步化与 `scanned` 计数，并做一致性测试。
  2. `indexState` 与 `/api/status` 新字段、类型。
  3. 启动页多库计数。
  4. 全局指示与轮询节奏。
  5. 精确检索、反链、自动链接与引用计数的就绪处理。
  6. 添加知识库的扫描计数。
- **下半部分**：第 8–11 条。最后更新文档，在 `docs/ARCHITECTURE.md` 补充状态字段与全局指示。

## 验收标准
### 上半部分
- **G1**：`npx tsc -b`、`npx eslint .` 0 问题，`npm run build` 成功。
- **G2**：新增 `scripts/test-scan-async.mjs`，对比新旧扫描结果：
  - 用仓库现有的测试语料，以及一个临时造的语料：包含 5000 个文件、多层目录、隐藏文件、元数据文件、不支持的扩展名；
  - 新异步扫描与旧同步扫描的结果做深比较，必须完全相等，`scannedAt` 除外。
  - 旧同步版本可以通过 `git show main:server/scanner.js` 落到临时文件里再导入，不要保留在仓库中。
- **G3**：同一个脚本或新脚本断言：扫描 5000 个文件期间，并发的一个计时器回调延迟不超过 100ms，证明扫描不再阻塞事件循环；`scanned` 单调递增，最终等于文件总数。
- **G4**：`/api/status` 在索引期间返回 `indexing.phase` 为 text 或 links，并带有 done/total；结束后 `phase` 为 null。用 node 脚本拉起后端验证，参照现有的 `test-*.mjs` 写法。
- **G5**：UI e2e：
  - 构造一个足够大的语料，让索引持续数秒。重扫后断言顶栏出现「正在建立索引」，结束后消失。
  - 此期间执行精确检索，断言出现「结果可能不完整」提示，索引完成后提示消失、结果自动刷新。
  - 打开反链面板，断言索引未就绪时显示「正在建立链接索引」，不会出现「还没有其他文档提到本篇」；就绪后显示正确的反链。
- **G6**：`e2e-filetree`、`e2e-perf` 等既有用例全部通过。尤其 `e2e-perf` 的 E1，即空闲最大卡顿，不得劣化：要贴出改前和改后的数字。

### 下半部分
- **G7**：UI e2e 至少覆盖以下几项：
  - 创建副本：伪造 `/api/file/duplicate` 延迟 2 秒，断言 1.5 秒后出现「正在更新索引」，完成后出现完成 toast。
  - 悬停卡片「加入屏蔽词表」的失败路径出现错误 toast。
  - 诊断导出按钮的 `aria-busy`。
  - 切换知识库期间不显示旧库数据，用骨架屏代替。
  - 概览页加载中不显示「暂无数据」。
- **G8**：grep `src/` 中的 `window.alert(`，结果为 0；本批涉及的文件里不再有用户操作失败时的 `catch {}` 空吞。确实属于预期内、可忽略的情况必须写注释说明，报告中列出保留的位置。
- **G9**：回归通过以下全部：
  - `scripts/test-*.mjs` 全部
  - `npm run test:e2e`
  - `e2e-filetree`
  - `test:retrieval:e2e`
  - `e2e-security`
  - `e2e-reader-regress`
  - `e2e-perf`
  - `git diff --check`

## 明确禁止
- 不改扫描规则、索引、内链和检索的结果。
- 不改写操作「等到可检索才返回」的语义。
- 不新增依赖。
- 不改第 1–3 批的范围。
- 不读写 `~/.xuewen-workbench`、`/Users/mayu/Downloads`。
