// 字义库后端（specs/2026-11-04-ziyi.md 验收 1）：临时 WORKBENCH_DATA_DIR 下拉起后端，字义包全部运行时合成。
// 断言：未安装状态；导入解析（嵌套目录、_ 开头、__MACOSX、坏 json、缺释义、重复字）；检索排序 / AND / 繁简；
// lookup 去重与跳过标点；新建 / 更新 / exists / conflict / 删除；保留与不保留本地修改；备份最多 5 份；
// 导出再导入一致；无效包 400 且数据不变；entries.json 损坏被保留；3000 条 × 4KB 检索耗时。
// 运行：node scripts/test-ziyi.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { makeTmpDir, atExit } from './tmpdirs.mjs';
import { writeZip } from '../server/zip.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = makeTmpDir('wb-ziyi-');
const dataDir = path.join(tmp, 'data');
const exportDir = path.join(tmp, 'desktop');
fs.mkdirSync(dataDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const check = (name, ok, detail) => {
  assert.ok(ok, name + (detail === undefined ? '' : ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
  console.log('PASS', name);
  passed++;
};

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

let server = null;
let base = '';
async function startServer() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1', WORKBENCH_DATA_DIR: dataDir, WORKBENCH_DESKTOP_DIR: exportDir, WORKBENCH_RAG_EMBED: 'mock' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(base + '/api/ziyi/status')).ok) return;
    } catch { /* 还没起来 */ }
    if (i > 200) throw new Error('后端启动超时');
    await sleep(50);
  }
}
async function stopServer() {
  const s = server;
  server = null;
  if (!s) return;
  const gone = new Promise((r) => s.once('exit', r));
  s.kill('SIGKILL');
  await gone;
}
atExit(() => server?.kill('SIGKILL'));

const call = async (method, url, body) => {
  const isBuf = Buffer.isBuffer(body);
  const r = await fetch(base + url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': isBuf ? 'application/zip' : 'application/json' },
    body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json };
};

const entryFile = (han, meaning, source = '') => JSON.stringify({ han, unicode: 'FFFF', meaning, source }, null, 2);
function makeZip(name, files) {
  const file = path.join(tmp, name);
  writeZip(file, files.map(([n, d]) => ({ name: n, data: d })));
  return fs.readFileSync(file);
}

// ---------- 合成字义包（不含任何真实字义） ----------
const PACK = makeZip('pack1.zip', [
  ['annotations/甲.json', entryFile('甲', '测试释义：甲字条目，屈曲一次。', '测试出处甲')],
  ['annotations/乙.json', entryFile('乙', '测试释义：乙字条目，屈曲屈曲屈曲，再屈曲。', '测试出处乙')],
  ['annotations/丙.json', entryFile('丙', '测试释义：丙字条目，与甲相关。', '测试出处丙，屈曲见此')],
  ['annotations/sub/丁.json', entryFile('丁', '测试释义：丁字条目，屈曲两次屈曲。', '')],
  ['annotations/枣.json', entryFile('枣', '测试释义：枣字条目，繁体作棗。', '测试出处枣')],
  ['annotations/曲.json', entryFile('曲', '测试释义：曲字条目。', '')],
  ['annotations/dup/甲.json', entryFile('甲', '测试释义：甲字条目（重复，后者为准），屈曲一次。', '测试出处甲2')],
  ['annotations/_batches.json', JSON.stringify({ batch0: [] })],
  ['__MACOSX/annotations/._乙.json', 'xx'],
  ['annotations/坏.json', '{ not json'],
  ['annotations/缺释义.json', JSON.stringify({ han: '戊' })],
  ['annotations/readme.txt', 'ignore me'],
]);

await startServer();

// ---------- 未安装 ----------
{
  const s = await call('GET', '/api/ziyi/status');
  check('未安装 status', s.json.installed === false && s.json.count === 0, s.json);
  check('未安装 search 空结果', (await call('GET', '/api/ziyi/search?q=甲')).json.total === 0);
  check('未安装 entry 404', (await call('GET', '/api/ziyi/entry?han=甲')).status === 404);
  const lk = await call('GET', '/api/ziyi/lookup?text=甲乙');
  check('未安装 lookup 全为 null', lk.json.items.length === 2 && lk.json.items.every((x) => x.entry === null), lk.json);
  check('未安装 export 409', (await call('POST', '/api/ziyi/export', { reveal: false })).status === 409);
}

