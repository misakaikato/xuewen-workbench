# 规格：运行日志、诊断导出与消除界面卡顿（后端移出主进程、模型下载重写、ONNX 推理进 worker）

日期：2026-11-02 ｜ 状态：施工中 ｜ 读者：施工者（无对话上下文也可施工）

## 背景与目标

Windows 用户实际遇到的事故：首次打开正常 → 加资料库、开始下载 RAG 模型 → 下载中界面卡住 → 显示 `fetch failed` → 窗口无响应 → 任务管理器结束后重开，不显示任何界面。打包版没有任何日志文件，无法取证。

代码层面已确认的成因：
1. Express 后端（扫描、索引、内链、RAG、助手、模型下载）全部在 Electron 主进程内运行（`electron/main.js` 直接 `import server/index.js`）。主进程同时承担 Windows 的窗口消息循环，任何长同步任务都会让窗口“未响应”。
2. Windows 的向量嵌入走 onnxruntime-node：`InferenceSession.create` 与 `session.run` 都是同步原生调用（`node_modules/onnxruntime-node/dist/backend.js` 只用 `setImmediate` 包了一层），推理期间所在线程完全阻塞。
3. 模型下载（`server/rag/embed.js` 的 `downloadTo`/`download`）：每个文件先连 huggingface.co（国内常要等 10 秒连接超时才换 hf-mirror）；Node 全局 fetch 不走 Windows 系统代理；写文件无背压；失败时写流不关闭；无断点续传、无空闲超时；`POST /api/rag/model/download` 一直挂到整个下载结束才返回。
4. 启动时窗口要等全部资料库扫描完、服务就绪后才创建，且隐藏到首帧；这段时间没有任何窗口。再次双击时新进程拿不到单实例锁直接退出，旧进程因 `win` 为空也不响应。

成功标准：
- 打包版在应用数据目录写运行日志；出问题后用户能一键导出诊断包（zip）发给开发者，**只导出、不上传**。
- 窗口在启动后 2 秒内出现；任何后端重活（扫描、建索引、嵌入推理、下载）都不能让窗口卡住。
- 模型下载能自动选可达的源、走系统代理、断点续传、超时重试，下载期间接口与界面保持响应。

## 非目标

- 不做日志或诊断包的网络上传。
- 不改扫描/索引/内链的算法与“文件变动即全量重建”的策略（只加计时日志）。
- 不做 Windows CUDA/DirectML 性能调优，不改嵌入模型、切块与检索算法。
- 不改 CI 发布流程（mac 包缺离线 MLX 环境是另一个问题，不在本规格内）。
- 不重构与本规格无关的代码；不修 lint 存量问题（但不得新增 lint 错误）。

## 假设（施工方按此执行，用户已确认“只导出不上传”）

1. 日志目录：`<数据目录>/logs/`（数据目录即 `server/store.js` 的 `dataDir()`，打包版默认 `~/.xuewen-workbench`，Windows 为 `%USERPROFILE%\.xuewen-workbench`）。
2. 每个进程一个日志文件：`main.log`（Electron 主进程）、`backend.log`（后端）、`renderer.log`（界面上报）。单文件上限 5MB，轮转保留 3 份（`x.log`、`x.log.1`、`x.log.2`）。
3. 卡顿阈值：事件循环一次阻塞 ≥ 1000ms 记一条 WARN（环境变量 `WORKBENCH_LAG_THRESHOLD_MS` 可覆盖，供测试用）；界面长任务 ≥ 1000ms 记一条。
4. 诊断包导出到桌面（Electron 下用 `app.getPath('desktop')`，可处理 OneDrive 重定向的桌面），写失败退回 `<数据目录>/diagnostics/`；导出后在系统文件管理器中选中该文件。
5. “出问题后”的提示只针对异常事件：上次没有正常退出、后端进程意外退出、界面进程崩溃、子进程异常退出。卡顿只写日志，不弹提示。
6. 日志与诊断包**绝不包含**：文档正文、对话内容、LLM 提示词与回复、API Key、LLM 端点地址（baseUrl）。允许包含：资料库路径、文件相对路径、文件名、计数、耗时、错误信息与堆栈。

## 现状（必须复用的部分）

