# 规格：反馈第 2 批——RAG 与模型全程可见

## 背景与目标
统一口径（反馈分级、两条硬规则）见 `specs/2026-11-03-feedback-overview.md`，本批对应其中「第 2 批」清单。

RAG 相关的几类操作都会持续数秒到数十分钟：
- 模型的下载与导入，以及其中的 MLX 环境置备；
- 嵌入运行时的首次加载；
- 索引构建。

目前这些操作有的完全没有反馈，有的反馈是错的（进度条固定在 30%），还有的同步阻塞整个后端，导致所有进度轮询冻结。

**成功标准**：这些操作在任何时刻都能看到当前阶段、能算出进度的就显示进度、失败可见、该能取消的能取消；后端不再出现同步阻塞。

## 非目标
- 不改嵌入模型、切块算法、检索排序。
- 不做构建的「取消」：已有「暂停」，语义够用。
- 检索页里精确检索的「结果可能不完整」提示归第 4 批。
- 不新增依赖。

## 前置
在第 1 批交付的基础件之上施工：
- `notify`（`src/lib/notify.ts`）；
- `Button` 的 `loading`（`src/components/ui/button.tsx`）；
- `useDelayedFlag`（`src/hooks/useDelayedFlag.ts`）。

## 假设
- A1：模型规格（`server/rag/embed.js` 里每个后端的 `spec.files`）事先可能不知道各文件大小。总体进度按「已知文件总大小」累计：未开始的文件大小未知时，总体百分比按文件数折算，并在界面上标明是估算。
- A2：导入改为后台任务，和下载一样「立即返回、走轮询」。
- A3：运行时加载（MLX sidecar 拉起、ONNX 建会话）的耗时无法估计，只给阶段文字和已用时间，不给百分比。

## 现状
- `server/rag/embed.js`（`EmbedService`）：
  - `state` 与 `progress{file, bytes, total, done, files, host, attempt, speedBps}`；
  - `download()` 后台跑 `_runDownload`：先 `ensureVenv()`，再 `probeHosts`，然后逐个下载文件，每个文件下完做 sha256 校验；
  - `importDir()` 同步复制加哈希；
  - `ensureVenv()` 里用 `execFileSync('tar')`；
  - `ensureReady()` / `_load*()` 加载运行时。
- `server/rag/download.js`：`probeHosts` 与 `downloadFile`。
- `server/rag/manager.js`（`RagIndex`）：
  - `build()` 依次做：快照检查 → 等待文本索引（`whenIndexed`）→ 必要时清库（单个 DELETE 事务）→ 增量计划 → 逐文件切块与嵌入；
  - `pause()` 只设置标志位；
  - `status()` 提供 state / phase / done / total 等字段。
- `server/rag/routes.js`：
  - 构建路由是 `manager.build(...).catch(() => {})`，提前返回的错误被吞掉；
  - 导入路由会等同步导入完成才返回。
- `src/pages/RagManage.tsx`：
  - `run()` 不看返回体；
  - 只有下载时 1 秒轮询，其他时候 5 秒；
  - 进度条是手写的；
  - 测试台「测试」按钮没有任何忙碌态；
  - 设置页的「RAG 检索」tab 复用这个组件。
- `src/pages/Search.tsx`：智能检索结果区有「正在检索…」，但没有首次加载模型的阶段说明。
- `src/lib/types.ts` / `src/lib/api.ts`：RAG 的类型与接口。

## 设计
### 后端：状态字段
1. **模型状态**（`embed.status()`）
   - `state` 增加 `'importing'`。
   - `progress` 增加以下字段：
     - `phase`：`'env-extract' | 'env-install' | 'probe' | 'download' | 'verify' | 'copy'`
     - `phaseDetail`：给人看的一句话，例如「安装依赖 3/21」「校验 model.onnx_data」
     - `overallBytes` / `overallTotal`：已知的总量
     - `etaSeconds`：可能为 null
     - `startedAt`
   - 另外新增 `canCancel`。
2. **运行时状态**：`embed.status().runtime = { state: 'idle'|'loading'|'ready'|'error', phase: 'env'|'start'|'warmup'|null, startedAt, error }`，由 `ensureReady` 和 `_load*` 维护。
3. **索引状态**（`RagIndex.status()`）
   - `phase` 增加：
     - `'等待文本索引'`
     - `'清理旧索引'`（附带进度）
     - `'加载模型'`：嵌入运行时还没就绪时
   - 增加以下字段：
     - `currentFile`
     - `fileChunksDone` / `fileChunksTotal`：当前文件的块进度
     - `chunksPerSec`、`etaSeconds`
   - `state` 增加 `'pausing'`：从点击暂停到循环真正停下之间。
   - 提前返回的错误（如「资料库尚未扫描完成」）要写入 `state:'error', error`。
   - **状态必须在第一个 await 之前就切到 building**，否则等待文本索引期间前端看不到任何变化。

