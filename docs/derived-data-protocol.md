# 加工数据协议（.derived）

语料目录下的 `.derived/` 存放 AI 从原始文档提取的加工数据。**系统只读不写**，缺失时相关功能自动退化为普通工作台。

> 命名：`derived` 即「派生数据」——全部内容都能从原文重新提取，删掉不损失任何原始信息。与逐文档的 `<文件名>.meta.json`（文档卡，不可重建）性质相反。旧版本目录名 `.xuewen/` 会在首次读取时自动迁移。

---

## 一、设计判据

> **这个字段丢了，能不能从文档正文和库本身重新算出来？**
> 不能 → 文档卡（`.meta.json`）；能 → 语料卡（`.derived/`）

这一条判据决定所有字段归属，不存在灰色地带。

```
<语料根>/
├── 笔记/
│   ├── 第1章.md
│   └── 第1章.md.meta.json      ← 文档卡：不可重建，跟文档走
└── .derived/                    ← 语料卡：可重建，跟库走
    ├── concepts.jsonl           # 概念 / 实体
    ├── topics.jsonl             # 文档 → 主题 / 核心概念
    ├── ziyi.jsonl               # 字义（某字在具体语境的讲法）
    ├── summaries.jsonl          # 每篇摘要
    └── graph.graphml            # 知识图谱（行业标准，直接读）
```

`.derived/` 是隐藏目录，扫描器跳过；已在 `.gitignore` 中排除。

---

## 二、概念词典

| 名称 | 是什么 | 粒度 | 例子 |
|---|---|---|---|
| **实体** | 具体可指认的对象 | 个体 | 孔子、《论语》、鲁国 |
| **概念** | 抽象范畴 | 范畴 | 仁、本体、心性 |
| **主题** | 文档的内容归属 | 文档级 | 本体论、基础 |
| **字义** | 某字在具体语境的讲法 | 字+语境 | 「仁」在学而篇第三章的用法 |
| **标签** | 人工打的标记 | 文档级 | 入门、待读 |
| **词条** | 内链匹配的字符串 | 无独立存储 | 以上所有名字的并集 |

实体与概念**不分开存**——都在 `concepts.jsonl`，用 `type` 区分（`概念` / `人物` / `书名` / `地名` …）。图谱节点同样不区分，边表达关系。

---

## 三、关系模型

```
概念 ──refs──────▶ 文档     出现在哪（AI 维护）
文档 ──concepts──▶ 概念     核心讲什么（AI 判断，区别于"提及"）
文档 ──扫描──────▶ 概念     提及了什么（正文匹配，免费全量）

文档 ──topics────▶ 主题     属于哪些主题（AI 候选）
文档 ──tags──────▶ 标签     人工定论（确认后升格进 meta）

字义 ──concept──▶ 概念     归属于哪个概念
图谱：节点=概念/实体，边=关系（包含/属于/引用/对立 …）
```

**「出现 ≠ 讲」**：某词在正文出现不代表这篇在讲它。`concepts` 字段只标**核心讲的**，提及的靠正文扫描兜底，UI 分两档显示。

---

## 四、确认流

所有 `.derived/` 文件共用 `status` 字段：

```
AI 提取  →  status: machine     ← 候选，可删可重跑
    ↓ 人工确认
升格     →  status: confirmed   ← 关键字段写入 meta.tags / meta.*，成定论
```

已确认的记录在 AI 重跑时不覆盖，只提示「建议更新」。

---

## 五、各文件协议

### concepts.jsonl —— 概念 / 实体

一行一条。`name` 必填且全局唯一。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 条目名，全局唯一 |
| `aliases` | string[] | 否 | 别名，同样进内链词条 |
| `type` | string | 否 | `概念`（默认）/ `人物` / `书名` / `地名` |
| `def` | string | 否 | 释义 |
| `refs` | string[] | 否 | 出处文档相对路径 |
| `related` | string[] | 否 | 相关条目名（展示用；图谱关系以 graph.graphml 为准） |
| `status` | string | 否 | `machine`（默认）/ `confirmed` |
| `source_hash` | string | 否 | 生成时原文哈希，供判断是否需重跑 |

```jsonl
{"name":"本体","aliases":["本原"],"type":"概念","def":"存在的根本依据。","refs":["笔记/第1章.md"],"related":["心性"],"status":"confirmed"}
{"name":"孔子","aliases":["仲尼"],"type":"人物","def":"春秋末期思想家。","refs":["笔记/第1章.md"]}
```

**行为**：`name` 与 `aliases` 进自动内链词条（确认条目放行单字规则，「道」「性」可链）；点击开概念卡。与文档词条同名时判歧义不链。

### topics.jsonl —— 文档标注

