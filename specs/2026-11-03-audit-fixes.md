# 规格：走查发现的八个体验问题

## 背景与目标
2026-11-03 对 main@2e8f7d8 做了一轮用户旅程走查（12 条路径，Chromium 生产构建），发现 2 个严重、4 个一般、2 个轻微问题。本规格按严重程度排序逐项修复，每项单独提交，每项都有可执行的验收。

## 非目标
- 不改 RAG 检索、嵌入、索引算法本身。
- 不改笔记、标签、检索结果的数据格式。
- 不新增依赖。
- 不重构无关代码。

## 假设
- A1 检索入口里，字面就是查关键词/文件名的（命令面板「全文检索」、目录过滤 `>` 前缀与「转全文检索」、概览页标签/主题/概念、阅读页「搜索同名文件」），一律显式带 `mode=exact`；不带模式的 `/search` 仍默认智能。
- A2 库根目录不可达时，保留上一份快照，不把空结果当成新快照（否则文本索引、内链索引、RAG 增量会把全部文档当成已删除）。
- A3 YAML 头信息只认文档第一行是 `---`、在前 100 行内以 `---` 或 `...` 收尾、中间每个非空行都像 YAML（`键:`、`- 列表项`、缩进续行、`#` 注释）的块。

## 1. 未建智能索引时检索没有结果（严重）
**现状**：`src/pages/Search.tsx` 默认 `mode=smart`。RAG 索引为空时，`api.ragSearch` 抛出「索引为空」，页面只显示「智能检索尚未建索引」。六个入口跳转都不带 `mode`。
**改法**：
- 智能检索因「索引为空」失败时，用 `setParams({ q, mode: 'exact' }, { replace: true })` 切到精确模式，并记下 `smartUnavailable`。精确模式下，`smartUnavailable` 为真时在结果上方显示提示：智能检索尚未建索引，已改用精确检索；附「RAG 管理」链接。
- 以下入口改为带 `&mode=exact`：
  - `CommandPalette.tsx` 的 `fullText`；
  - `Layout.tsx` 目录过滤框 `>` 前缀；
  - `FileTree.tsx` 的「转全文检索」；
  - `Dashboard.tsx` 的标签、主题、概念三处；
  - `Read.tsx` 的「搜索同名文件」。
**验收**：
- V1.1 无 RAG 索引时打开 `/search?q=雪拥蓝关`：URL 变为含 `mode=exact`，出现命中结果，并显示「已改用精确检索」。
- V1.2 命令面板「全文检索」跳转后的 URL 含 `mode=exact`。

## 2. 库目录短暂不可达后监听永久失效（严重）
**现状**：
- `server/scanner.js` 的 `startWatch` 只在 `Library.start()` 时调用一次。
- 根目录消失后，chokidar 监听失效，但 `status().watching = !!this.watcher` 仍为真。
- 根目录不可达时，`rescan()` 把 0 个文件的结果当成新快照并发出 `scan-done`。
- `/api/rescan` 在已有快照时只重扫，不重建监听。
**改法**（`server/scanner.js`）：
- `rescan()` 结果的 `dirErrors` 里含 `path === '.'`（根目录本身失败）时，判为不可达，按以下处理：
  - 设置 `this.unreachable = { since, reason }`，`reason` 是 `fsErrorText` 给出的中文原因；
  - 关闭监听但保留「需要监听」的意图；
  - 启动可达性探测：`setTimeout` 链，间隔 `this.probeIntervalMs`（默认 5000），用 `fs.promises.access`，定时器 `unref`；
  - 已有快照时：保留旧快照，不发 `scan-done`，返回旧快照；
  - 没有快照时：照旧写入带错误的快照。
- 探测发现根目录可达时，调用 `rescan()`。
- 任何一次根目录可达的扫描完成后：
  - 清除 `unreachable`，停止探测；
  - 有监听意图且监听未开时，重新开启监听。
- `startWatch()` 记下监听意图；公开的 `stopWatch()` 清除意图并停止探测；`setBaseDir()` 同样清除。
- 监听器 `error` 事件也按防抖触发一次 `rescan()`。
- `status()` 增加 `unreachable` 字段（无则为 `null`）。

