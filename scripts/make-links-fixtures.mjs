// 生成 test-data/ds-links 合成夹具：自动内链（词条）+ 反向链接 + 屏蔽词表 的验收数据。
// 覆盖：标题与别名、繁简互通、最长匹配、自提及、同节首链/新节再链、代码/链接/URL 跳过、
// 拉丁词边界、排除名（讲稿1/日期/未命名/单字）、重名歧义、通用标题、wikilink 各形态、JSON title。
// 全部用显式 Buffer 写入，保证字节精确。用法：node scripts/make-links-fixtures.mjs（重复执行重写为相同内容）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(ROOT, 'test-data', 'ds-links');

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const write = (name, text) => fs.writeFileSync(path.join(DIR, ...name.split('/')), Buffer.from(text, 'utf8'));
const sidecar = (name, meta) => write(name + '.meta.json', JSON.stringify(meta, null, 2) + '\n');
const meta = (id, title, aliases = []) => ({
  id, title, type: '文章', date: '2026-10-01', source_url: '', aliases, tags: [], created_at: '2026-10-01T08:00:00.000Z',
});

// 1. 孔子：标题 + 别名（仲尼、夫子）；含唯一标题「仁的定义」与通用标题「引言」；自提及不链接
sidecar('孔子.md', meta('doc_links_0001', '孔子', ['仲尼', '夫子']));
write('孔子.md', `# 孔子

孔子，名丘，字仲尼。夫子自道其生平。本篇自提及都不应链接。

《论语讲稿》另有专篇，此处应链接。

## 引言

「引言」在两篇文档里都出现，属于通用标题，不应作为词条。

## 仁的定义

仁是儒家核心概念，他篇提到「仁的定义」应链到本锚点。
`);

// 2. 孔子家语：同节重复提及只链首次；新节再链；繁体「論語」提及
sidecar('孔子家语.md', meta('doc_links_0002', '孔子家语'));
write('孔子家语.md', `# 孔子家语

《孔子家语》成书考。孔子 first 出现应链接，孔子 第二次同节不链接。論語 即论语讲稿，繁体提及也应链接。另参礼乐考。

## 引言

通用标题「引言」同样在此出现。

## 第二节

孔子在新的一节里再次出现，应当再次链接。
`);

// 3. 论语讲稿：别名「论语」；最长匹配（孔子家语 vs 孔子）；wikilink 各形态
sidecar('论语讲稿.md', meta('doc_links_0003', '论语讲稿', ['论语'], ));
write('论语讲稿.md', `# 论语讲稿

孔子家语与论语都提到孔子。仲尼与夫子都是孔子的别称。本文提到儒家概念表与文艺复兴。Renaissance 一词含 Ren 但不应命中。

## 章句解读

[[孔子]] 是显式 wikilink。[[孔子|孔夫子]] 带显示文字。[[孔子家语#引言]] 指向他篇锚点。[[礼记研讨]] 重名应给候选。[[不存在词条]] 缺失。

另外 [[儒家概念表.json]] 按路径解析。[[礼乐考#礼乐源流]] 按别名加锚点解析。另有礼乐考一篇可供改名测试。集合名|文件名 的显式引用语法不受影响。
`);

// 3b. 礼乐记：旁注标题「礼乐考」与主体名不同（改名时标题保留，链接跟随新路径）
sidecar('礼乐记.md', meta('doc_links_0008', '礼乐考'));
write('礼乐记.md', `# 礼乐考稿

本篇文件名是礼乐记，旁注标题是礼乐考。

## 礼乐源流

礼与乐的源流考辨。
`);

// 4. 文艺复兴：拉丁词边界（Ren vs Renaissance）；繁体「孔子家語」
sidecar('文艺复兴.md', meta('doc_links_0004', '文艺复兴'));
write('文艺复兴.md', `# 文艺复兴

Renaissance 是文艺复兴的英文称呼，Ren 不应在其内部命中。文艺复兴时代的人们重新读到了孔子。《孔子家語》的拉丁译本亦在此期问世。尼父亦是孔子的尊称。
`);

// 5. Ren：三字符拉丁词条（允许）
sidecar('Ren.md', meta('doc_links_0005', 'Ren'));
write('Ren.md', `# Ren

Ren 是《论语》(Lún Yǔ) 的拉丁转写缩写，单独出现时应链接。亦即 [[论语]] 本身，按别名解析。提到孔子与孔子家语。
`);

// 6–9. 排除名：讲稿1 / 日期 / 未命名 / 单字（它们的正文仍可向外链接）
write('讲稿1.md', `# 讲稿一

孔子第一处应链接，孔子 第二处同节不再链接。
`);
write('2023-05-01.md', `# 日课

本篇文件名是日期，不进词表。正文提到孔子家语应链接。
`);
write('未命名.md', `# 未命名

本篇文件名被排除。正文提到仲尼应链接到孔子。
`);
write('天.md', `# 天

单字标题不进词表。正文提到夫子应链接。
`);

// 10. 重名歧义：两篇同题「礼记研讨」，不自动链接，wikilink 给候选
sidecar('同题文档甲.md', meta('doc_links_0006', '礼记研讨'));
sidecar('同题文档乙.md', meta('doc_links_0007', '礼记研讨'));
write('同题文档甲.md', `# 甲篇

礼记研讨是重名词条，本篇自提及不链接。正文提到孔子应链接。
`);
write('同题文档乙.md', `# 乙篇

礼记研讨重名的另一篇。正文提到仁的定义应链到孔子的标题锚点。
`);

// 11. JSON 文档：顶层 title 进词表；正文值里的提及向外链接
write('儒家概念表.json', `{
  "title": "儒家概念表",
  "entries": [
    { "词": "仁", "释义": "爱人。参见孔子。" },
    { "词": "礼", "释义": "制度节文。参见论语讲稿。" }
  ]
}
`);

// 12. 跳过区：行内代码 / 既有链接 / URL / HTML 标签 / 围栏代码
write('编码与链接.md', `# 编码与链接

看 \`孔子\` 行内代码内不应链接。

[孔子](https://example.org/kongzi) 链接文字与目标都不链接。

访问 https://example.org/孔子 同样不链接。

<span data-x="1">标签本身</span>不链接，孔子在标签之间可链接。

## 代码块

\`\`\`text
孔子 在围栏内不链接
[[孔子]] 在围栏内也不解析
\`\`\`
`);

console.log('ds-links 夹具已生成：', fs.readdirSync(DIR).length, '个文件');
