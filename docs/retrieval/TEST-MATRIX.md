# 检索测试集与运行方式

这份测试集面向维护者，回答两个问题：检索管线是否正确，真实模型能否找到应该找到的内容。两类检查独立运行，不能用 mock 通过来替代模型质量验收。

固定语料位于 `test-data/retrieval/`：13 个 MD/TXT/JSON 文件，包含低频词、短语、繁体、全角、重复段落、40 章长文和语义对照。Word 夹具由浏览器脚本在临时目录生成，含 30 个标题和跨粗体节点的查询词。所有自动回归使用隔离数据目录；不写当前资料库。

## 命令

```bash
npm run test:retrieval
npm run test:retrieval:e2e
node scripts/evaluate-retrieval.mjs --model-data ~/.xuewen-workbench --output /tmp/retrieval-quality.json
```

前两项不需要下载模型。第三项复用已有 BGE-M3 权重与 Python 环境，索引写在临时目录，报告包含模型 SHA、配置与逐题排名。失败退出码为 1。

既有真实资料库评估另见 `scripts/retrieval-tests.mjs` 与 `scripts/retrieval-cases.json`，可指定 `--url`；它只读当前库，但题集要求对应书籍在库，零题执行不再算通过。

## 分层矩阵

| 层级 | 能力/用例 | 自动判据 | 执行器 |
|---|---|---|---|
| L1 | 独有词、生僻词、TXT、JSON | 指定文件召回 | test-retrieval |
| L1 | 仅文件名包含查询词 | 精确与智能都能召回该文件 | test-retrieval + evaluate-retrieval |
| L1 | 多词 AND、带标点引号短语 | 指定文件命中 | test-retrieval |
| L1 | 类型、目录、排除目录 | 范围外文件不返回 | test-retrieval |
| L1 | 空、空格、符号、超长 | 不崩溃 | test-retrieval |
| L2 | MD/TXT/JSON 分类和章节路径 | 块 kind 与 heading 正确 | test-retrieval |
| L2 | JSON 转义/嵌套/数组/空对象 | 原文片段可映射源码坐标 | test-retrieval |
| L2 | 全角/半角、大小写、空白 | 智能查找坐标正确 | test-retrieval |
| L2 | 重复片段、重叠查询 | occurrence 正确、非重叠计数 | test-retrieval |
| L3 | 词面/语义/双路 | 各类召回，双路贡献相加且样例第一 | test-retrieval |
| L3 | 补位去重、total、limit | 唯一块、计数稳定 | test-retrieval |
| L3 | 重复查询 | 同序同分 | test-retrieval |
| L4 | 重建、增量修改/删除、库隔离 | 无孤儿 FTS、无旧正文/串库 | test-retrieval |
| L5 | MD 远处目录、回跳、文末 | 标题真实坐标进入视口 | e2e-retrieval |
| L5 | MD 纯语义结果定位 | 查询词不存在仍定位块原文 | e2e-retrieval |
| L5 | 四格式查找、Enter、关闭 | mark/装饰可见、游标移动、旧色清除 | e2e-retrieval |
| L5 | Word 粗体拆词、目录 | 跨节点匹配；标题进入视口 | e2e-retrieval |
| L5 | TXT 重复段、同词多段 | 点击后续结果定位后续段 | e2e-search-location |
| L6 | 真实中文/语义改写/混合/负例 | 预先标注文件在前五；负例零结果 | evaluate-retrieval |

## 尚需扩大覆盖

DOC 老格式转换、损坏 Word、JSON 视图来回切换、目录重复标题与 hash、BOM/CRLF 长文、结果缓存后退/前进、快速连续查询竞态、索引暂停续建/模型中断、千文件性能与跨平台 Windows。这些列为待补，不视为已测通过。既有编辑器套件另验证字节往返与编辑生命周期。

真实语义集目前只有 11 题，其中语义题 4 题，规模不足以给整体质量下结论。扩充时先标注相关文件/段落、再运行；同时记录 Recall@5、MRR、无关查询误报与耗时，保留开发集和独立验收集，避免围绕少数题调参。
