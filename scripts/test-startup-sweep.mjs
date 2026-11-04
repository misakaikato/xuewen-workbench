// 中断恢复第 3 批（specs/2026-11-03-interrupted-3-cleanup.md）：
// G3 迁移边界：进程内调用启动时的迁移函数，先造出中断后的状态再「再次启动」，断言全部迁完。
// G2 启动清理、上限与回收：拉起真实后端（系统回收站用桩），预置各类残留，清理与扫描建索引后逐项断言。
// 运行：node scripts/test-startup-sweep.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = makeTmpDir('wb-sweep-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.error('  ✗ ' + name + (detail === undefined ? '' : '：' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
  }
}
const section = (t) => console.log('\n' + t);
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + what);
    await sleep(100);
  }
}
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const exists = (p) => fs.existsSync(p);
const ls = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// 把文件或目录的修改时间设为 ms 毫秒之前
function age(p, ms) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(p, t, t);
  return p;
}
function put(p, data = 'x', ageMs = 0) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return ageMs ? age(p, ageMs) : p;
}
// 与保存时的备份时间戳同一算法
const backupStamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');

// 进程内导入的后端模块：数据目录指向临时目录，跳过旧版数据迁移（G3 直接调用迁移函数）
process.env.WORKBENCH_HOSTED = '1';
process.env.WORKBENCH_DATA_DIR = path.join(tmp, 'inproc-data');
const { dsIdFor, migrateLegacyUserData, migrateSourcesToKnowledge } = await import('../server/store.js');
const { tmpPathFor } = await import('../server/atomicFile.js');
const { wordCacheKey } = await import('../server/word.js');
const { AgentHub } = await import('../server/agent/manager.js');

// 模拟中断：让 fs.renameSync 对源路径满足 pred 的第一次调用抛错（迁移函数与本进程共用同一个 fs 对象）
function interruptRenameOnce(pred) {
  const orig = fs.renameSync;
  let fired = false;
  fs.renameSync = function (from, to) {
    if (!fired && pred(String(from))) {
      fired = true;
      throw Object.assign(new Error('模拟中断'), { code: 'EIO' });
    }
    return orig.call(fs, from, to);
  };
  return () => { fs.renameSync = orig; };
}
const quiet = async (fn) => {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
};

// ---------- G3-1 旧版数据迁移 ----------
section('G3-1 旧版数据迁移：config.json 最后迁；它已不在而旧目录还有条目时续迁完并写 MIGRATED.txt');
{
  const legacy = path.join(tmp, 'g3-legacy-1');
  const target = path.join(tmp, 'g3-target-1');
  fs.mkdirSync(target, { recursive: true });
  put(path.join(legacy, 'config.json'), JSON.stringify({ version: 2, libraries: [{ id: 'x', baseDir: '/tmp/c', name: 'c' }], activeId: 'x' }));
  put(path.join(legacy, 'knowledge', 'x', 'rag.db'), 'db');
  put(path.join(legacy, 'logs', 'backend.log'), 'log');
  put(path.join(legacy, 'ui-settings.json'), '{}');
  const restore = interruptRenameOnce((from) => path.basename(from) === 'logs');
  const r1 = await quiet(() => migrateLegacyUserData(legacy, target));
  restore();
  check('第一次在中途中断：未完成', r1.migrated === false, r1);
  check('中断时 config.json 还在旧目录（最后一项才迁）', exists(path.join(legacy, 'config.json')) && !exists(path.join(target, 'config.json')));
  check('中断时没有写 MIGRATED.txt', !exists(path.join(legacy, 'MIGRATED.txt')));
  const r2 = await quiet(() => migrateLegacyUserData(legacy, target));
  check('再次启动：迁移完成', r2.migrated === true, r2);
  check('再次启动：所有条目都在新目录', ['config.json', 'knowledge', 'logs', 'ui-settings.json'].every((n) => exists(path.join(target, n))), ls(target));
  check('再次启动：旧目录只剩 MIGRATED.txt', JSON.stringify(ls(legacy)) === JSON.stringify(['MIGRATED.txt']), ls(legacy));

  // 旧版本按目录顺序先迁了 config.json 后中断：旧目录还有条目、config.json 已不在，新目录已有资料库
  const legacy2 = path.join(tmp, 'g3-legacy-2');
  const target2 = path.join(tmp, 'g3-target-2');
  put(path.join(target2, 'config.json'), JSON.stringify({ version: 2, libraries: [{ id: 'x', baseDir: '/tmp/c', name: 'c' }], activeId: 'x' }));
  put(path.join(legacy2, 'knowledge', 'x', 'rag.db'), 'db');
  put(path.join(legacy2, 'memory', 'facts.md'), '记忆');
  put(path.join(legacy2, 'logs', 'backend.log'), '旧日志');
  put(path.join(target2, 'logs', 'backend.log'), '新日志');
  const r3 = await quiet(() => migrateLegacyUserData(legacy2, target2));
  check('config.json 已迁走：续迁剩余条目', r3.migrated === true && r3.resumed === true, r3);
  check('续迁：缺的条目都搬到新目录', exists(path.join(target2, 'knowledge', 'x', 'rag.db')) && exists(path.join(target2, 'memory', 'facts.md')));
  check('续迁：新目录已有的条目不覆盖，旧份留在原处', fs.readFileSync(path.join(target2, 'logs', 'backend.log'), 'utf8') === '新日志' && exists(path.join(legacy2, 'logs')));
  check('续迁：写上 MIGRATED.txt', exists(path.join(legacy2, 'MIGRATED.txt')));
  const r4 = await quiet(() => migrateLegacyUserData(legacy2, target2));
  check('第三次启动：已有 MIGRATED.txt，不再迁移', r4.migrated === false, r4);
}

