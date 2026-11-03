# 规格：慢磁盘下后端不再卡死（热路径文件读写异步化、去掉同步空转）

## 背景与目标
一台 Windows 测试机上，应用 v0.1.10 的后端在扫描和建索引期间反复卡住，每次 1–78 秒。卡住期间 `/api/status` 要等十几秒到几十秒，页面脚本最长 71 秒才加载出来，诊断导出用了 77 秒，建文本索引始终没有完成。

诊断包里的线索：
- 扫描 473 个文件耗时 8.7–58 秒，正常机器上只要几十毫秒。这说明那台机器单次文件操作非常慢（推测是安全软件拦截检查，未证实）。
- 同一台机器的联网也被拦截（`ERR_NETWORK_ACCESS_DENIED`）。

后端在热路径上用的是同步文件读写。单次读写一慢，整个事件循环就停住。另外，`server/store.js` 的 `renameWithRetry` 在改名失败（Windows 上目标文件被占用时会报 EPERM、EACCES、EBUSY）时会同步空转退避，每次最多 1550ms。Word 缓存写失败后，`parseWord` 会把解析结果直接丢掉，下次建索引又要重新解析、重新失败。

**目标**：即使每次文件操作都很慢、改名持续失败，后端也始终能及时响应请求，扫描和建索引能正常完成。

## 非目标
- 不改扫描规则、索引、内链和 Word 解析的结果。
- 不碰启动期的一次性迁移，以及配置类的低频读写（`store.js` 的迁移、`listLibs`、`getUiSettings`）。
- 不处理网络被拦截的问题，那属于环境问题。
- 不新增依赖。

## 现状（行号以实际代码为准）
- `server/store.js`：`renameWithRetry` 同步空转退避（约 122–141 行）；`writeJsonAtomic` 用它（约 145 行）。
- `server/scanner.js`：`createScanWalk` 是唯一的遍历核心，由 `scanTreeAsync` 驱动，每 30ms 让出一次。但遍历里的 `readdirSync`、`realpathSync`、`statSync` 都是同步调用（约 69–157 行）。
- `server/indexer.js` 的 `build`：文本类文件用 `fs.readFileSync` 读取（约 45 行），Word 文件走 `extractWordText`。
- `server/word.js`：
  - `parseWord` 用同步 `readJson` 读缓存、用 `writeJsonAtomic` 写缓存，写失败就整体抛错；
  - `makeImageSink` 同步 `mkdirSync`、`readdirSync`、`rmSync`、`writeFileSync`（约 66–95 行）。
- `server/links.js`：同步读集合元数据（约 143 行）、同步读缓存（约 484 行）、`writeJsonAtomic` 写缓存（约 496 行）。
- `server/index.js`：保存文档时用 `renameWithRetry`（约 281 行）。
- 回归测试：
  - `scripts/test-scan-async.mjs` 对比新扫描与 v0.1.7 基线，结果必须逐项一致；
  - `e2e-perf` 的 E8 检查建索引期间没有卡顿行。

## 设计
1. **改名不再阻塞**（`store.js`）
   - 新增 `renameWithRetryAsync(from, to)`：退避节奏与现在相同，但用 `await` 定时器等待，不空转。
   - 新增 `writeJsonAtomicAsync(file, obj)`：用异步 `fs.promises` 写临时文件，再调用 `renameWithRetryAsync`。
   - 保留同步的 `writeJsonAtomic`，供低频配置写入使用，但同步重试里去掉空转。改为：
     - 改名失败且错误码属于占用类时，立即再试一次；
     - 仍然失败，就退回到 `copyFileSync(tmp, file)` 覆盖写入，再删掉临时文件；
     - 覆盖写入也失败才抛错。
   - 所有改名失败都记一行 WARN：带错误码、文件名和第几次尝试。同一路径每分钟最多记一次，避免刷屏。
2. **Word 缓存与图片**（`word.js`）
   - 缓存读取改为异步。
   - 缓存写入改用 `writeJsonAtomicAsync`。写入失败时记 WARN，但照样返回解析结果，不再丢弃。
   - `makeImageSink` 里的目录和文件操作全部改为异步。mammoth 的图片回调可以返回 Promise。
