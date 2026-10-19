// 加工数据（derived）：读取语料目录下 .xuewen/ 的 JSONL，提供概念表与知识图谱
// 定位为派生数据：由 AI 从原始 MD 转换产出，系统只读不写；缺失时功能自动退化
//
// .xuewen/concepts.jsonl —— 一行一个条目（概念/人物/书名/主题…）
//   {"name":"本体","aliases":["本原"],"type":"概念","def":"释义","refs":["笔记/第1章.md"],
//    "related":["心性"],"status":"machine","source_hash":null}
//
// .xuewen/graph.jsonl —— 图节点与边
//   {"kind":"node","id":"本体","label":"本体","type":"概念","desc":"…"}
//   {"kind":"edge","from":"本体","to":"心性","rel":"包含"}
import fs from 'node:fs';
import path from 'node:path';

export const DERIVED_DIR = '.xuewen';
const CONCEPTS_FILE = 'concepts.jsonl';
const GRAPH_FILE = 'graph.jsonl';

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { items: [], missing: true };
  }
  const items = [];
  const errors = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('//')) return;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object') items.push(o);
    } catch (e) {
      if (errors.length < 5) errors.push(`第 ${i + 1} 行: ${e.message}`);
    }
  });
  return { items, errors, missing: false };
}

const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);

/** 读取并规范化概念表 */
export function loadConcepts(baseDir) {
  const { items, errors, missing } = readJsonl(path.join(baseDir, DERIVED_DIR, CONCEPTS_FILE));
  const out = [];
  for (const it of items) {
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    if (!name) continue;
    out.push({
      name,
      aliases: strArr(it.aliases),
      type: typeof it.type === 'string' && it.type.trim() ? it.type.trim() : '概念',
      def: typeof it.def === 'string' ? it.def : '',
      refs: strArr(it.refs),
      related: strArr(it.related),
      status: it.status === 'confirmed' ? 'confirmed' : 'machine',
      source_hash: typeof it.source_hash === 'string' ? it.source_hash : null,
    });
  }
  return { concepts: out, errors: errors || [], missing };
}

/** 读取并规范化图谱（节点 + 边） */
export function loadGraph(baseDir) {
  const { items, errors, missing } = readJsonl(path.join(baseDir, DERIVED_DIR, GRAPH_FILE));
  const nodes = new Map();
  const edges = [];
  for (const it of items) {
    if (it.kind === 'edge' || (it.from && it.to)) {
      const from = String(it.from ?? '').trim();
      const to = String(it.to ?? '').trim();
      if (!from || !to) continue;
      edges.push({ from, to, rel: typeof it.rel === 'string' ? it.rel : '' });
      continue;
    }
    const id = String(it.id ?? it.name ?? '').trim();
    if (!id) continue;
    nodes.set(id, {
      id,
      label: typeof it.label === 'string' && it.label.trim() ? it.label.trim() : id,
      type: typeof it.type === 'string' && it.type.trim() ? it.type.trim() : '概念',
      desc: typeof it.desc === 'string' ? it.desc : '',
    });
  }
  // 边端点若未声明为节点，补一个占位节点（图数据常见：只给 id）
  for (const e of edges) {
    for (const id of [e.from, e.to]) {
      if (!nodes.has(id)) nodes.set(id, { id, label: id, type: '概念', desc: '' });
    }
  }
  return { nodes: [...nodes.values()], edges, errors: errors || [], missing };
}

/** 概念表 + 图谱合并视图：供 /api/concepts 与内链使用 */
export function loadDerived(baseDir) {
  const c = loadConcepts(baseDir);
  const g = loadGraph(baseDir);
  return { concepts: c.concepts, graph: g, conceptErrors: c.errors, graphErrors: g.errors, conceptsMissing: c.missing, graphMissing: g.missing };
}