一行一篇文档。主题与核心概念都是数组（**多主题、多概念都支持**）。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | 文档相对路径 |
| `topics` | string[] | 否 | 主题（宽泛分类），AI 候选 |
| `concepts` | string[] | 否 | 核心概念（这篇真正在讲的），AI 候选 |
| `status` | string | 否 | `machine` / `confirmed` |

```jsonl
{"path":"笔记/第1章.md","topics":["基础","本体论"],"concepts":["本体","心性"],"status":"machine"}
```

**行为**：阅读页徽章显示（AI 候选带 ✨）；确认后 `topics` 升格进 `meta.tags`。核心概念与「提及概念」（正文扫描）分两档显示。

### ziyi.jsonl —— 字义

某字/词在具体语境的讲法。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `word` | string | 是 | 被讲解的字/词 |
| `pinyin` | string | 否 | 读音 |
| `def` | string | 是 | 释义 |
| `source` | string | 否 | 出处文档相对路径 |
| `anchor` | string | 否 | 出处内锚点（标题路径 / 段落号） |
| `concept` | string | 否 | 归属的概念名 |

```jsonl
{"word":"仁","pinyin":"rén","def":"爱人也。","source":"笔记/第1章.md","anchor":"第三章","concept":"仁"}
```

**行为**：字义**不进内链**（避免「之乎者也」满屏链接）；阅读页选中文字时查字义卡片（UI 待实现）。

### summaries.jsonl —— 摘要

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | 文档相对路径 |
| `summary` | string | 是 | 摘要正文 |
| `status` | string | 否 | `machine` / `confirmed` |

**行为**：供 RAG / 检索增强使用（消费点待实现）。

### graph.graphml —— 知识图谱

**行业标准 GraphML，不转换，直接读**。AI 生成后放进 `.derived/` 即可用，可被 Gephi / yEd / NetworkX 打开。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="name" for="node" attr.name="name" attr.type="string"/>
  <key id="rel"  for="edge" attr.name="rel"  attr.type="string"/>
  <graph edgedefault="directed">
    <node id="n0">
      <data key="name">本体</data>
      <data key="type">概念</data>
    </node>
    <node id="n1"><data key="name">心性</data></node>
    <edge source="n0" target="n1"><data key="rel">包含</data></edge>
  </graph>
</graphml>
```

| 元素 | 说明 |
|---|---|
| `<node id="...">` | 内部 id 任意，显示名来自 data name |
| `data key="name"` | 节点名（必填，作为内链词条） |
| `data key="type"` | 节点类型，默认「概念」 |
| `edge source target` | 写节点内部 id，系统自动映射到 name |
| `data key="rel"` | 关系名 |

边端点未声明为节点时自动补占位节点。若 graph.graphml 不存在，回退读 graph.jsonl（旧格式仍支持）。

---

## 六、UI 落点与优先级

| 位置 | 显示 | 来源优先级 |
|---|---|---|
| 阅读页徽章 | 标签 + 主题 + 核心概念 | 人工 > AI 确认 > AI 候选（✨） |
| 阅读页「提及概念」 | 本文出现的所有概念词 | 正文扫描（免费） |
| 概念卡 | 释义/别名/出处/图谱邻居/相关字义 | concepts + graph + ziyi |
| Dashboard | 主题分布 / 概念列表 | topics + concepts |
| 内链 | 概念名/别名/文档标题可点 | 词条表（内存索引） |

---

## 七、前端接口

| 接口 | 用途 |
|---|---|
| GET /api/concepts | 概念列表 + 图谱计数 + 解析错误 |
| GET /api/concept?name= | 单概念详情 + 图上邻居 |
| GET /api/tags | 主题聚合（人工 + AI，带来源标记） |
| GET /api/tags/doc?path= | 单文档的主题/核心概念 |

---

## 八、写作建议（给生成数据的 AI）

- name / word 用正文里实际出现的写法——内链靠字面匹配
- aliases 收别称、简称、繁简变体、旧译名
- def 一条两三百字以内，避免整段抄原文
- refs / path / source 用相对语料根的路径，与磁盘文件名完全一致
- concepts 字段只标这篇核心讲的概念，不是出现过的都算
- graphml 节点显示名放 data name，边端点用内部 id
- 多主题按「内容 → 难度 → 体裁」顺序写，UI 暂不分轴

---

## 九、明确不做 / 缓做

| 项 | 决定 |
|---|---|
| 主题分轴 | 不做，约定 AI 按固定顺序写 |
| ziyi 的 UI 入口 | 等有真实数据再做 |
| summaries 的消费 | 留给 RAG 检索增强 |
| 字义进内链 | 不进（避免虚词满屏链接） |