// ---------- 无效包 ----------
check('非 zip 400', (await call('POST', '/api/ziyi/import', Buffer.from('hello'))).status === 400);
{
  const r = await call('POST', '/api/ziyi/import', makeZip('empty.zip', [['a/_x.json', '{}'], ['a/b.json', '{bad']]));
  check('0 条有效 400', r.status === 400, r);
  check('0 条有效后仍未安装', (await call('GET', '/api/ziyi/status')).json.installed === false);
}

// ---------- 导入 ----------
{
  const r = await call('POST', '/api/ziyi/import?name=pack1.zip', PACK);
  check('导入成功', r.status === 200 && r.json.ok, r);
  check('导入计数', r.json.count === 6 && r.json.added === 6 && r.json.updated === 0 && r.json.removed === 0, r.json);
  check('无效文件计数（坏 json、缺释义）', r.json.invalidCount === 2 && r.json.invalid.length === 2, r.json.invalid);
  check('重复字计数', r.json.duplicates === 1, r.json);
  check('首次导入无备份', r.json.backup === null);
  const s = (await call('GET', '/api/ziyi/status')).json;
  check('status 已安装', s.installed && s.count === 6 && s.editedCount === 0 && s.sourceName === 'pack1.zip' && !!s.importedAt, s);
  const e = (await call('GET', '/api/ziyi/entry?han=甲')).json;
  check('重复字以后出现者为准', e.entry.source === '测试出处甲2', e);
  check('unicode 由字计算', e.entry.unicode === '7532', e.entry);
}

// ---------- 检索 ----------
{
  const all = (await call('GET', '/api/ziyi/search?q=')).json;
  check('空查询列全部按码点', all.total === 6 && all.items.map((x) => x.han).join('') === '丁丙乙曲枣甲', all.items.map((x) => x.han));
  const r = (await call('GET', '/api/ziyi/search?q=屈曲')).json;
  const order = r.items.map((x) => x.han).join('');
  // 乙(4 次) 丁(2) 甲(1)：释义命中次数降序；丙：只在出处命中；曲：字头不含整个查询词，不命中
  check('检索排序', order === '乙丁甲丙', order);
  const head = (await call('GET', '/api/ziyi/search?q=' + encodeURIComponent('曲 测试'))).json;
  check('多词时字头含其一排在释义命中之前', head.items[0]?.han === '曲' && head.items[0].field === 'han', head.items.map((x) => x.han));
  check('只在出处命中 field=source', r.items.find((x) => x.han === '丙').field === 'source');
  check('释义命中 field=meaning 且片段含词', r.items.find((x) => x.han === '乙').field === 'meaning' && r.items.find((x) => x.han === '乙').snippet.includes('屈曲'));
  const exact = (await call('GET', '/api/ziyi/search?q=甲')).json;
  check('字头精确命中排第一', exact.items[0].han === '甲' && exact.items[0].field === 'han', exact.items);
  const and = (await call('GET', '/api/ziyi/search?q=' + encodeURIComponent('屈曲 两次'))).json;
  check('多词 AND', and.total === 1 && and.items[0].han === '丁', and);
  const t2s = (await call('GET', '/api/ziyi/search?q=棗')).json;
  check('繁简：检索棗命中枣', t2s.items[0]?.han === '枣', t2s);
  const page = (await call('GET', '/api/ziyi/search?q=&offset=2&limit=2')).json;
  check('分页', page.total === 6 && page.items.map((x) => x.han).join('') === '乙曲', page);
}

// ---------- 查询与 lookup ----------
{
  const e = await call('GET', '/api/ziyi/entry?han=' + encodeURIComponent('棗'));
  check('entry 繁简回退', e.status === 200 && e.json.entry.han === '枣' && e.json.resolvedFrom === '棗', e.json);
  const lk = (await call('GET', '/api/ziyi/lookup?text=' + encodeURIComponent('甲，甲 a乙！棗无'))).json.items;
  check('lookup 去重、跳过标点与拉丁', lk.map((x) => x.char).join('') === '甲乙棗无', lk.map((x) => x.char));
  check('lookup 命中与 resolvedFrom', lk[0].entry.han === '甲' && lk[2].entry.han === '枣' && lk[2].resolvedFrom === '棗' && lk[3].entry === null, lk);
  const many = (await call('GET', '/api/ziyi/lookup?text=' + encodeURIComponent('一二三四五六七八九十百千万亿'))).json.items;
  check('lookup 最多 12 个', many.length === 12);
}

