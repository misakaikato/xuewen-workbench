// RAG 管理器：嵌入服务（全局共享）+ 按库索引生命周期 + 混合检索。
// 索引构建：文件级进度位（files.done），可暂停/续建；扫描完成后对已有索引自动增量。
// 检索：t2s 归一 → FTS5 BM25 + 向量余弦各取 topN → RRF 融合 → 1e-4 量化稳定排序。
import fs from 'node:fs';
import path from 'node:path';
import { RagStore, tokenizeFts, ftsIndexText } from './store.js';
import { chunkFile, embedTextOf } from './chunk.js';
// embedTextOf 统一拼装 [文件名\n标题路径\n\n正文]，FTS 与向量共用
import { EmbedService, t2s, DIM } from './embed.js';
import { loadRagConfig, saveRagConfig, indexConfigFingerprint, DEFAULT_RAG_CONFIG } from './config.js';
import { readJson, writeJsonAtomic } from '../store.js';

// 检索参数来自按库配置（loadRagConfig），以下仅为回退默认
const { rrfK: RRF_K, topN: TOPN } = DEFAULT_RAG_CONFIG.search;

class RagIndex {
  constructor(dsId, dbPath, getSnapshot, embed) {
    this.dsId = dsId;
    this.dbPath = dbPath;
    this.getSnapshot = getSnapshot; // () => { files: [{path, contentHash, ext}] } | null
    this.embed = embed;
    this.cfg = loadRagConfig(dsId);
    this.reloadCfg = () => {
      this.cfg = loadRagConfig(dsId);
    };
    this.store = null;
    this.state = 'none'; // none | building | paused | ready | error
    this.phase = ''; // 切块 | 嵌入 | 完成
    this.done = 0;
    this.total = 0;
    this.error = null;
    this._pauseFlag = false;
    this._buildSeq = 0;
    this._autoQueued = false;
  }

  _ensureStore() {
    if (!this.store) {
      this.store = new RagStore(this.dbPath);
      this.store.metaSet('dim', String(DIM));
    }
    return this.store;
  }

  status() {
    const store = this._ensureStore();
    const st = store.stats();
    // 切块/嵌入参数与建库时不同 → 提示重建
    let configChanged = false;
    try {
      configChanged = !!store.metaGet('index_cfg') && store.metaGet('index_cfg') !== indexConfigFingerprint(this.cfg);
    } catch { /* 忽略 */ }
    // 重启恢复：库里有完成的文件即为就绪（内存态丢失时从数据推导）
    if (this.state === 'none' && st.files > 0 && st.filesDone === st.files) this.state = 'ready';
    let dbBytes = 0;
    try {
      dbBytes = fs.statSync(this.dbPath).size;
    } catch { /* 无库文件 */ }
    return {
      state: this.state,
      phase: this.phase,
      done: this.done,
      total: this.total,
      files: st.files,
      filesDone: st.filesDone,
      chunks: st.chunks,
      vecs: st.vecs,
      dbBytes,
      updatedAt: this._updatedAt || null,
      error: this.error,
      configChanged,
      ftsError: store.ftsError && Date.now() - store.ftsErrorAt < 3600_000 ? store.ftsError : null,
    };
  }