- `electron/main.js`：单实例锁、`freePort`、`waitFor`、建窗、菜单；打包模式注入 `trash`/`hostOpen`/更新桥后 `import server/index.js`。
- `electron/preload.cjs`：沙箱 preload，`contextBridge.exposeInMainWorld('wbHost', { isElectron, selectDirectory, platform })`。`src/pages/Setup.tsx` 使用 `window.wbHost.selectDirectory`。
- `electron/updater.js`：`createUpdaterBridge({ getUiSettings })` 返回 `{ state(), check(), download(), install(), openRelease() }`，其中 `state()` 同步返回快照。
- `server/update.js`：`setUpdateBridge` / `mountUpdateRoutes`，路由 `GET /api/update/state` 目前同步调用 `bridge.state()`。
- `server/trash.js`（`setTrashHandler`）、`server/hostOpen.js`（`setOpenHandler`、`hostOpenPath`）：可插拔宿主能力，后端用到时调用。
- `server/index.js`：`boot()` 先并行恢复所有资料库（`lib.start()` = 扫描 + 开监听），再 `app.listen`；`Lib` 的 `scan-done` 回调里依次 `indexer.build` → `linkIndex.rebuild` → `ragManager.onScanComplete`。`POST /api/reveal`（约第 553 行）内联了 explorer/open/xdg-open 的定位实现。
- `server/store.js`：`dataDir()`、`readJson`、`writeJsonAtomic`、`getUiSettings`。导入时有一次性迁移副作用。
- `server/rag/embed.js`：`EmbedService`（`download`、`importDir`、`ensureReady`、`_loadOnnx`、`_loadMlx`、`dispose`），`REPOS`、`HOSTS`、`sha256File`、`downloadTo`。`_loadOnnx` 在 Windows 默认 EP 为 `dml`，失败降级 `cpu`。MLX 走 Python 子进程，本身不阻塞事件循环，不改。
- `server/rag/routes.js`：`POST /model/download` 现为 `res.json(await manager.embed.download())`。
- `src/components/UpdateBanner.tsx`：顶栏上方横幅的现成样式与写法，`src/components/Layout.tsx` 第 161 行挂载。
- `src/pages/Settings.tsx`：`tab === 'about'` 的「关于与更新」一节。
- `src/pages/RagManage.tsx`：模型区每 5 秒 `poll()` 一次 `api.ragStatus()`，下载按钮调用 `api.ragModelDownload()`。
- `src/lib/api.ts`：`req()`、`json()`、`api` 对象，新接口按同样写法加。
- 应用内**没有挂载 Toaster**，结果提示一律用就地文字，不要引入 toast。
- 已在 Electron 44（Node 24.22）上实测可行：utilityProcess 中 `require('electron')` 提供 `net`、`systemPreferences`，`net.fetch` 可用；better-sqlite3 可加载；`process.resourcesPath` 有值；utilityProcess 入口脚本与 worker_threads 脚本放在 app.asar 内均可加载；worker 内可加载 onnxruntime-node 与 `@huggingface/transformers` 的 `AutoTokenizer`。Node 24 有 `zlib.crc32`。
- 代码风格：server/electron 为 ESM（preload 为 CJS），2 空格缩进、单引号、分号；注释简短中文。新代码照此写。

## 设计

### 一、日志 `server/logger.js`（新）

```js
// 返回写入器；写入为同步 appendFileSync，任何异常都吞掉，绝不抛出
export function createLogWriter({ dir, name, maxBytes = 5 * 1024 * 1024, keep = 3 }) // → { file, write(level, tag, message) }
// 接管本进程 console.log/info/warn/error/debug：原输出照常，同时写入 <dir>/<name>.log
// 并注册 process.on('uncaughtExceptionMonitor', (err, origin) => 写 FATAL)（只监听，不改变进程崩溃行为；不要注册 uncaughtException/unhandledRejection）
export function initProcessLogger({ dir, name, tag }) // → writer
export function logsDir(dataDir) // → path.join(dataDir, 'logs')
```

- 行格式：`<ISO UTC 时间> <LEVEL 补齐到 5 位> [<tag>] <message>`，例：`2026-11-02T08:15:30.123Z WARN  [backend] [lag] 事件循环阻塞 3120ms（进行中：解析 Word 文章/讲义.docx）`。console.log/info → `INFO`，warn → `WARN`，error → `ERROR`，debug → `DEBUG`。消息用 `util.format(...args)` 拼成，多行消息原样保留、续行前缀两个空格；单条超过 8000 字符截断并追加 `…(截断 N 字符)`。
- 轮转：写入前若 `当前大小 + 本行字节 > maxBytes`：删除 `name.log.{keep-1}`，依次把 `.{i}` 改名为 `.{i+1}`，`name.log` 改名为 `name.log.1`，再写新文件。当前大小启动时 `statSync` 取一次，之后在内存累加。
- `server/logInit.js`（新）：`import { dataDir } from './store.js'` 后调用 `initProcessLogger({ dir: logsDir(dataDir()), name: 'backend', tag: 'backend' })`，并启动卡顿看门狗（见二）。`server/index.js` 的**第一条 import** 改为 `import './logInit.js';`。
- 主进程：`electron/main.js` 在 `app.whenReady()` 之后、做任何其他事之前 `initProcessLogger({ dir, name: 'main', tag: 'main' })` 并启动看门狗。

必须新增的日志点（全部用 console.* 输出，自动进文件；不得输出正文）：

| 位置 | 内容 |
|---|---|
| 主进程启动 | 版本、`process.versions` 的 electron/node/chrome、`os.platform/release/arch`、CPU 型号与核数、总内存/空闲内存、`app.getGPUFeatureStatus()`、数据目录、是否打包 |
| 主进程 | 窗口创建（含距进程启动毫秒数）、后端 fork（含后端 pid）、后端 ready（含端口与距进程启动毫秒数）、后端退出（code）、窗口 `unresponsive`/`responsive`、`render-process-gone`（reason、exitCode）、`child-process-gone`（type、reason、exitCode、name；reason 为 `clean-exit` 时不记） |
| 后端 boot | 每个库：名称、baseDir、文件数、扫描耗时；服务开始监听（端口、距进程启动毫秒数） |
| 后端 `Lib` | 每次扫描耗时与文件数；`indexer.build` 耗时；`linkIndex.rebuild` 耗时；目录不可访问 |
| 后端 HTTP | 用一个 express 中间件：响应状态 ≥ 500 或耗时 ≥ 3000ms 时记 `方法 路径（不含查询串）状态 耗时`。`/api/agent/chat` 等 SSE 长连接与 `/api/rag/model/download` 不按耗时记（只记 ≥ 500） |
| RAG | 索引构建开始/结束/暂停/失败（文件数、耗时）；单个文件嵌入耗时 ≥ 2000ms 时记路径与段数；运行时加载（后端类型、EP、耗时） |
| 模型下载 | 见第五节 |

### 二、卡顿看门狗 `server/lagWatch.js`（新）

