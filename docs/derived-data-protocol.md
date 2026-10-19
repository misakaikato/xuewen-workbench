# 加工数据协议（.derived）

语料目录下的 `.derived/` 存放 AI 从原始文档提取的加工数据。**系统只读不写**，缺失时相关功能自动退化为普通工作台。

> 命名：`derived` 即「派生数据」——全部内容都能从原文重新提取，删掉不损失任何原始信息。与逐文档的 `<文件名>.meta.json`（文档身份证，不可重建）性质相反。旧版本目录名 `.xuewen/` 会在首次读取时自动迁移。

```
<语料根>/
├── 笔记/…
└── .derived/
    ├── concepts.jsonl   # 概念 / 人物 / 书名 等条目
    ├── topics.jsonl     # 文档 → 主题标注
    └── graph.graphml    # 知识图谱（GraphML，行业标准格式）
```

两文件均为 **JSONL**：一行一个 JSON 对象，空行与 `//` 开头的行忽略。文件编码 UTF-8，无 BOM。

`.derived/` 是隐藏目录，扫描器跳过，不会出现在文件树里；已在 `.gitignore` 中排除。

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

## topics.jsonl

一行一篇文档的主题标注。与 `.meta.json` 里**人工标注**的 `tags` 相互独立，展示时合并（AI 标注带 ✨ 标记）。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | 文档相对路径（相对语料根） |
| `topics` | string[] | 是 | 主题名列表，也可写作 `tags` |

示例：

```jsonl
{"path":"笔记/第1章 入门.md","topics":["基础","本体论"]}
{"path":"笔记/第2章 进阶.md","topics":["进阶","方法"]}
```

### 行为

- 阅读页正文上方显示该文档的主题徽章，AI 标注的带 ✨ 图标，点击展开同主题文档列表。
- 知识库概览的「主题分布」按主题聚合全文档数。
- 删除 `.derived/topics.jsonl` 即回到无标注状态，文档本身不受影响。

## graph.graphml

**行业标准 GraphML**，不转换，直接读。AI 生成的 graphml 放进 `.derived/` 即可用。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="name" for="node" attr.name="name" attr.type="string"/>
  <key id="type" for="node" attr.name="type" attr.type="string"/>
  <key id="desc" for="node" attr.name="desc" attr.type="string"/>
  <key id="rel"  for="edge" attr.name="rel"  attr.type="string"/>
  <graph edgedefault="directed">
    <node id="n0">
      <data key="name">本体</data>
      <data key="type">概念</data>
      <data key="desc">存在的根本依据</data>
    </node>
    <node id="n1"><data key="name">心性</data></node>
    <edge source="n0" target="n1"><data key="rel">包含</data></edge>
  </graph>
</graphml>
```

### 约定

| 元素 | 说明 |
|---|---|
| `<node id="...">` | 内部 id 任意（`n0`/`n1` 就行），**显示名来自 `<data key="name">`** |
| `<data key="name">` | 节点名（必填，作为内链词条） |
| `<data key="type">` | 节点类型，默认 `概念` |
| `<data key="desc">` | 节点描述 |
| `<edge source target>` | 边的 `source`/`target` 写**节点内部 id**（系统自动映射到 name） |
| `<data key="rel">` | 关系名（包含 / 属于 / 引用 …） |

边端点只给内部 id 而未声明节点时，自动补占位节点。

### 兼容

若 `.derived/graph.graphml` 不存在，系统回退读 `.derived/graph.jsonl`（旧格式，仍支持）。两者都存在时以 graphml 为准。

## 前端接口

| 接口 | 用途 |
|---|---|
| `GET /api/concepts` | 条目列表 + 图谱节点/边计数 + 解析错误 |
| `GET /api/concept?name=` | 单条目详情 + 图上邻居 |
| `GET /api/tags` | 主题聚合（人工 tags + AI 标注，含来源标记） |
| `GET /api/tags/doc?path=` | 单文档的主题 |

`/api/concepts` 里的 `conceptsMissing` / `graphMissing` 用于判断 `.derived` 是否就位；`errors` 返回前 5 条 JSONL 解析错误（行号 + 原因），便于排查 AI 产出格式问题。

## 写作建议（给生成数据的 AI）

- `name` 用正文里实际出现的写法，别用同义词替代——内链靠字面匹配。
- `aliases` 收常见别称、简称、繁简变体、旧译名。
- `def` 一条两三百字以内，避免整段抄原文。
- `refs` 用相对语料根的路径，必须与磁盘文件名完全一致（含空格）。
- 中文标点用全角，JSON 字符串里的 `"` 需转义为 `\"`。
- 概念名与已有文档标题不要重名（会因歧义而不链接）；确需同名时改用别名承接。
