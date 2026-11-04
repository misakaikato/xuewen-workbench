// 字义库后端（specs/2026-11-04-ziyi.md 验收 1）：临时 WORKBENCH_DATA_DIR 下拉起后端，字义文件全部运行时合成。
// 断言：未安装状态；导入解析（单 JSON、zip 里一个 JSON、非字义文件、缺字头 / 缺释义、重复字、来源与异体字清洗）；
// 检索排序 / AND / 繁简 / 来源筛选；lookup 去重、跳过标点、异体字回退；新建 / 更新（保留来源）/ exists / conflict / 删除；
// 保留与不保留本地修改；备份最多 5 份；合并脚本（课堂优先、待定改用 AI、富文本、异体字）；
// 导出再导入一致；无效包 400 且数据不变；写盘失败时内存不变；读盘失败 503 且可重试；entries.json 损坏被保留；
// 3000 条 × 4KB 检索耗时。
// 运行：node scripts/test-ziyi.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
      await fetch(base + '/api/ziyi/status'); // 有 HTTP 响应即已起来（读盘失败的用例里是 503）
      return;
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

const ent = (han, meaning, source = '', extra = {}) => ({ han, meaning, source, ...extra });
const packJson = (entries, extra = {}) => Buffer.from(JSON.stringify({ format: 'xuewen-ziyi', version: 1, entries, ...extra }));
function makeZip(name, files) {
  const file = path.join(tmp, name);
  writeZip(file, files);
  return fs.readFileSync(file);
}