```js
export function startLagWatch({ tag, intervalMs = 250, thresholdMs }) // thresholdMs 缺省取 Number(env.WORKBENCH_LAG_THRESHOLD_MS) || 1000；定时器 unref
export function setActivity(label) // → done()：把本次登记的这一项移出“进行中”集合（只移自己，不影响并发的其他项）
export async function withActivity(label, fn) // 同步或异步 fn 结束后（含抛错）自动 done，返回 fn 的结果
```

- 活动是一个**集合**而不是单值：`setActivity` 生成唯一令牌放进 `active: Map<token, label>`，返回的 `done()` 只删除自己的令牌。这样并发的多个 `withActivity`（如索引时 8 路并发解析 Word）以任意顺序结束都不会留下过期标签。
- 同时维护 `recent`：自上次 tick 以来调用过 `setActivity` 的标签（去重，最多保留 5 个）。
- 每次 tick：若 `实际间隔 - intervalMs ≥ thresholdMs`，报告的标签 = 去重后的「上次 tick 时 active 中的标签」+「recent」，最多列 3 个，多于 3 个时追加“等 N 项”，都没有时为“无记录”；`console.warn('[lag] 事件循环阻塞 ' + ms + 'ms（进行中：' + 标签 + '）')`。然后记下当前 active 的标签作为下次的「上次 tick 时 active」，清空 recent。
- 这样「先 setActivity 紧接着同步重活、期间没有 tick」的常见写法也能报出正确标签（它在 recent 里）。
- 后端需包上活动标签的位置：`scanner.rescan`（`扫描 <库名>`）、`indexer.build`（`建文本索引 <库名>`）、`extractWordText` 每个文件（`解析 Word <相对路径>`）、`linkIndex.rebuild`（`算内链 <库名>`）、RAG 构建每个文件（`RAG 切块/嵌入 <相对路径>`）、模型下载每个文件（`下载模型 <文件名>`）、嵌入调用（`向量推理 <n> 段`）。

### 三、异常事件记录与诊断包 `server/diagnostics.js`、`server/zip.js`（新）

文件：`<logs>/session.json`（运行标记）、`<logs>/incidents.jsonl`（异常事件，一行一条）、`<logs>/incident-ack.json`（`{ at }`，用户已看过的时间点）。

```js
// Incident: { kind: 'unclean-exit' | 'backend-exit' | 'renderer-gone' | 'child-gone', at: ISO, detail: object }
export function appendIncident(dataDir, incident)
export function readIncidents(dataDir, { limit = 50 } = {})   // 坏行跳过；返回时间升序的最后 limit 条
export function pendingIncident(dataDir)                        // at 晚于 ack.at 的最新一条，没有返回 null
export function ackIncidents(dataDir)                           // 写 { at: now }
export function markSessionStart(dataDir, info)                 // 若 session.json 已存在 → 先 appendIncident unclean-exit（detail = 旧标记内容），再写新标记 { pid, version, startedAt }
export function markSessionEnd(dataDir)                         // 同步删除 session.json，不存在不报错
export async function exportDiagnostics({ dataDir, outDir, summary }) // → { file }；summary 由调用方提供（见下）
```

- `markSessionStart`/`markSessionEnd` 只由 Electron 主进程调用（主进程 ready 后立即 start；`will-quit` 时 end）。独立 dev server 不调用。
- 主进程在以下情况 `appendIncident`：后端意外退出（`backend-exit`，detail `{ code, stderrTail }`，stderrTail 为最后 50 行 stderr）、`render-process-gone`（`renderer-gone`）、`child-process-gone` 且 reason ≠ `clean-exit`（`child-gone`）。
- 诊断包：`<outDir>/学问Workbench-诊断-YYYYMMDD-HHmmss.zip`（本地时间）。内容：
  - `summary.json`：调用方传入的 summary 对象，加上 `generatedAt`。
  - `logs/`：日志目录下所有 `*.log`、`*.log.N`、`incidents.jsonl`。总量上限 30MB：按修改时间从新到旧收录；单个文件超过剩余额度时只收其末尾部分并在开头加一行 `…(前 N 字节已省略)`。
  - `说明.txt`：中文，说明包含什么（日志、环境与资料库统计）、不含什么（文档正文、对话、API Key、端点地址），以及数据目录与日志目录的绝对路径。
- outDir 写入失败（不存在、无权限）时退回 `<dataDir>/diagnostics/`（自动创建），返回实际路径。
- `server/zip.js`：`export function writeZip(outFile, entries /* { name: string, data: Buffer }[] */)`，最小 ZIP 写入器：每项 deflate（`zlib.deflateRawSync`），CRC 用 `zlib.crc32`，文件名 UTF-8 且设通用标志位 bit 11，DOS 时间取当前时间，写本地文件头 + 数据 + 中央目录 + 目录结束记录；不支持 zip64（总大小超 4GB 时抛错，实际有 30MB 上限）。先写临时文件再改名。

summary 字段（后端导出时）：

```json
{
  "app": { "version": "0.1.6", "hosted": true },
  "runtime": { "electron": "…", "node": "…", "chrome": "…" },
  "os": { "platform": "win32", "release": "…", "arch": "x64", "cpu": "…", "cores": 8, "totalMemGB": 16, "freeMemGB": 5.2 },
  "host": { "gpu": { } },
  "dataDir": "…", "logsDir": "…",
  "libraries": [{ "id": "…", "name": "…", "baseDir": "…", "active": true, "scanning": false, "watching": true, "scannedAt": "…", "files": { ".md": 120, ".docx": 30 }, "totalBytes": 123, "dirErrors": 0, "fileErrors": 0 }],
  "rag": { "model": { "state": "…", "backend": "…", "ep": "…", "error": null, "progress": null }, "indices": [{ "dsId": "…", "state": "…", "files": 0, "filesDone": 0, "chunks": 0, "dbBytes": 0 }] },
  "agent": { "endpointConfigured": true, "model": "…", "mode": "auto" },
  "ui": { "theme": "A", "autoUpdate": true },
  "incidents": [ ]
}
```