// ---------- G3-2 sources → knowledge ----------
section('G3-2 sources → knowledge：目标目录已存在时逐项合并，中断后再次启动接着合并');
{
  const dataDir = path.join(tmp, 'g3-sources');
  const src = (...p) => path.join(dataDir, 'sources', ...p);
  const dst = (...p) => path.join(dataDir, 'knowledge', ...p);
  put(src('aaa', 'rag.db'), '旧库');
  put(src('aaa', 'backups', '文章', '甲.md.2026-10-01T00-00-00-000Z.bak'), '备份');
  put(src('aaa', 'cache', 'word-x.json'), '{}');
  put(src('aaa', 'recents.json'), '[]');
  put(src('bbb', 'metadata.json'), '{}');
  // 上次迁移中断：knowledge/aaa 已建好且有部分内容
  put(dst('aaa', 'rag.db'), '新库');
  fs.mkdirSync(dst('aaa', 'backups'), { recursive: true });
  const restore = interruptRenameOnce((from) => from.endsWith('recents.json'));
  await quiet(() => migrateSourcesToKnowledge(dataDir));
  restore();
  check('中断：sources/ 还在', exists(src()));
  const r = await quiet(() => migrateSourcesToKnowledge(dataDir));
  check('再次启动：目标缺的条目逐项合并过去（含下一层目录）',
    exists(dst('aaa', 'backups', '文章', '甲.md.2026-10-01T00-00-00-000Z.bak')) && exists(dst('aaa', 'cache', 'word-x.json')) && exists(dst('aaa', 'recents.json')), r);
  check('再次启动：目标不存在的库整个搬过去', exists(dst('bbb', 'metadata.json')));
  check('同名文件保留目标的，源文件原地保留', fs.readFileSync(dst('aaa', 'rag.db'), 'utf8') === '新库' && exists(src('aaa', 'rag.db')));
  check('搬空的目录删掉，只剩冲突条目', JSON.stringify(ls(src())) === JSON.stringify(['aaa']) && JSON.stringify(ls(src('aaa'))) === JSON.stringify(['rag.db']), ls(src('aaa')));
}

