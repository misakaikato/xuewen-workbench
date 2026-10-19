# 记忆与对话层设计（Agent 架构）

日期：2026-10-19
状态：设计定稿

## 设计目标

- 支持多个 Agent，每个 Agent 有自己的性格、能力、skills、MCP 配置
- 对话与记忆按知识库隔离，不同库互不干扰
- 记忆分三层（全局 / Agent / 库），各层作用域与注入策略不同
- 对话存储单一数据源（pi 会话文件），前端解析渲染，无重复数据

## 目录结构

```
~/.xuewen-workbench/
├── config.json                     # 全局配置（库清单、UI 偏好）
├── models/                         # 共享嵌入模型
│
├── memory/                         # 全局记忆（跨库、跨 agent 共享）
│   ├── facts.jsonl                 #   用户偏好/跨库约定
│   └── summary.md                  #   全局摘要
│
├── agents/                         # Agent 定义（多 agent）
│   ├── default/
│   │   ├── AGENTS.md               # 性格/能力 + 系统提示词（单一文件）
│   │   ├── skills/                 # 此 agent 的 skills
│   │   │   └── <skill-name>/
│   │   │       └── SKILL.md
│   │   ├── mcp.json                # 此 agent 的 MCP 配置
│   │   └── memory/                 # 此 agent 的记忆
│   │       ├── facts.jsonl
│   │       └── summary.md
│   │
│   └── researcher/                 # 另一个 agent（示例）
│       └── ...
│
└── knowledge/                      # 知识库数据（按库隔离）
    └── <dsId>/                     # 例：b30c99fef920（金融库）
        ├── rag.db                  # RAG 索引（切块 + FTS5 + 向量）
        ├── rag-config.json         # 检索参数配置
        │
        ├── memory/                 # 库记忆
        │   ├── facts.jsonl         #   对话中提取的事实
        │   └── summary.md          #   库级别摘要
        │
        └── conversations/          # 此库的对话（按 agent 分）
            └── default/
                ├── index.json      #   对话索引（id/标题/时间/文件夹/排序/置顶）
                ├── folders/        #   对话文件夹
                │   ├── 投资分析/
                │   │   └── <convId>.jsonl
                │   └── 读书笔记/
                │       └── <convId>.jsonl
                └── <convId>.jsonl  #   根目录对话
```

## 标识符设计

| 层 | ID | 作用域 | 说明 |
|---|---|---|---|
| **Agent** | `default` / `researcher` | 全局 | 性格/能力/skills/MCP 定义，跨库共享 |
| **知识库** | `<dsId>`（baseDir 的 hash） | 资料库 | RAG 索引 + 记忆 + 对话按此隔离 |
| **对话** | `<convId>`（随机 hex） | agent + 库 | 一个 agent+库下可有多个对话 |

## 记忆分层

| 层 | 位置 | 内容 | 注入策略 |
|---|---|---|---|
| **Agent 定义** | `agents/<id>/AGENTS.md` | 性格/能力/系统提示词 | 全量注入 |
| **全局记忆** | `memory/` | 用户偏好、跨库约定 | 全量注入（summary + 全部 facts） |
| **Agent 记忆** | `agents/<id>/memory/` | 此 agent 的习性/约定 | 全量注入（summary + 全部 facts） |
| **库记忆** | `knowledge/<dsId>/memory/` | 此库的知识/讨论要点 | summary 全量注入；facts 由模型用 `recall` 按需检索 |
| **对话** | `knowledge/<dsId>/conversations/<agent>/<convId>.jsonl` | pi 会话文件（含 system prompt、完整消息、tool_calls、thinking、usage） | 不注入（对话本身即上下文） |
| **RAG 索引** | `knowledge/<dsId>/rag.db` | 文档语料切块 + 向量 + FTS | 模型用 `rag_search` 检索 |

**注入时机**：会话创建时读取「Agent 定义 + 全局记忆 + Agent 记忆 + 库 summary」拼进 system prompt。对话期间不变。

**冲突优先级**：库记忆 > Agent 记忆 > 全局记忆（就近优先）。库级的规则覆盖全局偏好，system prompt 中按此顺序排列，并在库记忆段落前标注「以下规则优先于全局记忆」。

## 记忆工具

模型通过以下工具自主管理记忆，用户无需感知：

| 工具 | 签名 | 作用 |
|---|---|---|
| `remember` | `(fact: string, kind?: 'preference'\|'knowledge'\|'convention', scope?: 'global'\|'agent'\|'library', pinned?: boolean)` | 写入一条记忆，默认写到库层；`pinned` 标记为永不淘汰 |
| `forget` | `(id?: string, query?: string)` | 删除或纠正记忆 |
| `consolidate` | `(scope?: 'global'\|'agent'\|'library')` | 把该层 facts 压缩重写为 summary.md |
| `recall` | `(query: string, scope?: 'global'\|'agent'\|'library'\|'all', limit?: number)` | 检索记忆，默认库层 |