`host.gpu` 由主进程提供（后端托管模式下经 RPC `host.info` 取；取不到写 null）。主进程在后端不可用时自行导出（启动页按钮），summary 只含 app/runtime/os/host/dataDir/logsDir/incidents，另加 `"backend": "not-running"`。

### 四、后端接口（`server/index.js`）

```
POST /api/log                 { entries: [{ level: 'ERROR'|'WARN'|'INFO', message: string, at?: string }] }
                              → 200 { ok: true }；entries 不是数组或超过 50 条 → 400 { error }
                              每条 message 截断到 4000 字符，写入 renderer.log（tag: renderer；at 若提供则放在消息前）
GET  /api/diagnostics/state   → 200 { pending: Incident | null, logsDir: string }
POST /api/diagnostics/ack     → 200 { ok: true }
POST /api/diagnostics/export  → 200 { ok: true, file: string }；失败 500 { error }
                              成功后在系统文件管理器中选中该文件（见 revealInFolder），定位失败不影响返回
```

- `server/hostOpen.js` 新增 `export async function revealInFolder(absPath)`：把 `/api/reveal` 里 explorer/open/xdg-open 的实现搬进来，`/api/reveal` 改为调用它（行为不变）。托管模式下（见第五节）改走宿主 RPC `shell.showItemInFolder`。

### 五、后端移入 utilityProcess

#### 主进程 `electron/main.js` 新流程

1. 单实例锁不变。`second-instance`：若 `win` 存在 → 还原、显示、聚焦（窗口现在总是先于后端存在）。
2. `app.whenReady()` 后：初始化日志与看门狗 → 记录启动环境 → `markSessionStart` → `buildMenu()` → 读主题（保留 `import store.js` 的 `getUiSettings`，这一步也保证 store 的迁移副作用在后端启动前完成）→ **立即**建窗并加载启动页（`backgroundColor` 仍按主题）→ `freePort` 选端口 → 打包模式创建更新桥（`createUpdaterBridge` 不变）→ `startBackend()`。
   - 窗口显示时机：`show: false`，在 `ready-to-show` 与「建窗后 1500ms」两者**先到者**时 `show()`（只显示一次）。兜底计时器保证渲染进程或 GPU 出问题、首帧迟迟不来时窗口仍会出现；因兜底而显示时记一条 WARN `[window] 首帧 1500ms 内未就绪，先行显示窗口`。
3. `startBackend()`：
   ```js
   backend = utilityProcess.fork(path.join(ROOT, 'server', 'index.js'), [], {
     serviceName: 'Xuewen Workbench Backend',
     stdio: 'pipe',
     env: { ...process.env, WORKBENCH_PORT, WORKBENCH_HOST, WORKBENCH_HOSTED: '1',
            WORKBENCH_DESKTOP_DIR: app.getPath('desktop'), WORKBENCH_APP_VERSION: app.getVersion(),
            ...(DEV ? {} : { WORKBENCH_STATIC_DIR: path.join(ROOT, 'dist') }) },
   });
   ```
   子进程 stdout/stderr 原样转写到主进程的 stdout/stderr（开发时可见），**不**写入 main.log（后端自己写 backend.log）；另保留 stderr 最后 50 行环形缓冲，后端意外退出时连同退出码写入 main.log 与 incident。
4. 消息协议（`backend.postMessage` / `process.parentPort.postMessage`，均为可结构化克隆的普通对象）：
   - 后端 → 主：`{ t: 'boot', step: string }`、`{ t: 'ready', port: number }`、`{ t: 'rpc', id: number, method: string, args: unknown[] }`
   - 主 → 后端：`{ t: 'rpc-result', id, ok: true, value }` 或 `{ t: 'rpc-result', id, ok: false, error: string }`
   - 主进程实现的 RPC：`shell.trashItem(abs)`、`shell.openPath(abs)`（返回非空字符串时视为失败）、`shell.showItemInFolder(abs)`、`update.state()`、`update.check()`、`update.download()`、`update.install()`、`update.openRelease()`、`host.info()`（返回 `{ gpu: app.getGPUFeatureStatus() }`）。无更新桥（开发模式）时 `update.state` 返回与 `server/update.js` 的 `disabledUpdateState()` 相同结构，其余 `update.*` 失败 `update-disabled`。未知方法失败 `unknown-method`。
5. 收到 `ready` → 开发模式先起 Vite（保留现有逻辑）→ `win.loadURL(应用地址)`；记录“后端 ready 距启动 X ms”。删除旧的 180 秒 `waitFor('/api/config')`（开发模式等 Vite 的 `waitFor` 保留）。
6. 后端 `exit` 事件：若应用正在退出 → 忽略。否则 → 记日志与 incident，窗口加载启动页的错误态，显示“后台服务意外退出（代码 X）”，提供「重新启动」与「导出诊断信息」。「重新启动」重新 `startBackend()`（端口被占则重新 `freePort`），ready 后重新加载应用地址。
7. 退出：`before-quit` 标记 quitting 并 `backend.kill()`、停 Vite；`will-quit` 调 `markSessionEnd`。
8. 窗口事件日志：`win.on('unresponsive'/'responsive')`、`webContents.on('render-process-gone')`、`app.on('child-process-gone')`。

#### 启动页 `electron/startup.html`（新，单文件，内联 CSS/JS）