// ---------- G3-3 助手 skills ----------
section('G3-3 助手 skills：新目录不为空时逐个补齐，中断后再次启动补全；删掉的不会被搬回来');
{
  const dataDir = path.join(tmp, 'g3-skills');
  const oldSkill = (n) => path.join(dataDir, 'agent', 'skills', n);
  const newSkill = (n) => path.join(dataDir, 'agents', 'default', 'skills', n);
  for (const n of ['alpha', 'beta', 'gamma', 'delta']) put(path.join(oldSkill(n), 'SKILL.md'), '# ' + n);
  put(path.join(oldSkill('.half.tmp-0123456789ab'), 'SKILL.md'), '# 安装中断');
  // 上次迁移只搬了 alpha 就中断：新目录不为空
  put(path.join(newSkill('alpha'), 'SKILL.md'), '# alpha（新）');
  const hubOpts = { dataDir, getLib: () => null, ragManager: {}, getRagConfig: () => ({}) };
  const restore = interruptRenameOnce((from) => path.basename(from) === 'gamma');
  await quiet(() => new AgentHub(hubOpts));
  restore();
  check('中断：gamma 还没搬', !exists(newSkill('gamma')) && exists(oldSkill('gamma')));
  const hub = await quiet(() => new AgentHub(hubOpts));
  check('再次启动：旧目录有、新目录没有的 skill 都补齐', ['alpha', 'beta', 'gamma', 'delta'].every((n) => exists(path.join(newSkill(n), 'SKILL.md'))), ls(newSkill('')));
  check('新目录已有的 alpha 不被覆盖', fs.readFileSync(path.join(newSkill('alpha'), 'SKILL.md'), 'utf8') === '# alpha（新）');
  check('安装中断的点开头临时目录不搬', !exists(newSkill('.half.tmp-0123456789ab')));
  check('技能列表完整', JSON.stringify(hub._listSkills().sort()) === JSON.stringify(['alpha', 'beta', 'delta', 'gamma']), hub._listSkills());
  fs.rmSync(newSkill('beta'), { recursive: true, force: true });
  await quiet(() => new AgentHub(hubOpts));
  check('用户删掉的 beta 再次启动后不会被搬回来', !exists(newSkill('beta')));
}

// ---------- 会话文件引用：对话索引不可用时返回 null ----------
section('会话文件引用：对话索引缺失或读不到时不提供引用（启动清理整项跳过）');
{
  const hubOpts = (dataDir) => ({ dataDir, getLib: () => null, ragManager: {}, getRagConfig: () => ({}) });
  const missing = path.join(tmp, 'refs-missing');
  const hub1 = await quiet(() => new AgentHub(hubOpts(missing)));
  check('conversations.json 不存在 → null', (await hub1.sessionFileRefs()) === null);
  const unreadable = path.join(tmp, 'refs-unreadable');
  fs.mkdirSync(path.join(unreadable, 'conversations.json'), { recursive: true }); // 是目录，读取失败
  const hub2 = await quiet(() => new AgentHub(hubOpts(unreadable)));
  check('conversations.json 读取失败 → null', (await hub2.sessionFileRefs()) === null);
}

// ---------- G2 夹具 ----------
// 最小 docx：一段正文，可带一张 1×1 PNG（转换时外置到 word-assets）
function makeDocx(text, withImage = false) {
  const zip = new AdmZip();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  const image = withImage
    ? '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="图1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="图1"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
    : '';
  zip.addFile('word/document.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>' + image + '</w:body></w:document>'));
  if (withImage) {
    zip.addFile('word/_rels/document.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>'));
    zip.addFile('word/media/image1.png', png);
  }
  return zip.toBuffer();
}

// 两个库共用父目录 libs/；libs/C 不是资料库
const libsParent = path.join(tmp, 'libs');
const libA = path.join(libsParent, 'A');
const libB = path.join(libsParent, 'B');
const libC = path.join(libsParent, 'C');
const dataDir = path.join(tmp, 'data');
const fakeTrash = path.join(tmp, 'fake-os-trash');
fs.mkdirSync(fakeTrash, { recursive: true });
const dsA = dsIdFor(libA);
const dsB = dsIdFor(libB);
const A = (...p) => path.join(libA, ...p);
const D = (...p) => path.join(dataDir, ...p);
const kA = (...p) => D('knowledge', dsA, ...p);
const kB = (...p) => D('knowledge', dsB, ...p);
const foreignDir = process.platform === 'darwin' ? 'onnx-fp16' : 'mlx-fp16';
const nativeDir = process.platform === 'darwin' ? 'mlx-fp16' : 'onnx-fp16';

