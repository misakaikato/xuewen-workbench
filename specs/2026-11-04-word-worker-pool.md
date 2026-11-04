# 规格：Word 解析移出后端主线程（worker 线程池 + 超时 + 失败入缓存 + 正文大小上限）

## 背景与目标

后端（Electron utilityProcess 里的 Node，入口 `server/index.js`）用同一个 JS 主线程响应界面请求和建文本索引。2026-11-04 在一台 Windows 测试机（16 核、64GB 内存，知识库指向一个 473 个文件的 Downloads 目录）上实测到：

- 建文本索引期间后端事件循环反复阻塞 10–57 秒（`backend.log` 的 `[lag]` 行），`/api/status` 要 20–30 秒才返回，界面卡死。
- 卡顿期间后端进程 CPU 持续 100%–210%（每 2 秒采样、连续 90 秒），内存从 254MB 涨到 515MB，系统空闲内存 42GB。结论：主线程在计算，不是换页、也不是被挂起。
- 卡顿标签每次启动都是同一批「解析 Word 新网账号认证授权书.docx 等 7 项」，这 7 个 Word 同时解析、持续数分钟都没有完成。
- 应用的 Word 解析缓存（`<数据目录>/knowledge/<dsId>/cache/word-*.json`）自 2026-11-03 21:07 起没有再写入过一条：解析没完成就不写缓存，用户退出应用后下次启动从头再来，永远在原地打转；文本索引从此一次也没建完。

根因：Word 转换（mammoth 解 docx、word-extractor 解 doc）是大段纯 JS 计算，跑在后端主线程上。现有的「每个文件之间超过 30ms 让出一次」只在文件之间生效，挡不住单个文件几十秒的转换。

**成功标准**：任意内容的 Word 文档都不再阻塞后端主线程；单个文档解析有时限，超时或失败的结果写入缓存、下次不再重试；超大文本文件不把正文读进索引。

## 非目标

- 不改「算内链」（`server/links.js`）的执行线程。它已有分步让出（`server/linkMatch.js` 的生成器 + `sliceYielder`）。本规格落地后在测试机上复测，若 `[lag]` 仍出现「算内链」标签，另立规格。
- 不改 Word 解析结果的内容：`html`、`text` 与现在逐字一致（docx 仍是 `mammoth.convertToHtml` + `mammoth.extractRawText` 两次调用，不改成从 html 派生 text）。
- 前端只在设置页加一个「Word 解析并发数」选项（见设计第 6 项），其余前端不改。
- 不改 `/api/file` 打开文本文件的路径（`readTextPreserve` 同步读，属用户主动打开单个文件，另议）。
- 不改扫描器（`server/scanner.js`）与 RAG 模块。
- 不引入任何新依赖。

## 假设（执行前请用户扫一眼）

1. **Word 解析并发数是用户设置项**：`ui-settings.json` 新字段 `wordConcurrency`，整数 1–8，缺省 2；设置页「阅读与外观」里可改，保存后立即对线程池生效，无需重启。
2. **单个 Word 解析时限 120 秒**，环境变量 `WORKBENCH_WORD_TIMEOUT_MS` 可覆盖（测试用）。超时即终止该 worker 并重建。
3. **正文大小上限**：建文本索引时，`.md/.json/.txt/.html/.htm` 超过 **16MB**、`.doc/.docx` 超过 **64MB** 的文件不读正文，只按文件名收录（文件树、文件名检索照常可见）。上限常量集中定义，环境变量 `WORKBENCH_TEXT_INDEX_MAX_BYTES`、`WORKBENCH_WORD_INDEX_MAX_BYTES` 可覆盖（测试用）。
4. **失败缓存只约束建索引**：建索引遇到失败缓存（同 mtime）直接跳过；用户在界面上主动打开该 Word 时重新尝试一次（在 worker 里、受时限约束，不会卡界面），成功则覆盖失败缓存，再失败则更新失败缓存并把原因返回界面。
5. 「算内链」暂不动（见非目标）。

## 现状

