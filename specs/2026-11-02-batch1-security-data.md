# 规格：第 1 批——安全与数据修复

日期：2026-11-02 ｜ 状态：施工中 ｜ 读者：施工者（无对话上下文也可施工）

## 背景与目标

一次只读审查（含实验复现）发现：语料里的 Word 文档可执行脚本并调用全部接口；语料目录下的 `.pi/` 扩展会被助手当作可信代码执行；只读模式实际不生效；本机接口不校验 Host/Origin，可被 DNS rebinding 与跨站请求利用；导入 skill 的 zip 可路径穿越；GBK 等非 UTF-8 文本被当 UTF-8 编辑，一保存原文即毁。成功标准：下列每条攻击/误操作场景都被挡住且有自动化测试；正常功能（阅读、编辑、助手、检索、更新、e2e）不退化。

## 非目标

- 不做 GBK 写回（没有内置 GBK 编码器，不引入 iconv-lite）：非 UTF-8 文本一律只读。
- 不改 pi SDK 本身；不改检索、内链、RAG 算法；不做代码签名。
- 不处理第 2–4 批的问题（RAG 一致性、阅读页重载、性能、包体积、动效）。

## 假设（施工方按此执行）

1. 助手运行模式持久化到 `llm-settings.json` 的 `mode` 字段；**新装与未设置时默认 `confirm`**（原默认 auto）。`open_doc` 从需确认名单移除（只是在界面打开文档，无破坏性）；`remember`、`forget` 加入需确认名单。
2. CSP 只在托管构建产物时（设置了 `WORKBENCH_STATIC_DIR`，即 Electron 与生产）下发；Vite 开发模式不加，避免破坏 HMR。
3. `img-src` 允许 `https:`/`http:`，保留语料 HTML 里远程图片的现有行为；聊天窗口里的图片另行限制（见 §六）。
4. 开发模式后端默认只监听 `127.0.0.1`；需要局域网访问时显式设 `WORKBENCH_HOST=0.0.0.0`。

## 现状（相关代码）

- `server/word.js:68-74` `docxToHtml`：mammoth 输出的 HTML 原样返回；`src/components/WordReader.tsx:13` 用 `dangerouslySetInnerHTML` 渲染，**未净化**。对照：`src/components/HtmlReader.tsx:168` 已用 `DOMPurify.sanitize(content, { USE_PROFILES: { html: true } })`。
- `server/index.js`：无 Host/Origin 校验；`app.post('/api/config')` 调 `addOrActivateLibrary(req.body?.baseDir)`，其中 `path.normalize(String(baseDir || '').trim()…)` 对空串得到 `"."`；`app.listen(PORT, HOST)` 在 HOST 未设时监听所有地址；前端 `index.html` 由服务端注入主题内联脚本（约第 1790–1830 行，`window.__WB_THEME__=` 那段 `<script>`）。
- `server/index.js:207` `readTextPreserve`：只认 UTF-8 BOM，其余一律 `toString('utf8')`；`app.get('/api/file')`（514）返回 `readonly: isDerived`；`app.put('/api/file')`（596）写回 UTF-8。`server/indexer.js:41` 同样 `readFileSync(abs, 'utf8')`。
- `server/index.js:182` `resolveWithin`：目标不存在时只做静态前缀校验，不检查已存在的父目录是否为指向库外的符号链接。
- `server/agent/manager.js`：
  - `:17-19` `READONLY_TOOLS` / `DESTRUCTIVE_TOOLS` / `TOOL_NAMES`；`:44` `this.mode = 'auto'` 只在内存。
  - `:394-398` `pi.on('tool_call')` 钩子只拦 `bash` 走确认。
  - `:908` `new DefaultResourceLoader({ cwd, agentDir, … })` 未传 `settingsManager` → pi 的 `SettingsManager.create` 默认 `projectTrusted: true`（`node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js:238`），库根目录（cwd）下的 `.pi/` 扩展、skills、mcp.json 被加载执行。
  - `:979` `extensionFactories: [..., createMcpExtension()]`；`:982` `SettingsManager.inMemory(...)` 传给 `createAgentSession`；`:999` 会话 `tools: TOOL_NAMES` 与模式无关；`:1284` `_confirm` 非 confirm 模式直接放行；`:1407` 模式切换只调 `_applyModeToSessions`（只改内存中的会话）。
  - `:454` 附近 `read_doc` 的库内校验用 `startsWith(base)`，未带路径分隔符。
