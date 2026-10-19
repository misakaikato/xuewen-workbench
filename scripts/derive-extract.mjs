#!/usr/bin/env node
// 加工数据提取脚本：扫语料 → 调 LM Studio（本地）→ 写 .derived/
// 用法: node scripts/derive-extract.mjs <语料目录> [--model qwen/qwen3.6-35b-a3b] [--base http://127.0.0.1:1234]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const corpus = args.find((a) => !a.startsWith('--'));
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const MODEL = opt('model', 'qwen/qwen3.6-35b-a3b');
const BASE = opt('base', 'http://127.0.0.1:1234');

if (!corpus || !fs.existsSync(corpus)) {
  console.error('用法: node scripts/derive-extract.mjs <语料目录> [--model ...] [--base ...]');
  process.exit(1);
}

const DERIVED = path.join(corpus, '.derived');
const EXTS = ['.md', '.txt'];

function* walk(dir, rel = '') {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isDirectory()) yield* walk(abs, r);
    else if (EXTS.includes(path.extname(ent.name))) yield { abs, rel: r };
  }
}

async function chat(messages, { maxTokens = 4500, retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(BASE + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, temperature: 0.1, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(180000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const content = d.choices?.[0]?.message?.content || '';
      return content;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((s) => setTimeout(s, 2000 * (attempt + 1)));
    }
  }
}

function parseJson(text) {
  // 剥 ```json 围栏，取第一个 [ 或 { 到最后一个 ] 或 }
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  const start = Math.min(...['[', '{'].map((c) => t.indexOf(c)).filter((i) => i >= 0));
  const end = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (start < 0 || end < 0) throw new Error('未找到 JSON（原文前120字: ' + text.slice(0, 120).replace(/\n/g, ' ') + '）');
  return JSON.parse(t.slice(start, end + 1));
}

const SYS = '你是语料分析器。只输出 JSON，不要解释，不要 markdown 围栏之外的文字。';

async function extractDoc(relPath, content) {
  const clipped = content.slice(0, 6000);
  const raw = await chat([
    { role: 'system', content: SYS },
    { role: 'user', content: `分析这篇文档（路径：${relPath}），输出 JSON：\n{"topics": ["1-3个主题"], "concepts": [{"name":"概念名","type":"概念|人物|书名","def":"一句话释义","aliases":["别名"],"core":true}]}\n\n规则：\n- concepts 只收本文真正展开讲的核心概念（core: true），一笔带过的不要\n- def 不超过 40 字\n- type 只能是 概念/人物/书名 之一\n\n文档正文：\n${clipped}` },
  ]);
  return parseJson(raw);
}

async function genRelations(conceptNames) {
  const raw = await chat([
    { role: 'system', content: SYS },
    { role: 'user', content: `给定概念列表：${conceptNames.join('、')}。\n输出它们之间的关系，JSON 数组：\n[{"from":"概念A","to":"概念B","rel":"包含|互补|对立|相关"}]\n只输出确实存在的关系，不要编造。` },
  ], { maxTokens: 4500 });
  return parseJson(raw);
}

const docs = [...walk(corpus)];
console.log(`语料: ${corpus} (${docs.length} 篇)`);
console.log(`模型: ${MODEL} @ ${BASE}`);

fs.mkdirSync(DERIVED, { recursive: true });

const topicsLines = [];
const conceptMap = new Map(); // name -> {name, aliases:Set, type, def, refs:Set}

for (const d of docs) {
  process.stdout.write(`提取 ${d.rel} ... `);
  const content = fs.readFileSync(d.abs, 'utf8');
  try {
    const r = await extractDoc(d.rel, content);
    const topics = Array.isArray(r.topics) ? r.topics.filter((t) => typeof t === 'string' && t.trim()) : [];
    const concepts = Array.isArray(r.concepts) ? r.concepts.filter((c) => c && typeof c.name === 'string' && c.name.trim()) : [];
    topicsLines.push(JSON.stringify({ path: d.rel, topics, concepts: concepts.map((c) => c.name), status: 'machine' }));
    for (const c of concepts) {
      const name = c.name.trim();
      if (!conceptMap.has(name)) {
        conceptMap.set(name, { name, aliases: new Set(), type: '概念', def: '', refs: new Set() });
      }
      const e = conceptMap.get(name);
      if (typeof c.type === 'string' && c.type) e.type = c.type;
      if (typeof c.def === 'string' && c.def && !e.def) e.def = c.def;
      if (Array.isArray(c.aliases)) for (const a of c.aliases) if (typeof a === 'string' && a.trim()) e.aliases.add(a.trim());
      e.refs.add(d.rel);
    }
    console.log(`OK (${concepts.length} 概念, ${topics.length} 主题)`);
  } catch (e) {
    console.log(`失败: ${e.message}`);
  }
}

// 概念表
const conceptsLines = [...conceptMap.values()].map((c) => JSON.stringify({
  name: c.name,
  aliases: [...c.aliases],
  type: c.type,
  def: c.def,
  refs: [...c.refs],
  related: [],
  status: 'machine',
}));

// 图谱：AI 生成关系 + 共现兜底
const names = [...conceptMap.keys()];
let edges = [];
try {
  process.stdout.write('生成概念关系 ... ');
  edges = await genRelations(names);
  console.log(`OK (${edges.length} 条)`);
} catch (e) {
  console.log(`失败: ${e.message}，用共现兜底`);
}

// 共现兜底：同篇出现的概念连边（仅当 AI 关系为空时）
if (!edges.length) {
  for (const line of topicsLines) {
    const t = JSON.parse(line);
    for (let i = 0; i < t.concepts.length; i++) {
      for (let j = i + 1; j < t.concepts.length; j++) {
        edges.push({ from: t.concepts[i], to: t.concepts[j], rel: '共现' });
      }
    }
  }
}

// graphml
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nodeIds = new Map(names.map((n, i) => [n, 'n' + i]));
const graphml = `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="name" for="node" attr.name="name" attr.type="string"/>
  <key id="type" for="node" attr.name="type" attr.type="string"/>
  <key id="desc" for="node" attr.name="desc" attr.type="string"/>
  <key id="rel"  for="edge" attr.name="rel"  attr.type="string"/>
  <graph edgedefault="directed">
${names.map((n) => {
    const c = conceptMap.get(n);
    return `    <node id="${nodeIds.get(n)}"><data key="name">${esc(n)}</data><data key="type">${esc(c.type)}</data><data key="desc">${esc(c.def)}</data></node>`;
  }).join('\n')}
${edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)).map((e) => `    <edge source="${nodeIds.get(e.from)}" target="${nodeIds.get(e.to)}"><data key="rel">${esc(e.rel || '相关')}</data></edge>`).join('\n')}
  </graph>
</graphml>
`;

fs.writeFileSync(path.join(DERIVED, 'concepts.jsonl'), conceptsLines.join('\n') + '\n');
fs.writeFileSync(path.join(DERIVED, 'topics.jsonl'), topicsLines.join('\n') + '\n');
fs.writeFileSync(path.join(DERIVED, 'graph.graphml'), graphml);

console.log(`\n写入 ${DERIVED}:`);
console.log(`  concepts.jsonl: ${conceptsLines.length} 条`);
console.log(`  topics.jsonl:   ${topicsLines.length} 条`);
console.log(`  graph.graphml:  ${names.length} 节点, ${edges.length} 边`);
