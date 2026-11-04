// RAG SQLite 存储：切块 + FTS5（中文 bigram）+ 向量 BLOB，按库隔离（sources/<dsId>/rag.db）。
// 定位为可重建缓存：删除后从原文全量重建，不含只此一份的数据。
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// ---- 中文 bigram 分词（FTS 用；CJK 相邻两字成词，拉丁词保留） ----

export function tokenizeFts(text) {
  const out = [];
  const re = /[\u4e00-\u9fff\u3400-\u4dbf]|[A-Za-z0-9_]+/g;
  const toks = text.toLowerCase().match(re) || [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.length === 1 && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(t)) {
      const next = toks[i + 1];
      if (next && next.length === 1 && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(next)) out.push(t + next);
      else if (!next) out.push(t); // 孤字保留（罕见）
    } else {
      out.push(t);
    }
  }
  return out;
}

export function ftsIndexText(text) {
  return tokenizeFts(text).join(' ');
}

// ---- 存储 ----

// vecMatrix 每页读取的向量数（1024 维 float32 一页约 8MB）
const VEC_PAGE = 2000;

export class RagStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files(
        path TEXT PRIMARY KEY, content_hash TEXT NOT NULL,
        chunk_count INTEGER DEFAULT 0, done INTEGER DEFAULT 1, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS chunks(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL, heading_path TEXT NOT NULL DEFAULT '',
        ordinal INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'md',
        text TEXT NOT NULL, text_s TEXT NOT NULL, prefix_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text_s);
      CREATE TABLE IF NOT EXISTS vecs(
        chunk_id INTEGER PRIMARY KEY, vec BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    `);
    this._vecCache = null; // { gen, ids: Int32Array, mat: Float32Array }
    this._gen = 0;
    this.ftsError = null; // 最近一次 FTS 查询失败（静默降级防线：暴露给 status/界面）
    this.ftsErrorAt = 0;
  }

  /** FTS 查询失败留痕：绝不静默——检索会退化但必须可观测可归因 */
  _ftsFail(msg) {
    this.ftsError = msg;
    this.ftsErrorAt = Date.now();
    console.error('[rag] FTS 查询失败（检索将退化为仅语义路）:', msg);
  }

  close() {
    this.db.close();
  }

  metaGet(key) {
    const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return r ? r.value : null;
  }

  metaSet(key, value) {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
    this._bump();
  }

  metaDel(key) {
    this.db.prepare('DELETE FROM meta WHERE key=?').run(key);
    this._bump();
  }

  _bump() {
    this._gen++;
    this._vecCache = null;
  }

  /** 与扫描快照对账：返回需要(重)做与需要删除的文件路径 */
  planIncremental(snapshotFiles) {
    // snapshotFiles: [{ path, contentHash }]
    const known = new Map(this.db.prepare('SELECT path, content_hash, done FROM files').all().map((r) => [r.path, r]));
    const toAdd = [];
    for (const f of snapshotFiles) {
      const k = known.get(f.path);
      // 内容变化，或上次构建在该文件上中断（done=0，向量未写完）都重做
      if (!k || k.content_hash !== f.contentHash || k.done === 0) toAdd.push(f);
    }
    const snapSet = new Set(snapshotFiles.map((f) => f.path));
    const toDel = [...known.keys()].filter((p) => !snapSet.has(p));
    return { toAdd, toDel };
  }

  /** 替换一个文件的全部切块（不含向量；向量由 writeVecs 补）。
   * textSOf(chunk) 由调用方提供（统一走 chunk.js 的 embedTextOf + t2s + bigram） */
  // 一个文件的块整体替换 = clearFile + appendChunks + finishFile。replaceChunks 在一个事务里做完；
  // 大文件由调用方分批 appendChunks、批间让出事件循环（finishFile 之前该文件没有 files 记录，中断后会整体重切）。
  replaceChunks(filePath, contentHash, chunks, kind, textSOf) {
    this.db.transaction(() => {
      this.clearFile(filePath);
      this.appendChunks(filePath, chunks, 0, kind, textSOf);
      this.finishFile(filePath, contentHash, chunks.length);
    })();
  }

  /** 删除一个文件的全部块、向量与进度记录 */
  clearFile(filePath) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM vecs WHERE chunk_id IN (SELECT id FROM chunks WHERE path=?)').run(filePath);
      this.db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE path=?)').run(filePath);
      this.db.prepare('DELETE FROM chunks WHERE path=?').run(filePath);
      this.db.prepare('DELETE FROM files WHERE path=?').run(filePath);
    })();
    this._bump();
  }

  /** 追加一批块（ordinal 从 startOrdinal 起），textSOf(c) 给出全文检索用的归一化文本 */
  appendChunks(filePath, chunks, startOrdinal, kind, textSOf) {
    const insChunk = this.db.prepare(
      'INSERT INTO chunks(path, heading_path, ordinal, kind, text, text_s, prefix_hash) VALUES(?,?,?,?,?,?,?)'
    );
    const insFts = this.db.prepare('INSERT INTO chunks_fts(rowid, text_s) VALUES(?,?)');
    this.db.transaction(() => {
      chunks.forEach((c, i) => {
        const textS = textSOf(c);
        const r = insChunk.run(filePath, c.headingPath || '', startOrdinal + i, kind, c.text, textS, prefixHash(c.text));
        insFts.run(Number(r.lastInsertRowid), textS);
      });
    })();
    this._bump();
  }

  /** 登记文件的块已写全：向量由 writeVecs 补完后经 markFileDone 置 done=1；无块（空文本）直接完成 */
  finishFile(filePath, contentHash, chunkCount) {
    this.db.prepare('INSERT INTO files(path, content_hash, chunk_count, done, updated_at) VALUES(?,?,?,?,?)')
      .run(filePath, contentHash, chunkCount, chunkCount ? 0 : 1, Date.now());
    this._bump();
  }

  /** 标记文件「切块完成但向量未完成」（续建进度位） */
  markPending(filePath, contentHash, chunkCount) {
    this.db.prepare('INSERT INTO files(path, content_hash, chunk_count, done, updated_at) VALUES(?,?,?,0,?) ON CONFLICT(path) DO UPDATE SET content_hash=excluded.content_hash, chunk_count=excluded.chunk_count, done=0')
      .run(filePath, contentHash, chunkCount, Date.now());
    this._bump();
  }

  pendingChunkIds(limit) {
    return this.db.prepare(
      `SELECT c.id FROM chunks c JOIN files f ON f.path=c.path AND f.done=0 LIMIT ?`
    ).all(limit).map((r) => r.id);
  }

  chunkTexts(ids) {
    const stmt = this.db.prepare('SELECT id, text, heading_path, text_s FROM chunks WHERE id=?');
    return ids.map((id) => stmt.get(id));
  }

  writeVecs(pairs) {
    // pairs: [{ id, vec: Float32Array }]
    const txn = this.db.transaction((ps) => {
      const ins = this.db.prepare('INSERT INTO vecs(chunk_id, vec) VALUES(?,?) ON CONFLICT(chunk_id) DO UPDATE SET vec=excluded.vec');
      for (const p of ps) ins.run(p.id, Buffer.from(p.vec.buffer, p.vec.byteOffset, p.vec.byteLength));
    });
    txn(pairs);
    this._bump();
  }

  markFileDone(path) {
    this.db.prepare('UPDATE files SET done=1 WHERE path=?').run(path);
    this._bump();
  }

  deleteFiles(paths) {
    const txn = this.db.transaction((ps) => {
      const delV = this.db.prepare('DELETE FROM vecs WHERE chunk_id IN (SELECT id FROM chunks WHERE path=?)');
      const delFts = this.db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE path=?)');
      const delC = this.db.prepare('DELETE FROM chunks WHERE path=?');
      const delF = this.db.prepare('DELETE FROM files WHERE path=?');
      for (const p of ps) {
        delV.run(p);
        delFts.run(p);
        delC.run(p);
        delF.run(p);
      }
    });
    txn(paths);
    this._bump();
  }

  /** 分批清空全部索引表：批间让出事件循环（不阻塞进度轮询），onBatch 上报进度。
   * 中断后续建靠调用方的「清理中」标记（meta clearing），删除幂等，重跑不会新旧混杂 */
  async clearBatched({ batch = 2000, onBatch } = {}) {
    const total = this.db.prepare(
      'SELECT (SELECT COUNT(*) FROM vecs) + (SELECT COUNT(*) FROM chunks_fts) + (SELECT COUNT(*) FROM chunks) + (SELECT COUNT(*) FROM files) AS n'
    ).get().n;
    let done = 0;
    const steps = [
      'DELETE FROM vecs WHERE chunk_id IN (SELECT chunk_id FROM vecs LIMIT ?)',
      'DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks_fts LIMIT ?)',
      'DELETE FROM chunks WHERE id IN (SELECT id FROM chunks LIMIT ?)',
      'DELETE FROM files WHERE path IN (SELECT path FROM files LIMIT ?)',
    ];
    for (const sql of steps) {
      const stmt = this.db.prepare(sql);
      for (;;) {
        const r = stmt.run(batch);
        done += r.changes;
        if (onBatch) onBatch(Math.min(done, total), total);
        if (r.changes < batch) break;
        await new Promise((resolve) => setImmediate(resolve)); // 批间让出，进度轮询可插入
      }
    }
    this._bump();
  }

  stats() {
    const f = this.db.prepare('SELECT COUNT(*) n, COALESCE(SUM(done),0) done FROM files').get();
    const c = this.db.prepare('SELECT COUNT(*) n FROM chunks').get();
    const v = this.db.prepare('SELECT COUNT(*) n FROM vecs').get();
    return { files: f.n, filesDone: f.done, chunks: c.n, vecs: v.n };
  }

  /** FTS5 BM25 检索（OR 组合，返回 chunkId + bm25 分） */
  searchFts(queryTokens, limit) {
    if (!queryTokens.length) return [];
    const q = queryTokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    try {
      return this.db.prepare(
        `SELECT f.rowid AS id, bm25(chunks_fts) AS score FROM chunks_fts f WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?`
      ).all(q, limit);
    } catch (e) {
      this._ftsFail(String(e.message || e));
      return [];
    }
  }

  /** FTS 按文件配额：每个文件取 BM25 最优的 perFile 块（窗口函数），
   * 供智能检索的字面补位做文件轮转——覆盖全部命中文件不受候选池截断 */
  searchFtsByFile(queryTokens, perFile = 3) {
    if (!queryTokens.length) return [];
    const q = queryTokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    try {
      // bm25() 不能直接进窗口 ORDER BY（FTS5 辅助函数上下文限制）——先投影成普通列再开窗
      return this.db
        .prepare(
          `SELECT id, path, rnk FROM (
             SELECT id, path, s, ROW_NUMBER() OVER (PARTITION BY path ORDER BY s, id) AS rnk FROM (
               SELECT c.id AS id, c.path AS path, bm25(chunks_fts) AS s
               FROM chunks_fts f JOIN chunks c ON c.id = f.rowid
               WHERE chunks_fts MATCH ?
             )
           ) WHERE rnk <= ? ORDER BY rnk, s, id`
        )
        .all(q, perFile);
    } catch (e) {
      this._ftsFail(String(e.message || e));
      return [];
    }
  }

  /**
   * 全量向量矩阵（惰性缓存；写操作后失效）。按 chunk_id 分页读取、页间让出事件循环（向量多时一次读完会卡住后端）；
   * 读取期间若有写入（构建中检索），本次返回读到的那一刻的内容，缓存记的是开始时的代际，下次检索重读。
   */
  async vecMatrix() {
    if (this._vecCache && this._vecCache.gen === this._gen) return this._vecCache;
    const gen = this._gen;
    const dim = this.metaGet('dim') ? Number(this.metaGet('dim')) : 0;
    const page = this.db.prepare('SELECT chunk_id, vec FROM vecs WHERE chunk_id > ? ORDER BY chunk_id LIMIT ?');
    const idParts = [];
    const matParts = [];
    let total = 0;
    let last = -1;
    if (dim) {
      for (;;) {
        const rows = page.all(last, VEC_PAGE);
        if (!rows.length) break;
        const ids = new Int32Array(rows.length);
        const mat = new Float32Array(rows.length * dim);
        rows.forEach((r, i) => {
          ids[i] = r.chunk_id;
          mat.set(new Float32Array(r.vec.buffer, r.vec.byteOffset, dim), i * dim);
        });
        idParts.push(ids);
        matParts.push(mat);
        total += rows.length;
        last = rows[rows.length - 1].chunk_id;
        await new Promise((r) => setImmediate(r));
      }
    }
    const ids = new Int32Array(total);
    const mat = new Float32Array(total * dim);
    for (let i = 0, off = 0; i < idParts.length; off += idParts[i].length, i++) {
      ids.set(idParts[i], off);
      mat.set(matParts[i], off * dim);
    }
    const out = { gen, ids, mat, dim };
    if (this._gen === gen) this._vecCache = out;
    return out;
  }

  getChunksByIds(ids) {
    const out = new Map();
    const stmt = this.db.prepare('SELECT id, path, heading_path, ordinal, kind, text FROM chunks WHERE id=?');
    for (const id of ids) {
      const r = stmt.get(id);
      if (r) out.set(id, r);
    }
    return out;
  }
}

// 块首 32 字符的稳定指纹（结果卡定位/锚点用）
function prefixHash(text) {
  const s = text.replace(/\s+/g, ' ').trim().slice(0, 48);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