### recall 与 rag_search 的职责边界

| 工具 | 数据源 | 检索机制 | 用途 |
|---|---|---|---|
| `rag_search` | `rag.db` | 向量 + FTS 混合（RRF 融合） | 查文档语料内容 |
| `recall` | `memory/facts.jsonl` | 关键词匹配 + 打分 | 查历史积累的记忆 |

两者数据源、格式、检索机制均不同，不可混用。

### facts 条目格式

```jsonl
{"id":"f_01a2","fact":"用户偏好简体中文","kind":"preference","pinned":false,"source":"<convId>","at":"2026-10-19T..."}
{"id":"f_01a3","fact":"这个库中「安全边际」集中在证券分析第12章","kind":"knowledge","pinned":true,"source":"<convId>","at":"2026-10-19T..."}
```

`id` 供 `forget` 精确定位；`source` 记录来源对话便于溯源；`kind` 决定注入优先级；`pinned` 标记永不淘汰。

### 容量与淘汰

| 参数 | 值 | 行为 |
|---|---|---|
| 单层 facts 上限 | 200 条 | 超过时触发自动 consolidate |
| consolidate 保留 | 最近 150 条 | 压缩后丢弃最旧 50 条（已融入 summary） |
| summary 上限 | 约 2000 字 | 超过时二次压缩（提炼要点） |

自动 consolidate 由后台在 `remember` 写入后检查触发，无需用户干预。原始 facts 保留最近 150 条以支持 `recall` 和溯源；更早的信息以 summary 形式存在。

### 固定记忆（pinned）

`pinned: true` 的记忆永不淘汰，并（仅库记忆层）额外全量注入 system prompt。

| 约束 | 值 |
|---|---|
| 每层 pinned 上限 | 20 条 |
| 超限行为 | 拒绝新增 pinned，提示用户先取消一些 |
| 注入范围 | 只有库记忆层的 pinned 额外注入（全局/Agent 层本就全量注入，pinned 仅表示不淘汰） |

**语义统一说明**：pinned 在所有层都表示「永不淘汰」；「额外注入」只对库记忆层有意义，因为全局/Agent 记忆本来就全量注入。

## 对话存储

对话直接存 pi 的会话文件（JSONL），前端解析渲染。同一文件两种用途：

- **模型上下文**：pi SessionManager 读出，作为下次请求的完整历史
- **UI 渲染**：前端解析消息（role/content/tool_calls/thinking/usage）渲染为气泡、工具卡、思考块

pi 的 `importFromJsonl()` 支持会话恢复、分叉、续聊；compaction 与分支能力完整保留。

### 对话索引（index.json）

`.jsonl` 文件按文件系统组织（`folders/` 子目录 + 根目录），`index.json` 是权威索引：

```json
{
  "conversations": [
    { "id": "5507c5", "title": "凯利公式有哪些书", "folderId": "投资分析", "pinned": false, "updatedAt": "2026-10-19T..." }
  ],
  "folders": [
    { "id": "投资分析", "name": "投资分析", "order": 0 }
  ]
}
```

移动/删除对话时同时更新 index.json 与文件系统。读取时做一致性校验：文件存在但索引缺失 → 补录；索引存在但文件缺失 → 清除。

## 记忆管理界面

设置页新增「记忆」tab，用户可查看与编辑三层记忆：

| 层 | 可做的操作 |
|---|---|
| **全局记忆** | 查看 facts 列表 + summary；新增/编辑/删除单条；手动触发 consolidate |
| **Agent 记忆** | 同上（按 agent 切换） |
| **库记忆** | 同上（按库切换）；显示注入状态（summary 已注入 / pinned 全量注入 / 其余需 recall）；图钉切换 pinned（每层上限 20） |

编辑后立即生效于**下一个新建会话**（当前会话的 system prompt 已固定）。

## 关键行为

1. **切换库**：对话列表、记忆、RAG 索引均切到对应 `<dsId>` 目录
2. **切换 Agent**：对话列表切到 `conversations/<agentId>/`，记忆切到 `agents/<agentId>/memory/`
3. **删除库**：清理 `knowledge/<dsId>/` 整个目录（RAG + 记忆 + 对话）
4. **删除 Agent**：清理 `agents/<id>/` + 所有库下的 `conversations/<id>/`
5. **对话分组**：拖拽到文件夹（移动文件 + 更新 index.json 的 folderId）
6. **记忆注入**：会话创建时拼装 system prompt（见「记忆分层」的注入策略）
7. **不跨库**：对话绑定创建时的库，`rag_search` 只查当前库，记忆只读写当前库。跨库查询需切换库
8. **记忆容量**：单层 facts 超过 200 条时自动 consolidate（保留最近 150 条 + 全部 pinned，其余压缩进 summary）
9. **固定记忆**：pinned 条目永不淘汰（每层上限 20）；库记忆层的 pinned 额外全量注入 system prompt