- 通过 `win.loadFile(path.join(APP_DIR, 'startup.html'), { query: { theme } })` 加载。按主题取底色/文字色：A `#f7f1e3`/`#3b2f22`，B `#ffffff`/`#1f2328`，C `#1b1c20`/`#d8d4cc`。居中显示应用图标（`../assets/icons/icon.png`）、标题「学问 Workbench」、状态行、已用秒数。无 emoji。
- 状态来自 `window.wbHost.onBoot(cb)`：`{ state: 'starting', step }` 更新状态行；`{ state: 'error', message }` 切到错误态（显示 message，显示两个按钮）。启动超过 60 秒仍未 ready：状态行下方加提示「资料库较大或磁盘较慢时首次启动会久一些」并显示「导出诊断信息」按钮（不强制失败）。
- 按钮：「导出诊断信息」→ `wbHost.exportDiagnostics()`，完成后显示文件路径；「重新启动」→ `wbHost.restartBackend()`。

#### preload `electron/preload.cjs`

在现有 `wbHost` 上**增加**（不删现有字段）：
```js
onBoot: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('wb:boot', h); return () => ipcRenderer.removeListener('wb:boot', h); },
exportDiagnostics: () => ipcRenderer.invoke('wb:exportDiagnostics'),   // → { file } | { error }
restartBackend: () => ipcRenderer.invoke('wb:restartBackend'),
```
主进程：把后端 `boot` 消息与错误转发为 `win.webContents.send('wb:boot', …)`；`wb:exportDiagnostics` 优先请求后端 `POST /api/diagnostics/export`（后端已 ready 时），否则主进程直接调用 `exportDiagnostics`（summary 见第三节），完成后 `shell.showItemInFolder`。

#### 后端 `server/host.js`（新）

```js
export const hosted = !!process.parentPort && process.env.WORKBENCH_HOSTED === '1';
export function rpc(method, ...args)          // → Promise；非托管直接 reject；shell.* 与 host.* 30 秒超时，update.* 不设超时
export function postBoot(step)                // 非托管为空操作
export function postReady(port)               // 非托管为空操作
export function installHostBridges()          // 托管时：setTrashHandler(p => rpc('shell.trashItem', p))；
                                              // setOpenHandler(p => rpc('shell.openPath', p))；
                                              // setUpdateBridge({ state: () => rpc('update.state'), check, download, install, openRelease 同理 })
```
- `server/index.js`：在挂载路由前调用 `installHostBridges()`；`boot()` 中每个库开始恢复前 `postBoot('正在扫描资料库：' + 名称)`；`app.listen` 回调里 `postReady(PORT)`。
- `server/update.js`：`GET /api/update/state` 改为 `res.json(bridge ? await bridge.state() : disabledUpdateState())`（同步桥照样可用）。
- `revealInFolder` 托管时走 `rpc('shell.showItemInFolder', abs)`。
- 独立运行（`npm run dev`、`npm run dev:server`、所有 `scripts/e2e-*.mjs`）行为完全不变。

### 六、模型下载重写 `server/rag/download.js`（新）+ `embed.js` 改造

```js
// 并发 HEAD 探测各源上的 config.json，返回按响应先后排序的可达源；全部不可达返回 []
export async function probeHosts(hosts, repoPath, { fetchImpl, timeoutMs = 8000 })
// 下载单个文件到 dest（经 dest + '.part'），支持断点续传、空闲超时、重试、背压
export async function downloadFile({ urls, dest, fetchImpl, idleTimeoutMs = 30000, maxAttempts = 5,
                                     backoffMs = [2000, 4000, 8000, 16000, 30000], onProgress, log })
// → { bytes, total, host, attempts, resumed: boolean }
export function pickFetch() // 托管（utilityProcess）时返回 require('electron').net.fetch（走 Chromium 网络栈与系统代理），否则 globalThis.fetch；返回 { fetchImpl, kind: 'electron-net' | 'node' }
```

`downloadFile` 流程：
1. `.part` 已存在且大小 n > 0 → 带 `Range: bytes=n-` 请求。响应 206 → 追加写；200 → 截断重写；416 → 删除 `.part` 从头再来一次。
2. 用 `Readable.fromWeb(res.body)` + 计数 Transform + `fs.createWriteStream(part, { flags })`，以 `stream.promises.pipeline` 连接（背压与出错时关闭流都由 pipeline 负责）。
3. 空闲超时：每收到一块数据重置 `idleTimeoutMs` 计时器；超时用 AbortController 中止，本次尝试记为失败（原因 `idle-timeout`）。
4. 失败后按 backoffMs 等待再试，续传；连续两次在同一源失败则换 `urls` 中的下一个源。超过 `maxAttempts` 抛错，错误信息为「中文原因（原因码）」，取**最后一次尝试**的真实原因，例：`下载 model_fp16.onnx 失败（已尝试 5 次）：连接超时（UND_ERR_CONNECT_TIMEOUT）`。原因码提取顺序：空闲超时 → `idle-timeout`；非 200/206 响应 → `HTTP <状态码>`；`err.cause?.code || err.code`；Electron `net.fetch` 的错误消息形如 `net::ERR_CONNECTION_RESET`，从 message 中提取 `ERR_[A-Z_]+`；都没有时用 `err.name`。中文原因对照（未列出的写「网络错误」）：

   | 原因码 | 中文 |
   |---|---|
   | `idle-timeout` | 空闲超时（<idleTimeoutMs 换算的秒数> 秒无数据） |
   | `HTTP 4xx/5xx` | 服务器返回错误 |
   | `UND_ERR_CONNECT_TIMEOUT`、`ETIMEDOUT`、`ERR_CONNECTION_TIMED_OUT`、`ERR_TIMED_OUT` | 连接超时 |
   | `ECONNREFUSED`、`ERR_CONNECTION_REFUSED` | 连接被拒绝 |
   | `ECONNRESET`、`UND_ERR_SOCKET`、`ERR_CONNECTION_RESET`、`ERR_CONNECTION_CLOSED` | 连接被重置 |
   | `ENOTFOUND`、`EAI_AGAIN`、`ERR_NAME_NOT_RESOLVED` | 域名解析失败 |
   | `ERR_PROXY_CONNECTION_FAILED`、`ERR_TUNNEL_CONNECTION_FAILED` | 代理连接失败 |
   | `ERR_INTERNET_DISCONNECTED` | 网络未连接 |
   | 以 `CERT_`、`ERR_CERT_`、`UNABLE_TO_`、`SELF_SIGNED` 开头或含 `CERT` 的 | 证书校验失败 |

   每次尝试失败的日志行也用同样的「中文原因（原因码）」。`probeHosts` 增加可选参数 `log`，对每个源记录一行结果：可达时 `探测 <host> 可达，<ms>ms`，不可达时 `探测 <host> 不可达：<中文原因（原因码）>`；`EmbedService` 传入 `log`。
