# 规格：反馈第 3 批——助手全程可见

## 背景与目标
统一口径见 `specs/2026-11-03-feedback-overview.md`，本批对应其中「第 3 批」清单。

助手有三个对话界面：
- 完整页 `src/pages/AgentChat.tsx`
- 浮层 `src/components/QuickAgent.tsx`
- 阅读页面板 `src/components/ReadAgentPanel.tsx`

三处各自写了一份 SSE 事件 → 消息状态的处理逻辑，而且已经出现分叉：
- 浮层和阅读页面板不处理 `confirm`，破坏性工具在「确认」模式下要干等 30 秒，然后被静默拒绝。
- 两个面板都不渲染 thinking。
- 三处都不处理 `compaction` 的开始事件。

工具卡在运行中显示「0ms」，看起来像已经完成；工具结束到模型下一步之间没有任何活动指示。

**成功标准**：
- 三个界面共用同一份事件处理逻辑和同一套活动指示。
- 任何时刻都能看出助手在做什么：连接中、思考中、运行某个工具（带计时）、压缩上下文、等待你确认、生成回答。
- 设置类按钮都有忙碌态，失败都有提示。

## 非目标
- 不改后端的代理逻辑、工具集和确认超时时长。
- 不改消息的持久化格式。
- 不新增依赖。

## 前置
在第 1 批基础件之上施工：`notify`、`Button loading`、`useDelayedFlag`。

## 现状
- `src/lib/agentStream.ts`：`readAgentStream` 负责解析 SSE、判断是否收到完成标记，事件分发交给调用方。
- 三个界面各自的事件分支：`AgentChat.tsx` 约 312–341 行，`QuickAgent.tsx` 约 92–101 行，`ReadAgentPanel.tsx` 约 110–116 行。
- 确认弹窗只在 `AgentChat.tsx` 约 733–751 行；确认接口沿用现有的那个，见 AgentChat 的调用。
- `src/components/agent/ToolCard.tsx`：只按 `durationMs` 显示时长。
- 后端事件定义：`server/agent/manager.js`，约 1013–1091、1133–1180 行，事件类型有：
  - `open`、`start`、`delta`、`thinking`、`usage`
  - `compaction`（start / end）
  - `tool_start`、`tool_end`
  - `confirm`、`open_doc`、`settings_changed`、`steered`
  - `error`、`done`
- 其余入口：
  - 「选择模型」下拉：AgentChat 约 684–690 行，调用 `POST /api/agent/models`，超时 6 秒，失败原因被吞。
  - 记忆「整理」：`MemoryPanel.tsx`，按钮不禁用，可以重复触发。
  - 「测试连通」：`AgentSettingsPanel.tsx`，按钮不禁用。
  - Skill 安装、MCP 增删：`AgentSettingsPanel.tsx` 约 233–299 行，不检查返回结果；`btoa(String.fromCharCode(...大数组))` 遇到大 zip 会抛 RangeError。
  - 打开对话、唤出浮层：没有加载态。
  - 「重新生成」：先串行逐条 DELETE 再重发，中间有空窗。
  - 会话列表：`conversations[].busy` 只用来弹完成 toast。

## 设计
1. **共用事件处理**：在 `src/lib/agentStream.ts` 或新文件 `src/lib/agentReducer.ts` 中实现一个纯函数：
   ```ts
   applyAgentEvent(state: AgentTurnState, ev: AgentStreamEvent): AgentTurnState
   ```
   - `AgentTurnState` 包含：当前助手消息（text / thinking / tools / error）、`usage`、`activity`、`pendingConfirm`。
   - 三个界面都改为调用它，各自只保留界面特有的副作用：`open_doc` 的跳转方式、`settings_changed` 的刷新。
   - 现有三份分支逻辑删除，不留第二份。
2. **活动状态**：`activity` 的取值如下：
   - `{ kind:'connecting' }`：已发送，还没收到任何事件
   - `{ kind:'thinking' }`：收到 start 或 thinking，还没有正文
   - `{ kind:'tool', name, startedAt }`
   - `{ kind:'compacting' }`
   - `{ kind:'confirm', tool }`
   - `{ kind:'generating' }`
   - `null`：结束

   新增共用组件 `src/components/agent/AgentActivity.tsx`，显示图标、一句话和已用秒数：
   - 已用秒数每秒刷新，只在活动持续超过 2 秒后才显示。
   - 三个界面都用它，替代各自的三点动画。
   - 工具运行结束后，到下一个事件到来之前，显示为「思考中」，不能是空白。
3. **工具卡**：工具项增加 `running: boolean` 和 `startedAt`。
   - 运行中显示转圈，加实时计时（mm:ss 或 N.Ns）。
   - 结束后显示最终耗时；出错时为错误态。
   - 同名工具并发或重复调用时，按出现顺序配对：`tool_end` 对应最早一个仍在运行的同名项，不能匹配错位。