  /** 全量/增量构建；rebuild=true 清库重来。幂等：构建中忽略重复请求 */
  async build({ rebuild = false } = {}) {
    if (this.state === 'building') return { ok: true, already: true };
    const snap = this.getSnapshot();
    if (!snap || !snap.files || !snap.files.length) return { ok: false, error: '资料库尚未扫描完成' };
    if (this.whenIndexed) await this.whenIndexed(); // 等文本索引就绪（切块要从 indexer.texts 拿正文）
    const store = this._ensureStore();
    const seq = ++this._buildSeq;
    this._pauseFlag = false;
    this.state = 'building';
    this.error = null;
    try {
      if (rebuild) {
        store.db.exec('DELETE FROM files; DELETE FROM chunks; DELETE FROM vecs;');
        store._bump();
      }
      const texts = new Map(); // path -> 原文（切块用）；从扫描侧拿不到正文时由调用方提供 getText
      const plan = store.planIncremental(snap.files.map((f) => ({ path: f.path, contentHash: f.mtimeMs + ':' + f.size })));
      if (plan.toDel.length) store.deleteFiles(plan.toDel);
      const todo = plan.toAdd;
      this.total = todo.length;
      this.done = 0;
      this.phase = '切块';
      for (const f of todo) {
        if (seq !== this._buildSeq) return { ok: true, superseded: true };
        if (this._pauseFlag) {
          this.state = 'paused';
          this.phase = '';
          return { ok: true, paused: true };
        }
        const text = this.getText(f.path);
        if (text == null) {
          // 扫描快照里没有正文缓存时记录为空完成（词表文件等极端情况）
          store.replaceChunks(f.path, f.contentHash, [], f.ext?.slice(1) || 'md', () => '');
          this.done++;
          continue;
        }
        const chunks = chunkFile(f.ext || '.md', text, this.cfg.chunk);
        const eOpts = { headingContext: this.cfg.chunk.headingContext, fileName: f.name };
        store.replaceChunks(f.path, f.contentHash, chunks, kindOf(f.ext), (c) => ftsIndexText(t2s(embedTextOf(c, eOpts))));
        // 立即嵌入该文件全部块（文件级完成粒度）
        this.phase = '嵌入';
        if (chunks.length) {
          const ids = store.db.prepare('SELECT id FROM chunks WHERE path=? ORDER BY ordinal').all(f.path).map((r) => r.id);
          const vecs = await this.embed.embed(chunks.map((c) => embedTextOf(c, eOpts)), { maxLength: this.cfg.embed.maxLength });
          store.writeVecs(ids.map((id, i) => ({ id, vec: vecs[i] })));
        }
        store.markFileDone(f.path);
        this.done++;
        this._updatedAt = Date.now();
      }
      this.state = 'ready';
      this.phase = '完成';
      this._updatedAt = Date.now();
      store.metaSet('index_cfg', indexConfigFingerprint(this.cfg)); // 重建提示指纹
      return { ok: true };
    } catch (e) {
      this.state = 'error';
      this.error = String(e.message || e);
      return { ok: false, error: this.error };
    }
  }

  pause() {
    if (this.state === 'building') {
      this._pauseFlag = true;
      return { ok: true };
    }
    return { ok: false, error: '未在构建' };
  }

  /** getText 由 manager 注入（读磁盘 + word 提取缓存） */
  getText(_path) {
    return this._getText ? this._getText(_path) : null;
  }
}

function kindOf(ext) {
  if (ext === '.md') return 'md';
  if (ext === '.json') return 'json';
  if (ext === '.txt') return 'txt';
  return 'word';
}

export class RagManager {
  constructor({ dataDir, sourcesDir, getLib }) {
    this.dataDir = dataDir;
    this.sourcesDir = sourcesDir;
    this.getLib = getLib; // (dsId) => { snapshot, getText(relPath) } | null
    this.embed = new EmbedService(dataDir);
    this.indices = new Map(); // dsId -> RagIndex
    this.llm = {
      enabled: false, baseUrl: 'http://localhost:11434/v1', model: '', apiKey: '', thinkingLevel: 'off',
      // 持久化：生成端点配置是全局设置（跨资料库），重启后必须恢复
      ...readJson(path.join(dataDir, 'llm-settings.json'), {}),
    };
    this.onLlmChanged = null; // 由 agent 模块挂接：端点变化时同步 models.json
  }

