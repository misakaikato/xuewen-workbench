// RAG 管理器：嵌入服务（全局共享）+ 按库索引生命周期 + 混合检索。
// 索引构建：文件级进度位（files.done），可暂停/续建；扫描完成后对已有索引自动增量。
// 检索：t2s 归一 → FTS5 BM25 + 向量余弦各取 topN → RRF 融合 → 1e-4 量化稳定排序。
import fs from 'node:fs';
import path from 'node:path';
import { RagStore, tokenizeFts, ftsIndexText } from './store.js';
import { chunkFile, embedTextOf } from './chunk.js';
// embedTextOf 统一拼装 [文件名\n标题路径\n\n正文]，FTS 与向量共用
import { EmbedService, t2s, DIM } from './embed.js';
import { loadRagConfig, saveRagConfig, mergeRagConfig, indexConfigFingerprint, DEFAULT_RAG_CONFIG } from './config.js';
import { readJson, writeJsonAtomic } from '../store.js';
import { setActivity } from '../lagWatch.js';

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
    this.state = 'none'; // none | building | pausing | paused | ready | error | stale
    this.phase = ''; // 等待文本索引 | 清理旧索引 | 切块 | 嵌入 | 加载模型 | 完成
    this.done = 0;
    this.total = 0;
    this.error = null;
    this.currentFile = null;
    this.fileChunksDone = 0;
    this.fileChunksTotal = 0;
    this.chunksPerSec = null;
    this.etaSeconds = null;
    this.clearing = null; // { done, total } 清库分批进度
    this._pauseFlag = false;
    this._buildSeq = 0;
    this._chunksDone = 0; // 本次构建已嵌入的块数（速度/剩余时间用）
    this._embedT0 = 0;
    this._clearBatchHook = null; // 测试钩子：清库每批后回调（可抛错模拟中断）
    // 构建期间收到 onScanComplete 时置位：当前构建结束后立即再跑一次增量
    this.pendingRescan = false;
  }

  _ensureStore() {
    if (!this.store) {
      this.store = new RagStore(this.dbPath);
      this.store.metaSet('dim', String(DIM));
    }
    return this.store;
  }

  /** 进行中的构建（全局 /api/status 每秒带一次，只读内存不碰库）；空闲为 null */
  task() {
    return this.state === 'building' || this.state === 'pausing'
      ? { state: this.state, phase: this.phase, done: this.done, total: this.total }
      : null;
  }

  status() {
    const store = this._ensureStore();
    const st = store.stats();
    // 切块/嵌入参数与建库时不同 → 提示重建
    let configChanged = false;
    try {
      // 已建库用 index_cfg；首次构建中途（还没有 index_cfg）用构建中指纹 building_cfg
      const builtCfg = store.metaGet('index_cfg') || store.metaGet('building_cfg');
      configChanged = !!builtCfg && builtCfg !== indexConfigFingerprint(this.cfg);
    } catch { /* 忽略 */ }
    // 重启恢复：用户暂停过的索引仍显示暂停（自动续建也不会启动）
    if (this.state === 'none' && this._pausedByUser()) this.state = 'paused';
    // 重启恢复：库里有完成的文件且与当前快照完全对账一致才是就绪；
    // 有文件但有待加/待删则视为 stale（前端显示「待更新」）
    if (this.state === 'none' && st.files > 0) {
      const snap = this.getSnapshot();
      const plan = store.planIncremental((snap?.files || []).map((f) => ({ ...f, contentHash: f.mtimeMs + ':' + f.size })));
      if (st.filesDone === st.files && plan.toAdd.length === 0 && plan.toDel.length === 0) {
        this.state = 'ready';
      } else {
        this.state = 'stale';
      }
    }
    let dbBytes = 0;
    try {
      dbBytes = fs.statSync(this.dbPath).size;
    } catch { /* 无库文件 */ }
    return {
      state: this.state,
      phase: this.phase,
      done: this.done,
      total: this.total,
      currentFile: this.currentFile,
      fileChunksDone: this.fileChunksDone,
      fileChunksTotal: this.fileChunksTotal,
      chunksPerSec: this.chunksPerSec,
      etaSeconds: this.etaSeconds,
      clearing: this.clearing ? { ...this.clearing } : null,
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

  /** 构建前置检查（同步）：检查通过即切 building（状态先于第一个 await），供路由提前返回 409 */
  begin() {
    if (this.state === 'building' || this.state === 'pausing') return { ok: true, already: true };
    const snap = this.getSnapshot();
    if (!snap || !snap.files || !snap.files.length) {
      this.state = 'error';
      this.error = '资料库尚未扫描完成';
      return { ok: false, error: this.error };
    }
    this._pauseFlag = false;
    this.state = 'building';
    this.phase = '等待文本索引';
    this.error = null;
    this.clearing = null;
    return { ok: true };
  }

  /** 全量/增量构建；rebuild=true 清库重来。幂等：构建中忽略重复请求。begin() 已通过时可直接 _runBuild */
  async build({ rebuild = false } = {}) {
    const pre = this.begin();
    if (!pre.ok || pre.already) return pre;
    return this._runBuild({ rebuild });
  }

  _pauseNow(seq) {
    if (seq !== this._buildSeq) return { ok: true, superseded: true };
    this.state = 'paused';
    this.phase = '';
    console.log('[rag] 索引构建暂停: 已完成 ' + this.done + ' 个文件');
    return { ok: true, paused: true };
  }

  async _runBuild({ rebuild = false } = {}) {
    const store = this._ensureStore();
    const seq = ++this._buildSeq;
    const t0 = Date.now();
    try {
      if (this.whenIndexed) {
        this.phase = '等待文本索引';
        await this.whenIndexed(); // 等文本索引就绪（切块要从 indexer.texts 拿正文）
        if (this._pauseFlag) return this._pauseNow(seq); // 等待期间点了暂停：直接停在 paused
      }
      // 清库分批：先写「清理中」标记，清完写新指纹——中断后续建先清余量，不会新旧混杂、不会重复清已清的库
      // 首次构建没有 index_cfg：先记「构建中指纹」，中断后改了参数再续建时同样先清库
      const fp = indexConfigFingerprint(this.cfg);
      const cfgOld = store.metaGet('index_cfg') || store.metaGet('building_cfg');
      if (rebuild || store.metaGet('clearing') === '1' || (cfgOld && cfgOld !== fp)) {
        this.phase = '清理旧索引';
        store.metaSet('clearing', '1');
        await store.clearBatched({
          batch: 2000,
          onBatch: (done, total) => {
            this.clearing = { done, total };
            if (this._clearBatchHook) this._clearBatchHook(done, total);
          },
        });
        store.metaSet('index_cfg', fp);
        store.metaDel('building_cfg');
        store.metaSet('clearing', '0');
        this.clearing = null;
      } else if (!store.metaGet('index_cfg')) {
        store.metaSet('building_cfg', fp);
      }
      const plan = store.planIncremental(this.getSnapshot().files.map((f) => ({ ...f, contentHash: f.mtimeMs + ':' + f.size })));
      if (plan.toDel.length) store.deleteFiles(plan.toDel);
      const todo = plan.toAdd;
      this.total = todo.length;
      this.done = 0;
      this.currentFile = null;
      this.fileChunksDone = 0;
      this.fileChunksTotal = 0;
      this.chunksPerSec = null;
      this.etaSeconds = null;
      this._chunksDone = 0;
      this._embedT0 = Date.now();
      this.phase = '切块';
      console.log('[rag] 索引构建开始: ' + todo.length + ' 个文件');
      for (const f of todo) {
        if (seq !== this._buildSeq) return { ok: true, superseded: true };
        if (this._pauseFlag) return this._pauseNow(seq);
        const restoreActivity = setActivity('RAG 切块/嵌入 ' + f.path);
        try {
          this.currentFile = f.path;
          this.fileChunksDone = 0;
          this.fileChunksTotal = 0;
          this.phase = '切块';
          const text = this.getText(f.path);
          if (text == null) {
            // 扫描快照里没有正文缓存时记录为空完成（词表文件等极端情况）
            store.replaceChunks(f.path, f.contentHash, [], f.ext?.slice(1) || 'md', () => '');
            this.done++;
            this._tickEta();
            continue;
          }
          const chunks = chunkFile(f.ext || '.md', text, this.cfg.chunk);
          if (chunks.length) chunks[0] = { ...chunks[0], text: f.name + '\n\n' + chunks[0].text }; // 文件名进入正文索引与定位
          const eOpts = { headingContext: this.cfg.chunk.headingContext, fileName: this.cfg.chunk.fileNameContext ? f.name : '' };
          store.replaceChunks(f.path, f.contentHash, chunks, kindOf(f.ext), (c) => ftsIndexText(t2s(embedTextOf(c, eOpts))));
          // 立即嵌入该文件全部块（文件级完成粒度；分批上报块级进度）
          this.fileChunksTotal = chunks.length;
          this.fileChunksDone = 0;
          if (chunks.length) {
            const ids = store.db.prepare('SELECT id FROM chunks WHERE path=? ORDER BY ordinal').all(f.path).map((r) => r.id);
            const tEmb = Date.now();
            const BATCH = 32;
            for (let i = 0; i < chunks.length; i += BATCH) {
              if (this._pauseFlag) return this._pauseNow(seq); // 批间响应暂停
              if (this.embed.runtime.state !== 'ready') this.phase = '加载模型'; // 嵌入运行时未就绪：首次加载可能数十秒
              const vecs = await this.embed.embed(chunks.slice(i, i + BATCH).map((c) => embedTextOf(c, eOpts)), { maxLength: this.cfg.embed.maxLength });
              this.phase = '嵌入';
              store.writeVecs(ids.slice(i, i + BATCH).map((id, j) => ({ id, vec: vecs[j] })));
              this.fileChunksDone = Math.min(chunks.length, i + BATCH);
              this._chunksDone += vecs.length;
            }
            const embMs = Date.now() - tEmb;
            if (embMs >= 2000) console.warn('[rag] 单文件嵌入慢: ' + f.path + '，' + chunks.length + ' 段，耗时 ' + embMs + 'ms');
          }
          store.markFileDone(f.path);
          this.done++;
          this._updatedAt = Date.now();
          this._tickEta();
        } finally {
          restoreActivity();
        }
      }
      this.state = 'ready';
      this.phase = '完成';
      this.currentFile = null;
      this._updatedAt = Date.now();
      store.metaSet('index_cfg', fp); // 重建提示指纹：本次切块所用参数
      store.metaDel('building_cfg');
      store.metaDel('paused'); // 暂停请求落在最后一个文件之后：已建完，不再算暂停
      console.log('[rag] 索引构建完成: ' + this.done + ' 个文件，耗时 ' + (Date.now() - t0) + 'ms');
      return { ok: true };
    } catch (e) {
      this.state = 'error';
      this.error = String(e.message || e);
      console.error('[rag] 索引构建失败: ' + this.error);
      return { ok: false, error: this.error };
    } finally {
      // 构建期间扫描完成：结束后立即再跑一次增量（暂停则不续，等用户手动继续）
      if (this.pendingRescan && this.state !== 'paused' && !this._pausedByUser()) {
        this.pendingRescan = false;
        this.build({}).catch((e2) => console.error('[rag] 增量续建失败: ' + (e2?.message || e2)));
      }
    }
  }

  /** 速度与剩余时间：按已嵌入块数与耗时估算，剩余量按文件折算 */
  _tickEta() {
    const el = (Date.now() - this._embedT0) / 1000;
    if (this._chunksDone > 0 && el > 0) {
      this.chunksPerSec = Math.round(this._chunksDone / el);
      if (this.done > 0 && this.done < this.total) {
        this.etaSeconds = Math.round(((this.total - this.done) * (el / this.done)));
      } else if (this.done >= this.total) {
        this.etaSeconds = 0;
      }
    }
  }

  pause() {
    if (this.state === 'building' || this.state === 'pausing') {
      this._pauseFlag = true;
      this.state = 'pausing'; // 循环真正停下前给前端可见的过渡态
      // 暂停持久化：重启后仍是暂停，启动与扫描后的自动续建都不启动
      try {
        this._ensureStore().metaSet('paused', '1');
      } catch (e) {
        console.warn('[rag] 记录暂停状态失败: ' + (e?.message || e));
      }
      return { ok: true };
    }
    return { ok: false, error: '未在构建' };
  }

  _pausedByUser() {
    try {
      return this._ensureStore().metaGet('paused') === '1';
    } catch {
      return false;
    }
  }

  /** 用户主动开始构建：撤销持久化的暂停 */
  clearPaused() {
    this._ensureStore().metaDel('paused');
  }

  /** 自动续建（启动、扫描完成后）：用户暂停过的不续建、状态保持 paused；从未建过（库里无文件）的不自动建 */
  autoBuild() {
    if (this.state === 'paused') return;
    if (this._pausedByUser()) {
      if (this.state === 'none' || this.state === 'stale' || this.state === 'ready') this.state = 'paused';
      return;
    }
    if (this._ensureStore().stats().files > 0) {
      this.build({}).catch((e) => console.error('[rag] 自动续建失败: ' + (e?.message || e)));
    }
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
  constructor({ dataDir, knowledgeDir, getLib }) {
    this.dataDir = dataDir;
    this.knowledgeDir = knowledgeDir;
    this.getLib = getLib; // (dsId) => { snapshot, getText(relPath) } | null
    this.embed = new EmbedService(dataDir);
    this.indices = new Map(); // dsId -> RagIndex
    this.llm = {
      enabled: false, baseUrl: 'http://localhost:11434/v1', model: '', apiKey: '', thinkingLevel: 'off', mode: 'confirm',
      // 持久化：生成端点配置与助手运行模式是全局设置（跨资料库），重启后必须恢复
      ...readJson(path.join(dataDir, 'llm-settings.json'), {}),
    };
    this.onLlmChanged = null; // 由 agent 模块挂接：端点变化时同步 models.json
  }

  /** 更新并持久化生成端点配置（含 agent 侧 thinkingLevel 与运行模式） */
  setLlm(patch) {
    for (const k of ['enabled', 'baseUrl', 'model', 'apiKey', 'thinkingLevel', 'mode']) {
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
      const ix2 = new RagIndex(dsId, path.join(this.knowledgeDir, dsId, 'rag.db'), () => this.getLib(dsId)?.snapshot || null, this.embed);
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

  /** 某库进行中的构建；该库的索引还没建立过对象时直接返回 null，不为此打开数据库 */
  indexTask(dsId) {
    return this.indices.get(dsId)?.task() ?? null;
  }

  status(dsId) {
    return { model: this.embed.status(), index: this.index(dsId).status(), llm: { ...this.llm, apiKey: undefined } };
  }

  /** 用户发起的构建（助手工具）：前置检查通过后撤销持久化的暂停 */
  async build(dsId, { rebuild = false } = {}) {
    const ix = this.index(dsId);
    const pre = ix.begin();
    if (!pre.ok || pre.already) return pre;
    ix.clearPaused();
    return ix._runBuild({ rebuild });
  }

  /** 路由用：前置检查（begin）已由调用方完成，这里撤销持久化的暂停并启动后台构建 */
  startBuild(dsId, rebuild) {
    const ix = this.index(dsId);
    ix.clearPaused();
    return ix._runBuild({ rebuild });
  }

  /** 保存检索参数；构建进行中改切块/嵌入参数会让新旧切块混在一个索引里，返回 409 */
  saveConfig(dsId, patch) {
    const ix = this.index(dsId);
    if (ix.state === 'building' || ix.state === 'pausing') {
      if (indexConfigFingerprint(mergeRagConfig(ix.cfg, patch)) !== indexConfigFingerprint(ix.cfg)) {
        throw Object.assign(new Error('构建进行中，暂停或完成后再修改'), { status: 409 });
      }
    }
    const next = saveRagConfig(dsId, patch);
    ix.cfg = next;
    return next;
  }

  pause(dsId) {
    return this.index(dsId).pause();
  }

  /** 扫描完成钩子：已有索引（files>0）则自动增量；从未建过不自动 */
  onScanComplete(dsId) {
    const ix = this.indices.get(dsId);
    if (!ix) return;
    if (ix.state === 'building') {
      ix.pendingRescan = true; // 构建中：记一笔，结束后由 build 续跑增量
      return;
    }
    try {
      ix.autoBuild(); // 后台增量，不阻塞扫描
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
    // 语义保底：cos 已过统计阈值但融合分不足（单路弱命中）的结果不静默丢弃——
    // 词面为零而语义相关的查询（用户最常感知到的“有相近内容却 0 结果”）走这里。
    const weakCos = cos
      .filter((r) => !fusedIds.has(r.id))
      .map((r) => ({ id: r.id, score: Math.round((cfg.search.semanticWeight ?? 1) / (rrfK + cfg.search.topN + 1) * 1e4) / 1e4 }));
    // 补位池：每文件 BM25 最优 3 块（SQL 窗口函数保证文件多样性），轮转排序——
    // 第一轮所有命中文件各出一块，第二轮再各出一块……大文件不霸榜，覆盖完备
    const weakCosIds = new Set(weakCos.map((r) => r.id));
    const lexicalByFile = store.searchFtsByFile(tokens, 3);
    const byFile = lexicalByFile.filter((r) => !fusedIds.has(r.id) && !weakCosIds.has(r.id));
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
    const total = fused.length + filler.length + weakCos.length;
    const top = [...fused, ...weakCos, ...filler].slice(0, limit);
    const chunks = store.getChunksByIds(top.map((x) => x.id));
    const bm25Ids = new Set([...fts, ...lexicalByFile].map((r) => r.id));
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
          // 定位使用索引里的原文片段，不能使用可能不在正文中的语义查询词。
          location: {
            text: c.text.slice(0, 160),
            occurrence: store.db.prepare('SELECT text FROM chunks WHERE path=? AND ordinal<? ORDER BY ordinal')
              .all(c.path, c.ordinal)
              .reduce((n, row) => n + row.text.replace(/\s/g, '').split(c.text.slice(0, 160).replace(/\s/g, '')).length - 1, 0),
          },
          score: x.score,
          bm25: bm25Ids.has(c.id),
          cos: cosIds.has(c.id) ? Math.round(cosIds.get(c.id) * 1e4) / 1e4 : null,
        };
      })
      .filter(Boolean);
    return {
      hits, total, took: Date.now() - t0, backend: this.embed.backend,
      candidates: { fts: fts.length, cos: cos.length, fused: fused.length },
      reason: hits.length ? null : (st.chunks ? 'no_match' : 'index_empty'),
    };
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