| 文件 | 说明 |
|---|---|
| `server/word.js` | Word 解析全部逻辑：`findSoffice`/`wordCapability`、`makeImageSink`（图片写到 `cache/word-assets/<键>-<mtime>/`）、`docxToHtml`、`docViaSoffice`、`docViaExtractor`、带缓存的 `parseWord(dsId, absPath, relPath, mtimeMs)`、给索引用的 `extractWordText`（外包 `withActivity('解析 Word ' + relPath)`，异常返回 `null`）、`reclaimWordCache`、`wordCacheKey`、`WORD_ASSET_KEY`。顶部 `import` 了 `./store.js`（`cacheDirAsync, knowledgeDir, readJsonAsync, writeJsonAtomicAsync`）和 `./lagWatch.js`。缓存格式 `{ v: 2, mtimeMs, result: { html, text, engine, warning? } }`。 |
| `server/indexer.js` | `Indexer.build(snapshot, onProgress)`：8 个并发 worker 协程从队列取文件；文本类 `fs.promises.readFile` → `decodeText` → `toEditorText`，Word 类调 `extractWordText`；结果放进 `this.texts`（Map，relPath → 正文）。单文件超过 `SLOW_FS_OP_MS`（500ms）记 `[index] 慢文件` WARN，最多 20 条。 |
| `server/index.js` | 约第 690 行 `GET /api/file` 对 Word 调 `parseWord` 返回 `{ html, text, engine, warning }`；`Lib._beginIndexing` 串起文本索引 → 内链 → `reclaimWordCache`。`Lib` 的 `getText: (p) => lib.indexer.texts.get(p) ?? null` 供 RAG 取正文。 |
| `server/store.js` | 模块加载时就解析数据目录并可能执行迁移（`migrateIfNeeded`）。**worker 里不得 import 它**。 |
| `server/rag/onnxWorker.js` + `server/rag/embed.js`（约第 600–700 行） | 现成的 worker_threads 写法：`new Worker(new URL('./onnxWorker.js', import.meta.url), { workerData })`；消息协议 `{ t, id, ... }`；worker 日志经 `{ t: 'log', level, message }` 转回主线程写 `console`（worker 的 console 不进 `backend.log`）；`error`/`exit` 事件里让在途请求全部失败。**新 worker 照此写法**，打包无需改 `asarUnpack`（onnxWorker 已证明 asar 内的 worker 文件可加载）。 |
| `server/lagWatch.js` | `withActivity(label, fn)` 给 `[lag]` 行打活动标签；`SLOW_FS_OP_MS`。 |
| `server/textDecode.js`、`server/editorText.js` | `decodeText`、`toEditorText`：文本解码与换行归一的唯一实现，继续在主线程使用。 |
| `scripts/test-slow-fs.mjs` | 用 AdmZip 现造 docx、拉起后端、每 100ms 打 `/api/status` 测延迟的现成写法，新测试照抄其骨架。`scripts/tmpdirs.mjs` 管临时目录。 |

## 设计

### 模块划分

1. **`server/wordParse.js`（新建，纯解析，无缓存、无 store）**
   从 `word.js` 原样搬出：`escapeHtml`、`IMG_EXT_BY_TYPE`、`makeImageSink`、`textToHtml`、`docxToHtml`、`docViaSoffice`、`docViaExtractor`、`findSoffice`（含 `sofficePathCache`）。新增一个入口：
   ```js
   /** 解析一个 Word 文件为 { html, text, engine, warning? }；图片写入 cacheRoot/word-assets。只依赖参数，不读写解析缓存。 */
   export async function convertWord({ dsId, absPath, cacheRoot, cacheKey, mtimeMs })
   ```
   函数体即现 `parseWord` 里「缓存未命中」之后、写缓存之前的那段（docx / doc+soffice / doc 回退 extractor / 其余抛错）。`docViaSoffice` 的临时目录仍建在 `cacheRoot` 下。本文件不得 import `./store.js` 与 `./lagWatch.js`。

2. **`server/wordWorker.js`（新建，worker 线程入口）**
   ```
   入：{ t: 'convert', id, args }   // args 即 convertWord 的参数
   出：{ t: 'result', id, result }  |  { t: 'error', id, error: string }
   ```
   逐条串行处理（一个 worker 同时只做一件事）。

