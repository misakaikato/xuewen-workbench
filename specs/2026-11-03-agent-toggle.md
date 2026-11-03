# 规格：在设置中开关智能助手（默认关闭）

## 背景与目标
用户希望能在设置里整体关闭 AI 智能助手功能，并且默认关闭。关闭后，界面上不能残留任何助手入口：
- 顶栏入口；
- 快捷键；
- 命令面板；
- 阅读页的 AI 按钮与面板；
- 选中正文后浮动操作条里的「问 AI」。

打开后，所有入口恢复，行为与现在一致。

成功标准：开关为关时，用户无法通过任何界面入口或快捷键进入助手；开关为开时，一切照旧。

## 非目标
- 不删除助手代码，也不改变助手本身的功能。
- 不清除已有的对话、记忆、Agent 设置；关闭只是隐藏，再打开时数据都在。
- 「AI 标注的主题」标签（`TagChips`）和「导入 AI 产出的 JSONL 元数据」（`MetaImport`）不属于助手入口，不受开关影响。
- RAG 检索（智能检索）不属于助手，不受开关影响。

## 假设
- A1：「文件内容上右键菜单中的入口」指阅读页**选中正文后浮出的操作条**里的「问 AI」。代码里没有其他正文右键菜单，Electron 原生菜单里也没有助手项。如果施工时发现别的正文菜单含有助手入口，同样要隐藏，并在报告里列出。
- A2：开关存放在现有的界面设置里（`ui-settings`），字段名 `agentEnabled: boolean`，缺省视为 `false`。老用户升级后，助手默认是关闭的，需要在设置里手动打开。这正是用户要的「默认关闭」。

## 现状（入口清单，行号以实际代码为准）
- 顶栏「智能助手」链接：`src/components/Layout.tsx`，约 199 行，`Link to="/agent"`。
- 浮层助手 `QuickAgent` 与它的快捷键 ⌘J / Ctrl+J：`Layout.tsx`。挂载在约 341 行；快捷键帮助表在约 351 行，有一行「浮层智能助手」。
- 命令面板「智能助手」：`src/components/CommandPalette.tsx`，约 133 行。
- 路由 `/agent`：`src/App.tsx`，约 42 行。
- 阅读页：`src/pages/Read.tsx`
  - 工具栏的 AI 按钮，约 1123 行，`setAiOpen`；
  - 右侧 `ReadAgentPanel`，约 1376 行；
  - 选区浮动操作条里的「问 AI」，约 1469–1477 行。
- 界面设置：
  - 后端：`server/index.js` 的 `PUT /api/ui-settings`，约 475 行起，逐字段校验；存储在 `server/store.js`。
  - 前端：`api.getUiSettings` / `api.saveUiSettings`（`src/lib/api.ts`）；设置页 `src/pages/Settings.tsx`；主题初始化 `src/lib/theme.tsx` 会在启动时读取界面设置。
- 后端助手：`server/index.js` 约 175–184 行，`AgentHub` 与 `/api/agent` 路由。

## 设计
1. **存储与接口**
   - `ui-settings` 增加 `agentEnabled`，缺省 `false`。
   - `GET /api/ui-settings` 返回该字段。
   - `PUT` 接受该字段并校验为布尔值，校验写法与 `autoUpdate` 一致。
   - 同步 `src/lib/api.ts` 里的类型。
2. **前端单一来源**
   - 应用启动时读一次 `agentEnabled`，放进全局状态（沿用现有的 app store 或 theme 上下文，二选一，不另起第三套），对外提供一个 hook，例如 `useAgentEnabled()`。
   - 设置页切换后立即生效，**不需要重启**：所有入口通过这个 hook 读取，状态一变就重新渲染。
3. **关闭时的行为**
   - 顶栏「智能助手」链接不渲染。
   - ⌘J / Ctrl+J 不再打开浮层：快捷键处理里直接忽略；`QuickAgent` 不挂载；快捷键帮助表里不显示那一行。
   - 命令面板里不出现「智能助手」。
   - 访问 `/agent`（地址栏或旧链接）时，重定向到概览页 `/`，并用 `notify` 提示「智能助手已关闭，可在 设置 → 智能助手 中打开」。
   - 阅读页：
     - 工具栏的 AI 按钮不渲染；
     - `ReadAgentPanel` 不挂载；如果关闭时面板正开着，就收起；
     - 选区浮动操作条只保留「记笔记」，不显示「问 AI」。
   - 关闭时如果有正在进行的助手生成，调用现有的 `/api/agent/abort` 中止，然后再隐藏入口，不留后台生成。
