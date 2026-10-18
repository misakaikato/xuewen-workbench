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

  _bump() {
    this._gen++;
    this._vecCache = null;
  }

  /** 与扫描快照对账：返回需要(重)做与需要删除的文件路径 */
  planIncremental(snapshotFiles) {
    // snapshotFiles: [{ path, contentHash }]
    const known = new Map(this.db.prepare('SELECT path, content_hash FROM files').all().map((r) => [r.path, r.content_hash]));
    const toAdd = [];
    for (const f of snapshotFiles) {
      if (known.get(f.path) !== f.contentHash) toAdd.push(f);
    }
    const snapSet = new Set(snapshotFiles.map((f) => f.path));
    const toDel = [...known.keys()].filter((p) => !snapSet.has(p));
    return { toAdd, toDel };
  }

  /** 替换一个文件的全部切块（不含向量；向量由 writeVecs 补） */
  replaceChunks(filePath, contentHash, chunks, kind, textSOf) {
    const txn = this.db.transaction((chs) => {
      this.db.prepare('DELETE FROM vecs WHERE chunk_id IN (SELECT id FROM chunks WHERE path=?)').run(filePath);
      this.db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE path=?)').run(filePath);
      this.db.prepare('DELETE FROM chunks WHERE path=?').run(filePath);
      this.db.prepare('DELETE FROM files WHERE path=?').run(filePath);
      const insChunk = this.db.prepare(
        'INSERT INTO chunks(path, heading_path, ordinal, kind, text, text_s, prefix_hash) VALUES(?,?,?,?,?,?,?)'
      );
      const insFts = this.db.prepare('INSERT INTO chunks_fts(rowid, text_s) VALUES(?,?)');
      chs.forEach((c, i) => {
        const embedText = c.headingPath ? `${c.headingPath}\n\n${c.text}` : c.text;
        const textS = textSOf(embedText);
        const r = insChunk.run(filePath, c.headingPath || '', i, kind, c.text, textS, prefixHash(c.text));
        insFts.run(Number(r.lastInsertRowid), textS);
      });
      this.db.prepare('INSERT INTO files(path, content_hash, chunk_count, done, updated_at) VALUES(?,?,?,1,?)')
        .run(filePath, contentHash, chs.length, Date.now());
    });
    txn(chunks);
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
    } catch {
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
    } catch {
      return [];
    }
  }

  /** 全量向量矩阵（惰性缓存；写操作后失效） */
  vecMatrix() {
    if (this._vecCache && this._vecCache.gen === this._gen) return this._vecCache;
    const rows = this.db.prepare('SELECT chunk_id, vec FROM vecs').all();
    const dim = this.metaGet('dim') ? Number(this.metaGet('dim')) : 0;
    if (!rows.length || !dim) {
      this._vecCache = { gen: this._gen, ids: new Int32Array(0), mat: new Float32Array(0), dim };
      return this._vecCache;
    }
    const ids = new Int32Array(rows.length);
    const mat = new Float32Array(rows.length * dim);
    rows.forEach((r, i) => {
      ids[i] = r.chunk_id;
      mat.set(new Float32Array(r.vec.buffer, r.vec.byteOffset, dim), i * dim);
    });
    this._vecCache = { gen: this._gen, ids, mat, dim };
    return this._vecCache;
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