5. 成功后 `.part` 改名为 dest。
6. 日志（经 `log` 回调写 console）：每次尝试的源、起始偏移、HTTP 状态；每个文件完成时字节数、耗时、平均速度；每次失败的原因码。

`EmbedService` 改造：
- `download()` 立即返回：已在下载 → `{ ok: true, already: true }`；已就绪 → `{ ok: true, ready: true }`；否则启动后台任务并返回 `{ ok: true, started: true }`。后台任务出错设 `state='error'`、`error=中文信息`，不得出现未处理的 Promise 拒绝。
- 后台任务：mac 先 `ensureVenv()`（不变）→ `pickFetch()` → `probeHosts(HOSTS, REPOS[kind].repo)`；无可达源 → 错误「无法连接 huggingface.co 与 hf-mirror.com，请检查网络或代理」→ 按可达顺序逐个文件 `downloadFile` → sha256 与 manifest（不变）。
- `progress` 增加字段：`host`、`attempt`、`speedBps`（最近 5 秒平均），保留现有字段。
- 删除旧的 `downloadTo`。`HOSTS`、`REPOS` 保留在 embed.js。
- `src/pages/RagManage.tsx`：模型 `state === 'downloading'` 时轮询间隔改为 1 秒，否则 5 秒；下载中显示「正在从 <host> 下载 <file>：<已下载 MB>/<总 MB>（<速度 MB/s>），第 <attempt> 次尝试」。`src/lib/api.ts` 的 `ragModelDownload` 返回类型加上 `started?/already?/ready?`，RagStatus 的 progress 类型加新字段。

### 七、ONNX 推理移入 worker_threads

- `server/rag/onnxWorker.js`（新，worker 入口）：`workerData = { dir, modelPath, eps: string[] }`。加载 `AutoTokenizer.from_pretrained(dir)`（`env.allowLocalModels = true; env.allowRemoteModels = false`）与 `ort.InferenceSession.create`（按 eps 顺序尝试并降级 `cpu`，与现 `_loadOnnx` 相同）。就绪后 `postMessage({ t: 'ready', ep })`，加载失败 `{ t: 'fatal', error }`。收到 `{ t: 'embed', id, texts, maxLength }` 执行**从 `_loadOnnx` 原样搬来**的分批（8 条一批）、`f16To32`、CLS 取向量、L2 归一化代码，回 `{ t: 'result', id, vecs }`（vecs 为 `Float32Array[]`，用 transferList 转移各自 buffer），出错回 `{ t: 'error', id, error }`。`f16To32` 若在 embed.js 中定义，移到可共享的位置或在 worker 内保留唯一一份，不要两处各一份。
- `embed.js` 的 `_loadOnnx()`：创建 `new Worker(new URL('./onnxWorker.js', import.meta.url), { workerData })`，等 `ready`（或 `fatal` → 抛错）；返回 `{ kind: 'onnx', ep, embed(texts, opts) → Promise<Float32Array[]>, dispose() }`。worker 意外退出时：所有挂起请求以错误结束，`this._runtime`、`this._loading` 置空，下次调用重新加载。`EmbedService` 在 `_runtime = null` 的已有位置（重新下载、导入、`dispose`）调用旧运行时的 `dispose`。
- **禁止对 ONNX worker 调用 `worker.terminate()`**：worker 正处于 onnxruntime 原生 `session.run` 时被终止，会因未捕获的 `Napi::Error` 触发 `std::terminate`，整个后端进程 SIGABRT 退出（已实测，约 2/3 概率）。`dispose()` 改为**优雅关闭**：
  - 主线程：该运行时此后的新 `embed` 调用立即以错误结束（调用方经 `EmbedService.ensureReady` 会重建新运行时）；已发出的请求照常等待结果；向 worker 发 `{ t: 'close' }`。60 秒后 worker 仍未退出则 `console.warn('[rag] ONNX worker 关闭超时（60s），保留线程')`，**仍不 terminate**。
  - worker：所有消息按到达顺序串行处理（用一条 Promise 链），`close` 排在已收到的 `embed` 之后，执行到它时 `process.exit(0)`（此时不在原生调用中）。
- worker 内的日志不得直接用 `console.*`（worker 的 console 不经过后端进程已接管的 console，写不进 backend.log）：用 `parentPort.postMessage({ t: 'log', level: 'info'|'warn'|'error', message })`，主线程收到后 `console[level === 'info' ? 'log' : level]('[rag] ' + message)`。EP 降级原因、会话加载耗时都按此上报。
- 调用方（`server/rag/manager.js`）不改。

### 八、界面