4. **确认**：把 AgentChat 的确认弹窗抽成 `src/components/agent/ConfirmToolDialog.tsx`，三个界面共用。
   - 弹窗显示倒计时（剩余秒数），超时后自动关闭，并提示「已超时，操作被拒绝」。
   - 浮层和阅读页面板收到 `confirm` 时同样弹出。
5. **压缩**：收到 `compaction` 的 start 时，activity 为 compacting，文字「正在压缩上下文…」；收到 end 时恢复。AgentChat 现有的 end 处理逻辑保留，迁移到共用的处理函数中。
6. **thinking**：浮层和阅读页面板用现有的 `ThinkingBlock`（`src/components/agent/Extras.tsx`）渲染 thinking，默认折叠。
7. **设置类入口**：
   - 「选择模型」：点开后立即展开下拉，显示加载中；失败时显示原因，并提供「重试」。
   - 「整理记忆」「测试连通」：用 `Button loading`；结果和失败都用 `notify` 提示，或者沿用现有的页内消息，但两者只能选一种，不要并存。
   - Skill 安装、MCP 增删、Skill 删除：
     - 检查 `res.ok` 与返回体，成功或失败都要 `notify`；
     - base64 编码改为分块编码或 `FileReader.readAsDataURL`，修复大 zip 时的 RangeError。
8. **其余**：
   - 打开对话、唤出浮层、打开阅读页面板时，加载中用 `InlineLoading` 配合 `useDelayedFlag`。
   - 「重新生成」从点击起就进入 connecting 活动态。
   - 会话列表里 busy 为 true 的对话显示「生成中」小标记（转圈图标）。

## 边界情况
| 情况 | 期望 |
|---|---|
| 两个工具并发，或同名工具连续调用 | 计时与结果各自对应正确 |
| 确认弹窗打开时，用户关闭了浮层 | 视同拒绝：调用确认接口传 false；不留下悬空的倒计时 |
| 确认超时后用户才点击 | 按钮无效，提示已超时 |
| 流中途断开 | activity 变为 null，现有的失败提示照常出现；运行中的工具卡标记为中断，不能一直转圈 |
| 停止生成 | activity 变为 null，运行中的工具卡标记为已停止 |
| 后台对话完成 | 原有的完成 toast 改用 `notify` |

## 实施步骤
1. 写共用处理函数和它的单测，先让 AgentChat 改用它，保证行为不变。
2. 浮层和阅读页面板改用共用处理函数；接入 `ConfirmToolDialog`、`ThinkingBlock`、`AgentActivity`。
3. 工具卡运行态。
4. 设置类入口与其余各项。
5. 文档：`docs/ARCHITECTURE.md` 的助手章节写明共用处理函数与活动状态。

## 验收标准
- **G1**：`npx tsc -b`、`npx eslint .` 0 问题，`npm run build` 成功。
- **G2**：新增 `scripts/test-agent-reducer.mjs`（node；能直接导入 TS 就直接导入，不能就用现有测试脚本处理 TS 的办法，参照 `scripts/` 下已有的做法）。用事件序列驱动 `applyAgentEvent`，覆盖：
  - delta 和 thinking 正确累积；
  - `tool_start` → `tool_end` 配对，含同名两次、交错两种情况；
  - `confirm` 设置 `pendingConfirm` 和对应的 activity；
  - compaction 的 start 和 end；
  - error；
  - 流结束时运行中的工具被标为中断。
- **G3**：grep 三个界面文件，不再出现 `d.t === 'tool_start'` 这类各自的事件分支。允许保留的界面特有分支只有 `open_doc` 和 `settings_changed`，报告中列出。
- **G4**：UI e2e：在测试 preload 中包装 `fetch`，伪造 `/api/agent/chat` 的 SSE 流，逐个推送事件。分别在 AgentChat、浮层、阅读页面板中断言：
  - 发送后 100ms 内出现 connecting 指示；
  - `tool_start` 后工具卡转圈、计时在增长；`tool_end` 后显示耗时；
  - `confirm` 弹出确认框，显示倒计时；点「拒绝」时调用确认接口，传参为 false；
  - compaction 的 start 显示「正在压缩上下文」。
- **G5**：UI e2e：伪造 `/api/agent/models` 延迟 1 秒后失败，断言下拉立即展开并显示加载中，然后显示失败原因和「重试」。
- **G6**：用一个 300KB 的 zip 走 Skill 安装的前端编码路径，不抛错。用单测直接测编码函数即可。
- **G7**：回归通过以下全部：
  - `scripts/test-*.mjs` 全部，含 `test-agent-failures.mjs`
  - `npm run test:e2e`
  - `e2e-filetree`
  - `test:retrieval:e2e`
  - `e2e-security`
  - `e2e-reader-regress`
  - `e2e-perf`
  - `git diff --check`

## 明确禁止
- 不改后端代理、工具与超时。
- 不保留第二份事件处理逻辑。
- 不改第 1、2、4 批的范围。
- 不新增依赖。
- 不读写 `~/.xuewen-workbench`、`/Users/mayu/Downloads`。
