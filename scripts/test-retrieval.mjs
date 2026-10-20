// 确定性检索回归：临时库 + 真实 SQLite/切块/FTS/RRF，向量用受控夹具。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-retrieval-'));
process.env.WORKBENCH_DATA_DIR = path.join(tmp, 'data');
process.env.WORKBENCH_RAG_EMBED = 'mock';
const { RagManager } = await import('../server/rag/manager.js');
const { chunkFile } = await import('../server/rag/chunk.js');
const { DIM } = await import('../server/rag/embed.js');
const { Indexer } = await import('../server/indexer.js');
const { findAllRanges, findSearchLocation } = await import('../src/lib/searchLocation.ts');
let checks = 0;
function test(name, fn) { return Promise.resolve(fn()).then(() => { checks++; console.log('PASS', name); }); }
const corpus = path.join(tmp, 'corpus');
fs.cpSync(new URL('../test-data/retrieval', import.meta.url), corpus, { recursive: true });
const files = [];
function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { scan(abs); continue; }
    const p = path.relative(corpus, abs).split(path.sep).join('/');
    const st = fs.statSync(abs), ext = path.extname(p);
    files.push({ path: p, name: e.name, base: path.basename(p, ext), dir: path.posix.dirname(p), ext, mtimeMs: st.mtimeMs, size: st.size });
  }
}
scan(corpus);
const indexer = new Indexer();
indexer.reset('fixture', corpus);
await indexer.build({ files });
const libs = new Map([['fixture', { snapshot: { files }, getText: (p) => indexer.texts.get(p), whenIndexed: () => Promise.resolve() }]]);
const manager = new RagManager({ dataDir: tmp, knowledgeDir: path.join(tmp, 'knowledge'), getLib: (id) => libs.get(id) });
try {
  for (const [q, expected] of [['雪拥蓝关', '关键词.md'], ['苹果 香蕉', '多关键词.md'], ['"学而时习之，不亦说乎。"', '精确短语.md'], ['工艺', '数据表.json'], ['鲸落', '纯文本.txt']]) {
    test('精确 ' + q, () => assert.ok(indexer.search(q).results.some((r) => r.file.path.endsWith(expected))));
  }
  test('类型筛选', () => assert.ok(indexer.search('鲸落', { types: ['.md'] }).total === 0));
  test('目录限定', () => assert.equal(indexer.search('苹果', { dir: '03-类型' }).total, 0));
  test('排除目录', () => assert.equal(indexer.search('苹果', { excludeDirs: ['01-基础'] }).total, 0));
  for (const q of ['', '   ', '*"|"(', '测试'.repeat(500)]) test('边界 ' + q.slice(0, 8), () => assert.ok(Array.isArray(indexer.search(q).results)));
  await manager.build('fixture', { rebuild: true });
  const ix = manager.index('fixture'), store = ix._ensureStore();
  test('文件名必然入索引', () => {
    for (const f of files) {
      const chunks = store.db.prepare('SELECT text_s FROM chunks WHERE path=?').all(f.path);
      const base = f.name.replace(/\.[^.]*$/, '').toLowerCase();
      assert.ok(chunks.some((c) => c.text_s.includes(base.length === 1 ? base : base.slice(0, 2))));
    }
  });
  test('仅文件名词智能召回', async () => {
    const r = await manager.search('fixture', '偃师', 100);
    assert.ok(r.hits.some((h) => h.path.endsWith('仅文件名-偃师常淮.md')));
    const rows = store.db.prepare('SELECT text, text_s FROM chunks WHERE path=?').all('01-基础/仅文件名-偃师常淮.md');
    assert.ok(rows.length > 0);
    assert.ok(rows[0].text.startsWith('仅文件名-偃师常淮.md'));
    assert.ok(rows[0].text_s.includes('偃师'));
  });
  test('格式保留', () => {
    for (const [ext, kind] of [['.md', 'md'], ['.txt', 'txt'], ['.json', 'json']]) {
      assert.ok(store.db.prepare('SELECT 1 FROM chunks WHERE path LIKE ? AND kind=?').get('%' + ext, kind));
    }
    assert.ok(store.db.prepare("SELECT 1 FROM chunks WHERE heading_path LIKE '%第27章%'").get());
  });
  test('JSON 原始片段均可定位（转义、逗号、嵌套、空对象）', () => {
    for (const source of ['{"b": {"x":"a,b \\\""}, "a": [1,2]}', '[{"x":1},{"x":2}]', '{}', '"abc"']) {
      for (const c of chunkFile('.json', source)) assert.ok(findSearchLocation(source, { text: c.text, occurrence: 0 }));
    }
  });
  test('智能文内归一', () => assert.deepEqual(findAllRanges('ＡＢＣ\n１２３ abc123', 'abc123', true), [{ from: 0, to: 7 }, { from: 8, to: 14 }]));
  test('重叠查询不重复计数', () => assert.equal(findAllRanges('aaaa', 'aa', true).length, 2));
  test('重复片段序号', () => assert.deepEqual(findSearchLocation('同段\n同段', { text: '同段', occurrence: 1 }), { from: 3, to: 5 }));
  const original = store.stats().chunks;
  await manager.build('fixture', { rebuild: true });
  test('重建 FTS 不留孤儿', () => assert.equal(store.db.prepare('SELECT count(*) n FROM chunks_fts').get().n, store.stats().chunks));
  test('重复构建不膨胀', () => assert.equal(store.stats().chunks, original));

  // 真实 FTS 候选；向量仅控制相关性，避免以 mock 假装语义质量。
  const vector = (x) => { const v = new Float32Array(DIM); v[0] = x; v[1] = Math.sqrt(1 - x * x); return v; };
  manager.embed.embed = async () => [vector(1)];
  const rows = store.db.prepare('SELECT id,path FROM chunks').all();
  store.writeVecs(rows.map((r) => ({ id: r.id, vec: vector(r.path.includes('双命中') ? .99 : r.path.includes('仅语义') ? .95 : 0) })));
  manager.saveConfig('fixture', { search: { cosFloor: .8, cosSigma: .5, topN: 5, rrfMin: 0 } });
  const ranked = await manager.search('fixture', '梯度下降', 100);
  test('双路结果第一', () => assert.ok(ranked.hits[0].path.includes('双命中') && ranked.hits[0].bm25 && ranked.hits[0].cos > .9));
  test('两路贡献相加', () => assert.equal(ranked.hits[0].score, Math.round((1 / 61 + 1.2 / 61) * 1e4) / 1e4));
  test('单路均可召回', () => { assert.ok(ranked.hits.some((h) => h.path.includes('仅语义') && !h.bm25)); assert.ok(ranked.hits.some((h) => h.path.includes('仅词面') && h.bm25)); });
  manager.saveConfig('fixture', { search: { rrfMin: .05 } });
  const weak = await manager.search('fixture', '梯度下降', 100);
  const small = await manager.search('fixture', '梯度下降', 1);
  test('语义补位与词面补位无重复', () => assert.equal(new Set(weak.hits.map((h) => h.path + ':' + h.ordinal)).size, weak.hits.length));
  test('total 与 limit 无关', () => assert.equal(weak.total, small.total));
  test('计数为唯一块数', () => assert.equal(weak.total, weak.hits.length));
  const again = await manager.search('fixture', '梯度下降', 100);
  test('排序稳定', () => assert.deepEqual(again.hits, weak.hits));
  test('隔离资料库', () => assert.equal(manager.index('other')._ensureStore().stats().chunks, 0));
  const removed = files.pop();
  await manager.build('fixture', {});
  test('增量删除清理块/向量', () => assert.equal(store.db.prepare('SELECT count(*) n FROM chunks WHERE path=?').get(removed.path).n, 0));
  const changed = files.find((f) => f.path.endsWith('关键词.md'));
  changed.mtimeMs += 1000;
  indexer.texts.set(changed.path, '# 更新标题\n\n新增哨兵文字');
  await manager.build('fixture', {});
  test('增量更新替换旧正文', () => {
    const chunks = store.db.prepare('SELECT text FROM chunks WHERE path=?').all(changed.path);
    assert.ok(chunks.some((c) => c.text.includes('新增哨兵')));
    assert.ok(chunks.every((c) => !c.text.includes('雪拥蓝关')));
  });
  console.log(`\n${checks} checks passed; vectors are controlled, semantic quality NOT evaluated.`);
} finally {
  for (const ix of manager.indices.values()) ix.store?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