put(D('config.json'), JSON.stringify({ version: 2, libraries: [{ baseDir: libA, name: 'A' }, { baseDir: libB, name: 'B' }], activeId: dsA }));

// 资料库 A：文档、本应用临时文件（旧/新）、用户自己的同类名字、隐藏目录里的同名
put(A('文章', '甲.md'), '# 甲\n');
put(A('文章', '乙.md'), '# 乙\n');
const wbTmpOld = put(tmpPathFor(A('文章', '甲.md'), '.wb-tmp-'), '半截', 2 * HOUR);
const wbTmpMetaOld = put(A('文章', '甲.md.meta.json.wb-tmp-4321'), '半截旁注', 2 * HOUR);
const wbTmpNew = put(tmpPathFor(A('文章', '乙.md'), '.wb-tmp-'), '保存中', 10 * MIN);
const copyFileOld = put(A('文章', '.甲 副本.md.wb-copy-1700000000000'), '半截副本', 2 * HOUR);
put(A('文章', '.讲稿 副本.wb-copy-1700000000001', '一.md'), '目录副本');
const copyDirOld = age(A('文章', '.讲稿 副本.wb-copy-1700000000001'), 2 * HOUR);
const copyNew = put(A('文章', '.乙 副本.md.wb-copy-1700000000002'), '复制中', 5 * MIN);
const caseOld = put(A('文章', '戊.md.wb-case-0123456789ab'), '# 戊\n', 2 * HOUR);
put(A('文章', '己.md'), '# 己（已存在）\n');
const caseTaken = put(A('文章', '己.md.wb-case-abcdefabcdef'), '# 己（中间名）\n', 2 * HOUR);
const userTmpLike = put(A('文章', 'foo.tmp-1.md'), '用户自己的文件', 3 * HOUR);
const userWbLike = put(A('文章', 'bar.wb-tmp-1.md'), '用户自己的文件', 3 * HOUR);
const hiddenDirTmp = put(A('.git', 'x.wb-tmp-1'), 'git 里的', 3 * HOUR);
// Word：两篇在库里（甲带图片），另有一篇已删除文档的缓存与图片目录
fs.mkdirSync(A('讲义'), { recursive: true });
fs.writeFileSync(A('讲义', '甲讲义.docx'), makeDocx('甲讲义正文', true));
fs.writeFileSync(A('讲义', '乙讲义.docx'), makeDocx('乙讲义正文'));
const goneKey = wordCacheKey('讲义/已删除.docx');
const goneCache = put(kA('cache', `word-${goneKey}.json`), JSON.stringify({ v: 2, mtimeMs: 1, result: { html: '', text: '' } }));
const goneAssets = path.dirname(put(kA('cache', 'word-assets', `${goneKey}-1700000000000`, 'img-1.png'), 'png'));
const cacheOther = put(kA('cache', '其他.txt'), '不是 Word 缓存');
// .trash 中转：一个能交出去、一个桩会拒绝、一个不是批次目录的散文件和目录
put(A('.trash', '20261101-101010-123__旧文.md', '旧文.md'), '# 旧文\n');
put(A('.trash', '20261101-101010-123__旧文.md', '.trashinfo.json'), '{}');
const batchOk = age(A('.trash', '20261101-101010-123__旧文.md'), 2 * HOUR);
put(A('.trash', '20261101-101010-124__失败.md', '失败.md'), '# 失败\n');
const batchFail = age(A('.trash', '20261101-101010-124__失败.md'), 2 * HOUR);
const trashLoose = put(A('.trash', '随手放的.md'), '散文件', 2 * HOUR);
put(A('.trash', '某目录', 'a.md'), 'a');
const trashOtherDir = age(A('.trash', '某目录'), 2 * HOUR);