## system prompt 结构

```
## Agent 定义
（agents/<id>/AGENTS.md 内容）

## 全局记忆
（memory/summary.md + 全部 facts）

## Agent 记忆
（agents/<id>/memory/summary.md + 全部 facts）

## 本库记忆
（knowledge/<dsId>/memory/summary.md）
（固定记忆：全部 pinned 条目，最多 20 条）
（另有 N 条库记忆未注入，需要时用 recall 检索）

## 工具使用规则
（工具调用对用户透明：不提及工具名称、参数、使用过程）
```

## 记忆写入指引（写入 AGENTS.md）

- **该记**：用户的稳定偏好、跨对话有用的结论、用户明确的约定
- **不该记**：一次性问题、可从语料随时查到的事实（用 `rag_search`）、对话中的临时状态
- **写错了**：用 `forget` 纠正，不追加「更正」条目

## 从现有架构迁移

| 现有 | 迁移后 |
|---|---|
| `agent/conversations/`（UI 投影） | 删除，改用 pi 会话文件 |
| `agent/sessions/`（pi 会话） | `knowledge/<dsId>/conversations/<agent>/` |
| `agent/skills/` | `agents/default/skills/` |
| `agent/mcp.json` | `agents/default/mcp.json` |
| （无） | 新建 `agents/default/AGENTS.md`、`memory/`、`agents/default/memory/` |

**旧对话处理**：开发期数据，直接丢弃（`agent/conversations/` 与 `agent/sessions/` 清空），不做迁移。
配置文件与资料库注册保留，RAG 索引保留。


---

## 决策记录与潜在问题

### 2026-10-19 · AGENTS.md 与 system-prompt.md 合并

**建议**：合并为单一 AGENTS.md（性格/能力/系统提示词一体）。

**分析**：
- ✅ 减少文件数，用户只需编辑一个文件
- ✅ pi 的 context file 机制本身支持 AGENTS.md 自动注入 system prompt（agentDir/AGENTS.md 会自动加载）
- ⚠️ 当前实现用 `systemPromptOverride` 完全替代了默认 prompt——AGENTS.md 不会自动加载，需要手动读文件拼进去
- ⚠️ 潜在 bug：如果 AGENTS.md 很长，会挤占上下文窗口（需要控制长度或摘取关键段落）

**结论**：合并，但实现方式改为「AGENTS.md 作为 system prompt 的一部分」（读文件内容拼到 systemPromptOverride 里，而非依赖 pi 自动加载——因为 override 会屏蔽自动加载）。

### 2026-10-19 · 对话列表直接从文件系统读取

**建议**：不需要独立的 index.json 做索引，文件夹结构直接从文件系统复刻。

**分析**：
- ✅ 文件夹即目录，移动/删除对话直接操作文件系统，不需要同步 index
- ✅ 更直观（用户可以直接在文件管理器里整理）
- ⚠️ 潜在问题：
  - 文件系统扫描在 >1000 个对话时可能慢（届时加 index.json 缓存）
  - 自定义排序/置顶需要额外元数据（index.json 只存这些，不存结构）
  - 文件夹名含特殊字符（/、:、*、?）时 URL 编码可能出问题

**结论**：文件系统直读为主，index.json 降级为「可选的元数据缓存」（只存排序/置顶，不存结构）。


### 2026-10-19 · 对话存储合并为 pi 会话文件（选项 A）

**建议**：删独立的 UI 投影层，对话直接存 pi 会话文件，前端解析渲染。

**分析**：
- ✅ 单一数据源，无同步问题（之前的 id 不匹配 bug 根治）
- ✅ pi 的 `importFromJsonl()` 支持会话恢复/分叉/续聊
- ✅ compaction/分支能力完整保留
- ⚠️ pi 消息格式含嵌套结构，前端需要解析（性能可接受）
- ⚠️ pi 版本升级时消息格式可能变——前端解析逻辑需跟着改（可控，pi 版本我们锁定）
- ⚠️ 潜在 bug：pi 的 JSONL 里含完整工具参数（可能很大），导出/分享时需注意隐私

**结论**：按选项 A 实现——conversations/ 不再存在，对话 = pi 会话文件，前端解析。

### 2026-10-19 · index.json 恢复为完整索引

**建议**：大目录扫描慢，保留 index.json 作为完整索引。

