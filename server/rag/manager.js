// RAG 管理器：嵌入服务（全局共享）+ 按库索引生命周期 + 混合检索。
// 索引构建：文件级进度位（files.done），可暂停/续建；扫描完成后对已有索引自动增量。
// 检索：t2s 归一 → FTS5 BM25 + 向量余弦各取 topN → RRF 融合 → 1e-4 量化稳定排序。
import fs from 'node:fs';
import path from 'node:path';
import { RagStore, tokenizeFts, ftsIndexText } from './store.js';
import { chunkFile, embedTextOf } from './chunk.js';
import { EmbedService, t2s, DIM } from './embed.js';

const RRF_K = 60;
const TOPN = 30;

class RagIndex {
  constructor(dsId, dbPath, getSnapshot, embed) {
    this.dsId = dsId;
    this.dbPath = dbPath;
    this.getSnapshot = getSnapshot; // () => { files: [{path, contentHash, ext}] } | null
    this.embed = embed;
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
        const chunks = chunkFile(f.ext || '.md', text);
        store.replaceChunks(f.path, f.contentHash, chunks, kindOf(f.ext), (t) => ftsIndexText(t2s(t)));
        // 立即嵌入该文件全部块（文件级完成粒度）
        this.phase = '嵌入';
        if (chunks.length) {
          const ids = store.db.prepare('SELECT id FROM chunks WHERE path=? ORDER BY ordinal').all(f.path).map((r) => r.id);
          const vecs = await this.embed.embed(chunks.map(embedTextOf));
          store.writeVecs(ids.map((id, i) => ({ id, vec: vecs[i] })));
        }
        store.markFileDone(f.path);
        this.done++;
        this._updatedAt = Date.now();
      }
      this.state = 'ready';
      this.phase = '完成';
      this._updatedAt = Date.now();
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
    this.llm = { enabled: false, baseUrl: 'http://localhost:11434/v1', model: '', apiKey: '' };
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
  async search(dsId, q, limit = 20) {
    const t0 = Date.now();
    const ix = this.index(dsId);
    const store = ix._ensureStore();
    const st = store.stats();
    if (!st.chunks) throw new Error('索引为空（请先构建索引）');
    const qs = t2s(q).toLowerCase().trim();
    if (!qs) return { hits: [], took: 0 };

    // ① FTS5
    const tokens = tokenizeFts(qs);
    const fts = store.searchFts(tokens, TOPN); // [{id, score}] score=bm25（小好）

    // ② 余弦 + 统计阈值（诚实空结果：无关查询的余弦分布无离群点，整体压掉）
    const qv = (await this.embed.embed([qs]))[0];
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
      const cosMin = Math.max(0.25, mean + 2 * std);
      cos = all.filter((x) => x.score >= cosMin).sort((a, b) => b.score - a.score);
    }

    // ③ RRF 融合（bm25 名次升序、cos 名次降序）
    const rrf = new Map();
    fts.forEach((r, i) => {
      const s = 1 / (RRF_K + i + 1);
      rrf.set(r.id, (rrf.get(r.id) || 0) + s);
    });
    cos.slice(0, TOPN).forEach((r, i) => {
      const s = 1 / (RRF_K + i + 1);
      rrf.set(r.id, (rrf.get(r.id) || 0) + s);
    });
    // 只被一路命中的弱结果过滤：融合分 < 阈值（约等于另一路 60 名开外）
    const fused = [...rrf.entries()]
      .map(([id, score]) => ({ id, score: Math.round(score * 1e4) / 1e4 }))
      .filter((x) => x.score >= 0.0105)
      .sort((a, b) => (b.score - a.score) || (a.id - b.id)); // 量化后稳定排序
    const top = fused.slice(0, limit);
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
    return { hits, took: Date.now() - t0, backend: this.embed.backend };
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