// ---------- 合成字义文件（不含任何真实字义） ----------
const PACK = packJson([
  ent('甲', '测试释义：甲字条目，屈曲一次。', '测试出处甲', { origin: 'lecture' }),
  ent('乙', '测试释义：乙字条目，屈曲屈曲屈曲，再屈曲。', '测试出处乙', { origin: 'ai' }),
  ent('丙', '测试释义：丙字条目，与甲相关。', '测试出处丙，屈曲见此', { origin: 'ai' }),
  ent('丁', '测试释义：丁字条目，屈曲两次屈曲。', '', { origin: 'bogus' }),
  ent('枣', '测试释义：枣字条目，繁体作棗。', '测试出处枣', { origin: 'ai' }),
  ent('曲', '测试释义：曲字条目。', '', { origin: 'lecture', variants: ['麴', '曲', 'x', '甲乙', '麴'] }),
  ent('甲', '测试释义：甲字条目（重复，后者为准），屈曲一次。', '测试出处甲2', { origin: 'lecture' }),
  { han: '戊' },
  { meaning: '没有字头' },
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
check('不是 JSON 400', (await call('POST', '/api/ziyi/import', Buffer.from('hello'))).status === 400);
check('不是字义文件（缺 format）400', (await call('POST', '/api/ziyi/import', Buffer.from(JSON.stringify({ entries: [ent('甲', 'x')] })))).status === 400);
check('zip 里两个 JSON 400', (await call('POST', '/api/ziyi/import', makeZip('two.zip', [{ name: 'a.json', data: PACK }, { name: 'b.json', data: PACK }]))).status === 400);
{
  const r = await call('POST', '/api/ziyi/import', packJson([{ han: '甲' }]));
  check('0 条有效 400', r.status === 400, r);
  check('0 条有效后仍未安装', (await call('GET', '/api/ziyi/status')).json.installed === false);
}

// ---------- 导入 ----------
{
  const r = await call('POST', '/api/ziyi/import?name=pack1.json', PACK);
  check('导入成功', r.status === 200 && r.json.ok, r);
  check('导入计数', r.json.count === 6 && r.json.added === 6 && r.json.updated === 0 && r.json.removed === 0, r.json);
  check('无效条目计数（缺释义、缺字头）', r.json.invalidCount === 2 && r.json.invalid.join('|') === '第 8 条（戊）|第 9 条', r.json.invalid);
  check('重复字计数', r.json.duplicates === 1, r.json);
  check('首次导入无备份', r.json.backup === null);
  const s = (await call('GET', '/api/ziyi/status')).json;
  check('status 已安装', s.installed && s.count === 6 && s.editedCount === 0 && s.sourceName === 'pack1.json' && !!s.importedAt, s);
  check('status 按来源计数（非法来源记为未标注）', JSON.stringify(s.origins) === JSON.stringify({ lecture: 2, ai: 3, local: 0, none: 1 }), s.origins);
  const e = (await call('GET', '/api/ziyi/entry?han=甲')).json;
  check('重复字以后出现者为准', e.entry.source === '测试出处甲2', e);
  check('unicode 由字计算、来源带出', e.entry.unicode === '7532' && e.entry.origin === 'lecture', e.entry);
  const q = (await call('GET', '/api/ziyi/entry?han=' + encodeURIComponent('曲'))).json.entry;
  check('异体字清洗：只留与字头不同的单个汉字并去重', JSON.stringify(q.variants) === JSON.stringify(['麴']), q.variants);
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
  const lec = (await call('GET', '/api/ziyi/search?q=&origin=lecture')).json;
  check('来源筛选：课堂讲解', lec.items.map((x) => x.han).join('') === '曲甲' && lec.items.every((x) => x.origin === 'lecture'), lec.items);
  const none = (await call('GET', '/api/ziyi/search?q=' + encodeURIComponent('屈曲') + '&origin=none')).json;
  check('来源筛选与检索词同时生效', none.total === 1 && none.items[0].han === '丁', none.items);
}

// ---------- 查询与 lookup ----------
{
  const e = await call('GET', '/api/ziyi/entry?han=' + encodeURIComponent('棗'));
  check('entry 繁简回退', e.status === 200 && e.json.entry.han === '枣' && e.json.resolvedFrom === '棗', e.json);
  const lk = (await call('GET', '/api/ziyi/lookup?text=' + encodeURIComponent('甲，甲 a乙！棗无'))).json.items;
  check('lookup 去重、跳过标点与拉丁', lk.map((x) => x.char).join('') === '甲乙棗无', lk.map((x) => x.char));
  check('lookup 命中与 resolvedFrom', lk[0].entry.han === '甲' && lk[2].entry.han === '枣' && lk[2].resolvedFrom === '棗' && lk[3].entry === null, lk);
  const v = await call('GET', '/api/ziyi/entry?han=' + encodeURIComponent('麴'));
  check('异体字回退到字头', v.status === 200 && v.json.entry.han === '曲' && v.json.resolvedFrom === '麴', v.json);
  const marks = (await call('GET', '/api/ziyi/lookup?text=' + encodeURIComponent('々〇⺀甲'))).json.items;
  check('lookup 不收々〇与部首', marks.map((x) => x.char).join('') === '甲', marks.map((x) => x.char));
  const many = (await call('GET', '/api/ziyi/lookup?text=' + encodeURIComponent('一二三四五六七八九十百千万亿'))).json.items;
  check('lookup 最多 12 个', many.length === 12);
}

// ---------- 编辑 ----------
let yiEditedAt;
{
  const c = await call('PUT', '/api/ziyi/entry', { han: '戊', meaning: '本地新建：戊。', source: '自拟', create: true });
  check('新建标为本机新建', c.status === 200 && c.json.entry.han === '戊' && !!c.json.entry.editedAt && c.json.entry.origin === 'local', c);
  check('新建已存在 409 exists', (await call('PUT', '/api/ziyi/entry', { han: '甲', meaning: 'x', create: true })).json?.code === 'exists');
  check('更新不存在 404', (await call('PUT', '/api/ziyi/entry', { han: '己', meaning: 'x' })).status === 404);
  check('空释义 400', (await call('PUT', '/api/ziyi/entry', { han: '甲', meaning: '  ' })).status === 400);
  check('字头含空白 400', (await call('PUT', '/api/ziyi/entry', { han: '甲 乙', meaning: 'x', create: true })).status === 400);
  const u = await call('PUT', '/api/ziyi/entry', { han: '乙', meaning: '本地修改：乙。', source: '改过', expectEditedAt: null });
  check('更新且保留原来源', u.status === 200 && u.json.entry.meaning === '本地修改：乙。' && u.json.entry.origin === 'ai', u);
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
  const zipNames = new AdmZip(ex.json.file).getEntries().map((e) => e.entryName);
  check('导出为 zip 里的一个字义文件', zipNames.join(',') === '字义库.json', zipNames);
  const out = JSON.parse(new AdmZip(ex.json.file).getEntry('字义库.json').getData().toString('utf8'));
  check('导出格式与导入相同', out.format === 'xuewen-ziyi' && out.entries.length === before.length, { format: out.format, n: out.entries.length });
  const qu = out.entries.find((x) => x.han === '曲');
  check('导出带来源与异体字', qu.origin === 'lecture' && JSON.stringify(qu.variants) === '["麴"]', qu);
  const re = (await call('POST', '/api/ziyi/import?keepEdited=0', fs.readFileSync(ex.json.file))).json;
  check('导出再导入条数一致', re.count === before.length && re.added === 0 && re.removed === 0 && re.updated === 0, re);
  let same = true;
  for (const han of before) {
    const e = (await call('GET', '/api/ziyi/entry?han=' + encodeURIComponent(han))).json.entry;
    if (e.meaning !== snapshot[han].meaning || e.source !== snapshot[han].source || e.origin !== snapshot[han].origin) same = false;
  }
  check('导出再导入逐条一致', same);
  const s = (await call('GET', '/api/ziyi/status')).json;
  check('导出再导入来源计数一致', s.origins.lecture === 2 && s.origins.local === 1, s.origins);
}

// ---------- 无效包不动现有数据 ----------
{
  const before = (await call('GET', '/api/ziyi/status')).json;
  check('已安装时非 zip 400', (await call('POST', '/api/ziyi/import', Buffer.from('PK broken'))).status === 400);
  const after = (await call('GET', '/api/ziyi/status')).json;
  check('无效包后数据不变', after.count === before.count && after.importedAt === before.importedAt, { before, after });
}

// ---------- 写盘失败：内存与磁盘保持一致 ----------
{
  const zdir = path.join(dataDir, 'ziyi');
  const before = (await call('GET', '/api/ziyi/entry?han=甲')).json.entry;
  const status0 = (await call('GET', '/api/ziyi/status')).json;
  fs.chmodSync(zdir, 0o555);
  try {
    const u = await call('PUT', '/api/ziyi/entry', { han: '甲', meaning: '写不进去的修改', expectEditedAt: before.editedAt });
    check('写盘失败时编辑报错', u.status >= 500, u);
    check('写盘失败后内存仍是旧内容', (await call('GET', '/api/ziyi/entry?han=甲')).json.entry.meaning === before.meaning);
    check('写盘失败后检索不到新内容', (await call('GET', '/api/ziyi/search?q=' + encodeURIComponent('写不进去'))).json.total === 0);
    check('写盘失败时新建报错且不出现', (await call('PUT', '/api/ziyi/entry', { han: '癸', meaning: 'x', create: true })).status >= 500 && (await call('GET', '/api/ziyi/entry?han=癸')).status === 404);
    check('写盘失败时删除报错且仍在', (await call('DELETE', '/api/ziyi/entry?han=甲')).status >= 500 && (await call('GET', '/api/ziyi/entry?han=甲')).status === 200);
    const im = await call('POST', '/api/ziyi/import?keepEdited=0', packJson([ent('庚', '另一个包')]));
    check('写盘失败时导入报错', im.status >= 500, im);
    const status1 = (await call('GET', '/api/ziyi/status')).json;
    check('导入写盘失败后现有数据不动', status1.count === status0.count && status1.importedAt === status0.importedAt && (await call('GET', '/api/ziyi/entry?han=庚')).status === 404, status1);
  } finally {
    fs.chmodSync(zdir, 0o755);
  }
  const ok = await call('PUT', '/api/ziyi/entry', { han: '甲', meaning: '恢复后可写', expectEditedAt: before.editedAt });
  check('恢复可写后按原版本号保存成功（无误报冲突）', ok.status === 200, ok);
}

// ---------- 读盘失败：503，恢复后重试成功，且不当成未安装 ----------
await stopServer();
{
  const file = path.join(dataDir, 'ziyi', 'entries.json');
  fs.chmodSync(file, 0o000);
  await startServer();
  const s503 = await call('GET', '/api/ziyi/status');
  check('读盘失败返回 503', s503?.status === 503, s503);
  check('读盘失败时新建被拒、不覆盖原文件', (await call('PUT', '/api/ziyi/entry', { han: '癸', meaning: 'x', create: true })).status === 503);
  fs.chmodSync(file, 0o644);
  const s = (await call('GET', '/api/ziyi/status')).json;
  check('恢复可读后重试成功', s.installed === true && s.count > 0, s);
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

// ---------- 合并脚本：课堂讲解优先，待定改用 AI，富文本转纯文本，异体字 ----------
{
  const lec = path.join(tmp, 'lecture');
  const ai = path.join(tmp, 'ai');
  fs.mkdirSync(lec);
  fs.mkdirSync(ai);
  const w = (dir, f, obj) => fs.writeFileSync(path.join(dir, f), typeof obj === 'string' ? obj : JSON.stringify(obj));
  w(lec, '类（類 ）.json', { han: '类（類 ）', meaning: '课堂：类', source: '课一' });
  w(lec, '体-體.json', { han: '体-體', meaning: JSON.stringify({ root: { children: [{ text: '课堂：体' }] } }), source: '课二' });
  w(lec, '待.json', { han: '待', meaning: '待定', source: '' });
  w(lec, '空.json', { han: '空', meaning: '待定' });
  w(lec, '坏.json', '{ bad');
  w(ai, '类.json', { han: '类', unicode: '7C7B', meaning: 'AI：类', source: 'ai' });
  w(ai, '待.json', { han: '待', unicode: '5F85', meaning: 'AI：待', source: 'ai' });
  w(ai, '新.json', { han: '新', unicode: '65B0', meaning: 'AI：新', source: 'ai' });
  w(ai, '_batches.json', { batch0: [] });
  const out = path.join(tmp, 'merged', '字义库.json');
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-ziyi-pack.mjs'), '--lecture', lec, '--ai', ai, '--out', out], { encoding: 'utf8' });
  check('合并脚本运行成功', run.status === 0, run.stderr);
  check('合并脚本报告解析失败与跳过的文件名', run.stdout.includes('解析失败 1（坏.json）') && run.stdout.includes('跳过：1（空.json）'), run.stdout);
  check('合并脚本报告重叠计数', run.stdout.includes('两边都有：2 字，其中用课堂讲解 1，课堂释义为空或「待定」改用 AI 推导 1'), run.stdout);
  const pack = JSON.parse(fs.readFileSync(out, 'utf8'));
  const by = Object.fromEntries(pack.entries.map((x) => [x.han, x]));
  check('合并结果字头', pack.format === 'xuewen-ziyi' && Object.keys(by).sort().join('') === ['体', '待', '新', '类'].sort().join(''), Object.keys(by));
  check('重叠以课堂讲解为准', by['类'].origin === 'lecture' && by['类'].meaning === '课堂：类' && JSON.stringify(by['类'].variants) === '["類"]', by['类']);
  check('课堂待定改用 AI 推导', by['待'].origin === 'ai' && by['待'].meaning === 'AI：待', by['待']);
  check('只在 AI 目录的为 AI 推导', by['新'].origin === 'ai', by['新']);
  check('富文本释义转纯文本、体-體 取异体', by['体'].meaning === '课堂：体' && JSON.stringify(by['体'].variants) === '["體"]', by['体']);
  const r = await call('POST', '/api/ziyi/import?name=' + encodeURIComponent('字义库.json'), fs.readFileSync(out));
  check('合并结果可直接导入', r.status === 200 && r.json.count === 4, r.json);
  const t = await call('GET', '/api/ziyi/entry?han=' + encodeURIComponent('類'));
  check('导入后繁体字查到字头', t.json?.entry?.han === '类', t.json);
}

// ---------- 性能：3000 条 × 4KB ----------
{
  const filler = '测试长文本，用于性能。'.repeat(60); // 两段合计约 4KB UTF-8
  const files = [];
  for (let i = 0; i < 3000; i++) {
    const han = String.fromCodePoint(0x4e00 + i * 3);
    files.push(ent(han, `${filler}关键${i % 97}词${filler}`, `出处 ${i}`, { origin: i % 2 ? 'ai' : 'lecture' }));
  }
  const r = await call('POST', '/api/ziyi/import?keepEdited=0', makeZip('perf.zip', [{ name: 'perf/字义库.json', data: packJson(files) }]));
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