// 资料库 B：自己的旧临时文件；一个读不到的子目录（扫描不完整，Word 缓存不回收）
const bTmpOld = put(path.join(libB, '丙.md.wb-tmp-99'), '半截', 2 * HOUR);
put(path.join(libB, '丙.md'), '# 丙\n');
fs.mkdirSync(path.join(libB, '锁住'), { recursive: true });
put(path.join(libB, '锁住', '里面.md'), '# 里面\n');
fs.chmodSync(path.join(libB, '锁住'), 0o000);
atExit(() => { try { fs.chmodSync(path.join(libB, '锁住'), 0o755); } catch { /* 已删 */ } });
const bOrphanCache = put(kB('cache', `word-${wordCacheKey('不在了.docx')}.json`), '{}');
// 非资料库的兄弟目录与共用父目录里的同名文件不归任何库
const cTmpOld = put(path.join(libC, '丁.md.wb-tmp-99'), '别人的', 2 * HOUR);
const parentTmpOld = put(path.join(libsParent, '根.md.wb-tmp-99'), '父目录的', 2 * HOUR);

// 数据目录
const dataTmpOld = put(tmpPathFor(kA('recents.json')), '[]', 2 * HOUR);
const dataTmpNew = put(tmpPathFor(kA('pins.json')), '[]', 10 * MIN);
const logTmpOld = put(D('logs', 'session.json.tmp-777'), '{}', 2 * HOUR);
put(kA('cache', 'convert-AbC123', 'x.docx'), 'x');
const convertOld = age(kA('cache', 'convert-AbC123'), 2 * HOUR);
put(kA('cache', 'convert-XyZ789', 'y.docx'), 'y');
const convertNew = age(kA('cache', 'convert-XyZ789'), 5 * MIN);
put(D('agents', 'default', 'skills', '.旧技能.tmp-0123456789ab', 'SKILL.md'), '# 中断');
const skillTmpOld = age(D('agents', 'default', 'skills', '.旧技能.tmp-0123456789ab'), 2 * HOUR);
put(D('agents', 'default', 'skills', '.新技能.tmp-abcdef012345', 'SKILL.md'), '# 安装中');
const skillTmpNew = age(D('agents', 'default', 'skills', '.新技能.tmp-abcdef012345'), 5 * MIN);
const skillReal = put(D('agents', 'default', 'skills', '真技能', 'SKILL.md'), '# 真技能');
const dataUserLike = put(D('generated', '图.tmp-1.png'), 'png', 3 * HOUR);
const modelsTmp = put(D('models', 'note.tmp-1-1'), 'x', 3 * HOUR);
const pyTmp = put(D('py', 'rag-venv', 'lib', 'thing.tmp-1'), 'x', 3 * HOUR);
const foreignPart = put(D('models', 'bge-m3', foreignDir, 'onnx', 'model_fp16.onnx.part'), 'half', 3 * HOUR);
const nativePart = put(D('models', 'bge-m3', nativeDir, 'model.safetensors.part'), 'half', 3 * HOUR);
// 备份：甲 25 份、乙 3 份、无关文件；B 库 3 份各 200MB 的稀疏文件（总量 600MB）
const t0 = Date.now() - 30 * DAY;
const stampsA = Array.from({ length: 25 }, (_, i) => backupStamp(t0 + i * HOUR));
for (const s of stampsA) put(kA('backups', '文章', `甲.md.${s}.bak`), '# 甲 ' + s, 2 * DAY);
for (let i = 0; i < 3; i++) put(kA('backups', '文章', `乙.md.${backupStamp(t0 + i * HOUR)}.bak`), '# 乙', 2 * DAY);
const backupOther = put(kA('backups', 'readme.txt'), '无关');
const bigBackups = [0, 1, 2].map((i) => {
  const p = put(kB('backups', `大.md.${backupStamp(t0 + i * HOUR)}.bak`), '');
  fs.truncateSync(p, 200 * 1024 * 1024);
  return p;
});
// incidents.jsonl：3000 条约 1.2MB
put(D('logs', 'incidents.jsonl'), Array.from({ length: 3000 }, (_, i) => JSON.stringify({ kind: 'test', at: new Date(t0 + i).toISOString(), seq: i, pad: 'x'.repeat(360) })).join('\n') + '\n');
// 对话：被引用的、不被引用且超过 1 天的、不被引用但不到 1 天的 pi 会话文件，以及显示记录
const convDir = kA('conversations', 'default');
const piRef = '2026-10-01T00-00-00-000Z_aaaaaaaaaaaa-11111111-1111-4111-8111-111111111111.jsonl';
const piStale = '2026-09-01T00-00-00-000Z_aaaaaaaaaaaa-00000000-0000-4000-8000-000000000000.jsonl';
const piYoung = '2026-11-03T00-00-00-000Z_aaaaaaaaaaaa-22222222-2222-4222-8222-222222222222.jsonl';
put(D('conversations.json'), JSON.stringify({ conversations: [{ id: 'aaaaaaaaaaaa', title: '对话', dsId: dsA, agentId: 'default', pinned: false, folderId: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', piSessionFile: piRef }], folders: [] }));
const display = put(path.join(convDir, 'aaaaaaaaaaaa.jsonl'), JSON.stringify({ role: 'user', text: '问', at: 'x' }) + '\n', 2 * DAY);
const piRefP = put(path.join(convDir, piRef), '{}\n', 2 * DAY);
const piStaleP = put(path.join(convDir, piStale), '{}\n', 2 * DAY);
const piYoungP = put(path.join(convDir, piYoung), '{}\n', 2 * HOUR);
const orphanDisplay = put(path.join(convDir, 'bbbbbbbbbbbb.jsonl'), '', 2 * DAY);
const convOther = put(path.join(convDir, 'notes.jsonl'), '', 2 * DAY);

// ---------- G2 后端（系统回收站桩） ----------
const SWEEP_DELAY = 3000;
const wrapper = path.join(tmp, 'wrapper', 'backend-with-trash-stub.mjs');
put(wrapper, `import fs from 'node:fs';
import path from 'node:path';
import { setTrashHandler } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'server', 'trash.js')).href)};
// 系统回收站桩：记录调用；名称含「失败」的批次抛错，其余移到假回收站目录
const fake = process.env.TEST_FAKE_TRASH;
setTrashHandler(async (p) => {
  fs.appendFileSync(path.join(fake, 'calls.txt'), p + '\\n');
  if (path.basename(p).includes('失败')) throw new Error('桩：系统回收站拒绝');
  fs.renameSync(p, path.join(fake, path.basename(p)));
});
await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'server', 'index.js')).href)});
`);

async function startBackend(dir) {
  const port = await freePort();
  const env = {
    ...process.env, WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1', WORKBENCH_DATA_DIR: dir,
    WORKBENCH_RAG_EMBED: 'mock', WORKBENCH_SWEEP_DELAY_MS: String(SWEEP_DELAY), TEST_FAKE_TRASH: fakeTrash,
  };
  delete env.WORKBENCH_HOSTED;
  const proc = spawn(process.execPath, [wrapper], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', () => {}); // 日志在 backend.log
  const exited = new Promise((r) => proc.on('exit', r));
  atExit(() => { try { proc.kill('SIGKILL'); } catch { /* 已退出 */ } });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(base + '/api/config')).ok; } catch { return false; } }, 30000, '后端就绪');
  return { proc, base, exited, readyAt: Date.now() };
}
const backendLog = (dir) => { try { return fs.readFileSync(path.join(dir, 'logs', 'backend.log'), 'utf8'); } catch { return ''; } };
const sweepLine = (dir) => backendLog(dir).split('\n').find((l) => l.includes('[sweep] 启动清理完成')) || '';

section('G2 启动清理：就绪时尚未清理（不在启动关键路径上）');
const srv = await startBackend(dataDir);
check('后端就绪时旧临时文件还在', exists(wbTmpOld) && exists(dataTmpOld) && !sweepLine(dataDir));
await waitFor(() => sweepLine(dataDir), 60000, '启动清理完成');
check('清理在就绪后延迟执行', Date.now() - srv.readyAt >= SWEEP_DELAY - 500, Date.now() - srv.readyAt);
const libStatus = async () => (await (await fetch(srv.base + '/api/status')).json()).libs;
await waitFor(async () => {
  const st = await libStatus();
  return [dsA, dsB].every((id) => st[id]?.scannedAt && st[id].indexing.phase === null && st[id].linksReady);
}, 60000, '两个库扫描与建索引完成');
await waitFor(() => !exists(goneCache) && !exists(goneAssets), 30000, 'A 库已删除文档的 Word 缓存被回收');
await sleep(800); // 清理触发的重扫与随后的回收一并结束
const line = sweepLine(dataDir);
const log = backendLog(dataDir);
console.log('  汇总：' + line.replace(/^.*\[sweep\] /, '').slice(0, 400));

section('G2 数据目录');
check('超过 1 小时的 .tmp-* 删除', !exists(dataTmpOld) && !exists(logTmpOld));
check('不到 1 小时的 .tmp-* 保留', exists(dataTmpNew));
check('超过 1 小时的 cache/convert-* 删除', !exists(convertOld));
check('不到 1 小时的 convert-* 保留', exists(convertNew));
check('超过 1 小时的 skills/.x.tmp-* 删除', !exists(skillTmpOld));
check('不到 1 小时的 skills/.x.tmp-* 与正式 skill 保留', exists(skillTmpNew) && exists(skillReal));
check('不符合命名规则的文件保留（图.tmp-1.png）', exists(dataUserLike));
check('models/ 与 py/ 内部不进入', exists(modelsTmp) && exists(pyTmp));
check('另一后端的 .part 删除', !exists(foreignPart));
check('本机后端的 .part 保留（供续传）', exists(nativePart));

section('G2 资料库目录');
check('超过 1 小时的 .wb-tmp-* 删除', !exists(wbTmpOld) && !exists(wbTmpMetaOld));
check('不到 1 小时的 .wb-tmp-* 保留', exists(wbTmpNew));
check('超过 1 小时的 .wb-copy-* 文件与目录删除', !exists(copyFileOld) && !exists(copyDirOld));
check('不到 1 小时的 .wb-copy-* 保留', exists(copyNew));
check('大小写改名中断的条目改回原名（不删除）', !exists(caseOld) && fs.readFileSync(A('文章', '戊.md'), 'utf8') === '# 戊\n');
check('原名被占用时大小写改名的中间名原样保留', exists(caseTaken) && fs.readFileSync(A('文章', '己.md'), 'utf8') === '# 己（已存在）\n');
check('用户文件 foo.tmp-1.md、bar.wb-tmp-1.md 保留', exists(userTmpLike) && exists(userWbLike));
check('隐藏目录（.git）里不清理', exists(hiddenDirTmp));
check('B 库清理自己的旧临时文件', !exists(bTmpOld));
check('共用父目录与非资料库的兄弟目录里的文件不动', exists(cTmpOld) && exists(parentTmpOld));

section('G2 备份与 incidents 上限');
const leftA = ls(kA('backups', '文章')).filter((n) => n.startsWith('甲.md.'));
check('每篇文档的备份剩 20 份', leftA.length === 20, leftA.length);
check('留下的是最近的 20 份', JSON.stringify(leftA) === JSON.stringify(stampsA.slice(5).map((s) => `甲.md.${s}.bak`).sort()));
check('不足 20 份的文档不动', ls(kA('backups', '文章')).filter((n) => n.startsWith('乙.md.')).length === 3);
check('备份目录里的无关文件不动', exists(backupOther));
check('库备份总量超过 500MB：从最旧的删起直到不超过', !exists(bigBackups[0]) && exists(bigBackups[1]) && exists(bigBackups[2]));
const inc = fs.readFileSync(D('logs', 'incidents.jsonl'), 'utf8').split('\n').filter(Boolean);
check('incidents.jsonl 剩 500 条', inc.length === 500, inc.length);
check('保留的是最近的 500 条', JSON.parse(inc[0]).seq === 2500 && JSON.parse(inc[499]).seq === 2999);
check('incidents.jsonl 原子写入不留临时文件', !ls(D('logs')).some((n) => n.startsWith('incidents.jsonl.tmp-')), ls(D('logs')));

section('G2 Word 缓存回收');
const keyJia = wordCacheKey('讲义/甲讲义.docx');
const keyYi = wordCacheKey('讲义/乙讲义.docx');
check('已删除文档的 word-*.json 与图片目录已删除', !exists(goneCache) && !exists(goneAssets));
check('仍存在的文档 Word 缓存都在', exists(kA('cache', `word-${keyJia}.json`)) && exists(kA('cache', `word-${keyYi}.json`)));
check('仍存在的文档图片目录在', ls(kA('cache', 'word-assets')).some((n) => n.startsWith(keyJia + '-')), ls(kA('cache', 'word-assets')));
check('缓存目录里的其他文件不动', exists(cacheOther));
check('扫描不完整（有读不到的目录）的库不回收', exists(bOrphanCache));

section('G2 .trash 中转');
const calls = ls(fakeTrash).includes('calls.txt') ? fs.readFileSync(path.join(fakeTrash, 'calls.txt'), 'utf8').split('\n').filter(Boolean) : [];
check('停在 .trash 的批次交给系统回收站并从中转删除', !exists(batchOk) && exists(path.join(fakeTrash, path.basename(batchOk), '旧文.md')));
check('交给系统回收站失败时保留中转目录', exists(batchFail) && exists(path.join(batchFail, '失败.md')));
check('失败记 WARN', /WARN .*\[sweep\].*20261101-101010-124__失败\.md.*交给系统回收站失败/.test(log));
check('只把批次目录交给系统回收站（散文件与其他目录不动）', calls.length === 2 && exists(trashLoose) && exists(trashOtherDir), calls);

section('G2 模型会话文件');
check('不被引用且超过 1 天的 pi 会话文件删除', !exists(piStaleP));
check('被引用的 pi 会话文件保留', exists(piRefP));
check('不被引用但不到 1 天的保留', exists(piYoungP));
check('显示记录与其他文件不动', exists(display) && exists(orphanDisplay) && exists(convOther));

section('G2 汇总日志');
check('删了哪些汇总成一行 INFO', / INFO  \[backend\] \[sweep\] 启动清理完成/.test(line) && line.includes('临时文件') && line.includes('涉及：'), line.slice(0, 200));
check('汇总里列出被删的条目', line.includes(path.basename(dataTmpOld)) || line.includes(' 等 '));
check('清理期间没有事件循环阻塞告警', !/\[lag\].*启动清理/.test(log));
srv.proc.kill('SIGKILL');
await srv.exited;

section('G2 对话索引损坏：启动时重建，本次不删任何会话文件');
{
  const dir2 = path.join(tmp, 'data-corrupt');
  const conv2 = path.join(dir2, 'knowledge', 'dsX', 'conversations', 'default');
  put(path.join(dir2, 'conversations.json'), '{"conversations": [{"id": "cccc');
  put(path.join(conv2, 'cccccccccccc.jsonl'), JSON.stringify({ role: 'user', text: '问', at: 'x' }) + '\n', 2 * DAY);
  const older = put(path.join(conv2, '2026-09-01T00-00-00-000Z_cccccccccccc-33333333-3333-4333-8333-333333333333.jsonl'), '{}\n', 3 * DAY);
  const newer = put(path.join(conv2, '2026-09-02T00-00-00-000Z_cccccccccccc-44444444-4444-4444-8444-444444444444.jsonl'), '{}\n', 2 * DAY);
  const srv2 = await startBackend(dir2);
  await waitFor(() => sweepLine(dir2), 60000, '启动清理完成（索引损坏）');
  const rebuilt = JSON.parse(fs.readFileSync(path.join(dir2, 'conversations.json'), 'utf8'));
  check('对话索引已从记录重建', rebuilt.conversations.length === 1 && ls(dir2).some((n) => n.startsWith('conversations.json.corrupt-')));
  check('重建后未被推断为引用的旧会话文件也保留', exists(older) && exists(newer));
  check('汇总注明会话文件这一项跳过', sweepLine(dir2).includes('跳过：会话文件'), sweepLine(dir2).slice(0, 200));
  srv2.proc.kill('SIGKILL');
  await srv2.exited;
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
