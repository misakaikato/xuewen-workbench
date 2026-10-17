// 后端验收脚本：逐项调用 API 并断言，输出通过/失败明细
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateMeta } from '../server/meta.js';
import { dataDir } from '../server/store.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const A = path.join(ROOT, 'test-data', 'ds-a');
const B = path.join(ROOT, 'test-data', 'ds-b');
const PERF = path.join(ROOT, 'test-data', 'ds-perf');
const BASE = 'http://localhost:7410';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail); }
}
async function j(url, init) {
  const r = await fetch(BASE + url, init);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const post = (url, body) => j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (url, body) => j(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

console.log('== 1. 配置数据源 A ==');
let r = await post('/api/config/test', { baseDir: A });
check('测试连接成功且可写', r.body.ok && r.body.writable, JSON.stringify(r.body));
r = await post('/api/config', { baseDir: A });
check('保存并加载 A', r.body.ok && r.body.dsId, JSON.stringify(r.body));
const dsA = r.body.dsId;
check('扫描计数正确（11 文件）', r.body.status.counts.files === 11, JSON.stringify(r.body.status.counts));
check('类型分布正确（5md/3json?）', r.body.status.counts.doc === 1 && r.body.status.counts.docx === 1, JSON.stringify(r.body.status.counts));

console.log('== 2. 目录树与自然排序 ==');
r = await j('/api/tree');
const allPaths = [];
(function walk(n) { n.files.forEach(f => allPaths.push(f.path)); n.dirs.forEach(walk); })(r.body.tree);
check('树含多级目录文件', allPaths.includes('笔记/子目录/第10章 总结.md'));
check('树含同名文件两处', allPaths.filter(p => p.endsWith('同名文件.md')).length === 2);
const noteFiles = allPaths.filter(p => p.startsWith('笔记/') && !p.includes('子目录'));
check('自然排序 1 < 2', noteFiles.indexOf('笔记/第1章 入门.md') < noteFiles.indexOf('笔记/第2章 进阶.md'), noteFiles.join(','));

console.log('== 3. 文件读取 ==');
r = await j('/api/file?path=' + encodeURIComponent('笔记/第1章 入门.md'));
check('MD 读取含正文', r.body.type === 'markdown' && r.body.content.includes('第1章 入门'));
r = await j('/api/file?path=' + encodeURIComponent('资料库/broken.json'));
check('无效 JSON 仍可读原文', r.body.type === 'json' && r.body.content.includes('无效'));
r = await j('/api/file?path=' + encodeURIComponent('word/报告 2024.docx'));
check('DOCX 解析出正文', r.body.type === 'word' && r.body.text.includes('月落乌啼霜满天'), r.body.warning || '');
check('DOCX 保留表格', (r.body.html || '').includes('<table'), '');
r = await j('/api/file?path=' + encodeURIComponent('word/旧文档.doc'));
check('二进制 DOC 提取正文', r.body.type === 'word' && (r.body.text || '').includes('江枫渔火对愁眠'), JSON.stringify(r.body).slice(0, 200));
check('DOC 提示 LibreOffice 缺失诊断', !!r.body.warning, '');

console.log('== 4. 引用解析 ==');
r = await j('/api/refs/resolve?name=' + encodeURIComponent('概念总表.json'));
check('完整文件名唯一命中', r.body.status === 'unique' && r.body.targets[0].path === '资料库/概念总表.json');
r = await j('/api/refs/resolve?name=' + encodeURIComponent('同名文件.md'));
check('同名文件返回候选', r.body.status === 'candidates' && r.body.targets.length === 2);
await put('/api/collections', { collections: [{ name: '集合甲', dirs: ['笔记'] }, { name: '集合乙', dirs: ['资料库'] }] });
r = await j('/api/refs/resolve?name=' + encodeURIComponent('同名文件') + '&collection=' + encodeURIComponent('集合甲'));
check('集合甲|同名文件 → 笔记目录', r.body.status === 'unique' && r.body.targets[0].path === '笔记/同名文件.md', JSON.stringify(r.body));
r = await j('/api/refs/resolve?name=' + encodeURIComponent('同名文件.md') + '&collection=' + encodeURIComponent('集合乙'));
check('集合乙|同名文件.md → 资料库目录', r.body.status === 'unique' && r.body.targets[0].path === '资料库/同名文件.md');
r = await j('/api/refs/resolve?name=' + encodeURIComponent('不存在的文件.md'));
check('缺失目标报告原因', r.body.status === 'missing' && !!r.body.reason);
r = await j('/api/refs/resolve?name=' + encodeURIComponent('第2章 进阶.md') + '&collection=' + encodeURIComponent('集合乙'));
check('集合内缺失→不静默跨集合', r.body.status === 'missing' && r.body.suggestions?.length >= 1, JSON.stringify(r.body));
r = await j('/api/backlinks?path=' + encodeURIComponent('资料库/概念总表.json'));
check('反链找到 第1章', r.body.backlinks.some(f => f.path === '笔记/第1章 入门.md'));

console.log('== 5. 全局检索 ==');
r = await j('/api/search?q=' + encodeURIComponent('雪拥蓝关'));
check('MD 正文中文命中', r.body.results.some(x => x.file.path === '笔记/第2章 进阶.md'));
r = await j('/api/search?q=' + encodeURIComponent('星垂平野阔'));
check('JSON 值命中', r.body.results.some(x => x.file.path === '资料库/数据 表格.json'));
r = await j('/api/search?q=' + encodeURIComponent('月落乌啼'));
check('DOCX 正文命中', r.body.results.some(x => x.file.path === 'word/报告 2024.docx'));
r = await j('/api/search?q=' + encodeURIComponent('江枫渔火'));
check('DOC 正文命中', r.body.results.some(x => x.file.path === 'word/旧文档.doc'));
r = await j('/api/search?q=' + encodeURIComponent('雪拥蓝关') + '&types=.json');
check('类型筛选缩小结果', r.body.results.length === 0);
r = await j('/api/search?q=' + encodeURIComponent('"夜半钟声到客船"'));
check('短语检索（B 未接入时无结果）', r.body.results.length === 0);

console.log('== 6. 保存与冲突 ==');
const target = '笔记/第2章 进阶.md';
r = await j('/api/file?path=' + encodeURIComponent(target));
const before = r.body;
const newContent = before.content + '\n新增词：孤舟蓑笠翁。\n';
r = await put('/api/file', { path: target, content: newContent, baseMtimeMs: before.mtimeMs, dsId: dsA });
check('保存 MD 成功', r.body.ok === true, JSON.stringify(r.body));
const disk = fs.readFileSync(path.join(A, target), 'utf8');
check('磁盘确认写回', disk.includes('孤舟蓑笠翁'));
r = await j('/api/search?q=' + encodeURIComponent('孤舟蓑笠翁'));
check('保存后搜索命中新词', r.body.results.some(x => x.file.path === target));
// 外部修改 → 冲突
fs.appendFileSync(path.join(A, target), '\n外部修改行。\n');
await new Promise(s => setTimeout(s, 50));
r = await put('/api/file', { path: target, content: newContent + '\n我的覆盖。\n', baseMtimeMs: before.mtimeMs, dsId: dsA });
check('外部修改触发 409 冲突', r.status === 409 && r.body.conflict === true, JSON.stringify(r.body).slice(0, 120));
check('冲突响应含磁盘当前内容', (r.body.current || '').includes('外部修改行'));
// 用最新 mtime 覆盖保存
r = await put('/api/file', { path: target, content: newContent + '\n我的覆盖。\n', baseMtimeMs: r.body.currentMtimeMs, dsId: dsA });
check('冲突后显式覆盖成功', r.body.ok === true);
// 无效 JSON 不允许写入由前端校验；后端原子写检查备份存在
const bakDir = path.join(ROOT, 'server', 'data', 'sources', dsA, 'backups', '笔记');
check('备份文件已生成', fs.existsSync(bakDir) && fs.readdirSync(bakDir).some(f => f.includes('第2章')), '');

console.log('== 7. 数据源切换隔离 ==');
r = await post('/api/config', { baseDir: B });
const dsB = r.body.dsId;
check('切换到 B，dsId 不同', r.body.ok && dsB !== dsA);
r = await j('/api/search?q=' + encodeURIComponent('夜半钟声到客船'));
check('B 中命中 B 的文件', r.body.results.some(x => x.file.path === '笔记/第1章 入门.md'));
r = await j('/api/file?path=' + encodeURIComponent('笔记/第1章 入门.md'));
check('B 的同路径文件内容不同', r.body.content.includes('数据源 B'));
r = await j('/api/search?q=' + encodeURIComponent('雪拥蓝关'));
check('A 的内容在 B 中不可见', r.body.results.length === 0);
r = await put('/api/file', { path: '笔记/第1章 入门.md', content: 'x', baseMtimeMs: 0, dsId: dsA });
check('旧 dsId 写入被拒绝', r.status === 409 && r.body.stale === true);

console.log('== 8. 元数据主题/概念（回到 A） ==');
await post('/api/config', { baseDir: A });
await put('/api/metadata', { mappings: [{ file: '索引/index.json', itemPath: 'items', fields: { file: 'doc', topics: '主题', concepts: '概念' } }] });
r = await j('/api/topics');
check('主题聚合正确', r.body.topics.some(t => t.topic === '基础' && t.count === 1) && r.body.topics.length >= 2, JSON.stringify(r.body.topics));
check('概念聚合含频次', r.body.concepts.some(c => c.concept === '方法' && c.count === 2), JSON.stringify(r.body.concepts));

console.log('== 9. 性能（千文件语料） ==');
const t0 = Date.now();
r = await post('/api/config', { baseDir: PERF });
const scanMs = Date.now() - t0;
const perfCount = r.body.status.counts.files;
check('扫描到 ~1000 文件', perfCount === 1000, String(perfCount));
const t1 = Date.now();
r = await j('/api/search?q=' + encodeURIComponent('蜡炬成灰'));
const searchMs = Date.now() - t1;
check('千文件搜索命中唯一文档', r.body.results.length === 1 && r.body.results[0].file.path.includes('文档0500'));
console.log(`  ℹ 文件数=${perfCount}，扫描+索引耗时=${scanMs}ms，单次搜索耗时=${searchMs}ms，环境=${process.platform} node ${process.version}`);

console.log('== 10. 路径安全 ==');
r = await j('/api/file?path=' + encodeURIComponent('../../etc/passwd'));
check('越界路径被拒绝', r.status === 403 || r.status === 404 || r.status === 500, String(r.status));

console.log('== 11. 新建文档 / 文件夹 / 元数据旁注 ==');
r = await post('/api/config', { baseDir: A });
const dsA2 = r.body.dsId;
const NEWDIR = '验收新建目录';
const created = [path.join(A, NEWDIR), path.join(A, '笔记', '验收新建讲稿.md'), path.join(A, '笔记', '验收新建讲稿.md.meta.json'),
  path.join(A, '笔记', '验收旁注占用.md.meta.json'), path.join(A, '笔记', '验收逃逸链接')];
const cleanup = () => created.forEach((p) => fs.rmSync(p, { recursive: true, force: true }));
cleanup();
const create = (body) => post('/api/file/create', { dsId: dsA2, ...body });

r = await create({ dir: '笔记', kind: 'md', name: '验收新建讲稿', title: '验收新建讲稿 庚辛壬癸', docType: '讲稿' });
check('新建 md 成功（自动补 .md）', r.status === 200 && r.body.ok && r.body.path === '笔记/验收新建讲稿.md', JSON.stringify(r.body));
const mdAbs = path.join(A, '笔记', '验收新建讲稿.md');
const md = fs.existsSync(mdAbs) ? fs.readFileSync(mdAbs, 'utf8') : '';
check('md 正文为最小标题且无 front matter', md === '# 验收新建讲稿 庚辛壬癸\n', JSON.stringify(md));
const metaAbs = mdAbs + '.meta.json';
check('旁注 <文件名>.meta.json 已生成', fs.existsSync(metaAbs));
let meta = null;
try { meta = JSON.parse(fs.readFileSync(metaAbs, 'utf8')); } catch { /* invalid */ }
check('旁注为合法 JSON（2 空格缩进）', !!meta && fs.readFileSync(metaAbs, 'utf8').startsWith('{\n  "id"'));
check('旁注含 id/title/type/date 等字段', !!meta && /^doc_[0-9a-f-]{36}$/.test(meta.id) && meta.title === '验收新建讲稿 庚辛壬癸' &&
  meta.type === '讲稿' && /^\d{4}-\d{2}-\d{2}$/.test(meta.date) && meta.source_url === '' &&
  Array.isArray(meta.aliases) && meta.aliases.length === 0 && Array.isArray(meta.tags) && !isNaN(Date.parse(meta.created_at)), JSON.stringify(meta));
const mv11 = validateMeta(meta);
check('新建旁注通过 meta.schema.json 校验', mv11.ok, JSON.stringify(mv11.errors));
r = await j('/api/tree');
const paths2 = []; const dirs2 = [];
(function walk(n) { n.files.forEach(f => paths2.push(f.path)); n.dirs.forEach(d => { dirs2.push(d.path); walk(d); }); })(r.body.tree);
check('新文档立即出现在目录树', paths2.includes('笔记/验收新建讲稿.md'));
check('旁注不出现在目录树', !paths2.some(p => p.endsWith('.meta.json')));
r = await j('/api/search?q=' + encodeURIComponent('庚辛壬癸'));
check('新文档立即可检索', r.body.results?.some(x => x.file.path === '笔记/验收新建讲稿.md'), JSON.stringify(r.body.results?.map(x => x.file.path)));
r = await j('/api/search?q=' + encodeURIComponent(meta?.id || 'doc_'));
check('旁注内容不进入检索', r.body.results?.length === 0);
r = await j('/api/file?path=' + encodeURIComponent('笔记/验收新建讲稿.md'));
check('新文档可在编辑器打开（读取成功）', r.status === 200 && r.body.type === 'markdown');

r = await create({ dir: '笔记', kind: 'md', name: '验收新建讲稿.md' });
check('重复文档返回 409', r.status === 409 && r.body.exists === true, String(r.status));
fs.writeFileSync(path.join(A, '笔记', '验收旁注占用.md.meta.json'), '{}');
r = await create({ dir: '笔记', kind: 'md', name: '验收旁注占用' });
check('仅旁注已存在也返回 409', r.status === 409 && !fs.existsSync(path.join(A, '笔记', '验收旁注占用.md')), String(r.status));

r = await create({ dir: '', kind: 'folder', name: NEWDIR });
check('新建文件夹成功', r.status === 200 && fs.statSync(path.join(A, NEWDIR)).isDirectory(), JSON.stringify(r.body));
r = await j('/api/tree');
check('空文件夹出现在目录树', r.body.tree.dirs.some(d => d.path === NEWDIR));
r = await create({ dir: '', kind: 'folder', name: NEWDIR });
check('重复文件夹返回 409', r.status === 409, String(r.status));
r = await create({ dir: NEWDIR, title: '默认类型文档' });
check('在新文件夹内建文档，类型默认文章', r.status === 200 && JSON.parse(fs.readFileSync(path.join(A, NEWDIR, '默认类型文档.md.meta.json'), 'utf8')).type === '文章', JSON.stringify(r.body));

r = await create({ dir: '../', kind: 'md', name: '越界' });
check('目录含 .. 被拒绝', r.status === 400, String(r.status));
r = await create({ dir: '笔记/../../', kind: 'md', name: '越界' });
check('嵌套 .. 被拒绝', r.status === 400, String(r.status));
r = await create({ dir: '/tmp', kind: 'md', name: '越界' });
check('绝对路径被拒绝', r.status === 400, String(r.status));
r = await create({ dir: 'C:\\Windows', kind: 'md', name: '越界' });
check('Windows 绝对路径被拒绝', r.status === 400, String(r.status));
fs.symlinkSync(fs.realpathSync(os.tmpdir()), path.join(A, '笔记', '验收逃逸链接'));
r = await create({ dir: '笔记/验收逃逸链接', kind: 'md', name: '越界' });
check('符号链接逃逸被拒绝', r.status === 403, String(r.status));
fs.rmSync(path.join(A, '笔记', '验收逃逸链接'), { force: true });

for (const bad of ['a/b', '..\\evil', 'CON', 'lpt1.md', 'x?y', '名称.', '.hidden', '   ']) {
  r = await create({ dir: '笔记', kind: 'md', name: bad });
  check('非法名称被拒绝: ' + JSON.stringify(bad), r.status === 400, String(r.status));
}
r = await create({ dir: '笔记', kind: 'folder', name: 'a:b' });
check('非法文件夹名被拒绝', r.status === 400, String(r.status));
r = await create({ dir: '笔记', kind: 'md', name: '类型错误', docType: '小说' });
check('非法文档类型被拒绝', r.status === 400, String(r.status));
r = await create({ dir: '不存在的目录', kind: 'md', name: '找不到' });
check('目标目录不存在返回 404', r.status === 404, String(r.status));
r = await post('/api/file/create', { dsId: 'stale000', dir: '', kind: 'md', name: '旧数据源' });
check('旧 dsId 新建被拒绝', r.status === 409 && r.body.stale === true, String(r.status));
cleanup();
await post('/api/rescan');

console.log('== 12. 重命名 / 移动 / 删除 / 元数据问题 ==');
const N = (p) => path.join(A, ...p.split('/'));
const created12 = ['笔记/验收改名源.md', '笔记/验收改名后.md', '资料库/验收改名后.md', '笔记/验收标题保留.md', '笔记/验收标题保留2.md',
  '笔记/验收占位.md', '笔记/验收冲突.md', '资料库/验收冲突.md', '验收文件夹', '验收文件夹2', '笔记/验收文件夹2',
  '笔记/验收孤立.md', '笔记/验收外移.md', '资料库/验收外移.md'];
const cleanup12 = () => {
  for (const p of created12) { fs.rmSync(N(p), { recursive: true, force: true }); fs.rmSync(N(p) + '.meta.json', { force: true }); }
  fs.rmSync(path.join(A, '.trash'), { recursive: true, force: true });
};
cleanup12();
const readMeta = (rel) => { try { return JSON.parse(fs.readFileSync(N(rel) + '.meta.json', 'utf8')); } catch { return null; } };
const op = (name, body) => post('/api/file/' + name, { dsId: dsA2, ...body });
const treePaths = async () => {
  const t = await j('/api/tree'); const files = [], dirs = [];
  (function walk(n) { n.files.forEach(f => files.push(f.path)); n.dirs.forEach(d => { dirs.push(d.path); walk(d); }); })(t.body.tree);
  return { files, dirs };
};

await create({ dir: '笔记', name: '验收改名源', docType: '知乎' });
const id1 = readMeta('笔记/验收改名源.md')?.id;
r = await op('rename', { path: '笔记/验收改名源.md', newName: '验收改名后' });
check('重命名文档成功（自动保留 .md）', r.status === 200 && r.body.path === '笔记/验收改名后.md', JSON.stringify(r.body));
check('旧文档与旧旁注已不存在', !fs.existsSync(N('笔记/验收改名源.md')) && !fs.existsSync(N('笔记/验收改名源.md') + '.meta.json'));
let m1 = readMeta('笔记/验收改名后.md');
check('旁注随重命名且 id 不变', !!m1 && m1.id === id1 && m1.type === '知乎');
check('标题等于旧文件名主体时随之更新', m1?.title === '验收改名后' && r.body.titleUpdated === true, JSON.stringify(m1?.title));

await create({ dir: '笔记', name: '验收标题保留', title: '自定义标题 子丑寅' });
r = await op('rename', { path: '笔记/验收标题保留.md', newName: '验收标题保留2.md' });
const m2 = readMeta('笔记/验收标题保留2.md');
check('自定义标题在重命名后保持不变', r.status === 200 && m2?.title === '自定义标题 子丑寅' && r.body.titleUpdated === false, JSON.stringify(r.body));

r = await op('rename', { path: '笔记/验收改名后.md', newName: '验收标题保留2' });
check('重命名目标文档已存在返回 409', r.status === 409 && fs.existsSync(N('笔记/验收改名后.md')), String(r.status));
fs.writeFileSync(N('笔记/验收占位.md') + '.meta.json', '{}');
r = await op('rename', { path: '笔记/验收改名后.md', newName: '验收占位' });
check('重命名目标旁注已存在返回 409（源不变）', r.status === 409 && fs.existsSync(N('笔记/验收改名后.md')) && readMeta('笔记/验收改名后.md')?.id === id1, String(r.status));
fs.rmSync(N('笔记/验收占位.md') + '.meta.json', { force: true });

r = await op('move', { path: '笔记/验收改名后.md', targetDir: '资料库' });
check('移动文档成功', r.status === 200 && r.body.path === '资料库/验收改名后.md', JSON.stringify(r.body));
check('旁注随移动且 id 不变', readMeta('资料库/验收改名后.md')?.id === id1 && !fs.existsSync(N('笔记/验收改名后.md') + '.meta.json'));
let tp = await treePaths();
check('目录树已更新到新位置', tp.files.includes('资料库/验收改名后.md') && !tp.files.includes('笔记/验收改名后.md'));
r = await j('/api/search?q=' + encodeURIComponent('验收改名源'));
check('移动后检索指向新路径', r.body.results?.some(x => x.file.path === '资料库/验收改名后.md') && !r.body.results?.some(x => x.file.path.startsWith('笔记/验收改名')), JSON.stringify(r.body.results?.map(x => x.file.path)));
r = await op('move', { path: '资料库/验收改名后.md', targetDir: '资料库' });
check('移动到原目录被拒绝', r.status === 400, String(r.status));
await create({ dir: '笔记', name: '验收冲突' });
await create({ dir: '资料库', name: '验收冲突' });
r = await op('move', { path: '笔记/验收冲突.md', targetDir: '资料库' });
check('移动目标已存在返回 409', r.status === 409 && fs.existsSync(N('笔记/验收冲突.md')), String(r.status));
fs.rmSync(N('资料库/验收冲突.md'), { force: true });
r = await op('move', { path: '笔记/验收冲突.md', targetDir: '资料库' });
check('移动目标仅旁注存在也返回 409', r.status === 409 && fs.existsSync(N('笔记/验收冲突.md')), String(r.status));

await create({ dir: '', kind: 'folder', name: '验收文件夹' });
await create({ dir: '验收文件夹', name: '内部文档' });
const idIn = readMeta('验收文件夹/内部文档.md')?.id;
r = await op('rename', { path: '验收文件夹', newName: '验收文件夹2' });
check('重命名文件夹（内容与旁注随行）', r.status === 200 && fs.existsSync(N('验收文件夹2/内部文档.md')) && readMeta('验收文件夹2/内部文档.md')?.id === idIn, JSON.stringify(r.body));
r = await op('move', { path: '验收文件夹2', targetDir: '验收文件夹2' });
check('文件夹移入自身被拒绝', r.status === 400, String(r.status));
r = await op('move', { path: '验收文件夹2', targetDir: '笔记' });
check('移动文件夹（内容与旁注随行）', r.status === 200 && readMeta('笔记/验收文件夹2/内部文档.md')?.id === idIn, JSON.stringify(r.body));
tp = await treePaths();
check('目录树含移动后的文件夹内容', tp.files.includes('笔记/验收文件夹2/内部文档.md') && !tp.dirs.includes('验收文件夹2'));

for (const [name, body, want] of [
  ['rename', { path: '../外部.md', newName: 'x' }, 400],
  ['rename', { path: '/etc/hosts', newName: 'x' }, 400],
  ['rename', { path: '资料库/验收改名后.md', newName: '../逃逸' }, 400],
  ['rename', { path: '资料库/验收改名后.md', newName: 'CON' }, 400],
  ['rename', { path: '资料库/验收改名后.md.meta.json', newName: 'x' }, 400],
  ['move', { path: '资料库/验收改名后.md', targetDir: '../' }, 400],
  ['move', { path: '资料库/验收改名后.md', targetDir: '/tmp' }, 400],
  ['move', { path: '资料库/验收改名后.md', targetDir: '.trash' }, 400],
  ['delete', { path: '..' }, 400],
  ['delete', { path: '' }, 400],
  ['delete', { path: '笔记/../../x' }, 400],
  ['delete', { path: '笔记/不存在.md' }, 404],
]) {
  r = await op(name, body);
  check(`拒绝 ${name} ${JSON.stringify(body)} → ${want}`, r.status === want, String(r.status));
}
r = await post('/api/file/rename', { dsId: 'stale000', path: '资料库/验收改名后.md', newName: 'y' });
check('旧 dsId 重命名被拒绝', r.status === 409 && r.body.stale === true);

r = await op('delete', { path: '资料库/验收改名后.md' });
check('删除文档成功（移入 .trash）', r.status === 200 && r.body.trashedTo === 'local' && r.body.sidecar === true, JSON.stringify(r.body));
const batch = r.body.trashPath ? path.join(A, ...r.body.trashPath.split('/')) : '';
check('文档与旁注出现在 .trash 批次目录', !!batch && fs.existsSync(path.join(batch, '验收改名后.md')) && fs.existsSync(path.join(batch, '验收改名后.md.meta.json')));
check('批次目录含来源说明', (() => { try { return JSON.parse(fs.readFileSync(path.join(batch, '.trashinfo.json'), 'utf8')).originalPath === '资料库/验收改名后.md'; } catch { return false; } })());
check('原位置文档与旁注已不存在', !fs.existsSync(N('资料库/验收改名后.md')) && !fs.existsSync(N('资料库/验收改名后.md') + '.meta.json'));
tp = await treePaths();
check('删除后目录树不含该文档，也不含 .trash', !tp.files.includes('资料库/验收改名后.md') && !tp.files.some(p => p.startsWith('.trash')) && !tp.dirs.some(d => d.startsWith('.trash')));
r = await j('/api/search?q=' + encodeURIComponent('验收改名源'));
check('删除后检索无结果（回收站不被索引）', r.body.results?.length === 0, JSON.stringify(r.body.results?.map(x => x.file.path)));
r = await op('delete', { path: '笔记/验收文件夹2' });
check('删除文件夹移入 .trash（含内容）', r.status === 200 && fs.existsSync(path.join(A, ...r.body.trashPath.split('/'), '验收文件夹2', '内部文档.md.meta.json')) && !fs.existsSync(N('笔记/验收文件夹2')), JSON.stringify(r.body));

fs.writeFileSync(N('笔记/验收孤立.md') + '.meta.json', JSON.stringify({ id: 'doc_orphan_acceptance' }));
await create({ dir: '笔记', name: '验收外移' });
const idOut = readMeta('笔记/验收外移.md')?.id;
fs.renameSync(N('笔记/验收外移.md'), N('资料库/验收外移.md')); // 模拟在应用外移动（旁注留在原处）
await post('/api/rescan');
r = await j('/api/meta/issues');
const iss = r.body.issues || [];
check('报告孤立旁注', iss.some(i => i.kind === 'orphan' && i.sidecar === '笔记/验收孤立.md.meta.json' && i.id === 'doc_orphan_acceptance'), JSON.stringify(iss));
check('报告疑似外部移动（同 id 旁注在原处）', iss.some(i => i.kind === 'moved' && i.sidecar === '笔记/验收外移.md.meta.json' && i.id === idOut && i.candidates.includes('资料库/验收外移.md')), JSON.stringify(iss));
check('无旁注的普通文档不算问题', iss.every(i => JSON.stringify(i).includes('验收')), JSON.stringify(iss));
check('问题报告不做任何修改', fs.existsSync(N('笔记/验收孤立.md') + '.meta.json') && fs.existsSync(N('笔记/验收外移.md') + '.meta.json'));
cleanup12();
await post('/api/rescan');
r = await j('/api/meta/issues');
check('清理后问题列表为空', r.body.total === 0, JSON.stringify(r.body.issues));

console.log('== 13. 元数据导入 ==');
r = await post('/api/config', { baseDir: A });
const ds13 = r.body.dsId;
const N13 = (p) => path.join(A, ...p.split('/'));
const sidecars13 = ['笔记/第1章 入门.md', '笔记/第2章 进阶.md', '资料库/同名文件.md', 'word/报告 2024.docx'].map((p) => p + '.meta.json');
const cleanup13 = () => sidecars13.forEach((p) => fs.rmSync(N13(p), { force: true }));
cleanup13();
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const readM13 = (rel) => JSON.parse(fs.readFileSync(N13(rel) + '.meta.json', 'utf8'));
const imp = (body) => post('/api/meta/import', { dsId: ds13, ...body });
const jsonlA = [
  JSON.stringify({ path: '笔记/第1章 入门.md', title: '入门讲稿（AI 拟）', type: '讲稿', date: '2024-05', source_url: 'https://example.com/a', tags: ['x'], confidence: { title: 0.9 }, notes: '依据正文首段' }),
  JSON.stringify({ path: 'word/报告 2024.docx' }),
].join('\n');
const docBefore13 = Object.fromEntries(['笔记/第1章 入门.md', 'word/报告 2024.docx'].map((p) => [p, sha256(N13(p))]));

// (a) 预览：不写盘
r = await imp({ jsonl: jsonlA, mode: 'preview' });
check('预览 create=2 且无错误', r.status === 200 && r.body.mode === 'preview' && r.body.overwrite === false &&
  r.body.summary.lines === 2 && r.body.summary.valid === 2 && r.body.summary.create === 2 && r.body.summary.errors === 0, JSON.stringify(r.body.summary));
check('预览不写任何旁注', sidecars13.every((p) => !fs.existsSync(N13(p))));
const itDocx = r.body.items.find((i) => i.path === 'word/报告 2024.docx');
check('docx 标题默认为文件名主体', itDocx?.action === 'create' && itDocx?.fields?.title === '报告 2024' && itDocx?.fields?.type === '' && itDocx?.fields?.date === '', JSON.stringify(itDocx));
const it1 = r.body.items.find((i) => i.path === '笔记/第1章 入门.md');
check('items 含置信度/备注且不含 id/created_at/content_hash', it1?.confidence?.title === 0.9 && it1?.notes === '依据正文首段' &&
  it1?.fields && !('id' in it1.fields) && !('created_at' in it1.fields) && !('content_hash' in it1.fields), JSON.stringify(it1));

// (b) 应用：写入旁注，文档字节不变
r = await imp({ jsonl: jsonlA, mode: 'apply' });
check('apply 写入 2 个旁注', r.status === 200 && r.body.summary.written === 2 && r.body.summary.create === 2 && r.body.summary.errors === 0, JSON.stringify(r.body.summary));
check('旁注文件已存在', fs.existsSync(N13('笔记/第1章 入门.md.meta.json')) && fs.existsSync(N13('word/报告 2024.docx.meta.json')));
const m13 = readM13('笔记/第1章 入门.md');
const vm13 = validateMeta(m13);
check('旁注通过 meta.schema.json 校验', vm13.ok, JSON.stringify(vm13.errors));
check('id/created_at 形如预期', /^doc_[0-9a-f-]{36}$/.test(m13.id) && !isNaN(Date.parse(m13.created_at)));
check('content_hash 与文档字节一致', m13.content_hash === 'sha256:' + sha256(N13('笔记/第1章 入门.md')));
check('confidence/notes/path 不写入旁注', !('confidence' in m13) && !('notes' in m13) && !('path' in m13));
check('字段值正确写入', m13.title === '入门讲稿（AI 拟）' && m13.type === '讲稿' && m13.date === '2024-05' && m13.source_url === 'https://example.com/a' && JSON.stringify(m13.tags) === '["x"]' && Array.isArray(m13.aliases));
const mDocx13 = readM13('word/报告 2024.docx');
check('docx 旁注默认字段且哈希一致', validateMeta(mDocx13).ok && mDocx13.title === '报告 2024' && mDocx13.type === '' && mDocx13.date === '' && mDocx13.source_url === '' && mDocx13.content_hash === 'sha256:' + sha256(N13('word/报告 2024.docx')), JSON.stringify(mDocx13));
check('文档字节保持不变', ['笔记/第1章 入门.md', 'word/报告 2024.docx'].every((p) => sha256(N13(p)) === docBefore13[p]));

// (c) 幂等
r = await imp({ jsonl: jsonlA, mode: 'apply' });
check('重复 apply 幂等（written 0 / skip 2）', r.body.summary.written === 0 && r.body.summary.skip === 2 && r.body.summary.create === 0, JSON.stringify(r.body.summary));
check('跳过原因正确', r.body.items.every((i) => i.action === 'skip' && i.reason === '已有元数据，未覆盖'));

// (d) 逐行错误：坏 JSON / 非法字段值 / 多余字段 / 缺 path
const jsonlD = [
  JSON.stringify({ path: '笔记/第2章 进阶.md', title: '进阶（AI 拟）' }),
  '{"path": "笔记/第2章 进阶.md", "title": ',
  JSON.stringify({ path: '笔记/第2章 进阶.md', type: '小说' }),
  JSON.stringify({ path: '笔记/第2章 进阶.md', date: '2024-13' }),
  JSON.stringify({ path: '笔记/第2章 进阶.md', source_url: 'not a url' }),
  JSON.stringify({ path: '笔记/第2章 进阶.md', id: 'doc_x' }),
  JSON.stringify({ path: '笔记/第2章 进阶.md', aliases: ['a', 'a'] }),
  JSON.stringify({ path: '笔记/第2章 进阶.md', confidence: { title: 2 } }),
  JSON.stringify({ title: '缺路径' }),
].join('\n');
r = await imp({ jsonl: jsonlD, mode: 'preview' });
check('坏行逐条报告且行号正确', r.body.summary.errors === 8 && r.body.summary.create === 1 &&
  JSON.stringify(r.body.errors.map((e) => e.line)) === '[2,3,4,5,6,7,8,9]', JSON.stringify(r.body.errors.map((e) => e.line)));
check('错误信息指向具体字段', r.body.errors.some((e) => e.line === 3 && e.error.includes('/type')) && r.body.errors.some((e) => e.line === 4 && e.error.includes('/date')) &&
  r.body.errors.some((e) => e.line === 6 && e.error.includes('id')) && r.body.errors.some((e) => e.line === 9 && e.error.includes('path')), JSON.stringify(r.body.errors));
check('同批有效行仍被处理', r.body.items.length === 1 && r.body.items[0].path === '笔记/第2章 进阶.md' && r.body.items[0].action === 'create');

// (e) 路径类错误：未知 / 越界 / 反斜杠 / 旁注本身 / 重复
const jsonlE = [
  JSON.stringify({ path: '笔记/不存在.md' }),
  JSON.stringify({ path: '../ds-b/笔记/第1章 入门.md' }),
  JSON.stringify({ path: '/etc/hosts' }),
  JSON.stringify({ path: '笔记\\第2章 进阶.md' }),
  JSON.stringify({ path: '笔记/第1章 入门.md.meta.json' }),
  JSON.stringify({ path: '资料库/同名文件.md' }),
  JSON.stringify({ path: '资料库/同名文件.md' }),
].join('\n');
r = await imp({ jsonl: jsonlE, mode: 'preview' });
check('未知路径报错', r.body.errors.some((e) => e.line === 1 && e.error.includes('不存在')), JSON.stringify(r.body.errors));
check('越界/绝对/反斜杠路径一律拒绝', [2, 3, 4].every((n) => r.body.errors.some((e) => e.line === n && e.error.includes('path 越界'))), JSON.stringify(r.body.errors));
check('旁注路径本身报错', r.body.errors.some((e) => e.line === 5 && e.error.includes('元数据')));
check('重复 path 第二次报错且首次有效', r.body.errors.some((e) => e.line === 7 && e.error.includes('重复')) && r.body.summary.create === 1, JSON.stringify(r.body.summary));

// (f) 覆盖合并：id/created_at 不变，只合并提供字段
const jsonlF1 = JSON.stringify({ path: '笔记/第1章 入门.md', title: '不会被写入' });
r = await imp({ jsonl: jsonlF1, mode: 'apply', overwrite: false });
check('已有旁注且不覆盖 → 跳过', r.body.summary.written === 0 && r.body.summary.skip === 1 && readM13('笔记/第1章 入门.md').title === '入门讲稿（AI 拟）', JSON.stringify(r.body.summary));
const before13 = readM13('笔记/第1章 入门.md');
const jsonlF2 = JSON.stringify({ path: '笔记/第1章 入门.md', tags: ['y', 'z'] });
r = await imp({ jsonl: jsonlF2, mode: 'preview', overwrite: true });
check('覆盖模式预览 update 仅变化字段', r.body.summary.update === 1 && JSON.stringify(Object.keys(r.body.items[0].fields || {})) === '["tags"]' &&
  JSON.stringify(r.body.items[0].fields?.tags?.to) === '["y","z"]', JSON.stringify(r.body.items[0]));
r = await imp({ jsonl: jsonlF2, mode: 'apply', overwrite: true });
check('覆盖更新写入 1 个', r.body.summary.written === 1 && r.body.summary.update === 1, JSON.stringify(r.body.summary));
const after13 = readM13('笔记/第1章 入门.md');
check('id/created_at/其余字段保持不变', after13.id === before13.id && after13.created_at === before13.created_at && after13.title === before13.title &&
  after13.type === '讲稿' && after13.date === '2024-05' && after13.source_url === before13.source_url, JSON.stringify(after13));
check('tags 已合并为 y,z', JSON.stringify(after13.tags) === '["y","z"]');
r = await imp({ jsonl: jsonlF2, mode: 'apply', overwrite: true });
check('重复覆盖导入 → 无变化跳过', r.body.summary.written === 0 && r.body.summary.skip === 1 && r.body.items[0]?.reason === '无变化', JSON.stringify(r.body.summary));

// (g) 参数校验
r = await post('/api/meta/import', { dsId: 'stale000', jsonl: jsonlA, mode: 'preview' });
check('旧 dsId 导入被拒绝', r.status === 409 && r.body.stale === true, String(r.status));
r = await imp({ jsonl: jsonlA, mode: 'bogus' });
check('非法 mode 返回 400', r.status === 400, String(r.status));
r = await imp({ jsonl: 123, mode: 'preview' });
check('jsonl 非字符串返回 400', r.status === 400, String(r.status));

// (h) 收尾：树隐藏旁注，清理后无问题
r = await j('/api/tree'); // 此时旁注仍在磁盘（最近一次 apply 已重扫）
const paths13 = [];
(function walk(n) { n.files.forEach((f) => paths13.push(f.path)); n.dirs.forEach(walk); })(r.body.tree);
check('导入后目录树仍隐藏 .meta.json', paths13.includes('笔记/第1章 入门.md') && !paths13.some((p) => p.endsWith('.meta.json')));
cleanup13();
await post('/api/rescan');
r = await j('/api/meta/issues');
check('清理后问题列表为空', r.body.total === 0, JSON.stringify(r.body.issues));

console.log('== 14. 主题 ==');
// (a) 变量与内联脚本检查：读主题 CSS 源文件与 index.html 源
const themeCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'themes.css'), 'utf8');
const REQUIRED_VARS = ['--background', '--foreground', '--card', '--primary', '--primary-foreground', '--muted', '--muted-foreground',
  '--accent', '--border', '--input', '--ring', '--radius', '--sidebar-background', '--sidebar-foreground', '--sidebar-accent',
  '--sidebar-border', '--font-ui', '--font-serif', '--wb-chrome', '--wb-hl'];