### 后端：去掉同步阻塞
4. **`ensureVenv`**：解压和安装都改成异步 `spawn`，同时更新 `phase` / `phaseDetail`。安装依赖要能按包计数：逐包安装或解析输出都可以，以实际代码为准。
5. **`importDir` 改为后台任务**：用流式复制，复制过程中边读边算 sha256。按字节更新进度，阶段依次为 `copy` 和 `verify`。
   - 路由立即返回 `{ ok:true, started:true }`。
   - 参数校验失败（缺少文件、目录不存在）要同步返回 `{ ok:false, error }`，前端必须显示这个错误。
6. **清库分批**：把一次性的 DELETE 改为按批删除（例如每批 2000 行）。批与批之间让出事件循环，同时更新「清理旧索引」的进度。
   - 「清库与写入新指纹在同一事务」所保证的语义要保持：中途中断后再续建，不会重复清库。做法可以是先写入一个「清理中」标记，清完再写新指纹；只要中断后再续建的行为正确即可。施工方要在报告里说明怎么保证的。
7. **sha256 校验阶段**：下载完一个文件开始校验时，`phase='verify'`，`phaseDetail` 写清楚正在校验哪个文件。

### 后端：取消
8. 新增 `POST /api/rag/model/cancel`。
   - 下载、导入、环境置备都可以取消。
   - 取消后删除半截文件，`state` 回到取消前的值（未就绪 / 就绪）。
   - 没有可取消的任务时返回 `{ ok:false, error:'没有进行中的任务' }`。

### 后端：路由
9. 构建路由先同步执行前置检查，失败时返回 409 和 `{ error }`；检查通过后台启动构建，再返回 `{ ok:true }`。
10. 修复 S1：模型已就绪时点「重新下载」，现在后端返回 `{ok:true, ready:true}`、什么也不做。改为 `download({ force:true })` 重新下载，未传 force 时行为不变。前端在模型已就绪时，按钮文案为「重新下载」，点击前用 Dialog 确认（不用 `window.confirm`）。

### 前端（`RagManage.tsx`，`Search.tsx` 只改智能检索部分）
11. `run()` 要读取返回体，遇到 `{ ok:false, error }` 时显示错误：页内错误条加 `notify`，`kind:'error'`。
    - 所有动作按钮用 `loading`。
    - 已有「暂停」中的状态时，暂停按钮显示「正在暂停…」。
12. **轮询节奏**：以下任一成立时 1 秒一次，否则 5 秒一次：
    - 模型处于 `downloading` 或 `importing`；
    - 运行时处于 `loading`；
    - 索引处于 `building` 或 `pausing`。
13. **模型进度区**
    - 第一行是阶段文字：
      - 准备 Python 环境：解压运行时，或安装依赖 n/N
      - 探测下载源
      - 下载 {file}（第 i/N 个文件）
      - 校验 {file}
      - 复制 {file}
    - 有字节量时，显示「总体」进度条，附百分比、已下载/总量、速度、剩余时间；下方再显示一条细的「当前文件」进度。
    - 阶段无法计量时（解压、探测），进度条用不确定态（循环动画），**不允许显示一个假的百分比**。
    - 提供「取消」按钮。
    - 进度条统一用 `src/components/ui/progress.tsx`；不确定态如果要扩展这个组件，就在组件内实现，不另造。
14. **索引进度区**
    - 阶段文字与总体进度，显示为「i/N 个文件」。
    - 当前文件名，以及块进度「块 j/M」。
    - 速度（块/秒）与剩余时间。
    - 「加载模型」阶段要显示：「首次加载嵌入模型，可能需要几十秒」，再加上已用秒数。
15. **测试台「测试」**（H1）与**检索页智能检索**（M4）
    - 请求期间按钮 `loading`，结果区显示加载态。
    - 若此时 `runtime.state === 'loading'`，加载态文字为「首次加载嵌入模型…（已用 N 秒）」。
    - 结果区的加载态用 `InlineLoading`，配合 `useDelayedFlag`：结果很快返回时不闪。
16. `src/lib/types.ts` 和 `src/lib/api.ts` 同步新增字段与接口。`ep`（Windows 上实际用的是 dml 还是 cpu）补进类型，在模型信息区显示一行「执行设备」。