// ---------- 编辑 ----------
let yiEditedAt;
{
  const c = await call('PUT', '/api/ziyi/entry', { han: '戊', meaning: '本地新建：戊。', source: '自拟', create: true });
  check('新建', c.status === 200 && c.json.entry.han === '戊' && !!c.json.entry.editedAt, c);
  check('新建已存在 409 exists', (await call('PUT', '/api/ziyi/entry', { han: '甲', meaning: 'x', create: true })).json?.code === 'exists');
  check('更新不存在 404', (await call('PUT', '/api/ziyi/entry', { han: '己', meaning: 'x' })).status === 404);
  check('空释义 400', (await call('PUT', '/api/ziyi/entry', { han: '甲', meaning: '  ' })).status === 400);
  check('字头含空白 400', (await call('PUT', '/api/ziyi/entry', { han: '甲 乙', meaning: 'x', create: true })).status === 400);
  const u = await call('PUT', '/api/ziyi/entry', { han: '乙', meaning: '本地修改：乙。', source: '改过', expectEditedAt: null });
  check('更新', u.status === 200 && u.json.entry.meaning === '本地修改：乙。', u);
  yiEditedAt = u.json.entry.editedAt;
  const stale = await call('PUT', '/api/ziyi/entry', { han: '乙', meaning: '另一处修改', expectEditedAt: null });
  check('基于旧版本更新 409 conflict', stale.status === 409 && stale.json.code === 'conflict', stale);
  check('更新后检索即时生效', (await call('GET', '/api/ziyi/search?q=' + encodeURIComponent('本地修改'))).json.items[0]?.han === '乙');
  check('删除', (await call('DELETE', '/api/ziyi/entry?han=' + encodeURIComponent('曲'))).status === 200);
  check('删除后 404', (await call('GET', '/api/ziyi/entry?han=' + encodeURIComponent('曲'))).status === 404);
  check('删除不存在 404', (await call('DELETE', '/api/ziyi/entry?han=' + encodeURIComponent('曲'))).status === 404);
  const s = (await call('GET', '/api/ziyi/status')).json;
  check('editedCount', s.count === 6 && s.editedCount === 2, s);
}

// ---------- 并发写串行 ----------
{
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => call('PUT', '/api/ziyi/entry', { han: '丙', meaning: '并发 ' + i })));
  check('并发更新全部成功', rs.every((r) => r.status === 200));
  const last = rs.map((r) => r.json.entry.editedAt).sort().pop();
  check('最终状态为最后一次写', (await call('GET', '/api/ziyi/entry?han=丙')).json.entry.editedAt === last);
}

// ---------- 重启后数据仍在 ----------
await stopServer();
await startServer();
check('重启后数据保留', (await call('GET', '/api/ziyi/entry?han=乙')).json?.entry?.editedAt === yiEditedAt);

// ---------- 再导入：保留 / 不保留本地修改 ----------
const backupsDir = path.join(dataDir, 'ziyi', 'backups');
{
  const r = (await call('POST', '/api/ziyi/import?name=pack1.zip', PACK)).json;
  // 本地：甲 乙* 丙* 丁 枣 戊*（* 为本地修改）；包：甲 乙 丙 丁 枣 曲
  check('保留本地修改', r.keptEdited === 3 && r.count === 7 && r.added === 1 && r.removed === 0, r);
  check('生成备份', !!r.backup && fs.existsSync(r.backup));
  check('乙仍为本地修改', (await call('GET', '/api/ziyi/entry?han=乙')).json.entry.meaning === '本地修改：乙。');
  const r2 = (await call('POST', '/api/ziyi/import?keepEdited=0', PACK)).json;
  check('不保留本地修改', r2.keptEdited === 0 && r2.count === 6 && r2.removed === 1 && r2.updated === 2, r2);
  check('乙恢复为包内版本', (await call('GET', '/api/ziyi/entry?han=乙')).json.entry.editedAt === null);
  for (let i = 0; i < 5; i++) await call('POST', '/api/ziyi/import', PACK);
  const backups = fs.readdirSync(backupsDir).filter((f) => f.endsWith('.zip'));
  check('备份最多 5 份', backups.length === 5, backups);
}