3. **建索引**（`indexer.js`）：文本类文件改用 `await fs.promises.readFile`；`decodeText` 不变。
4. **扫描**（`scanner.js`）
   - 遍历核心仍然只有一份，把其中的 `readdirSync`、`realpathSync`、`statSync` 改为对应的 `fs.promises` 调用。
   - 同一个目录里的 stat 可以有限并发（不超过 16 个），但结果必须按 readdir 的原顺序合并，保证输出和现在逐项一致。
   - 已有的 `scanned` 进度、`scan-progress` 节流事件保持不变。
5. **内链**（`links.js`）
   - 集合元数据读取、缓存读取改为异步，限于它们所在的函数本来就是 async 的情况。
   - 不在 async 上下文里的，就在报告中列出，并说明为什么保留。
   - 缓存写入改用 `writeJsonAtomicAsync`，失败只记 WARN。
6. **保存文档**（`index.js`）：改用 `renameWithRetryAsync`。
7. **慢操作日志**，用于诊断：
   - 扫描结束时，如果单次 stat 或 readdir 超过 500ms，记一行 WARN：给出最慢那次的耗时和相对路径，以及超过 500ms 的次数。
   - 建索引时，单个文件读取或解析超过 500ms 的，记 WARN：给出相对路径和耗时。同一次构建最多记 20 条，超出部分汇总为一行。

## 边界情况
| 情况 | 期望 |
|---|---|
| 改名持续失败 | 不阻塞；缓存不写入，解析结果照用；记 WARN |
| 单次 stat 要 500ms | 只拖慢扫描本身，`/api/status` 仍然快速响应 |
| 扫描中途目录被删除 | 行为与现在一致（进入错误、`scanning` 复位） |
| 保存文档时目标被占用 | 异步重试；最终失败则如实返回错误，不丢临时文件以外的数据 |

## 验收标准
- **G1**：`npx tsc -b` 和 `npx eslint .` 都是 0 问题；`npm run build` 成功。
- **G2**：新增 `scripts/test-slow-fs.mjs`，要求如下。
  - **准备**：用 `node --import <注入模块>` 拉起后端子进程，后端用临时 `WORKBENCH_DATA_DIR`；注入模块和临时目录都用 `scripts/tmpdirs.mjs` 创建。注入模块要做三件事：
    - 给同步的 `fs.statSync`、`lstatSync`、`readdirSync`、`readFileSync`、`realpathSync` 各加 40ms 延迟，用 `Atomics.wait` 模拟系统调用真的慢；
    - 给对应的 `fs.promises` 异步版本加 40ms 的 `setTimeout` 延迟；
    - 让 `fs.renameSync`、`fs.promises.rename` 对 `word-*.json` 和内链缓存文件一律抛出 EPERM。
  - **语料**：临时生成约 300 个文本文件，再放入至少 4 个 Word 文件（docx 与 doc 各至少 1 个）。Word 可以复用仓库现有的测试夹具；没有 doc 夹具时，可以只用 docx，并在报告中说明。
  - **断言**：
    - 添加资料库后，在扫描加建索引期间，每 100ms 请求一次 `/api/status`，**单次响应不超过 400ms**；
    - 建索引在 120 秒内完成（`indexing.phase` 回到 null）；
    - Word 文件的正文能用精确检索搜到，证明缓存写失败时结果没有被丢弃；
    - 后端日志里有改名失败的 WARN，以及慢操作的 WARN。
  - **对照**：在修复前的代码（`git show HEAD:<文件>` 落到临时目录）上跑同一个测试，至少「单次响应不超过 400ms」这一条必须失败。在报告中贴出两边的数字。
- **G3**：`scripts/test-scan-async.mjs`（与 v0.1.7 逐项一致）、`test-index-status`、`test-links-async`、`test-linkmatch` 全部通过。
- **G4**：回归全部通过：
  - 全部 `scripts/test-*.mjs`
  - `npm run test:e2e`
  - `e2e-filetree`
  - `test:retrieval:e2e`
  - `e2e-security`
  - `e2e-reader-regress`
  - `e2e-perf`（E1–E10，含 E8）
  - `e2e-index-visibility`
  - `e2e-files-feedback`
  - `e2e-update-ui`
  - `e2e-agent-activity`
  - `e2e-agent-toggle`
  - `git diff --check`

## 明确禁止
- 不在任何地方用空转或 `Atomics.wait` 等待（测试注入模块除外）。
- 不改结果语义；不新增依赖；不改既有测试断言。
- 不读写 `~/.xuewen-workbench` 与 `/Users/mayu/Downloads`。