4. **后端防御**
   - `agentEnabled` 为 false 时，`/api/agent` 下**会发起生成或修改数据的接口**（chat、确认、导入导出等写操作）返回 409，`{ error: 'agent-disabled' }`。
   - 只读接口（status、会话列表）可以照常返回，供设置页显示数据仍然保留。
   - 如果 `AgentHub` 在启动期就初始化外部资源（MCP 连接、模型探测等），关闭时不要初始化，打开时再按需初始化。若现状本来就是懒初始化，则不改，并在报告中说明。
5. **设置页**
   - 新增「智能助手」区块，含一个开关和一句说明：「关闭后隐藏所有助手入口（顶栏、⌘J、阅读页 AI 面板与「问 AI」）。已有对话和设置会保留。」
   - 开关保存时用 `Button` 或 `Switch` 的忙碌态；失败时 `notify` 报错，并把开关恢复到服务端的实际值。
   - Agent 自己的设置面板（模型、MCP 等）仍放在助手页内，不移动。

## 边界情况
| 情况 | 期望 |
|---|---|
| 关闭时正在 /agent 页 | 跳转到 `/` 并提示 |
| 关闭时浮层助手开着 | 浮层收起，进出场动画照常（`usePresence`） |
| 关闭时阅读页 AI 面板开着 | 面板收起，正文区恢复原宽度 |
| 关闭时有生成在进行 | 先中止生成，再隐藏入口 |
| 设置读取失败 | 按关闭处理（缺省 false），并提示界面设置读取失败（沿用现有提示） |
| 旧版数据里没有该字段 | 视为关闭 |

## 实施步骤
1. 后端存储、接口、409 防御，以及懒初始化的确认。
2. 前端单一来源 hook，以及设置页开关。
3. 逐个入口接入：顶栏、⌘J、帮助表、命令面板、路由、阅读页三处。
4. 测试与文档：`docs/ARCHITECTURE.md` 的助手章节写明开关和 409 语义；`README` 如果提到助手入口，就补一句「默认关闭，可在设置中打开」。

## 验收标准
- **G1**：`npx tsc -b`、`npx eslint .` 均 0 问题，`npm run build` 成功。
- **G2**：新增 node 测试，例如 `scripts/test-agent-toggle.mjs`，在临时 `WORKBENCH_DATA_DIR` 下拉起后端：
  - 默认 `GET /api/ui-settings` 返回 `agentEnabled:false`；
  - 此时 `POST /api/agent/chat` 返回 409 `agent-disabled`；
  - `PUT agentEnabled:true` 后，chat 不再是 409（可以是其他错误，比如未配置模型，但不能是 409 agent-disabled）；
  - `PUT agentEnabled:"yes"` 返回 400。
- **G3**：新增 UI e2e，例如 `scripts/e2e-agent-toggle.mjs`。
  - 默认关闭时断言以下几项：
    - 顶栏没有「智能助手」；
    - 按 ⌘J（或 Ctrl+J）后不出现浮层；
    - 命令面板搜「助手」没有该项；
    - 访问 `/agent` 会落到 `/`，并出现提示 toast；
    - 阅读页没有 AI 按钮；
    - 选中正文后，浮动操作条里没有「问 AI」，但「记笔记」还在。
  - 在设置页打开开关后（不重启），上述入口全部出现：⌘J 能打开浮层，阅读页 AI 按钮能打开面板。
  - 再关闭开关后，入口全部消失；关闭时正开着的阅读页 AI 面板会被收起。
- **G4**：既有的助手相关 e2e（`e2e-agent-activity`、`e2e-agent-feedback`）和 `test:e2e` 中的助手用例都要通过。这些测试本来就默认助手可用，因此需要在测试准备阶段打开开关（`PUT /api/ui-settings agentEnabled:true`）。**只允许新增这一步准备，不得修改既有断言。**
- **G5**：回归通过全部 `scripts/test-*.mjs`、`npm run test:e2e`、`e2e-filetree`、`test:retrieval:e2e`、`e2e-security`、`e2e-reader-regress`、`e2e-update-ui`、`e2e-files-feedback`、`e2e-index-visibility`、`e2e-rag-feedback`，以及 `git diff --check`。

## 明确禁止
- 不删除助手代码与数据；不新增依赖。
- 不改既有测试断言；只允许在测试准备阶段打开开关。
- 开关状态只有一个来源，就是 `ui-settings.agentEnabled`：不得另存 localStorage，也不得在各个组件里各自读取接口。
- 不读写 `~/.xuewen-workbench` 与 `/Users/mayu/Downloads`。