3. **`server/wordPool.js`（新建，主线程侧线程池）**
   ```js
   export function setWordPoolSize(n: number): void   // 1–8；见下方「改并发数」
   export const WORD_TIMEOUT_MS  // Number(process.env.WORKBENCH_WORD_TIMEOUT_MS) || 120000
   /** 在 worker 里解析；label 为日志用的相对路径。超时 reject code === 'WORD_TIMEOUT'；运行中崩溃 reject 'WORD_WORKER_CRASH'；
       worker 还没启动就出错（如模块加载失败）reject 'WORD_WORKER_UNAVAILABLE' */
   export function convertInWorker(args, label): Promise<{ html, text, engine, warning? }>
   export function closeWordPool(): Promise<void>   // 供测试与进程退出
   ```
   - 懒创建：第一次调用才起 worker，最多 `size` 个（初值 2，由 `server/index.js` 启动时按 `getUiSettings().wordConcurrency` 调 `setWordPoolSize`）；任务排 FIFO 队列，空闲 worker 取下一个。
   - 改并发数：调大立即按队列需要多起 worker；调小时空闲的多余 worker 立即 `terminate`，忙的做完手上的任务再退出。每次生效记一行 `[word] 解析并发数：<n>`。
   - **在途去重**：同一 `absPath + mtimeMs` 已在排队或执行时，返回同一个 Promise（连续重扫会让索引重复请求同一文件）。
   - 每个任务开始执行时起计时器；到 `WORD_TIMEOUT_MS` 仍未返回：`worker.terminate()`，该任务 reject `WORD_TIMEOUT`，按需新建一个 worker 接着处理队列。
   - worker `error`/非零 `exit`：该 worker 上的在途任务 reject `WORD_WORKER_CRASH`，丢弃该 worker，队列继续由其余或新建 worker 处理。
   - worker 一律 `unref()`，不阻止进程退出。每个任务开始时主线程记 `[word] 开始解析 <label>`。
   - 区分「崩溃」与「不可用」：worker 收到 `online` 事件之后出错算崩溃；之前出错算不可用（环境问题，如打包后找不到 worker 文件），记 `[word] 解析线程启动失败：…` ERROR。

4. **`server/word.js`（改）**
   - `parseWord(dsId, absPath, relPath, mtimeMs, { force = false } = {})`：
     1. 读缓存（主线程，`readJsonAsync`）。
     2. 命中成功缓存（`v === 3 && mtimeMs 相同 && result`）→ 返回 `result`。
     3. 命中失败缓存（`v === 3 && mtimeMs 相同 && failed`）且 `!force` → 抛 `Error`，`code = 'WORD_SKIPPED'`，`message` 为失败缓存里的中文原因。
     4. 否则 `convertInWorker({ dsId, absPath, cacheRoot, cacheKey: key, mtimeMs })`。
        - 成功：写 `{ v: 3, mtimeMs, result }`，返回 `result`。
        - 失败：`console.warn('[word] ' + relPath + '：' + message)`，写 `{ v: 3, mtimeMs, failed: { code, message, at: ISO 时间 } }`，再抛出（`message` 为中文，见下表）。**`WORD_WORKER_UNAVAILABLE` 不写失败缓存**：线程起不来不是文档的问题，否则一次环境故障会让所有 Word 永久没有正文。
     5. 写缓存失败仍只记 WARN（保持现行为），不影响返回或抛出。
   - `WORD_CACHE_VERSION` 从 2 改为 3（新增 `failed` 形态；旧的 v2 缓存不命中、重新解析一次，属预期）。
   - `extractWordText(dsId, absPath, relPath, mtimeMs)`：调 `parseWord(...)`（不 force），异常一律返回 `null`；保留 `withActivity('解析 Word ' + relPath, …)` 包裹。
   - `wordCapability()` 改为从 `wordParse.js` 取 `findSoffice`；`reclaimWordCache`、`wordCacheKey`、`WORD_ASSET_KEY` 留在 `word.js` 不动。
   - 失败原因文案（写进 `failed.message`、也作为抛出的 `message`，界面直接显示）：

     | code | message |
     |---|---|
     | `WORD_TIMEOUT` | `解析超时（超过 ${Math.round(WORD_TIMEOUT_MS/1000)} 秒），已跳过。可在阅读页重新打开以重试。` |
     | `WORD_WORKER_CRASH` | `解析进程意外退出，已跳过。可在阅读页重新打开以重试。` |
     | `WORD_WORKER_UNAVAILABLE` | `解析线程无法启动，请重启应用后再试。` |
     | 其余（convertWord 抛出的错误） | `无法解析此文档：${原 message}` |

