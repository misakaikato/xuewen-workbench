// 加工数据（derived）：读取语料目录下 .derived/ 的 JSONL，提供概念表、主题与知识图谱
// 定位为派生数据：由 AI 从原始 MD 转换产出，系统只读不写；缺失时功能自动退化
//
// .derived/concepts.jsonl —— 一行一个条目（概念/人物/书名…）
//   {"name":"本体","aliases":["本原"],"type":"概念","def":"释义","refs":["笔记/第1章.md"],
//    "related":["心性"],"status":"machine","source_hash":null}
//
// .derived/topics.jsonl —— 文档 → 主题标注
//   {"path":"笔记/第1章.md","topics":["基础"]}
//
// .derived/graph.jsonl —— 图节点与边
//   {"kind":"node","id":"本体","label":"本体","type":"概念","desc":"…"}
//   {"kind":"edge","from":"本体","to":"心性","rel":"包含"}
import fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import path from 'node:path';

export const DERIVED_DIR = '.derived';
export const LEGACY_DERIVED_DIR = '.xuewen';
const CONCEPTS_FILE = 'concepts.jsonl';
const GRAPH_FILE = 'graph.jsonl';
const GRAPHML_FILE = 'graph.graphml';
const TOPICS_FILE = 'topics.jsonl';

let migrated = new Set();

/** 旧版目录 .xuewen/ 一次性迁移为 .derived/（只在目标不存在时执行，避免覆盖） */
export function migrateLegacyDir(baseDir) {
  if (migrated.has(baseDir)) return;
  migrated.add(baseDir);
  const legacy = path.join(baseDir, LEGACY_DERIVED_DIR);
  const target = path.join(baseDir, DERIVED_DIR);
  try {
    if (!fs.existsSync(legacy)) return;
    if (fs.existsSync(target)) return;
    fs.renameSync(legacy, target);
    console.log(`[derived] 已迁移 ${LEGACY_DERIVED_DIR}/ → ${DERIVED_DIR}/`);
  } catch (e) {
    console.error('[derived] 目录迁移失败:', e.message);
  }
}

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

function readGraphml(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { nodes: [], edges: [], missing: true };
  }
  try {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true });
    const doc = parser.parse(raw);
    const g = doc?.graphml?.graph;
    if (!g) return { nodes: [], edges: [], errors: ['graphml 结构不合法：缺少 graph'] };
    // key 定义：id -> 属性名（attr.name）
    const keyMap = {};
    const keys = Array.isArray(doc.graphml.key) ? doc.graphml.key : doc.graphml.key ? [doc.graphml.key] : [];
    for (const k of keys) {
      const id = k['@id'];
      const name = k['@attr.name'] || id;
      if (id) keyMap[id] = name;
    }
    const dataToObj = (data) => {
      const o = {};
      const arr = Array.isArray(data) ? data : data ? [data] : [];
      for (const d of arr) {
        const key = d['@key'];
        const name = keyMap[key] || key;
        const val = typeof d === 'object' ? (d['#text'] ?? '') : String(d ?? '');
        if (name && val !== '') o[name] = String(val);
      }
      return o;
    };
    const nodes = [];
    const edges = [];
    const nodeArr = Array.isArray(g.node) ? g.node : g.node ? [g.node] : [];
    for (const n of nodeArr) {
      const attrs = dataToObj(n.data);
      const id = String(attrs.name ?? attrs.label ?? n['@id'] ?? '').trim();
      if (!id) continue;
      nodes.push({ id, label: String(attrs.label ?? attrs.name ?? id), type: String(attrs.type ?? '概念'), desc: String(attrs.desc ?? attrs.description ?? '') });
    }
    const nodeIds = new Set(nodes.map((x) => x.id));
    const edgeArr = Array.isArray(g.edge) ? g.edge : g.edge ? [g.edge] : [];
    for (const e of edgeArr) {
      const attrs = dataToObj(e.data);
      const from = String(attrs.from ?? attrs.source ?? e['@source'] ?? '').trim();
      const to = String(attrs.to ?? attrs.target ?? e['@target'] ?? '').trim();
      if (!from || !to) continue;
      edges.push({ from, to, rel: String(attrs.rel ?? attrs.relation ?? attrs.label ?? '') });
      // 边端点若是内部 id（n1/n0），尝试映射到节点 name；否则补占位节点
    }
    // 若边端点不是节点 id 而是内部编号，做一次映射
    const idByInternal = new Map();
    for (const n of nodeArr) {
      const internal = String(n['@id'] ?? '').trim();
      const attrs = dataToObj(n.data);
      const realId = String(attrs.name ?? attrs.label ?? internal).trim();
      if (internal && realId && internal !== realId) idByInternal.set(internal, realId);
    }
    for (const e of edges) {
      if (idByInternal.has(e.from)) e.from = idByInternal.get(e.from);
      if (idByInternal.has(e.to)) e.to = idByInternal.get(e.to);
    }
    return { nodes, edges, missing: false };
  } catch (e) {
    return { nodes: [], edges: [], errors: ['graphml 解析失败: ' + e.message], missing: false };
  }
}

/** 读取并规范化图谱（节点 + 边）：优先 graph.graphml，回退 graph.jsonl */
export function loadGraph(baseDir) {
  migrateLegacyDir(baseDir);
  const gm = readGraphml(path.join(baseDir, DERIVED_DIR, GRAPHML_FILE));
  if (!gm.missing) {
    // 补占位节点（只给 id 的边端点）
    const nodeIds = new Set(gm.nodes.map((n) => n.id));
    for (const e of gm.edges) {
      for (const id of [e.from, e.to]) {
        if (!nodeIds.has(id)) { gm.nodes.push({ id, label: id, type: '概念', desc: '' }); nodeIds.add(id); }
      }
    }
    return { nodes: gm.nodes, edges: gm.edges, errors: gm.errors || [], missing: false, format: 'graphml' };
  }
  // 回退 JSONL
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
  migrateLegacyDir(baseDir);
  const c = loadConcepts(baseDir);
  const g = loadGraph(baseDir);
  return { concepts: c.concepts, graph: g, conceptErrors: c.errors, graphErrors: g.errors, conceptsMissing: c.missing, graphMissing: g.missing };
}

/** 读取 AI 标注的主题：{ path -> topics[] }。与 .meta.json 里人工标注的 tags 相互独立，展示时合并 */
export function loadTopics(baseDir) {
  const { items, errors, missing } = readJsonl(path.join(baseDir, DERIVED_DIR, TOPICS_FILE));
  const byPath = new Map();
  for (const it of items) {
    const p = typeof it.path === 'string' ? it.path.trim() : '';
    if (!p) continue;
    const topics = strArr(it.topics ?? it.tags);
    const concepts = strArr(it.concepts);
    if (!topics.length && !concepts.length) continue;
    if (!byPath.has(p)) byPath.set(p, { topics: [], concepts: [] });
    const e = byPath.get(p);
    for (const t of topics) if (!e.topics.includes(t)) e.topics.push(t);
    for (const c of concepts) if (!e.concepts.includes(c)) e.concepts.push(c);
  }
  return { byPath, errors: errors || [], missing };
}