  /** 更新并持久化生成端点配置（含 agent 侧 thinkingLevel） */
  setLlm(patch) {
    for (const k of ['enabled', 'baseUrl', 'model', 'apiKey', 'thinkingLevel']) {
      if (patch && k in patch) this.llm[k] = patch[k];
    }
    writeJsonAtomic(path.join(this.dataDir, 'llm-settings.json'), this.llm);
    this.onLlmChanged?.();
    return { ...this.llm, apiKey: undefined };
  }

  index(dsId) {
    let ix = this.indices.get(dsId);
    if (!ix) {
      const lib = this.getLib(dsId);
      const ix2 = new RagIndex(dsId, path.join(this.sourcesDir, dsId, 'rag.db'), () => this.getLib(dsId)?.snapshot || null, this.embed);
      ix2.whenIndexed = () => (this.getLib(dsId)?.whenIndexed || Promise.resolve())();
      ix2._getText = (p) => {
        const lib2 = this.getLib(dsId);
        return lib2 ? lib2.getText(p) : null;
      };
      ix = ix2;
      this.indices.set(dsId, ix);
    }
    return ix;
  }

  remove(dsId) {
    const ix = this.indices.get(dsId);
    if (ix) {
      if (ix.store) ix.store.close();
      this.indices.delete(dsId);
    }
  }

  status(dsId) {
    return { model: this.embed.status(), index: this.index(dsId).status(), llm: { ...this.llm, apiKey: undefined } };
  }

  async build(dsId, opts) {
    return this.index(dsId).build(opts);
  }

  saveConfig(dsId, patch) {
    const next = saveRagConfig(dsId, patch);
    const ix = this.index(dsId);
    ix.cfg = next;
    return next;
  }

  pause(dsId) {
    return this.index(dsId).pause();
  }

  /** 扫描完成钩子：已有索引（files>0）则自动增量；从未建过不自动 */
  onScanComplete(dsId) {
    const ix = this.indices.get(dsId);
    if (!ix || ix.state === 'building') return;
    try {
      const st = ix._ensureStore().stats();
      if (st.files > 0 && ix.state !== 'paused') {
        ix.build({}).catch(() => {}); // 后台增量，不阻塞扫描
      }
    } catch { /* 库文件异常时忽略自动增量 */ }
  }