5. **`server/index.js` 的 `GET /api/file`（改一行）**：Word 分支改为 `parseWord(lib.id, abs, rel, f.mtimeMs, { force: true })`；失败时沿用现有 `catch` 返回 `{ error: e.message }`（状态码保持 `e.status || 500`）。

6. **设置项 `wordConcurrency`**
   - `server/store.js` 的 `getUiSettings()`：增加 `wordConcurrency`，非 1–8 的整数一律回落 2（文件损坏分支同样给 2）。
   - `server/index.js` 的 `PUT /api/ui-settings`：接受 `wordConcurrency`，不是 1–8 的整数返回 400 `{ error: 'Word 解析并发数必须是 1 到 8 的整数' }`；保存后调 `setWordPoolSize(next.wordConcurrency)`。「缺少可更新字段」的错误文案补上 `wordConcurrency`。启动时（`libs` 打开之前）调一次 `setWordPoolSize(getUiSettings().wordConcurrency)`。
   - `src/lib/api.ts` 的 `UiSettings` 加 `wordConcurrency: number`。
   - `src/pages/Settings.tsx`「阅读与外观」区块，「元数据文件」那一行之后加一行：左侧标签「Word 解析」，一个 `UISelect`（选项 1–8，显示为「同时 N 个」），右侧说明文字「建索引时同时解析的 Word 文档数，默认 2；调大更快但更占 CPU」。改动即保存（`api.saveUiSettings({ wordConcurrency })`），成功 `setMsg` 提示「Word 解析并发数已保存：N」，失败 `notify` 报错并回显服务端值；初值在现有 `getUiSettings` 加载处一并读取。

7. **正文大小上限（`server/indexer.js`）**
   - 在 `indexer.js` 顶部导出：
     ```js
     export const TEXT_INDEX_MAX_BYTES = Number(process.env.WORKBENCH_TEXT_INDEX_MAX_BYTES) || 16 * 1024 * 1024;
     export const WORD_INDEX_MAX_BYTES = Number(process.env.WORKBENCH_WORD_INDEX_MAX_BYTES) || 64 * 1024 * 1024;
     ```
   - `build()` 取到文件后、读取前：按 `f.size`（扫描快照已有）判断，超限则不读、不放进 `texts`，计数并记下最大的一个。
   - 构建结束（与「慢文件」汇总同处）若有跳过，记一行：
     `[index] 跳过正文：${n} 个文件超过大小上限（文本 ${TEXT}MB / Word ${WORD}MB），只按文件名收录；最大的是 ${path}（${MB}MB）`

### 核心流程（建文本索引遇到一个 Word）

```
Indexer.build 的协程取到 f(.docx)
 ├─ f.size > WORD_INDEX_MAX_BYTES → 计入跳过，下一个
 └─ extractWordText
     └─ parseWord（主线程只做缓存读写）
         ├─ 成功缓存命中 → text
         ├─ 失败缓存命中 → 抛 WORD_SKIPPED → extractWordText 返回 null（不进 texts）
         └─ convertInWorker（排队 → worker 转换，主线程空闲）
             ├─ 成功 → 写成功缓存 → text
             ├─ 超时 → terminate + 重建 worker → 写失败缓存 → null
             └─ 崩溃 → 写失败缓存 → null
```

主线程在等待 worker 期间不做任何同步重活；`Indexer.build` 的 8 个协程会在 Word 上排队等待线程池，文本类文件不受影响继续处理。

## 边界情况