- `server/agent/routes.js:230-262` skill 导入：zip 条目 `path.join(dest, rel)` 无包含性校验；`:266` `DELETE /skill/:name` 直接 `path.join(skillsDir, req.params.name)` 后递归删除。
- `src/components/agent/mdInline.tsx:13-24`：Markdown 图片 `<img src={m[2]}>` 任意 URL。
- `electron/main.js`：`setWindowOpenHandler` 已拒绝新窗口，但无 `will-navigate` 限制；`/api/open-external`（`server/index.js:534`）可打开任意绝对路径，含可执行文件。
- `server/store.js:7-29`：数据目录 `~/.xuewen-workbench`；v0.1.1–v0.1.3 的数据在 Electron userData 下的 `data/`（macOS `~/Library/Application Support/Xuewen Workbench/data`，Windows `%APPDATA%\Xuewen Workbench\data`），当前迁移分支走不到。
- `vite.config.ts:14` 代理目标 `http://${WORKBENCH_HOST || 'localhost'}:${port}`。

## 设计

### 一、Word 预览净化 + CSP
1. `src/components/WordReader.tsx`：渲染前 `DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })`（与 HtmlReader 同一配置；mammoth 的 `data:` 图片须保留，DOMPurify 默认对 `img` 允许 data URI，测试确认）。净化在 `useMemo` 中按 html 计算一次。
2. CSP（`server/index.js` 下发 index.html 的那段）：每次请求生成随机 nonce（`crypto.randomBytes(16).toString('base64')`），注入的主题脚本写成 `<script nonce="…">`，并设响应头：
   ```
   Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-<n>'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self'; media-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'
   ```
   构建产物里若还有其它内联 `<script>`（检查 `dist/index.html`），同样加 nonce。施工后用 Electron 实机打开应用，确认控制台无 CSP 违规报错、各页面正常（含 CodeMirror、助手 SSE、生图图片 `/api/agent/generated/`）。
3. `electron/main.js`：`win.webContents.on('will-navigate', (e, url) => { 只允许 file://…/startup.html 与 http://127.0.0.1:<当前端口>/ 开头（开发模式另加 Vite 地址）；其余 e.preventDefault()，http(s) 交给 shell.openExternal })`。

### 二、本机接口的 Host / Origin 校验
`server/index.js` 在所有路由之前加中间件：
- 允许的主机名：`127.0.0.1`、`localhost`、`[::1]`；若设置了 `WORKBENCH_HOST` 且不是以上之一（如局域网开发），把它也加入。
- `Host` 头的主机名（去掉端口）不在允许集 → `403 { error: 'forbidden-host' }`。
- 存在 `Origin` 头时：值为 `null`，或其主机名不在允许集 → `403 { error: 'forbidden-origin' }`（端口不限，以兼容 Vite 开发端口）。
- 记一条 WARN 日志（方法、路径、Host、Origin），同一来源 1 分钟内只记一次。
- `HOST` 未设置时默认 `'127.0.0.1'`；`vite.config.ts` 代理目标默认改为 `127.0.0.1`（`localhost` 可能解析到 `::1` 导致连不上）。
- `addOrActivateLibrary`：baseDir 去空白后为空 → `{ ok: false, error: '缺少资料库目录' }`（400）。

### 三、非 UTF-8 文本只读
1. 新增 `server/textDecode.js`：`export function decodeText(buf) → { content, bom, encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030', lossless: boolean }`：
   - UTF-8 BOM → 去 BOM，utf-8；UTF-16 LE/BE BOM → 用 `TextDecoder('utf-16le'|'utf-16be')`；
   - 否则 `new TextDecoder('utf-8', { fatal: true })`，成功即 utf-8；
   - 失败 → `new TextDecoder('gb18030')`（非 fatal），encoding 记 `gb18030`。
   - `lossless` 只对 utf-8 为 true。
2. `readTextPreserve` 与 `indexer.build` 的文本读取都改用 `decodeText`（单一真相源；检索、内链、RAG 自然拿到正确正文）。
3. `GET /api/file`：非 utf-8 → `readonly: true`、`encoding`、`readonlyReason: '此文件为 <GBK/UTF-16> 编码，为避免损坏原文只读显示'`。utf-8 文件不返回 readonlyReason。
4. `PUT /api/file` 与其它写正文的路径（笔记追加、另存、`content_hash` 同步若会写正文则同理）：目标现有内容非 utf-8 → `409 { error: 'non-utf8', message: … }`，不写。
5. 前端 `Read.tsx` 只读徽标处：有 `readonlyReason` 时显示其文字（title 与可见文字），其余不变；`src/lib/types.ts` 加可选字段。