- `src/lib/diagnostics.ts`（新）：`export function installRendererDiagnostics()`，在 `src/main.tsx` 渲染前调用一次。监听 `window` 的 `error` 与 `unhandledrejection`（消息 + 堆栈，截断 4000 字符，level ERROR）；`PerformanceObserver` 观察 `longtask`（`buffered: true`），时长 ≥ 1000ms 记 `[longtask] <ms>ms 页面 <location.pathname>`（level WARN）。队列每 2 秒批量 `fetch('/api/log', POST)`（直接用 fetch，不经 `api.req`；单批 ≤ 50 条；队列超过 200 条丢弃最旧；上报失败静默丢弃，不重试，不得递归产生新错误）。
- `src/components/DiagnosticsBanner.tsx`（新）：挂在 `Layout.tsx` 的 `<UpdateBanner />` 之后。挂载时 `api.diagnosticsState()`；`pending` 非空时显示一行横幅（样式参照 UpdateBanner）：「上次运行出现异常：<中文类型>（<本地时间>）。可以导出诊断信息发给开发者。」按钮「导出诊断信息」（成功后横幅内显示「已导出到 <路径>」并调用 ack）、「×」（调用 ack 并隐藏）。中文类型：`unclean-exit` 上次没有正常退出；`backend-exit` 后台服务意外退出；`renderer-gone` 界面进程崩溃；`child-gone` 子进程异常退出。
- `Settings.tsx` 关于页：在「关于与更新」区块内末尾加「诊断信息」小节：说明「出现卡顿、白屏或报错时，导出诊断信息发给开发者。包含运行日志与环境信息，不含文档正文、对话与 API Key。」+ 按钮「导出诊断信息」+ 就地结果文字（成功显示路径，失败显示错误）+ 日志目录路径文字。此小节在开发模式（更新不可用）下同样显示。
- `src/lib/api.ts` 新增 `diagnosticsState`、`diagnosticsAck`、`exportDiagnostics`。

## 边界情况

| 情况 | 期望 |
|---|---|
| 日志目录不可写 | 日志静默失效，应用照常运行，不抛错 |
| 日志写入极频繁 | 同步追加，轮转后单文件不超过 maxBytes + 一行 |
| 进程崩溃 | `uncaughtExceptionMonitor` 已同步写入 FATAL 行，进程照常崩溃 |
| session.json 损坏 | 仍视为上次未正常退出，detail 记 `{ raw: '无法解析' }` |
| incidents.jsonl 有坏行 | 跳过坏行 |
| 桌面不存在/无权限 | 导出到 `<数据目录>/diagnostics/`，返回实际路径 |
| 日志总量超 30MB | 按新到旧收录，最后一个文件只收末尾 |
| 后端启动阶段崩溃（如原生模块加载失败） | 启动页错误态，显示退出码；main.log 有 stderr 末尾 50 行；可导出诊断包 |
| 后端运行中崩溃 | 窗口切到启动页错误态；「重新启动」后恢复到应用首页 |
| 启动中再次双击 | 已有窗口被还原并聚焦 |
| 端口在重启后端时被占 | 重新选空闲端口 |
| 下载时两个源都不可达 | 立即报中文错误，不卡住，不残留未关闭的写流 |
| 下载中断网/连接被重置 | 按 backoff 重试并从 `.part` 续传 |
| 服务端不支持 Range（回 200） | 截断重下 |
| 下载已在进行时再点下载 | 返回 already，不起第二个任务 |
| worker 中 DirectML 不可用 | 降级 cpu，日志记录降级原因 |
| worker 崩溃 | 挂起的 embed 全部报错；下次调用自动重建 worker |
| 前端上报接口失败 | 静默丢弃 |

## 实施步骤（按序；每步可独立验收、单独提交）

1. **日志、看门狗、异常事件与诊断导出**（进程结构不变；主进程仍内嵌后端时，`markSessionStart/End` 与 incident 由 main.js 调用，后端导出时 `host.gpu` 写 null）：`logger.js`、`logInit.js`、`lagWatch.js`、`diagnostics.js`、`zip.js`、日志点、`/api/log` 与 `/api/diagnostics/*`、`revealInFolder` 抽取、`diagnostics.ts`、`DiagnosticsBanner`、设置页小节、`scripts/test-diagnostics.mjs`。
2. **后端移入 utilityProcess**：`host.js`、`main.js` 新流程、`startup.html`、preload 增补、`update.js` await、宿主桥 RPC。
3. **模型下载重写**：`download.js`、`EmbedService.download` 改造、RagManage 进度与轮询、`scripts/test-download.mjs`。
4. **ONNX 推理进 worker**：`onnxWorker.js`、`_loadOnnx` 改造、worker 生命周期。

## 验收标准

通用（每步都要）：
- G1 `npx tsc -b` 退出码 0。
- G2 `npx eslint .` 的错误数不超过基线 21；本次新增的文件没有 eslint 错误；修改的文件不新增 eslint 错误（以改动前同一文件的错误为基线，如 `Layout.tsx` 既有 2 个 `react-hooks/refs`）。
- G3 `node scripts/test-linkmatch.mjs` 50/50 通过；`node scripts/test-retrieval.mjs` 全部 PASS。
- G4 `npm run build` 成功。