| 情况 | 期望行为 |
|---|---|
| 文档在解析中被修改（mtime 变了） | 本次结果按旧 mtime 写缓存；下次扫描 mtime 不符，缓存不命中、重新解析。与现行为一致。 |
| 同一文件被连续重扫重复请求 | `wordPool` 在途去重，只解析一次。 |
| 超时 worker 正在写图片 | `terminate` 后可能留下半截的 `word-assets/<键>-<mtime>/` 目录；下次成功解析时 `makeImageSink` 的 `prepare` 会清掉同键旧目录，不需要额外处理。 |
| 超时 worker 正在跑 soffice 子进程 | `docViaSoffice` 的 `execFile` 自带 `{ timeout: 60000 }`，短于 `WORD_TIMEOUT_MS`，子进程会先被它杀掉；保持不变，不额外处理。 |
| 所有 worker 都在跑超长任务 | 后续任务排队等待；每个最多等 `WORD_TIMEOUT_MS` 就会腾出 worker。界面请求不受影响（主线程空闲）。 |
| 用户打开一个失败缓存的 Word | 带 `force` 重试一次；成功覆盖缓存并正常显示；再失败返回中文原因。 |
| 失败缓存里的文档之后被用户修改 | mtime 变化，失败缓存不命中，下次建索引重新尝试。 |
| `.doc` 无 LibreOffice | 走 `docViaExtractor`，`warning` 文案不变，同样在 worker 里。 |
| 文件大小正好等于上限 | 不跳过（判断用 `>`）。 |
| 后端退出 | worker 已 `unref`，不阻止退出；不需要显式关闭。测试里用 `closeWordPool()` 收尾。 |

## 实施步骤

1. **拆出 `wordParse.js`**（纯搬移 + 新增 `convertWord`），`word.js` 暂时在主线程直接调 `convertWord`。跑现有测试全绿（行为不变的重构，单独一个提交）。
2. **加 `wordWorker.js` + `wordPool.js`**，`parseWord` 改走 `convertInWorker`；缓存版本升到 3、加失败缓存、`force` 参数、`/api/file` 改调用。单独一个提交。
3. **正文大小上限**（`indexer.js`）。单独一个提交。
4. **设置项 `wordConcurrency`**（后端 + 设置页）。单独一个提交。
5. **新测试 `scripts/test-word-worker.mjs`**（见验收标准），并在基线提交上确认它会失败（见验收 A1 的说明）。

每一步结束都要能跑通现有测试；第 1 步之后的任何一步都不能让现有测试变红。

## 验收标准

**新测试 `scripts/test-word-worker.mjs`**（node 运行；骨架照抄 `scripts/test-slow-fs.mjs`：临时语料目录、`ELECTRON_RUN_AS_NODE=1` 用 Electron 二进制拉起 `server/index.js`、`WORKBENCH_RAG_EMBED=mock`）。语料由脚本用 AdmZip 现造：

- `重文档1.docx` … `重文档4.docx`：每个 `word/document.xml` 含 60000 个段落（每段约 40 个汉字，含一个唯一标记词 `标记甲1`…`标记甲4`），使单个文件在 mammoth 上的转换耗时达到秒级（执行者在本机先确认：基线代码下单个文件转换 ≥ 1 秒；不够就加段落数，并在测试头部注释写明实测值）。
- `超时文档.docx`：同样结构但段落数加倍，标记词为 `标记丙`。
- `大文本.txt`：17MB，内含唯一标记词 `标记乙`。
- 约 50 个普通 `.md` 小文件。

后端环境变量：`WORKBENCH_WORD_TIMEOUT_MS` 设为「`超时文档.docx` 必然超时、`重文档*.docx` 必然不超时」的值（执行者按本机实测选定并写进注释）。

断言：