**`fsErrorText`**：新增 `server/fsErrors.js`，导出 `fsErrorText(err)`，把常见 fs 错误码映射成中文：
- `ENOENT`：不存在或已被移走
- `EACCES` / `EPERM`：没有访问权限
- `ENOTDIR`：不是文件夹
- `EBUSY`：被其他程序占用
- `ETIMEDOUT`：访问超时
- `EIO`：读写出错（磁盘或网络盘异常）
- `ELOOP`：符号链接循环
- `EMFILE` / `ENFILE`：打开的文件过多

其他错误码返回 `访问失败（<code>）`，没有错误码时返回 `err.message`。

**前端**：
- `src/lib/types.ts` 的状态类型加 `unreachable`。
- `Dashboard.tsx`：`unreachable` 时显示警示条「知识库目录暂时无法访问：<原因>。目录恢复后会自动重新扫描，也可以点「重新扫描」。」，同时不再显示「N 项扫描失败（其余内容正常）」条；头部的监听状态改为「目录不可访问」。
- `Layout.tsx` 顶栏：`unreachable` 时显示红色「目录不可访问」，代替「自动监听」。
- `Setup.tsx` 库列表：`unreachable` 时标注「目录不可访问」。
**验收**：
- V2.1 新建 `scripts/test-scan-recover.mjs`（node），用真实临时目录与 Scanner：
  - 扫描并开监听，把目录改名移走后 `rescan()`：快照文件数不变，未触发 `scan-done`，`status().unreachable` 非空，`watching=false`。
  - 改名移回，等待探测（测试把 `probeIntervalMs` 设为 200）：`unreachable=null`，`watching=true`。
  - 随后新建文件，监听自动触发扫描，快照里出现该文件。
- V2.2 e2e：目录移走后概览显示「暂时无法访问」且文档数不变；移回后 15 秒内自动恢复，新建文件能出现在树里。

## 3. 跳转后目标被吸顶区挡住（一般）
**现状**：`Read.tsx` 的目录跳转（偏移 70）、`#锚点`（80）、文内查找（120）都是写死的偏移；吸顶区（`sticky top-0 z-20` 那个 div，含标签、工具栏和打开时的查找条/偏好面板）实测高约 119px，查找条打开时更高。
**改法**：
- 给吸顶 div 加 `ref`，新增 `jumpOffset(gap) = (吸顶区高度) + gap`。
- 目录跳转（CodeMirror 与 DOM 两条路径）、`#锚点`（两条路径）改用 `jumpOffset(16)`。
- 文内查找两处改用 `jumpOffset(40)`。
- 检索命中的 `clientHeight / 3` 不动。
**验收**：
- V3.1 e2e：长文点目录「第 30 节」后，标题行顶部 ≥ 吸顶区底部。
- V3.2 带 `#锚点` 打开长笔记，锚点标题行顶部 ≥ 吸顶区底部。
- V3.3 查找条打开时回车跳到命中，命中顶部 ≥ 吸顶区底部。

## 4. 改名/删除后标签不跟随（一般）
**现状**：`src/lib/tabs.ts` 只有增删；`src/lib/entryOps.ts` 的 `runEntryAction` 迁移草稿后跟随导航，但不动标签；`Read.tsx` 的标签 state 只在 dsId 变化时从存储载入。
**改法**：
- `tabs.ts` 新增 `retargetTabs(dsId, from, to, isDir)`：
  - 把等于 `from`（目录时含 `from/` 前缀）的标签改成 `to` 开头；`to` 为 `null` 时移除；
  - 去重保序后保存；
  - 派发 `window` 事件 `wb:tabs-changed`（`detail: { dsId }`）。
- `runEntryAction` 在 `followNavigation` 之前调用它。
- `Read.tsx` 监听该事件，dsId 相同时 `setTabs(loadTabs(dsId))`。
**验收**：
- V4.1 e2e：打开文档 → 改名 → 标签只剩新名、位置不变。
- V4.2 打开文档 → 删除 → 该标签消失。
- V4.3 目录改名时，其下已打开文档的标签一起改。