步骤 1：
- A1 `node scripts/test-diagnostics.mjs` 全部通过，至少覆盖：轮转（写入 12MB、maxBytes=5MB → 存在 `x.log`、`x.log.1`、`x.log.2`，不存在 `x.log.3`，每个 ≤ 5MB + 一行）；行格式匹配 `^\d{4}-\d\d-\d\dT[\d:.]+Z (INFO |WARN |ERROR|DEBUG|FATAL) \[\w+\] `；看门狗（`thresholdMs=100`）：①`withActivity('甲', () => 同步忙等 400ms)` 立即执行、中间无 tick，日志 `[lag]` 行含「甲」；②两个并发 `withActivity('乙', async…)`、`withActivity('丙', async…)` 以与开始相反的顺序结束后，再同步忙等 400ms（不登记活动），该条 `[lag]` 行为「无记录」，不含乙、丙；`markSessionStart` 两次（中间不 end）→ `pendingIncident` 返回 `unclean-exit`，`ackIncidents` 后返回 null；`exportDiagnostics` 产出的 zip 能被 `unzip -t` 校验通过，且 `python3 -c "import zipfile,sys;print(zipfile.ZipFile(sys.argv[1]).namelist())"` 列出 `summary.json`、`说明.txt`、`logs/…`（中文名正确）；`summary.json` 中不存在 `apiKey`、`baseUrl` 字段。
- A2 启动 `WORKBENCH_DATA_DIR=<临时> node server/index.js` 后：`<临时>/logs/backend.log` 存在且含服务监听行；`curl -X POST /api/log -d '{"entries":[{"level":"ERROR","message":"probe"}]}'` 返回 ok 且 `renderer.log` 出现 `[renderer] probe`；body 为 `{"entries":"x"}` 返回 400；`POST /api/diagnostics/export` 返回的 `file` 存在。
- A3 `npm run test:e2e` 与 `./node_modules/.bin/electron scripts/e2e-filetree.mjs`（先 build）结果与改动前一致。

步骤 2：
- B1 `./node_modules/.bin/electron .`（`WORKBENCH_DATA_DIR` 指向含一个测试库的临时目录）：`main.log` 中「窗口创建」时刻距进程启动 < 2000ms；出现「后端 ready」行；页面最终加载应用（可用 `curl` 访问 main.log 记录的端口 `/api/config` 返回 `configured: true`）。
- B2 进程列表中存在独立的后端进程（macOS `ps` 可见 `Xuewen Workbench Backend` 或 utility 进程），且 `kill -9 <后端 pid>` 后：main.log 有后端退出记录，`incidents.jsonl` 新增 `backend-exit`；窗口未退出。
- B3 主进程不受后端负载影响：用 `WORKBENCH_LAG_THRESHOLD_MS=200` 启动并打开一个约 1500 个文件的库（冷缓存），`backend.log` 可以有 `[lag]`，`main.log` 不得有任何 `[lag]` 行。
- B4 删除（回收站）、用系统应用打开、在文件夹中显示、更新状态接口（开发模式返回 `enabled:false`）在托管模式下工作。
- B5 正常退出后 `session.json` 不存在；`kill -9` 主进程后再启动，`GET /api/diagnostics/state` 的 `pending.kind` 为 `unclean-exit`。
- B6 `npx electron-builder --mac dir --arm64` 产物 `.app` 可启动并完成 B1（验证 asar 内 fork 与原生模块）。
- B7 `npm run dev`、`npm run dev:server`、所有 `scripts/e2e-*.mjs` 不需要任何修改即可照常运行。

步骤 3：
- C1 `node scripts/test-download.mjs` 全部通过：脚本内起本地 HTTP 服务器提供 20MB 随机文件（支持 Range），注入「首次在 5MB 处断开连接」「第二次在 8MB 处停发超过 idleTimeoutMs（测试中设 1000）」，最终 sha256 与源一致，服务器日志显示后续请求带 `Range`；源不支持 Range 时截断重下仍成功；全部源不可达时 `probeHosts` 返回 `[]`；任何情况下测试结束时无打开的文件句柄残留（下载函数返回或抛错后 `.part` 能被立即删除，Windows 语义下尤其重要）。
- C2 `POST /api/rag/model/download` 在 500ms 内返回 `started`；下载期间 `GET /api/rag/status` 响应 < 200ms 且 progress 含 host/attempt/speedBps。
- C3 托管模式下 `pickFetch().kind === 'electron-net'`（backend.log 记录），独立模式为 `node`。

步骤 4：
- D1 `node scripts/test-onnx-worker.mjs` 通过：用 `scripts/make-onnx-fixture.py` 生成的夹具模型（输入输出签名与 bge-m3 ONNX 相同，输出 float16）加真实 bge-m3 分词器，强制 `WORKBENCH_RAG_EMBED=onnx`。① 固定 3 条文本，新 worker 实现与旧同步实现的向量逐维差值 ≤ 1e-6；② 64 条约 500 字文本推理期间，主线程 20ms 定时器最大延迟 < 100ms（同负载下旧同步实现的最大延迟作为对照报告）。缺网络或缺 `uv` 是唯一允许的跳过条件。
- D2 同一脚本：`dispose()` 后立即 `embed` 报错、再次调用自动恢复；worker 被 `terminate()` 时挂起请求报错、之后自动恢复。
- D3 `node scripts/test-retrieval.mjs` 不受影响。

## 明确禁止

- 不得引入任何新的 npm 依赖（zip、日志、下载全部用 Node/Electron 内置能力实现）。
- 不得在日志、诊断包里输出文档正文、对话内容、LLM 提示词与回复、API Key、baseUrl。
- 不得注册 `process.on('uncaughtException')` 或 `process.on('unhandledRejection')` 改变崩溃语义（只能用 `uncaughtExceptionMonitor`）。
- 不得改动扫描/索引/内链/检索算法，不得改动 `scripts/e2e-*.mjs` 与 `scripts/test-*.mjs` 的既有用例来让它们通过。
- 不得删除 `wbHost` 现有字段，不得改变独立 dev server 的启动方式与行为。
- 不得在产物中留下过程叙事注释（如“此处已修复”“改动说明”）；注释只写代码本身的意图。
- 新写的大文件分块写入（每次约 150 行以内），写一节测一节。