- **A1 主线程不阻塞**：从配置知识库开始到 `/api/status` 报告索引结束，每 100ms 请求一次 `/api/status`，单次耗时全部 ≤ 300ms。（基线提交 `ee30ef4`（v0.1.13）上此条必须失败——由调度方在独立 worktree 验证，执行者不需要也不允许切换版本或 `git stash`。）
- **A2 Word 正文可检索**：索引结束后，`GET /api/search?q=标记甲1`（…`标记甲4` 同理）返回的 `results` 里有对应 `重文档N.docx`，且该条 `matches` 中有一项 `field` 不是 `name`/`path`（即正文命中）。`GET /api/search?q=标记丙` 的 `results` 为空（超时文档没有正文进索引）。
- **A3 超时入缓存**：`超时文档.docx` 对应的 `word-<sha1(相对路径)>.json` 存在且 `failed.code === 'WORD_TIMEOUT'`；`<WORKBENCH_DATA_DIR>/logs/backend.log`（`server/logInit.js` 按数据目录写日志）里有一行含该文件相对路径与「解析超时」的 WARN（由 `parseWord` 写失败缓存时记录）。
- **A4 重启不重试**：关掉后端、用同一数据目录重启，索引结束后 `超时文档.docx` 的缓存文件 `mtime` 与 `at` 字段不变（没有被重新解析），且重启后的索引在 30 秒内结束。
- **A5 打开时重试**：`GET /api/file?path=超时文档.docx` 返回非 2xx 且 `error` 文案以「解析超时」开头；缓存里的 `at` 更新为本次时间。
- **A6 大文本跳过**：`GET /api/search?q=标记乙` 的 `results` 为空；`GET /api/search?q=大文本` 的 `results` 含 `大文本.txt` 且其 `matches` 有 `field === 'name'` 一项；日志有一行以 `[index] 跳过正文：1 个文件` 开头。
- **A7 在途去重**：索引期间连续触发 3 次 `POST /api/rescan`，日志里每个 `重文档*.docx` 的 worker 转换开始记录各只有 1 条（执行者在 `wordPool` 里以 `[word] 开始解析 <relPath>` 记一行 `info`，供此断言使用）。

- **A8 并发数设置**：`PUT /api/ui-settings {"wordConcurrency":4}` 返回 200 且 `GET /api/ui-settings` 的 `wordConcurrency === 4`，日志出现 `[word] 解析并发数：4`；`0`、`9`、`2.5`、`"3"` 各返回 400；删掉 `ui-settings.json` 后 `GET` 得到 `2`。
- **A9 设置页**：`npm run build` 后用 Electron 打开 `/settings` 的「阅读与外观」，能看到「Word 解析」选项且初值为「同时 2 个」；改选「同时 3 个」后 `GET /api/ui-settings` 得到 `3`。

**回归**（全部串行跑，不并行，避免计时类测试误报）：

- `scripts/` 下全部 `test-*.mjs`（node 运行）全绿，其中 `test-slow-fs.mjs`、`test-scan-async.mjs`、`test-links-async.mjs`、`test-index-status.mjs`、`test-interrupted-backend.mjs` 必须逐个确认。
- `npm run build` 后，`electron scripts/e2e-reader-regress.mjs`、`electron scripts/e2e-files-feedback.mjs`、`electron scripts/e2e-index-visibility.mjs`、`electron scripts/e2e-perf.mjs` 全绿（e2e-perf 的 E8 若失败，先按其注释检查窗口是否被节流，再判断）。
- `npx tsc -b` 与 `npx eslint server scripts` 无新增错误。

**真机复测**（调度方负责，不属于执行者）：发版后在 Windows 测试机上用同一 Downloads 库启动，`backend.log` 中「解析 Word」相关的 `[lag]` 行消失，`[index] 文本索引构建完成` 出现。

## 明确禁止

- 不许引入新依赖（worker 用 Node 内置 `node:worker_threads`）。
- `wordParse.js`、`wordWorker.js` 不许 import `./store.js`、`./lagWatch.js` 或任何会在模块加载时读写数据目录的模块。
- 不许改动 `server/links.js`、`server/linkMatch.js`、`server/scanner.js`、`server/rag/**`；`src/**` 只许改 `src/lib/api.ts` 的 `UiSettings` 与 `src/pages/Settings.tsx` 的这一行设置。
- 不许改变 Word 解析结果的内容（`html`/`text`/`engine`/`warning` 与改动前逐字一致；A2 之外，执行者用仓库夹具 `test-data/ds-a/word/旧文档.doc` 与 `test-data/ds-a/word/报告 2024.docx` 对比改动前后 `/api/file` 的返回体（图片 `src` 里的路径以外），必须完全相同，比对方法写进汇报）。
- 不许 `git stash`、不许切换分支或版本、不许 `git add -A`；只提交本规格涉及的文件。
- 不许删弱或跳过任何现有测试断言。
- 测试与 Electron 命令一律用 `timeout` 包住（单条 ≤ 600 秒），脚本的 `finally` 里关闭后端子进程与线程池。
- 交付物不留过程叙事（代码注释、日志文案里不写「此处已修复」「原来是…」之类）。