## 边界情况
| 情况 | 期望 |
|---|---|
| 置备 MLX 环境时断网（uv 路径） | `state:'error'`，`error` 写清楚是哪一步失败；可以重试 |
| 下载中取消 | 半截文件已删除；再次点下载能从头开始；不会有两个下载同时进行 |
| 导入的目录缺文件 | 立即返回 `{ ok:false, error }`，前端显示 |
| 导入中断（磁盘满） | `error` 写人话，已复制的半截文件被清理 |
| 构建前快照不存在 | 返回 409，前端显示错误 |
| 等待文本索引期间点暂停 | 进入 `pausing`，等待结束后直接停在 paused，不开始嵌入 |
| 清库进行到一半时退出 | 再次构建时继续清理，不会出现新旧索引混杂 |
| 运行时加载失败 | `runtime.state:'error'`；检索和测试返回错误，前端显示，不会一直转圈 |
| 页面切走再回来 | 轮询恢复后阶段与进度正确，不会从 0 开始闪一下 |

## 实施步骤
1. 后端状态字段与「状态先于 await 切换」，加 `types` 和 `api`。
2. `ensureVenv` 异步化与阶段；`importDir` 后台化与流式哈希；校验阶段；取消。
3. 清库分批，加中断续建语义。
4. 构建路由前置检查、修复 S1。
5. 前端：模型进度区、索引进度区、测试台、智能检索、`run()`、轮询。
6. 测试与文档：`docs/ARCHITECTURE.md` 的 RAG 章节补充阶段字段和取消接口。

## 验收标准
- **G1**：`npx tsc -b`、`npx eslint .` 0 问题，`npm run build` 成功。
- **G2**：grep `server/rag/` 不再出现 `execFileSync`、`copyFileSync`、`spawnSync`、`readFileSync` 处理模型文件的调用。小配置文件除外，报告里要列出保留的调用并说明理由。
- **G3**：新增 `scripts/test-rag-feedback.mjs`（node），覆盖以下几项：
  - **导入**：用临时目录造一份带正确 sha 的假模型文件，体积约 50MB。调用导入后：
    - 路由或函数立即返回；
    - 导入期间另一个并发的 `status()` 调用能在 200ms 内返回，证明没有阻塞事件循环；
    - 进度单调不减，阶段依次为 copy 和 verify；
    - 完成后进入 ready。
  - **导入取消**：半截文件被删除，状态回到原值。
  - **缺文件导入**：立即返回 `{ ok:false, error }`。
  - **下载**：参照 `scripts/test-download.mjs` 里假下载源的写法，断言：
    - 阶段依次经过 probe、download、verify；
    - 总体字节进度单调不减；
    - 取消后半截文件已删除。
  - **清库分批**：造一个有 2 万个块的索引库，重建。断言：
    - 「清理旧索引」阶段有进度；
    - 清理期间 `status()` 在 200ms 内返回；
    - 中途模拟中断（在第 k 批后抛错）后再次构建，结果与一次跑完一致（文件数、块数相同）。
  - **构建前置检查**：没有快照时返回错误，并且错误进入了状态。
  - **等待文本索引**：在 `whenIndexed` 未完成时调用 build，`status().state` 立即变为 building，phase 为「等待文本索引」。
- **G4**：UI e2e（在 `scripts/` 下新增，或扩展现有 e2e）用 mock 后端（`backend:'mock'`，现有的 mock 测试后端）跑一次构建，断言：
  - 进度区出现阶段文字、文件计数和当前文件；
  - 点暂停后出现「正在暂停…」，最终变为 paused；
  - 测试台点「测试」后按钮立即 `aria-busy`。
- **G5**：在 mock 后端或可控的假运行时下，让 `runtime.state` 保持 loading 2 秒，断言测试台加载态文字含「首次加载嵌入模型」。如果现有 mock 无法控制加载时长，允许在 mock 后端内加一个由环境变量控制的延迟。只限 mock 后端，不得影响真实后端。
- **G6**：回归通过以下全部：
  - `scripts/test-*.mjs` 全部
  - `npm run test:e2e`
  - `e2e-filetree`
  - `test:retrieval:e2e`
  - `e2e-security`
  - `e2e-reader-regress`
  - `e2e-perf`
  - `git diff --check`

## 明确禁止
- 不新增依赖，不改嵌入和切块算法，不改检索结果。
- 不调大任何超时来掩盖阻塞。
- 不改第 1、3、4 批的范围（更新流程、助手、文件操作）。`Search.tsx` 只改智能检索的加载态。
- 不读写 `~/.xuewen-workbench`、`/Users/mayu/Downloads`。