### 四、助手
1. 资源加载不信任库目录：`DefaultResourceLoader` 传入 `settingsManager: SettingsManager.create(cwd, this.agentDir, { projectTrusted: false })`（若该 API 签名不同，以 pi 源码为准实现同等效果：库根的 `.pi/` 下扩展、skills、prompts、mcp.json、settings 一律不加载）。`createMcpExtension` 的配置来源只能是 `agents/default/mcp.json`（设置页写入的位置）：查 pi 源码确认它读哪里；若读的是全局 `~/.pi/agent/mcp.json` 或项目 `.pi/mcp.json`，改为显式传入 `agentDir`/配置路径；无法控制时不挂 MCP 扩展并在报告中说明。
2. 模式：
   - 持久化：`mode` 存入 `llm-settings.json`（与 `baseUrl/model` 同处，经 `ragManager.setLlm` 路径落盘），`AgentHub` 构造时读取；缺省 `confirm`。
   - `_ensureSession` 新建会话时 `tools` 按当前模式选择（readonly → `READONLY_TOOLS`）。
   - 执行防线：`tool_call` 钩子对所有工具生效：readonly 模式下不在 `READONLY_TOOLS` 的一律 `{ block: true, reason: '只读模式' }`；confirm 模式下在 `DESTRUCTIVE_TOOLS` 的走 `_confirm`（bash 原有逻辑并入）。自定义工具 execute 包装里已有的确认调用不要重复弹两次。
   - `DESTRUCTIVE_TOOLS`：去掉 `open_doc`，加入 `remember`、`forget`。
3. `read` 工具路径限制：钩子里对 `read` 的目标路径 resolve（相对路径以 cwd 为基准）后，只允许位于当前资料库根目录或 `agents/default/skills/` 内（用 realpath + 带分隔符的前缀判断）；否则 block，reason 说明只能读资料库与 skills。
4. `read_doc` 的库内判断改为 `rel === '' || abs === base || abs.startsWith(base + path.sep)` 的形式。

### 五、skill 导入与删除
- 名称白名单：`/^[\w\u4e00-\u9fff-]{1,64}$/`；导入与删除都先校验，不合法 → 400。
- zip 每个条目：`const fp = path.resolve(dest, rel)`；`fp !== dest && !fp.startsWith(dest + path.sep)` → 整个导入失败 400 `zip 含越界路径`，已写入的部分删除（先解压到 `dest + '.tmp-<随机>'`，全部校验通过再改名为 dest）。目录条目同理。
- 删除：`const dir = path.resolve(skillsDir, name)`，必须在 skillsDir 内且是目录，否则 400/404。

### 六、其它加固
1. `resolveWithin`：目标不存在时，向上找到最近一个存在的祖先目录做 `realpathSync`，必须位于 `realBase` 内，否则 403 `符号链接指向数据源之外`。
2. 聊天 Markdown 图片（`mdInline.tsx`）：只渲染 `src` 以 `/api/agent/generated/` 开头或 `data:image/` 开头的图片；其余渲染为文字链接（不自动加载）。
3. `/api/open-external`：拒绝可执行类扩展名（大小写不敏感）：`.exe .com .bat .cmd .msi .msp .ps1 .psm1 .vbs .vbe .js .jse .wsf .wsh .scr .pif .lnk .hta .cpl .reg .jar .app .command .sh .pkg .dmg .scpt .workflow`，以及 macOS 上的 `.app` 目录 → 403 `出于安全原因不直接打开可执行文件`。
4. 旧版本数据迁移（`server/store.js`）：主进程在 import `store.js` 前设置 `process.env.WORKBENCH_LEGACY_DATA_DIR = path.join(app.getPath('userData'), 'data')`（后端经环境继承）。`store.js` 在确定 `DATA_DIR` 后：若 legacy 目录存在且含 `config.json`，而新数据目录的 `config.json` 不存在或其 `libraries` 为空 → 把 legacy 目录下每个条目移动到新目录（目标已存在的条目跳过），移动完成后在 legacy 目录写 `MIGRATED.txt` 说明去向；否则（新目录已有库）不动，记一条 WARN 说明两处路径。迁移逻辑只在主进程执行一次（后端进程看到 `WORKBENCH_HOSTED=1` 时跳过），避免两进程同时搬。

## 边界情况

| 情况 | 期望 |
|---|---|
| Electron 正常使用 | 所有请求 Host=127.0.0.1:端口、Origin=http://127.0.0.1:端口，全部放行 |
| `npm run dev`（Vite 3000 代理） | Origin=http://localhost:3000 放行；Host 被改写为目标，放行 |
| curl 不带 Origin | 放行（本机进程本就有完整权限） |
| Origin: null（本地 html 文件发请求） | 403 |
| GBK 文件被 chokidar 重扫 | 检索、内链按 gb18030 正文工作 |
| 带 BOM 的 UTF-8 | 行为不变，可编辑 |
| 空文件 | utf-8，可编辑 |
| 只读模式下模型请求 bash | 被拒，前端收到工具错误 |
| zip 内 `../x`、绝对路径条目、`C:\x` | 导入失败，不留任何文件 |
| legacy 目录与新目录都有库 | 不迁移，WARN |