## 5. YAML 头信息当正文显示（一般）
**现状**：`livePreview.ts` 不识别头信息：首行 `---` 被画成分割线，`title:`、`tags:` 按正文显示。
**改法**：
- 新增 StateField（块级替换必须来自 StateField），按假设 A3 识别头信息块，用块部件 `FrontmatterWidget` 替换整块。部件渲染一个低调的元数据框（类 `cm-lp-fm`，每行一项，键弱化显示）。
- 编辑态下，选区端点落在块内时不替换，显示源码，与表格的做法一致。
- `buildInlineDecorations` 跳过完全落在头信息块内的语法节点。
- 样式进 `makeLpTheme`，用现有颜色变量。
**验收**：
- V5.1 e2e：打开带头信息的文档，正文顶部没有分割线部件，有 `.cm-lp-fm` 框且含 `title`，目录仍从第一个真标题开始。
- V5.2 原位编辑时，把光标放进头信息块，显示源码 `---`。
- V5.3 首行是 `---`、但后面不是 YAML 的文档仍按分割线渲染。

## 6. 带扩展名的 wikilink 不在根目录就判缺失（一般）
**现状**：`server/links.js` 的 `resolveWiki` 只有名称里含 `/` 时才做路径后缀匹配。
**改法**：
- `buildResolve` 增加 `byFile`：小写归一化的文件名（含扩展名）→ 路径数组。
- `resolveWiki` 对不含 `/` 的名称查 `byFile`。
- 命中多个时按现有规则返回候选。
**验收**：
- V6.1 node 测试：子目录里的 `儒家概念表.json` 被 `[[儒家概念表.json]]` 唯一解析；两个子目录各有同名文件时返回候选。

## 7. 报错露出系统错误码（轻微）
**改法**：
- `server/index.js` 的 `testDir`（约 448 行）与 `addOrActivateLibrary`（「目录不可访问」）改用 `fsErrorText`。
- `server/scanner.js` 的 dirErrors/fileErrors 原因（四处）改用 `fsErrorText`。
- 同类的文件读写失败提示也改用它：重新扫描失败（两处）、打开失败、写入失败（两处）、写入笔记失败。没有错误码的自定义错误，`fsErrorText` 原样返回 message。
**验收**：
- V7.1 node 测试覆盖 `fsErrorText` 的映射与兜底。
- V7.2 e2e：测试连接与添加一个不存在的目录，提示里不含 `ENOENT`、`no such file`。

## 8. 记笔记弹框按 Esc 关不掉（轻微）
**改法**：
- 弹框容器上 Esc 关闭。
- 关闭（Esc、取消、点遮罩）时同步写一次草稿，不等 400ms 防抖，否则最后几个字会丢。
**验收**：
- V8.1 e2e：输入后立刻按 Esc，弹框关闭；重开后草稿与输入完全一致。

## 总验收
- `npx tsc -b`、`npx eslint .` 零问题。
- 新增 `node scripts/test-scan-recover.mjs`、`node scripts/test-audit-fixes.mjs`（fsErrorText、wikilink 解析）通过。
- 新增 `electron scripts/e2e-audit-fixes.mjs` 通过。
- 回归全部通过：
  - `electron scripts/e2e-note-marks.mjs`
  - `electron scripts/e2e-reader-regress.mjs`
  - `electron scripts/e2e-retrieval.mjs`
  - `electron scripts/e2e-search-location.mjs`
  - `node scripts/test-retrieval.mjs`
  - `node scripts/test-scan-async.mjs`
  - `node scripts/test-slow-fs.mjs`
  - `node scripts/test-links-async.mjs`
  - `node scripts/test-linkmatch.mjs`

## 明确禁止
- 不许改动 RAG 检索与索引算法。
- 不许改标签、笔记、快照的持久化格式（快照只多一个状态字段）。
- 不许留下调试输出与过程注释。
