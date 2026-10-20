#!/usr/bin/env node
// 内链匹配样本集：文档名形态 × 正文提及形态的排列组合
// 用法: node scripts/test-linkmatch.mjs
// 直接调 server/linkMatch.js 的纯函数，无需起服务
import { buildAutoIndex, extractLinks, normalizeText } from '../server/linkMatch.js';

// ---------- 样本 ----------
// docs: [{path, title?}]（title 模拟 meta.title；不给则取文件名 stem）
// text: 被扫描的正文
// expectLinks: 期望命中的 [{term, target}]（term 是链接覆盖的原文片段）
// expectNoLink: 这些片段不得被链
const CASES = [
  // ── A. 文档带日期前缀 ──
  {
    name: 'A1 全文一致（带日期）',
    docs: [{ path: '2022-12-10-维天有汉，星传诸夏.md' }],
    text: '详见 2022-12-10-维天有汉，星传诸夏 一文。',
    expectLinks: [{ term: '2022-12-10-维天有汉，星传诸夏', target: '2022-12-10-维天有汉，星传诸夏.md' }],
  },
  {
    name: 'A2 文本不带日期（用户案例2）',
    docs: [{ path: '2022-12-10-维天有汉，星传诸夏.md' }],
    text: '维天有汉，星传诸夏 这篇讲历法。',
    expectLinks: [{ term: '维天有汉，星传诸夏', target: '2022-12-10-维天有汉，星传诸夏.md' }],
  },
  {
    name: 'A3 书名号包裹（不带日期）',
    docs: [{ path: '2022-12-10-维天有汉，星传诸夏.md' }],
    text: '读《维天有汉，星传诸夏》有感。',
    expectLinks: [{ term: '《维天有汉，星传诸夏》', target: '2022-12-10-维天有汉，星传诸夏.md' }],
  },
  {
    name: 'A4 书名号+日期全包裹',
    docs: [{ path: '2022-12-10-维天有汉，星传诸夏.md' }],
    text: '见《2022-12-10-维天有汉，星传诸夏》。',
    expectLinks: [{ term: '《2022-12-10-维天有汉，星传诸夏》', target: '2022-12-10-维天有汉，星传诸夏.md' }],
  },
  {
    name: 'A5 日期点分格式',
    docs: [{ path: '2022-12-10-维天有汉，星传诸夏.md' }],
    text: '2022.12.10-维天有汉，星传诸夏 亦可。',
    expectLinks: [{ term: '2022.12.10-维天有汉，星传诸夏', target: '2022-12-10-维天有汉，星传诸夏.md' }],
  },
  {
    name: 'A6 中文日期格式',
    docs: [{ path: '2022-12-10-维天有汉，星传诸夏.md' }],
    text: '2022年12月10日-维天有汉，星传诸夏 亦可。',
    expectLinks: [{ term: '2022年12月10日-维天有汉，星传诸夏', target: '2022-12-10-维天有汉，星传诸夏.md' }],
  },

  // ── B. 文档不带日期，文本带日期（用户案例1：链接范围要含日期）──
  {
    name: 'B1 词条无日期，文本有日期前缀',
    docs: [{ path: '维天有汉，星传诸夏.md' }],
    text: '2022-12-10-维天有汉，星传诸夏 这篇。',
    expectLinks: [{ term: '2022-12-10-维天有汉，星传诸夏', target: '维天有汉，星传诸夏.md' }],
  },
  {
    name: 'B2 同上但书名号在外',
    docs: [{ path: '维天有汉，星传诸夏.md' }],
    text: '《2022-12-10-维天有汉，星传诸夏》这篇。',
    expectLinks: [{ term: '《2022-12-10-维天有汉，星传诸夏》', target: '维天有汉，星传诸夏.md' }],
  },
  {
    name: 'B3 title 无日期但文件名带日期（meta.title 被清理过）',
    docs: [{ path: '2022-12-10-维天有汉，星传诸夏.md', title: '维天有汉，星传诸夏' }],
    text: '2022-12-10-维天有汉，星传诸夏 这篇。',
    expectLinks: [{ term: '2022-12-10-维天有汉，星传诸夏', target: '2022-12-10-维天有汉，星传诸夏.md' }],
  },

  // ── C. 文档名带书名号 ──
  {
    name: 'C1 文档带书名号，文本不带',
    docs: [{ path: '《读书笔记》.md' }],
    text: '读书笔记 里写过。',
    expectLinks: [{ term: '读书笔记', target: '《读书笔记》.md' }],
  },
  {
    name: 'C2 文档带书名号，文本也带',
    docs: [{ path: '《读书笔记》.md' }],
    text: '《读书笔记》里写过。',
    expectLinks: [{ term: '《读书笔记》', target: '《读书笔记》.md' }],
  },

  // ── D. 分隔符/下划线变体 ──
  {
    name: 'D1 文档用下划线，文本用横线',
    docs: [{ path: '2022_12_10_试剑石.md' }],
    text: '2022-12-10-试剑石 这个案例。',
    expectLinks: [{ term: '2022-12-10-试剑石', target: '2022_12_10_试剑石.md' }],
  },
  {
    name: 'D2 文档无分隔（紧凑日期），文本带横线',
    docs: [{ path: '20221210-试剑石.md' }],
    text: '2022-12-10-试剑石 这个案例。',
    expectLinks: [{ term: '2022-12-10-试剑石', target: '20221210-试剑石.md' }],
  },

  // ── E. 歧义控制 ──
  {
    name: 'E1 裸名歧义：不直链但产出候选',
    docs: [{ path: '2022-01-01-同名.md' }, { path: '2022-02-02-同名.md' }],
    text: '同名 这篇。',
    expectLinks: [],
    expectCandidates: [{ term: '同名', count: 2 }],
  },
  {
    name: 'E2 带日期消歧（左）',
    docs: [{ path: '2022-01-01-同名.md' }, { path: '2022-02-02-同名.md' }],
    text: '2022-01-01-同名 这篇。',
    expectLinks: [{ term: '2022-01-01-同名', target: '2022-01-01-同名.md' }],
  },
  {
    name: 'E3 带日期消歧（右）',
    docs: [{ path: '2022-01-01-同名.md' }, { path: '2022-02-02-同名.md' }],
    text: '2022-02-02-同名 这篇。',
    expectLinks: [{ term: '2022-02-02-同名', target: '2022-02-02-同名.md' }],
  },

  // ── F. 不得误链 ──
  {
    name: 'F1 纯日期不成词条',
    docs: [{ path: '2023-05-01.md' }],
    text: '2023-05-01 那天。',
    expectLinks: [],
  },
  {
    name: 'F2 单字核心不链，但完整带日期形式可链',
    docs: [{ path: '2022-01-01-道.md' }],
    text: '2022-01-01-道 与裸写的 道。',
    expectLinks: [{ term: '2022-01-01-道', target: '2022-01-01-道.md' }],
  },
  {
    name: 'F3 同一节内同词只链一次',
    docs: [{ path: '维天有汉，星传诸夏.md' }],
    text: '维天有汉，星传诸夏 与 维天有汉，星传诸夏。',
    expectLinks: [{ term: '维天有汉，星传诸夏', target: '维天有汉，星传诸夏.md' }],
  },
  {
    name: 'F4 代码块内不链',
    docs: [{ path: '维天有汉，星传诸夏.md' }],
    text: '`维天有汉，星传诸夏` 是代码。',
    expectLinks: [],
  },
  {
    name: 'F5 已有 markdown 链接内不链',
    docs: [{ path: '维天有汉，星传诸夏.md' }],
    text: '[见文](维天有汉，星传诸夏.md) 这里。',
    expectLinks: [],
  },
  // ── G. 更刁钻的形态 ──
  // ── G. 更刁钻的形态 ──
  {
    name: 'G1 繁体文本 + 简体词条',
    docs: [{ path: '维天有汉.md' }],
    text: '維天有漢 这篇。',
    expectLinks: [{ term: '維天有漢', target: '维天有汉.md' }],
  },
  {
    name: 'G2 全角数字日期前缀',
    docs: [{ path: '维天有汉.md' }],
    text: '２０２２-１２-１０-维天有汉 这篇。',
    expectLinks: [{ term: '２０２２-１２-１０-维天有汉', target: '维天有汉.md' }],
  },
  {
    name: 'G3 多层书名号文本',
    docs: [{ path: '读书笔记.md' }],
    text: '《《读书笔记》》这篇。',
    expectLinks: [{ term: '《《读书笔记》》', target: '读书笔记.md' }],
  },
  {
    name: 'G4 词条内部标点：文本也有才链',
    docs: [{ path: '维天有汉，星传诸夏.md' }],
    text: '维天有汉，星传诸夏 这篇。',
    expectLinks: [{ term: '维天有汉，星传诸夏', target: '维天有汉，星传诸夏.md' }],
  },
  {
    name: 'G5 词条内部标点：文本没有则不链（现状边界）',
    docs: [{ path: '维天有汉，星传诸夏.md' }],
    text: '维天有汉星传诸夏 这篇。',
    expectLinks: [],
  },
  {
    name: 'G6 日期在标题中间：核心提取只去前缀，中间日期保留',
    docs: [{ path: '讲座-2022-01-01-补记.md' }],
    text: '讲座-2022-01-01-补记 这篇。',
    expectLinks: [{ term: '讲座-2022-01-01-补记', target: '讲座-2022-01-01-补记.md' }],
  },
  {
    name: 'G7 短核心词误链检查：两字核心会链（与无包装词条同风险）',
    docs: [{ path: '2022-01-01-总结.md' }],
    text: '这一年的总结 写完了。',
    expectLinks: [{ term: '总结', target: '2022-01-01-总结.md' }],
  },
  {
    name: 'G8 吸收不会吃掉日期前的普通文字',
    docs: [{ path: '维天有汉.md' }],
    text: '截止2022-12-10-维天有汉 这篇。',
    expectLinks: [{ term: '2022-12-10-维天有汉', target: '维天有汉.md' }],
  },
  {
    name: 'G9 别名词条也走核心+吸收',
    docs: [{ path: '论语.md', aliases: ['《论语译注》'] }],
    text: '论语译注 这本书。',
    expectLinks: [{ term: '论语译注', target: '论语.md' }],
  },
  {
    name: 'G10 不链自身（含核心形式）',
    docs: [{ path: '2022-12-10-维天有汉.md' }],
    text: '维天有汉 这篇。',
    selfPath: '2022-12-10-维天有汉.md',
    expectLinks: [],
  },
  // ── H. 扩展名与路径形态 ──
  {
    name: 'H1 纯文本路径：吸收 .md 后缀与路径段（用户案例3）',
    docs: [{ path: '笔记/第2章 进阶.md' }],
    text: '来源：笔记/第2章 进阶.md',
    expectLinks: [{ term: '笔记/第2章 进阶.md', target: '笔记/第2章 进阶.md' }],
  },
  {
    name: 'H2 带扩展名提及：覆盖完整文件名',
    docs: [{ path: '同名文件.md' }],
    text: '见 同名文件.md 这篇。',
    expectLinks: [{ term: '同名文件.md', target: '同名文件.md' }],
  },
  {
    name: 'H3 路径消歧：两篇同名，文本带路径段',
    docs: [{ path: '笔记/同名文件.md' }, { path: '资料库/同名文件.md' }],
    text: '见 笔记/同名文件.md 这篇。',
    expectLinks: [{ term: '笔记/同名文件.md', target: '笔记/同名文件.md' }],
  },
  {
    name: 'H4 路径消歧：另一篇',
    docs: [{ path: '笔记/同名文件.md' }, { path: '资料库/同名文件.md' }],
    text: '见 资料库/同名文件.md 这篇。',
    expectLinks: [{ term: '资料库/同名文件.md', target: '资料库/同名文件.md' }],
  },
  {
    name: 'H5 扩展名不匹配不吸收：target 是 .md，文本写 .txt',
    docs: [{ path: '第2章 进阶.md' }],
    text: '见 第2章 进阶.txt 这篇。',
    expectLinks: [{ term: '第2章 进阶', target: '第2章 进阶.md' }],
  },
  {
    name: 'H6 裸名歧义：不直链但产出候选',
    docs: [{ path: '笔记/同名文件.md' }, { path: '资料库/同名文件.md' }],
    text: '见 同名文件 这篇。',
    expectLinks: [],
    expectCandidates: [{ term: '同名文件', count: 2 }],
  },
  {
    name: 'H7 完整文件名歧义：不直链但产出候选',
    docs: [{ path: '笔记/同名文件.md' }, { path: '资料库/同名文件.md' }],
    text: '见 同名文件.md 这篇。',
    expectLinks: [],
    expectCandidates: [{ term: '同名文件.md', count: 2 }],
  },
  {
    name: 'H8 路径段不被普通斜杠误吸收',
    docs: [{ path: '第2章 进阶.md' }],
    text: '比例 1/2 与 第2章 进阶 无关。',
    expectLinks: [{ term: '第2章 进阶', target: '第2章 进阶.md' }],
  },
  // ── I. 真实语料命名模式（workbench-text）──
  {
    name: 'I1 编号前缀：1.劝学 ↔ 劝学',
    docs: [{ path: '荀子/1.劝学.md' }],
    text: '劝学 这篇讲学习。',
    expectLinks: [{ term: '劝学', target: '荀子/1.劝学.md' }],
  },
  {
    name: 'I2 编号前缀完整形式：1.劝学 ↔ 1.劝学',
    docs: [{ path: '荀子/1.劝学.md' }],
    text: '见 1.劝学.md 这篇。',
    expectLinks: [{ term: '1.劝学.md', target: '荀子/1.劝学.md' }],
  },
  {
    name: 'I3 卡片编号：C01_心的定义（总卡） ↔ 心的定义',
    docs: [{ path: '知识库卡片/C01_心的定义（总卡）.md' }],
    text: '心的定义 这张卡。',
    expectLinks: [{ term: '心的定义', target: '知识库卡片/C01_心的定义（总卡）.md' }],
  },
  {
    name: 'I4 系列核心不同则直链（北境≠北地），系列后缀进范围',
    docs: [{ path: 'b/2021-11-22-天高地远，北境长生（一）.md' }, { path: 'b/2022-02-04-天高地远，北地长生（二）.md' }],
    text: '天高地远，北境长生（一）这篇。',
    expectLinks: [{ term: '天高地远，北境长生（一）', target: 'b/2021-11-22-天高地远，北境长生（一）.md' }],
  },
  {
    name: 'I4b 系列核心相同给候选',
    docs: [{ path: 'b/2024-02-28-龙精乘气，凤律遗珍（一）.md' }, { path: 'b/2024-03-15-龙精乘气，凤律遗珍（二）.md' }],
    text: '龙精乘气，凤律遗珍 这个系列。',
    expectLinks: [],
    expectCandidates: [{ term: '龙精乘气，凤律遗珍', count: 2 }],
  },
  {
    name: 'I5 系列完整提及直链：（一）',
    docs: [{ path: 'b/2021-11-22-天高地远，北境长生（一）.md' }, { path: 'b/2022-02-04-天高地远，北地长生（二）.md' }],
    text: '天高地远，北境长生（一） 这篇。',
    expectLinks: [{ term: '天高地远，北境长生（一）', target: 'b/2021-11-22-天高地远，北境长生（一）.md' }],
  },
  {
    name: 'I6 拷贝后缀：家国天下，盈科而进 - 拷贝 ↔ 裸名',
    docs: [{ path: 'b/2021-08-19-家国天下，盈科而进 - 拷贝.md' }],
    text: '家国天下，盈科而进 这篇。',
    expectLinks: [{ term: '家国天下，盈科而进', target: 'b/2021-08-19-家国天下，盈科而进 - 拷贝.md' }],
  },
  {
    name: 'I7 词中书名号+序言后缀：《天高地广，北境长生》序言二 ↔ 《天高地广，北境长生》',
    docs: [{ path: 'b/2021-10-29-《天高地广，北境长生》序言二.md' }],
    text: '《天高地广，北境长生》这篇序言。',
    expectLinks: [{ term: '《天高地广，北境长生》', target: 'b/2021-10-29-《天高地广，北境长生》序言二.md' }],
  },
  {
    name: 'I8 怪编号：314-11-37 第十一季总决赛《庄子》 ↔ 第十一季总决赛《庄子》',
    docs: [{ path: '周年祭/314-11-37 第十一季总决赛《庄子·庚桑楚》、《春秋繁露》.md' }],
    text: '第十一季总决赛《庄子·庚桑楚》、《春秋繁露》这场。',
    expectLinks: [{ term: '第十一季总决赛《庄子·庚桑楚》、《春秋繁露》', target: '周年祭/314-11-37 第十一季总决赛《庄子·庚桑楚》、《春秋繁露》.md' }],
  },
  {
    name: 'I9 数字下划线编号：04_内容索引 ↔ 内容索引',
    docs: [{ path: '整理排序/04_内容索引.md' }],
    text: '内容索引 里有全部摘要。',
    expectLinks: [{ term: '内容索引', target: '整理排序/04_内容索引.md' }],
  },
  {
    name: 'I10 括号注释后缀：S09_发生学基础（开放系统与从外有所得） ↔ 发生学基础',
    docs: [{ path: '知识库卡片/S09_发生学基础（开放系统与从外有所得）.md' }],
    text: '发生学基础 这张卡。',
    expectLinks: [{ term: '发生学基础', target: '知识库卡片/S09_发生学基础（开放系统与从外有所得）.md' }],
  },
];