const blockVars = {};
for (const key of ['A', 'B', 'C']) {
  const sel = ':root:where\\(' + '\\[data-theme="' + key + '"\\]' + '\\)|:root' + '\\[data-theme="' + key + '"\\]';
  const re = new RegExp('(' + sel + ')\\s*\\{([\\s\\S]*?)\\n\\s*\\}');
  const m = themeCss.match(re);
  check('主题 ' + key + ' 变量块存在', !!m);
  if (m) {
    const decls = m[2];
    blockVars[key] = {};
    for (const line of decls.split('\n')) {
      const dm = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/);
      if (dm) blockVars[key][dm[1]] = dm[2].trim();
    }
    const missing = REQUIRED_VARS.filter((v) => !(v in blockVars[key]));
    check('主题 ' + key + ' 定义全部必需变量', missing.length === 0, '缺少: ' + missing.join(','));
  }
}
check('三主题 --primary 互不相同', blockVars.A && blockVars.B && blockVars.C &&
  new Set([blockVars.A['--primary'], blockVars.B['--primary'], blockVars.C['--primary']]).size === 3);
check('三主题 --background 互不相同', blockVars.A && blockVars.B && blockVars.C &&
  new Set([blockVars.A['--background'], blockVars.B['--background'], blockVars.C['--background']]).size === 3);