// ---------- 导出再导入一致 ----------
{
  await call('PUT', '/api/ziyi/entry', { han: '𠀀', meaning: '扩展 B 区字，测试代理对。', create: true });
  const before = (await call('GET', '/api/ziyi/search?q=&limit=200')).json.items.map((x) => x.han);
  const snapshot = {};
  for (const han of before) snapshot[han] = (await call('GET', '/api/ziyi/entry?han=' + encodeURIComponent(han))).json.entry;
  check('扩展区 unicode 5 位', snapshot['𠀀'].unicode === '20000', snapshot['𠀀']);
  const ex = await call('POST', '/api/ziyi/export', { reveal: false });
  check('导出到桌面目录', ex.status === 200 && ex.json.file.startsWith(exportDir) && fs.existsSync(ex.json.file), ex);
  const zipNames = new AdmZip(ex.json.file).getEntries().map((e) => e.entryName).sort();
  check('导出文件名为 <字>.json', zipNames.join(',') === before.map((h) => h + '.json').sort().join(','), zipNames);
  const one = JSON.parse(new AdmZip(ex.json.file).getEntry('甲.json').getData().toString('utf8'));
  check('导出条目格式', Object.keys(one).join(',') === 'han,unicode,meaning,source' && one.unicode === '7532', one);
  const re = (await call('POST', '/api/ziyi/import?keepEdited=0', fs.readFileSync(ex.json.file))).json;
  check('导出再导入条数一致', re.count === before.length && re.added === 0 && re.removed === 0 && re.updated === 0, re);
  let same = true;
  for (const han of before) {
    const e = (await call('GET', '/api/ziyi/entry?han=' + encodeURIComponent(han))).json.entry;
    if (e.meaning !== snapshot[han].meaning || e.source !== snapshot[han].source) same = false;
  }
  check('导出再导入逐条一致', same);
}

// ---------- 无效包不动现有数据 ----------
{
  const before = (await call('GET', '/api/ziyi/status')).json;
  check('已安装时非 zip 400', (await call('POST', '/api/ziyi/import', Buffer.from('PK broken'))).status === 400);
  const after = (await call('GET', '/api/ziyi/status')).json;
  check('无效包后数据不变', after.count === before.count && after.importedAt === before.importedAt, { before, after });
}

// ---------- 移除 ----------
{
  const r = (await call('DELETE', '/api/ziyi')).json;
  check('移除并备份', r.ok && !!r.backup && fs.existsSync(r.backup), r);
  check('移除后未安装', (await call('GET', '/api/ziyi/status')).json.installed === false);
  const c = await call('PUT', '/api/ziyi/entry', { han: '甲', meaning: '空库新建', create: true });
  check('未安装时新建初始化空库', c.status === 200 && (await call('GET', '/api/ziyi/status')).json.count === 1);
}

// ---------- 损坏的 entries.json ----------
await stopServer();
fs.writeFileSync(path.join(dataDir, 'ziyi', 'entries.json'), '{ half written');
await startServer();
{
  const s = (await call('GET', '/api/ziyi/status')).json;
  check('损坏文件按未安装处理', s.installed === false, s);
  const kept = fs.readdirSync(path.join(dataDir, 'ziyi')).filter((f) => f.startsWith('entries.json.corrupt-'));
  check('损坏文件被保留', kept.length === 1, kept);
}

// ---------- 性能：3000 条 × 4KB ----------
{
  const filler = '测试长文本，用于性能。'.repeat(60); // 两段合计约 4KB UTF-8
  const files = [];
  for (let i = 0; i < 3000; i++) {
    const han = String.fromCodePoint(0x4e00 + i * 3);
    files.push([`p/${han}.json`, entryFile(han, `${filler}关键${i % 97}词${filler}`, `出处 ${i}`)]);
  }
  const r = await call('POST', '/api/ziyi/import?keepEdited=0', makeZip('perf.zip', files));
  check('性能数据导入', r.json?.count === 3000, r.json);
  const queries = ['关键5词', '性能', '不存在的词语', '出处 12', '一', '长文本 关键', '用于', '关键96词', '测试', 'abc'];
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) await call('GET', '/api/ziyi/search?q=' + encodeURIComponent(queries[i % queries.length]));
  const avg = (performance.now() - t0) / 20;
  console.log(`  检索平均 ${avg.toFixed(1)}ms`);
  check('20 次检索平均 < 50ms', avg < 50, avg);
}

await stopServer();
console.log(`\n全部通过：${passed} 项`);
process.exit(0);
