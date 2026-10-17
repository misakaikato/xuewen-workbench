// 生成 test-data/ds-fmt 合成夹具：用于字节一致性（CRLF/BOM/无末尾换行/混行尾/制表符）与
// 实时预览（rich.md）验收。全部用显式 Buffer 写入，保证行尾字节精确。
// 用法：node scripts/make-fmt-fixtures.mjs（重复执行会重写为相同内容）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(ROOT, 'test-data', 'ds-fmt');

fs.mkdirSync(path.join(DIR, 'img'), { recursive: true });

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const write = (name, bytes) => fs.writeFileSync(path.join(DIR, ...name.split('/')), bytes);
const lines = (arr, sep) => Buffer.from(arr.join(sep), 'utf8');
const CRLF = '\r\n';

// 1. 纯 CRLF
write('crlf.md', lines([
  '# CRLF 样例',
  '',
  '本文件全部使用 Windows 风格行尾 CRLF。',
  '第二段正文，含中文与 English 混排。',
], CRLF));

// 2. UTF-8 BOM + LF
write('bom.md', Buffer.concat([BOM, lines([
  '# BOM 样例',
  '',
  '本文件带 UTF-8 BOM，行尾为 LF。',
], '\n')]));

// 3. BOM + CRLF
write('bom-crlf.md', Buffer.concat([BOM, lines([
  '# BOM 加 CRLF 样例',
  '',
  '既带 BOM 又用 CRLF 行尾。',
], CRLF)]));

// 4. 无末尾换行
write('no-final-newline.md', Buffer.from('# 无末尾换行\n\n正文最后一行没有换行符。', 'utf8'));

// 5. 行尾空白：两个空格（硬换行）、行尾制表符、带空格的空行
write('trailing-spaces.md', Buffer.from(
  '# 行尾空白样例\n' +
  '行尾有两个空格  \n' +
  '行尾有一个制表符\t\n' +
  '   \n' +
  '普通正文。\n' +
  ' \t \n', 'utf8'));

// 6. 混合行尾：\r\n、\n 与孤立 \r 各有分布
write('mixed-eol.md', Buffer.concat([
  Buffer.from('# 混合行尾样例\r\n', 'utf8'),
  Buffer.from('这行以 CRLF 结束\r\n', 'utf8'),
  Buffer.from('这行以 LF 结束\n', 'utf8'),
  Buffer.from('老式 Mac 弧行尾 CR\r下一行还是 LF\n', 'utf8'),
  Buffer.from('再来一行 CRLF\r\n结尾 LF\n', 'utf8'),
]));

// 7. 制表符缩进正文
write('tabs.md', Buffer.from(
  '# 制表符样例\n' +
  '\t缩进一段（一个制表符）。\n' +
  '\t\t缩进两级的段落。\n' +
  '- 列表项\n' +
  '\t- 子列表项（制表符缩进）\n', 'utf8'));

// 8. 富格式样例（实时预览验收用）
write('rich.md', Buffer.from([
  '# 富格式样例',
  '',
  '这是**加粗**、这是*斜体*、这是~~删除线~~、这是`行内代码`。',
  '链接：[跳到 CRLF 样例](crlf.md) 与 [外部链接](https://example.com)，还有自动链接 <https://example.com/help>。',
  '图片：![小圆点](img/dot.png)',
  '',
  '## 二级标题',
  '',
  '- 无序项目一',
  '- 无序项目二',
  '- [ ] 待办未完成',
  '- [x] 待办已完成',
  '',
  '1. 有序项目一',
  '2. 有序项目二',
  '',
  '### 三级标题',
  '',
  '> 引用第一层',
  '> > 引用第二层（嵌套）',
  '',
  '```js',
  'const greeting = "你好，世界";',
  'console.log(greeting);',
  '```',
  '',
  '| 表头甲 | 表头乙 | 表头丙 |',
  '| --- | :---: | ---: |',
  '| 单元一 | 单元二 | 单元三 |',
  '| 单元四 | 单元五 | 单元六 |',
  '',
  '---',
  '',
  '收尾一段正文。',
  '',
].join('\n'), 'utf8'));

// 9. 1x1 透明 PNG
write('img/dot.png', Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]));

// 10. 长行夹具（编辑器折行验收）：~3000 字无空格段落 / 超长 URL 记号 / 长列表项 / 长引用
{
  const unit = '学问workbench折行验证'; // 中英混排、无空格，16 字符/次
  let para = '';
  for (let i = 0; i < 188; i++) para += unit; // 3008 字符
  const url = 'https://example.com/very/long/' + 'abcdefghij'.repeat(60) + '/end'; // 632 字符长记号
  let item = '- 长列表项：';
  for (let i = 0; i < 38; i++) item += unit;
  let quote = '> 长引用：';
  for (let i = 0; i < 50; i++) quote += unit;
  write('long-line.md', Buffer.from([
    '# 长行折行样例',
    '',
    para,
    '',
    '长链接记号：' + url,
    '',
    item,
    '',
    quote,
    '',
    '收尾一段正文。',
    '',
  ].join('\n'), 'utf8'));
}

console.log('ds-fmt 夹具已生成:', DIR);