  /** 混合检索：RRF 融合 BM25 与余弦 */
  async search(dsId, q, limit = 50) {
    const t0 = Date.now();
    const ix = this.index(dsId);
    const store = ix._ensureStore();
    const cfg = ix.cfg;
    const st = store.stats();
    if (!st.chunks) throw new Error('索引为空（请先构建索引）');
    const qs = t2s(q).toLowerCase().trim();
    if (!qs) return { hits: [], took: 0 };

    // ① FTS5
    const tokens = tokenizeFts(qs);
    // 融合用 FTS 前 topN 名（语义精华）
    const fts = store.searchFts(tokens, cfg.search.topN); // [{id, score}] score=bm25（小好）

    // ② 余弦 + 统计阈值（诚实空结果：无关查询的余弦分布无离群点，整体压掉）
    const qv = (await this.embed.embed([qs], { maxLength: cfg.embed.maxLength }))[0];
    const { ids, mat, dim } = store.vecMatrix();
    let cos = [];
    if (ids.length && dim === qv.length) {
      const all = [];
      for (let i = 0; i < ids.length; i++) {
        let s = 0;
        const off = i * dim;
        for (let j = 0; j < dim; j++) s += mat[off + j] * qv[j];
        all.push({ id: ids[i], score: s });
      }
      const n = all.length || 1;
      const mean = all.reduce((a, x) => a + x.score, 0) / n;
      const std = Math.sqrt(all.reduce((a, x) => a + (x.score - mean) * (x.score - mean), 0) / n);
      const cosMin = Math.max(cfg.search.cosFloor, mean + cfg.search.cosSigma * std);
      cos = all.filter((x) => x.score >= cosMin).sort((a, b) => b.score - a.score);
    }

    // ③ RRF 融合（bm25 名次升序、cos 名次降序）
    const rrf = new Map();
    const rrfK = cfg.search.rrfK;
    const wSem = cfg.search.semanticWeight ?? 1; // 语义路权重（>1：语义相对词面更有话语权）
    fts.forEach((r, i) => {
      const s = 1 / (rrfK + i + 1);
      rrf.set(r.id, (rrf.get(r.id) || 0) + s);
    });
    cos.slice(0, cfg.search.topN).forEach((r, i) => {
      const s = wSem / (rrfK + i + 1);
      rrf.set(r.id, (rrf.get(r.id) || 0) + s);
    });
    // 只被一路命中的弱结果过滤：融合分 < 阈值（约等于另一路 60 名开外）
    const fused = [...rrf.entries()]
      .map(([id, score]) => ({ id, score: Math.round(score * 1e4) / 1e4 }))
      .filter((x) => x.score >= cfg.search.rrfMin)
      .sort((a, b) => (b.score - a.score) || (a.id - b.id)); // 量化后稳定排序
    // 字面补位：FTS 确凿命中但被融合阈值滤掉的，跟在融合段后。
    // 补位序 = 文件轮转（每文件先出一段，再出第二段……）——大文件的高频块
    // 不霸榜，limit 内覆盖尽可能多的文件；文件内仍按 BM25 名次
    const fusedIds = new Set(fused.map((x) => x.id));
    // 补位池：每文件 BM25 最优 3 块（SQL 窗口函数保证文件多样性），轮转排序——
    // 第一轮所有命中文件各出一块，第二轮再各出一块……大文件不霸榜，覆盖完备
    const byFile = store.searchFtsByFile(tokens, 3).filter((r) => !fusedIds.has(r.id));
    const rounds = new Map(); // rnk -> [ids]
    for (const r of byFile) {
      if (!rounds.has(r.rnk)) rounds.set(r.rnk, []);
      rounds.get(r.rnk).push(r.id);
    }
    const filler = [];
    for (const rnk of [...rounds.keys()].sort((a, b) => a - b)) {
      for (const id of rounds.get(rnk)) filler.push({ id, score: 0 }); // 0 = 未过融合线
    }
    // total 如实反映融合命中 + 可用补位（受 FTS 候选池限制）
    const total = fused.length + filler.length;
    const top = [...fused, ...filler].slice(0, limit);
    const chunks = store.getChunksByIds(top.map((x) => x.id));
    const bm25Ids = new Map(fts.map((r) => [r.id, r.score]));
    const cosIds = new Map(cos.map((r) => [r.id, r.score]));
    const hits = top
      .map((x) => {
        const c = chunks.get(x.id);
        if (!c) return null;
        return {
          path: c.path,
          name: c.path.split('/').pop() || c.path,
          headingPath: c.heading_path,
          ordinal: c.ordinal,
          kind: c.kind,
          snippet: snippetOf(c.text, qs),
          score: x.score,
          bm25: bm25Ids.has(c.id),
          cos: cosIds.has(c.id) ? Math.round(cosIds.get(c.id) * 1e4) / 1e4 : null,
        };
      })
      .filter(Boolean);
    return { hits, total, took: Date.now() - t0, backend: this.embed.backend };
  }

  async llmTest() {
    const { baseUrl, apiKey } = this.llm;
    try {
      const r = await fetch(baseUrl.replace(/\/$/, '') + '/models', {
        headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
      const j = await r.json();
      const models = (j.data || []).map((m) => m.id).slice(0, 20);
      return { ok: true, models };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }
}

// 摘要：命中词首现处前后截取；纯语义命中（无字面命中）取块首
function snippetOf(text, qs) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const tok = tokenizeFts(qs)[0];
  let i = tok ? flat.toLowerCase().indexOf(tok) : -1;
  if (i < 0) i = 0;
  const start = Math.max(0, i - 60);
  const end = Math.min(flat.length, start + 240);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}