// ---------- 执行 ----------
function stem(p) {
  const n = p.split('/').pop();
  const dot = n.lastIndexOf('.');
  return dot > 0 ? n.slice(0, dot) : n;
}

let pass = 0, fail = 0;
const failures = [];

for (const c of CASES) {
  const entries = [];
  for (const d of c.docs) {
    const title = d.title ?? stem(d.path);
    entries.push({ term: title, path: d.path, kind: 'title' });
    for (const a of d.aliases ?? []) entries.push({ term: a, path: d.path, kind: 'alias' });
  }
  const idx = buildAutoIndex(entries, []);
  const links = extractLinks(c.text, idx, { selfPath: c.selfPath ?? null });
  const got = links.filter((l) => l.target).map((l) => ({ term: l.term, target: l.target?.path }));
  const gotCands = links.filter((l) => !l.target && l.candidates).map((l) => ({ term: l.term, count: l.candidates.length }));

  const missing = (c.expectLinks ?? []).filter(
    (e) => !got.some((g) => g.term === e.term && g.target === e.target)
  );
  const extra = got.filter((g) => !(c.expectLinks ?? []).some((e) => e.term === g.term && e.target === g.target));
  const missCands = (c.expectCandidates ?? []).filter((e) => !gotCands.some((g) => g.term === e.term && g.count === e.count));
  const extraCands = gotCands.filter((g) => !(c.expectCandidates ?? []).some((e) => e.term === g.term && e.count === g.count));
  missing.push(...missCands.map((m) => ({ term: m.term + '(候选)', target: m.count + '个' })));
  extra.push(...extraCands.map((m) => ({ term: m.term + '(候选)', target: m.count + '个' })));

  if (!missing.length && !extra.length) {
    pass++;
    console.log(`✓ ${c.name}`);
  } else {
    fail++;
    failures.push({ name: c.name, missing, extra, got });
    console.log(`✗ ${c.name}`);
    if (missing.length) console.log(`    缺: ${missing.map((m) => `「${m.term}」→${m.target}`).join(' ')}`);
    if (extra.length) console.log(`    多: ${extra.map((m) => `「${m.term}」→${m.target}`).join(' ')}`);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
