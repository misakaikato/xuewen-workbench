// RAG 参数配置：按库持久化（sources/<dsId>/rag-config.json），含默认值与范围钳制。
// 三段：chunk 切块（影响索引内容，改动需重建）/ embed 嵌入（影响索引内容）/
// search 检索（只影响查询，无需重建）。
import { getState, setState } from '../store.js';

export const DEFAULT_RAG_CONFIG = {
  chunk: {
    maxChars: 600, // 目标块上限（CJK 字符）；超长节按段落聚合二次分组
    jsonValueLimit: 1500, // json 单值截断字符数
    headingContext: true, // 标题路径拼入嵌入文本（提供语境）
    fileNameContext: true, // 文件名拼入块文本（文件名含查询词但正文没有的文件也能被智能检索命中）
    hardSplitOversize: false, // 超长单元硬切（默认独立成块不切）
  },
  embed: {
    maxLength: 1024, // tokenizer 截断 token 数（影响索引与查询两侧）
  },
  search: {
    topN: 30, // BM25 / 余弦各取 top-N
    rrfK: 60, // RRF 融合常数
    rrfMin: 0.0105, // 最低融合分（低于此不出现 = 诚实空结果阈值）
    cosFloor: 0.25, // 余弦绝对下限
    cosSigma: 2.0, // 余弦统计阈值倍数（均值 + cosSigma × 标准差）
    semanticWeight: 1.2, // RRF 语义路权重（>1 提升语义相对词面的话语权；1 = 等权）
  },
};

// 钳制范围（防呆：存坏/手改出格也落回合理区间）
const CLAMPS = {
  'chunk.maxChars': [80, 4000],
  'chunk.jsonValueLimit': [200, 10000],
  'embed.maxLength': [128, 8192],
  'search.topN': [5, 200],
  'search.rrfK': [10, 200],
  'search.rrfMin': [0, 0.05],
  'search.cosFloor': [0, 1],
  'search.cosSigma': [0.5, 6],
};

const clamp = (v, [lo, hi], dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

/** 读取并归一（缺省补默认、越界钳制、布尔容错） */
export function normalizeRagConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = JSON.parse(JSON.stringify(DEFAULT_RAG_CONFIG));
  for (const section of ['chunk', 'embed', 'search']) {
    const src = r[section] && typeof r[section] === 'object' ? r[section] : {};
    for (const key of Object.keys(out[section])) {
      if (src[key] === undefined) continue;
      const ck = `${section}.${key}`;
      if (CLAMPS[ck]) {
        out[section][key] = clamp(src[key], CLAMPS[ck], out[section][key]);
      } else if (typeof out[section][key] === 'boolean') {
        out[section][key] = !!src[key];
      }
    }
  }
  return out;
}

export function loadRagConfig(dsId) {
  return normalizeRagConfig(getState(dsId, 'rag-config', {}));
}

export function saveRagConfig(dsId, patch) {
  const cur = loadRagConfig(dsId);
  const next = normalizeRagConfig({ ...cur, ...patch, chunk: { ...cur.chunk, ...(patch?.chunk || {}) }, embed: { ...cur.embed, ...(patch?.embed || {}) }, search: { ...cur.search, ...(patch?.search || {}) } });
  setState(dsId, 'rag-config', next);
  return next;
}

/** 影响索引内容的配置指纹（chunk + embed.maxLength）——变化即需重建 */
export function indexConfigFingerprint(cfg) {
  return JSON.stringify({ c: cfg.chunk, m: cfg.embed.maxLength });
}