## 实施步骤

1. 文本解码（`textDecode.js`、读写路径、前端只读理由）+ Host/Origin 中间件 + 空 baseDir + 默认监听 127.0.0.1 + vite 代理。
2. Word 净化 + CSP + will-navigate + open-external 拦截 + resolveWithin 祖先 realpath + mdInline 图片。
3. 助手：projectTrusted、MCP 来源、模式持久化与执行防线、read 限制、read_doc 分隔符。
4. skill zip / 删除。
5. 旧数据迁移。
6. 测试脚本 `scripts/test-security.mjs`（见验收），全量回归。

## 验收标准

通用：`npx tsc -b` 通过；`npx eslint .` 错误数不超过 21 且新增/修改文件不新增错误；`node scripts/test-linkmatch.mjs`、`test-retrieval.mjs`、`test-diagnostics.mjs`、`test-download.mjs`、`test-onnx-worker.mjs` 全过；`npm run build` 成功；`npm run test:e2e` 与 `electron scripts/e2e-filetree.mjs` 结果与改动前一致（226/60）。

`node scripts/test-security.mjs`（新增，自起临时后端，`WORKBENCH_DATA_DIR` 临时，`WORKBENCH_RAG_EMBED=mock`）全过，至少覆盖：
- S1 Word：构造含 `<a href="javascript:…">` 与 `<img src=x onerror=…>` 的 docx（用 python-docx 或手写最小 docx zip；若生成 docx 困难，可直接对 WordReader 的净化函数做单元测试，但净化函数必须是 WordReader 实际调用的同一个导出函数），断言净化后不含 `javascript:`、`onerror`，仍含 `data:image` 图片。
- S2 CSP：`GET /`（设 `WORKBENCH_STATIC_DIR=dist`）响应头含 CSP，nonce 与页面内联脚本的 nonce 一致；页面内没有不带 nonce 的内联脚本。
- S3 Host：`Host: evil.example:<port>` → 403；`Origin: https://evil.example` 的 POST `/api/config`（`Content-Type: text/plain`）→ 403 且 config.json 未变；`Origin: null` → 403；`Origin: http://localhost:3000` 与无 Origin → 正常。
- S4 空 baseDir：`POST /api/config {}` → 400，config.json 无 `"."`。
- S5 编码：GBK、UTF-16LE(BOM) 文本 → `GET /api/file` 内容正确解码、`readonly:true`、有 `readonlyReason`；`PUT` → 409 且磁盘字节不变；`/api/search` 能搜到其中的中文词。
- S6 skill：含 `../evil.txt` 条目的 zip → 400，`agents/default/skills` 外与内都没有残留；`DELETE /api/agent/skill/..%2F..%2Fx` → 400，目标目录仍在。
- S7 符号链接：库内 `link -> <库外目录>`，另存为 `link/new.md` → 403，库外无新文件。
- S8 open-external：`.exe` / `.sh` / `.app` 路径 → 403。
- S9 助手（用一个本地假 OpenAI 兼容端点，脚本内起 http 服务按需返回 tool_call）：①库根放 `.pi/extensions/x.js`（执行时写标记文件），发一条消息后标记文件不存在；②mode=readonly 新开会话，假端点收到的 tools 列表不含 bash，强行返回 bash tool_call 被拒、无副作用；③重启后端后 `GET /api/agent/status` 的 mode 仍为上次设置的值；新数据目录默认 `confirm`；④confirm 模式下 `read` 库外文件被拒。
- S10 迁移：构造 legacy 目录（含 config.json 与 models/），新目录不存在 → 启动后数据出现在新目录、legacy 有 MIGRATED.txt；新目录已有库 → 不迁移。（迁移逻辑若在主进程，测试可直接 import 迁移函数调用。）

Electron 实机：`./node_modules/.bin/electron .`（临时数据目录 + `test-data/ds-a`）打开概览、阅读 md、阅读 docx（`test-data` 中的 docx）、检索、助手页、设置页，主进程与渲染进程控制台无 CSP 违规（main.log / renderer.log 无 `Content Security Policy` 报错）。

## 明确禁止

- 不得引入新 npm 依赖（DOMPurify 已在依赖中）。
- 不得放宽或删除既有测试断言；不得修改 `scripts/e2e-*.mjs` 让其通过（若 Host/Origin 校验导致 e2e 失败，说明 e2e 的请求方式与真实环境不符，先停下报告原因）。
- 不得在日志中输出 API Key 或请求体正文。
- 不得改动第 2–4 批范围的代码（RAG 构建、阅读页加载逻辑、性能、包体积、动效）。
- 产物无过程叙事注释。新文件超过 150 行分块写。
