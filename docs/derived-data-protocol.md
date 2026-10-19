# 加工数据协议（.xuewen）

语料目录下的 `.xuewen/` 存放 AI 从原始文档提取的加工数据。**系统只读不写**，缺失时相关功能自动退化为普通工作台。

```
<语料根>/
├── 笔记/…
└── .xuewen/
    ├── concepts.jsonl   # 概念 / 人物 / 书名 / 主题 等条目
    └── graph.jsonl      # 知识图谱（节点 + 边）
```

两文件均为 **JSONL**：一行一个 JSON 对象，空行与 `//` 开头的行忽略。文件编码 UTF-8，无 BOM。

`.xuewen/` 是隐藏目录，扫描器跳过，不会出现在文件树里；已在 `.gitignore` 中排除。

## concepts.jsonl

一行一个条目。`name` 必填且全局唯一。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 条目名称，唯一标识 |
| `aliases` | string[] | 否 | 别名。别名同样参与正文内链，点击都打开同一条目 |
| `type` | string | 否 | 条目类别，默认 `概念`；可用 `人物` / `书名` / `主题` 等 |
| `def` | string | 否 | 释义，支持纯文本（换行照原样显示） |
| `refs` | string[] | 否 | 出处文档相对路径（相对语料根），如 `笔记/第1章 入门.md` |
| `related` | string[] | 否 | 相关条目名称。仅作展示，图谱关系以 graph.jsonl 为准 |
| `status` | string | 否 | `machine`（默认，机器生成）或 `confirmed`（人工确认后锁定） |
| `source_hash` | string | 否 | 生成时原文的哈希，供后续判断是否需要重跑 |

示例：

```jsonl
{"name":"本体","aliases":["本原","实体"],"type":"概念","def":"指存在的根本依据。本体论讨论存在的本质。","refs":["笔记/第1章 入门.md"],"related":["心性"],"status":"confirmed"}
{"name":"心性","aliases":["性"],"type":"概念","def":"人的本然之性。","refs":["笔记/第1章 入门.md"],"related":["本体"]}
{"name":"礼","type":"概念","def":"外在的行为规范。","refs":[]}
```

### 行为

- 条目 `name` 与所有 `aliases` 进入**自动内链词条表**：正文出现即渲染为可点链接，点击打开概念弹层。
- 词条表对确认条目**放行单字规则**——`道`、`性`、`礼` 这类单字概念也能链接（文档标题/别名仍适用单字过滤）。
- 概念词条优先级低于文档词条：同名时以文档为准（`buildAutoIndex` 判为歧义，不生成链接）。
- `related` 只在概念弹层展示；弹层的「相关概念」以 graph.jsonl 的边为准。

## graph.jsonl

图节点与边混放，用 `kind` 区分（无 `kind` 但有 `from`/`to` 视为边）。

**节点**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `kind` | string | 否 | `node` |
| `id` | string | 是 | 节点 id，通常与概念名一致 |
| `label` | string | 否 | 显示名，默认取 `id` |
| `type` | string | 否 | 节点类型，默认 `概念` |
| `desc` | string | 否 | 描述 |

**边**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `kind` | string | 否 | `edge` |
| `from` | string | 是 | 起点节点 id |
| `to` | string | 是 | 终点节点 id |
| `rel` | string | 否 | 关系名（`包含` / `属于` / `引用` …） |

示例：

```jsonl
{"kind":"node","id":"本体","label":"本体","type":"概念","desc":"存在的根本"}
{"kind":"node","id":"心性","type":"概念"}
{"kind":"edge","from":"本体","to":"心性","rel":"包含"}
{"kind":"edge","from":"心性","to":"礼","rel":"发用"}
```

边端点若未声明为节点，自动补占位节点。概念弹层的「相关概念」列出与该条目相连的所有边，方向用 `→`（出）/`←`（入）标出。

## 从 GraphML 转换

GraphML 只作**导入/导出格式**，系统内部统一用 JSONL。转换要点：

| GraphML | JSONL |
|---|---|
| `<node id="n1"><data key="name">本体</data></node>` | `{"kind":"node","id":"本体"}` |
| `<edge source="n1" target="n2"><data key="rel">包含</data></edge>` | `{"kind":"edge","from":"本体","to":"心性","rel":"包含"}` |
| `<key ... attr.name="type">` | 映射到 `type` |
| `<key ... attr.name="desc">` | 映射到 `desc` |

GraphML 的 `id` 常是不可读的内部编号（`n1`、`n0`），转换时**取 `name`/`label` 属性作为 `id`**，边端点同步替换；否则弹层里会显示 `n1 包含 n2`。

## 前端接口

| 接口 | 用途 |
|---|---|
| `GET /api/concepts` | 条目列表 + 图谱节点/边计数 + 解析错误 |
| `GET /api/concept?name=` | 单条目详情 + 图上邻居 |

`/api/concepts` 里的 `conceptsMissing` / `graphMissing` 用于判断 `.xuewen` 是否就位；`errors` 返回前 5 条 JSONL 解析错误（行号 + 原因），便于排查 AI 产出格式问题。

## 写作建议（给生成数据的 AI）

- `name` 用正文里实际出现的写法，别用同义词替代——内链靠字面匹配。
- `aliases` 收常见别称、简称、繁简变体、旧译名。
- `def` 一条两三百字以内，避免整段抄原文。
- `refs` 用相对语料根的路径，必须与磁盘文件名完全一致（含空格）。
- 中文标点用全角，JSON 字符串里的 `"` 需转义为 `\"`。
- 概念名与已有文档标题不要重名（会因歧义而不链接）；确需同名时改用别名承接。