const cBg = blockVars.C && (blockVars.C['--background'] || '').match(/([\d.]+)%\s*$/);
check('C 的 --background 为深色（亮度 < 20%）', !!cBg && parseFloat(cBg[1]) < 20, String(cBg && cBg[1]));
const indexHtmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
check('index.html 内联脚本读取 wb:theme', indexHtmlSrc.includes("'wb:theme'") && indexHtmlSrc.includes('dataset.theme'));

// (b) 独立服务进程：临时数据目录 + 静态目录（最小 index.html 夹具），验证持久化与注入
const THEME_PORT = 7499;
const TB = 'http://127.0.0.1:' + THEME_PORT;
const themeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-theme-data-'));
const themeStaticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-theme-static-'));
fs.writeFileSync(path.join(themeStaticDir, 'index.html'),
  '<!doctype html><html lang="zh-CN"><head><script>/*wb-theme*/</script></head><body><div id="root"></div></body></html>');
let themeChild = null;
const stopThemeChild = () => {
  if (themeChild && !themeChild.killed) { try { themeChild.kill('SIGKILL'); } catch { /* ignore */ } }
  themeChild = null;
};
const waitThemeApi = async () => {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(TB + '/api/ui-settings'); if (r.ok) return; } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 10000) throw new Error('主题服务等待超时');
    await new Promise((s) => setTimeout(s, 200));
  }
};
const spawnThemeServer = async () => {
  themeChild = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, WORKBENCH_PORT: String(THEME_PORT), WORKBENCH_HOST: '127.0.0.1', WORKBENCH_DATA_DIR: themeDataDir, WORKBENCH_STATIC_DIR: themeStaticDir },
    stdio: 'ignore',
  });
  await waitThemeApi();
};
const tJson = async (url, init) => {
  const r = await fetch(TB + url, init);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const tPut = (url, body) => tJson(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const tHtml = async (url) => (await fetch(TB + url)).text();
try {
  await spawnThemeServer();
  let tr = await tJson('/api/ui-settings');
  check('默认主题为 A', tr.body.theme === 'A', JSON.stringify(tr.body));
  let th = await tHtml('/');
  check('GET / 注入 data-theme="A"', th.includes('data-theme="A"') && th.includes('__WB_THEME__="A"'));
  tr = await tPut('/api/ui-settings', { theme: 'C' });
  check('PUT theme=C 成功', tr.status === 200 && tr.body.ok === true && tr.body.theme === 'C', JSON.stringify(tr.body));
  tr = await tPut('/api/ui-settings', { theme: 'Z' });
  check('PUT theme=Z 返回 400', tr.status === 400, String(tr.status));
  // 重启同一数据目录：持久化与注入均应回到 C
  stopThemeChild();
  await new Promise((s) => setTimeout(s, 300));
  await spawnThemeServer();
  tr = await tJson('/api/ui-settings');
  check('重启后主题仍为 C', tr.body.theme === 'C', JSON.stringify(tr.body));
  th = await tHtml('/');
  check('重启后 GET / 注入 data-theme="C" 且挂 dark 类', th.includes('data-theme="C"') && th.includes('class="dark"'));
  th = await tHtml('/some/spa/route');
  check('SPA 路由回退同样注入 C + dark', th.includes('data-theme="C"') && th.includes('class="dark"'));
  th = await tHtml('/read/a/b.md');
  const baseCount = th.split('<base href="/">').length - 1;
  check('深链 HTML 注入 <base href="/">（恰一次）', baseCount === 1, '次数: ' + baseCount);
  const asset404 = await fetch(TB + '/some/deep/assets/x.js');
  check('缺失静态资源（.js）返回 404 而非 SPA HTML', asset404.status === 404, String(asset404.status));
  const saved = JSON.parse(fs.readFileSync(path.join(themeDataDir, 'ui-settings.json'), 'utf8'));
  check('持久化文件 ui-settings.json 含 theme C', saved.theme === 'C', JSON.stringify(saved));
} finally {
  stopThemeChild();
  fs.rmSync(themeDataDir, { recursive: true, force: true });
  fs.rmSync(themeStaticDir, { recursive: true, force: true });
}

console.log('== 15. 编辑器字节一致 ==');
// 指向临时副本，避免碰仓库内 test-data；结束后切回 A 并删除临时目录
const tmp15 = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fmt-'));
const tmpRoot15 = path.join(tmp15, 'test-data');
fs.cpSync(path.join(ROOT, 'test-data'), tmpRoot15, { recursive: true });
const T15 = (ds, ...p) => path.join(tmpRoot15, ds, ...p);
const sha256b = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const listMd = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.md')) out.push(f);
    }
  };
  walk(dir);
  return out.sort();
};
const tempDsIds = [];
const sourcesDir15 = path.join(dataDir(), 'sources'); // 随 WORKBENCH_DATA_DIR，可在临时数据目录上验收
try {
  // (a) ds-fmt：GET→PUT 全量往返，字节一致（含 BOM / CRLF / 混行尾 / 无末尾换行）
  r = await post('/api/config', { baseDir: T15('ds-fmt') });
  tempDsIds.push(r.body.dsId);
  check('切换到临时 ds-fmt（9 个 md）', r.body.ok && r.body.status.counts.md === 9, JSON.stringify(r.body.status?.counts));
  const dsFmt = r.body.dsId;
  let rtOk = 0;
  let rtTotal = 0;
  for (const abs of listMd(T15('ds-fmt'))) {
    const rel = path.relative(T15('ds-fmt'), abs).split(path.sep).join('/');
    rtTotal++;
    const before = fs.readFileSync(abs);
    const g = await j('/api/file?path=' + encodeURIComponent(rel));
    const p = await put('/api/file', { path: rel, content: g.body.content, baseMtimeMs: g.body.mtimeMs, dsId: dsFmt });
    const after = fs.readFileSync(abs);
    if (p.body.ok === true && sha256b(before) === sha256b(after)) rtOk++;
    else check('ds-fmt 往返一致: ' + rel, false, JSON.stringify(p.body).slice(0, 120));
  }
  check('ds-fmt 全部 .md 打开→不改→保存 字节一致', rtOk === rtTotal && rtTotal === 9, `${rtOk}/${rtTotal}`);

  // (b) ds-a / ds-b 全量 + ds-perf 抽样 20
  for (const [ds, limit] of [['ds-a', Infinity], ['ds-b', Infinity], ['ds-perf', 20]]) {
    const cr = await post('/api/config', { baseDir: T15(ds) });
    tempDsIds.push(cr.body.dsId);
    const dsIdX = cr.body.dsId;
    const files = listMd(T15(ds)).slice(0, limit === Infinity ? undefined : limit);
    let ok = 0;
    for (const abs of files) {
      const rel = path.relative(T15(ds), abs).split(path.sep).join('/');
      const before = fs.readFileSync(abs);
      const g = await j('/api/file?path=' + encodeURIComponent(rel));
      const p = await put('/api/file', { path: rel, content: g.body.content, baseMtimeMs: g.body.mtimeMs, dsId: dsIdX });
      const after = fs.readFileSync(abs);
      if (p.body.ok === true && sha256b(before) === sha256b(after)) ok++;
    }
    check(`${ds} 抽样往返字节一致（${files.length} 个）`, ok === files.length, `${ok}/${files.length}`);
  }

  // (c) 单字符编辑：仅改中段，前后缀不变，长度 +1
  r = await post('/api/config', { baseDir: T15('ds-fmt') });
  tempDsIds.push(r.body.dsId);
  const dsFmt2 = r.body.dsId;
  for (const name of ['crlf.md', 'mixed-eol.md']) {
    const abs = T15('ds-fmt', name);
    const beforeBuf = fs.readFileSync(abs);
    const g = await j('/api/file?path=' + encodeURIComponent(name));
    const s = g.body.content;
    const mid = Math.floor(s.length / 2);
    const edited = s.slice(0, mid) + '字' + s.slice(mid);
    const p = await put('/api/file', { path: name, content: edited, baseMtimeMs: g.body.mtimeMs, dsId: dsFmt2 });
    const afterStr = fs.readFileSync(abs, 'utf8');
    check(`单字符插入仅改中段: ${name}`, p.body.ok === true && afterStr === edited && afterStr.startsWith(s.slice(0, mid)) && afterStr.endsWith(s.slice(mid)) && afterStr.length === s.length + 1, JSON.stringify(p.body).slice(0, 80));
    const p2 = await put('/api/file', { path: name, content: s, baseMtimeMs: p.body.mtimeMs, dsId: dsFmt2 });
    check(`编辑后可还原: ${name}`, p2.body.ok === true && fs.readFileSync(abs).equals(beforeBuf));
  }

  // (d) 旁注 content_hash：有则更新（仅哈希字段、保持键序与缩进），无则不创建，非法不动
  fs.writeFileSync(T15('ds-fmt', 'bom.md.meta.json'), JSON.stringify({ id: 'doc_fmt_bom', title: 'BOM 样例', aliases: ['bom'], content_hash: 'sha256:old' }, null, 2) + '\n');
  {
    const abs = T15('ds-fmt', 'bom.md');
    const g = await j('/api/file?path=' + encodeURIComponent('bom.md'));
    const edited = g.body.content + '\n追加一行。\n';
    const p = await put('/api/file', { path: 'bom.md', content: edited, baseMtimeMs: g.body.mtimeMs, dsId: dsFmt2 });
    const wroteBuf = fs.readFileSync(abs);
    const sidecarRaw = fs.readFileSync(T15('ds-fmt', 'bom.md.meta.json'), 'utf8');
    const meta = JSON.parse(sidecarRaw);
    check('保存后旁注 content_hash 更新为实际字节哈希（含 BOM）', p.body.ok === true && meta.content_hash === 'sha256:' + sha256b(wroteBuf), JSON.stringify(meta));
    check('旁注其余键与顺序保持', Object.keys(meta).join(',') === 'id,title,aliases,content_hash' && meta.id === 'doc_fmt_bom' && meta.title === 'BOM 样例');
    check('旁注保持原缩进格式', /^{\n  "id"/.test(sidecarRaw));
    const g2 = await j('/api/file?path=' + encodeURIComponent('crlf.md'));
    const p2 = await put('/api/file', { path: 'crlf.md', content: g2.body.content, baseMtimeMs: g2.body.mtimeMs, dsId: dsFmt2 });
    check('无旁注文件保存后不创建旁注', p2.body.ok && !fs.existsSync(T15('ds-fmt', 'crlf.md.meta.json')));
    fs.writeFileSync(T15('ds-fmt', 'tabs.md.meta.json'), '{ 不是 JSON');
    const g3 = await j('/api/file?path=' + encodeURIComponent('tabs.md'));
    const p3 = await put('/api/file', { path: 'tabs.md', content: g3.body.content + '\n补一行\n', baseMtimeMs: g3.body.mtimeMs, dsId: dsFmt2 });
    check('非法旁注保持原样且不影响保存', p3.body.ok === true && fs.readFileSync(T15('ds-fmt', 'tabs.md.meta.json'), 'utf8') === '{ 不是 JSON');
  }

  // (e) 编辑备份随重命名 / 移动迁移
  r = await post('/api/config', { baseDir: T15('ds-a') });
  tempDsIds.push(r.body.dsId);
  const dsA15 = r.body.dsId;
  const bdir15 = path.join(sourcesDir15, dsA15, 'backups');
  fs.rmSync(bdir15, { recursive: true, force: true });
  const t1 = '笔记/第1章 入门.md';
  const g1 = await j('/api/file?path=' + encodeURIComponent(t1));
  const s1 = await put('/api/file', { path: t1, content: g1.body.content + '\n备份触发行。\n', baseMtimeMs: g1.body.mtimeMs, dsId: dsA15 });
  check('保存生成备份', s1.body.ok === true && fs.readdirSync(path.join(bdir15, '笔记')).some((f) => f.startsWith('第1章 入门.md.') && f.endsWith('.bak')));
  r = await post('/api/file/rename', { dsId: dsA15, path: t1, newName: '第1章 改名' });
  check('重命名成功', r.body.ok === true && r.body.path === '笔记/第1章 改名.md', JSON.stringify(r.body));
  const baksOld = fs.readdirSync(path.join(bdir15, '笔记')).filter((f) => f.startsWith('第1章 入门.md.'));
  const baksNew = fs.readdirSync(path.join(bdir15, '笔记')).filter((f) => f.startsWith('第1章 改名.md.') && f.endsWith('.bak'));
  check('备份随重命名迁移（旧名不再有）', baksOld.length === 0 && baksNew.length >= 1, `${baksOld.length}/${baksNew.length}`);
  const stampSuffix = baksNew[0].slice('第1章 改名.md'.length);
  r = await post('/api/file/move', { dsId: dsA15, path: '笔记/第1章 改名.md', targetDir: '资料库' });
  check('移动成功', r.body.ok === true && r.body.path === '资料库/第1章 改名.md', JSON.stringify(r.body));
  check('备份随移动迁移到新目录', fs.readdirSync(path.join(bdir15, '资料库')).includes('第1章 改名.md' + stampSuffix) && !fs.existsSync(path.join(bdir15, '笔记', '第1章 改名.md' + stampSuffix)));
  check('旧备份目录随空清理', !fs.existsSync(path.join(bdir15, '笔记')));
} finally {
  for (const id of tempDsIds) fs.rmSync(path.join(sourcesDir15, id), { recursive: true, force: true });
  await post('/api/config', { baseDir: A });
  fs.rmSync(tmp15, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