**分析**：
- ✅ index.json 是权威索引（id/标题/时间/文件夹/排序/置顶），读取快
- ✅ 文件系统 folders/ 是存储载体，与 index 同步
- ⚠️ 潜在 bug：index.json 和文件系统不同步（移动/删除时只改了一边）→ 读取时做一致性校验（文件存在但 index 没有 → 补录；index 有但文件不存在 → 清 index）

**结论**：index.json 保留为完整索引，文件系统做一致性校验。

### 2026-10-19 · 记忆分三层 + 四件套工具（remember/forget/consolidate/recall）

**建议**：记忆分全局 / Agent / 库三层；工具方案 2 扩展为四件套，`recall` 与 `rag_search` 分开。

**分析**：
- ✅ 三层记忆解决了「用户偏好跨库共享」与「库知识隔离」的矛盾
- ✅ `recall` 与 `rag_search` 分离：数据源不同（facts.jsonl vs rag.db）、检索机制不同（关键词 vs 向量混合），混用会让模型困惑
- ✅ 会话创建时注入（保守方案，零技术风险）
- ⚠️ 潜在问题：
  - 三层记忆的 `remember` 默认 scope 若判断错误，会把库知识写进全局（污染）→ system prompt 里给明确判断规则
  - 注入时机是「会话创建时」，对话中新写的记忆本轮看不到 → 可接受（下轮新对话生效），但如果模型在同一对话里 `remember` 后立刻需要用到，会失败
  - 库 facts 不注入，模型可能「忘记」之前记过什么（因为它不知道 facts 里有）→ system prompt 里提示「本库已积累 N 条记忆，可用 recall 检索」
  - `consolidate` 是破坏性操作（重写 summary），生成质量差会丢信息 → 保留 facts.jsonl 原始层，summary 可随时重建

### 2026-10-19 · 五项决策（旧对话/容量/冲突/可见性/跨库）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 旧对话迁移 | **直接丢弃** | 开发期数据，无保留价值 |
| 记忆容量 | **自动 consolidate + 淘汰旧的** | 无人干预，靠原始 facts 保留最近 150 条兜底 |
| 记忆冲突 | **库 > Agent > 全局**（就近优先） | 符合直觉：具体的库规则覆盖通用偏好 |
| 记忆可见性 | **设置页可增删改** | 用户能纠正错误记忆，出问题可排查 |
| 跨库对话 | **不支持** | 保持隔离清晰；跨库需求改为切换库 |

**分析**：
- ✅ 丢弃旧对话让迁移逻辑大幅简化（无需 dsId 归属推断）
- ✅ 自动淘汰避免 facts 无限增长，且 summary 承接被淘汰的信息
- ✅ 就近优先符合直觉，且实现简单（prompt 里按序排列 + 标注优先级）
- ⚠️ 潜在问题：
  - **用户手改记忆后模型不知道**：设置页改了的记忆只在下一个新会话生效，当前会话仍是旧 prompt → 界面上标注「改动将在下次新建对话时生效」
  - **淘汰可能丢有用记忆**：最近 150 条之外的 facts 被压缩，`recall` 就查不到了 → summary 质量成为关键；提供「固定记忆」标记（pinned）避免重要事实被淘汰
  - **就近优先的副作用**：库记忆里写错一条，会覆盖全局正确偏好且用户不易察觉 → 记忆管理界面需按优先级排序展示，库级记忆标注「覆盖全局」
  - **不跨库的限制**：用户问「哪个库里讲过 X」时无法回答 → 可后续加轻量的 `list_libraries` 只列库名（不含内容）

### 2026-10-19 · 固定记忆（pinned，方案 C + 两个约束）

**建议**：pinned = 永不淘汰 + 库记忆层额外全量注入；上限每层 20 条；只有库记忆层的 pinned 额外注入。

**分析**：
- ✅ 解决「重要记忆因时间久被淘汰」的问题（淘汰跳过 pinned）
- ✅ 库记忆层最重要的几条能自动进入上下文（相当于 MemGPT 的 core memory）
- ✅ 20 条上限防止全 pin 导致注入爆表
- ⚠️ 潜在问题：
  - **三层语义不完全一致**：全局/Agent 层 pinned 只是「不淘汰」，不改变注入行为（本就全量）→ 文档中需明确说明，避免用户困惑「为什么 pin 了没效果」
  - **模型可能滥用 pinned**：把临时结论也标为 pinned → system prompt 里限定「只在你确信这是跨对话长期有效的信息时才用 pinned」
  - **pinned 满 20 条后新增被拒**：模型会失败 → 工具返回明确错误信息，提示它先取消不重要的
  - **用户在图钉时不知道哪些在注入**：界面需显示「已注入 12/20」，让用户对 token 消耗有感知
  - **淘汰后 summary 与 pins 可能重复**：pinned 的内容也会进 summary → consolidate 时应从 summary 中排除 pinned 内容，避免重复注入
