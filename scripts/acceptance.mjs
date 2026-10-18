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
const BASE = 'http://localhost:' + (process.env.WORKBENCH_PORT || 7410); // 主服务端口（可用环境变量错开他人占用）

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
const bakDir = path.join(dataDir(), 'sources', dsA, 'backups', '笔记');
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

// (a2) 原生控件主题化：滚动条/选区/accent 走主题令牌；设置页不再用原生 select
const indexCssSrc = fs.readFileSync(path.join(ROOT, 'src', 'index.css'), 'utf8');
check('全局滚动条样式存在（Chromium）', indexCssSrc.includes('::-webkit-scrollbar') && indexCssSrc.includes('::-webkit-scrollbar-thumb'));
check('全局滚动条样式存在（Firefox）', indexCssSrc.includes('scrollbar-width') && indexCssSrc.includes('scrollbar-color'));
check('滚动条拇指引用主题令牌', /::-webkit-scrollbar-thumb\s*\{[^}]*var\(--muted-foreground\)/s.test(indexCssSrc));
check('选区颜色引用主题令牌', /::selection\s*\{[^}]*var\(--primary\)/s.test(indexCssSrc));
check('原生表单控件 accent 引用主题令牌', /input\[type="range"\]\s*\{[^}]*accent-color:\s*hsl\(var\(--primary\)\)/s.test(indexCssSrc));
const settingsSrc = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'Settings.tsx'), 'utf8');
check('设置页无原生 select', !settingsSrc.includes('<select'));

// (a3) Logo 资产与集成
check('图标源文件存在（1024）', fs.existsSync(path.join(ROOT, 'assets', 'icons', 'icon.png')));
for (const s of [512, 192, 64, 32]) {
  check('public/logo-' + s + '.png 存在', fs.existsSync(path.join(ROOT, 'public', 'logo-' + s + '.png')));
}
check('index.html 引用 favicon', /rel="icon"[^>]*logo-32\.png/.test(indexHtmlSrc));
const electronMainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
check('Electron 窗口设置 icon', /icon:\s*path\.join\(ROOT,\s*'assets',\s*'icons',\s*'icon\.png'\)/.test(electronMainSrc));
const pkgSrc = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
check('electron-builder 配置 icon', /"icon"\s*:\s*"assets\/icons\/icon\.png"/.test(pkgSrc));
const layoutSrc = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Layout.tsx'), 'utf8');
check('顶栏渲染 logo 图片', /<img[^>]*logo-32\.png/.test(layoutSrc));

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

console.log('== 16. 自动内链与反向链接 ==');
// 独立服务 + 临时数据目录 + test-data 临时副本：不碰仓库内夹具与 server/data
{
  const PORT16 = 7498;
  const B16 = 'http://127.0.0.1:' + PORT16;
  const tmp16 = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-links-'));
  const corpus16 = path.join(tmp16, 'test-data');
  fs.cpSync(path.join(ROOT, 'test-data'), corpus16, { recursive: true });
  const DS = path.join(corpus16, 'ds-links');
  const PERF = path.join(corpus16, 'ds-perf');
  const dataDir16 = path.join(tmp16, 'data');
  const N16 = (...p) => path.join(DS, ...p);
  const j16 = async (url, init) => {
    const r = await fetch(B16 + url, init);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const post16 = (url, body) => j16(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const put16 = (url, body) => j16(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let child16 = null;
  const spawn16 = async () => {
    child16 = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: { ...process.env, WORKBENCH_PORT: String(PORT16), WORKBENCH_HOST: '127.0.0.1', WORKBENCH_DATA_DIR: dataDir16 },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child16.stderr.on('data', (d) => process.stderr.write('[srv16] ' + d));
    const t0 = Date.now();
    for (;;) {
      try { const r = await fetch(B16 + '/api/config'); if (r.ok) return; } catch { /* 未就绪 */ }
      if (Date.now() - t0 > 15000) throw new Error('§16 服务等待超时');
      await new Promise((s) => setTimeout(s, 200));
    }
  };
  const stop16 = async () => {
    if (child16 && !child16.killed) {
      try { child16.kill('SIGKILL'); } catch { /* ignore */ }
      child16 = null;
      await new Promise((s) => setTimeout(s, 300));
    }
  };
  const waitReady16 = async (timeout = 20000) => {
    const t0 = Date.now();
    for (;;) {
      const st = await j16('/api/links/status');
      if (st.body.ready) return st.body;
      if (Date.now() - t0 > timeout) throw new Error('链接索引就绪超时');
      await new Promise((s) => setTimeout(s, 200));
    }
  };
  const linksOf16 = async (p) => (await j16('/api/links/doc?path=' + encodeURIComponent(p))).body;
  const backOf16 = async (p) => (await j16('/api/links/backlinks?path=' + encodeURIComponent(p))).body;
  const contentOf16 = async (p) => (await j16('/api/file?path=' + encodeURIComponent(p))).body.content;
  const sha256dir16 = (dir) => {
    const out = {};
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(f, r);
        else out[r] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      }
    };
    walk(dir, '');
    return out;
  };

  try {
    await spawn16();
    let r16 = await post16('/api/config', { baseDir: DS });
    check('配置 ds-links 副本成功', r16.body.ok === true, JSON.stringify(r16.body).slice(0, 100));
    const ds16 = r16.body.dsId;
    const st16 = await waitReady16();
    check('链接索引就绪且统计非空', st16.ready && st16.files === 14 && st16.terms >= 15 && st16.links >= 30, JSON.stringify(st16));

    // 快照哈希：后续只读操作后必须逐一相等
    const before16 = sha256dir16(DS);

    // (a) 词条与匹配规则：正向/反向用例（偏移以 /api/file 文本为准）
    {
      const c = await contentOf16('论语讲稿.md');
      const d = await linksOf16('论语讲稿.md');
      const auto = d.links.filter((l) => l.kind === 'auto');
      const at = (term, nth = 0) => {
        const hits = auto.filter((l) => l.term === term);
        return hits[nth];
      };
      const wantKzjy = c.indexOf('孔子家语与论语都提到孔子');
      check('最长匹配：孔子家语 整词链出（不吃内部的 孔子）',
        at('孔子家语') && at('孔子家语').from === wantKzjy && at('孔子家语').target.path === '孔子家语.md' &&
        !auto.some((l) => l.term === '孔子' && l.from > wantKzjy && l.from < wantKzjy + 4),
        JSON.stringify(auto.slice(0, 3)));
      check('后续独立 孔子 仍链接且偏移精确',
        auto.some((l) => l.term === '孔子' && l.from === c.indexOf('都提到孔子') + 3 && l.to === l.from + 2),
        JSON.stringify(auto.filter((l) => l.term === '孔子')));
      check('别名 仲尼/夫子 链到 孔子', at('仲尼')?.target.path === '孔子.md' && at('夫子')?.target.path === '孔子.md');
      check('自身别名 论语 不自动链', !auto.some((l) => l.term === '论语'));
      check('链 JSON 词条 儒家概念表', at('儒家概念表')?.target.path === '儒家概念表.json');
      check('链标题词条 文艺复兴', at('文艺复兴')?.target.path === '文艺复兴.md');
      const renStart = c.indexOf('Renaissance');
      check('拉丁边界：Ren 不命中 Renaissance 内部',
        renStart >= 0 && !d.links.some((l) => l.from >= renStart && l.from < renStart + 'Renaissance'.length && l.term === 'Ren'),
        JSON.stringify(d.links.filter((l) => l.term === 'Ren')));
      check('独立 Ren 单独成链', auto.some((l) => l.term === 'Ren' && l.from === c.indexOf('Ren 但') && l.target.path === 'Ren.md'));
      // wikilink 各形态
      const wk = (name) => d.links.find((l) => l.kind !== 'auto' && l.term === name);
      check('[[孔子]] 解析为 wiki 链接', wk('孔子')?.kind === 'wiki' && wk('孔子').target.path === '孔子.md');
      check('[[孔子|孔夫子]] 带显示文字', d.links.some((l) => l.display === '孔夫子' && l.kind === 'wiki'));
      check('[[孔子家语#引言]] 指向锚点', wk('孔子家语#引言') == null && d.links.some((l) => l.kind === 'wiki' && l.target?.path === '孔子家语.md' && l.target?.heading === '引言'));
      check('[[礼记研讨]] 重名给候选不直链', d.links.some((l) => l.term === '礼记研讨' && l.kind === 'wiki' && !l.target && l.candidates?.length === 2));
      check('[[不存在词条]] 标记缺失', d.links.some((l) => l.term === '不存在词条' && l.kind === 'wiki-missing'));
      check('[[儒家概念表.json]] 按路径解析', d.links.some((l) => l.kind === 'wiki' && l.target?.path === '儒家概念表.json'));
    }
    {
      const d = await linksOf16('论语讲稿.md'); // 上面作用域外的重复请求，简单化处理
      check('集合名|文件名 显式引用不进链接索引（由前端 RefChip 处理）', !d.links.some((l) => l.term.includes('|')));
    }
    {
      const c = await contentOf16('孔子家语.md');
      const d = await linksOf16('孔子家语.md');
      const hits = d.links.filter((l) => l.term === '孔子');
      const sec = c.indexOf('## 第二节');
      check('同节只链首次', hits.length >= 1 && hits[0].from === c.indexOf('孔子 first') && !hits.slice(1).some((l) => l.from < sec), JSON.stringify(hits));
      check('新节再次链接', hits.length === 2 && hits[1].from > sec, JSON.stringify(hits));
      check('繁体 論語 链到 论语讲稿', d.links.some((l) => l.term === '論語' && l.target.path === '论语讲稿.md'));
      check('通用标题 引言 不自动链', !d.links.some((l) => l.term === '引言'));
      check('自提及 孔子家语 不链自身', !d.links.some((l) => l.target?.path === '孔子家语.md'));
    }
    {
      const c = await contentOf16('文艺复兴.md');
      const d = await linksOf16('文艺复兴.md');
      const ren = c.indexOf('Renaissance');
      check('Renaissance 整词不链', !d.links.some((l) => l.from >= ren && l.to <= ren + 'Renaissance'.length));
      check('Ren 独立出现成链', d.links.some((l) => l.term === 'Ren' && l.from === c.indexOf('Ren 不应')));
      check('繁体 孔子家語 链出', d.links.some((l) => l.term === '孔子家語' && l.target.path === '孔子家语.md'));
      check('自身标题 文艺复兴 不自链', !d.links.some((l) => l.term === '文艺复兴' && l.target?.path === '文艺复兴.md'));
    }
    {
      const d = await linksOf16('讲稿1.md');
      check('排除名文档仍可向外链接且同节只链一次', d.links.filter((l) => l.term === '孔子').length === 1);
      const d2 = await linksOf16('未命名.md');
      check('排除名 未命名.md 正文仲尼成链', d2.links.some((l) => l.term === '仲尼' && l.target.path === '孔子.md'));
      const d3 = await linksOf16('天.md');
      check('单字标题 天 不进词表但正文夫子成链', d3.links.some((l) => l.term === '夫子' && l.target.path === '孔子.md'));
      const d4 = await linksOf16('2023-05-01.md');
      check('日期名文档正文孔子家语成链', d4.links.some((l) => l.term === '孔子家语' && l.target.path === '孔子家语.md'));
    }
    {
      const d = await linksOf16('同题文档甲.md');
      check('重名词条 礼记研讨 不自动链', !d.links.some((l) => l.term === '礼记研讨' && l.kind === 'auto'));
      const d2 = await linksOf16('同题文档乙.md');
      check('唯一标题锚点 仁的定义 成链', d2.links.some((l) => l.term === '仁的定义' && l.target.path === '孔子.md' && l.target.heading === '仁的定义'));
    }

    // (a2) 最长匹配的占位消费：自身/歧义/屏蔽/通用标题长词命中后整体消费，
    //      绝不回退到其内部的短词条（孔子家语 内部的 孔子 不得成链）
    {
      const c = await contentOf16('孔子家语.md');
      const d = await linksOf16('孔子家语.md');
      const selfAt = c.indexOf('《孔子家语》');
      check('自身长词整体消费：《孔子家语》区间内无链接起点',
        selfAt >= 0 && !d.links.some((l) => l.from >= selfAt + 1 && l.from < selfAt + 5),
        JSON.stringify(d.links.filter((l) => l.from >= selfAt && l.from < selfAt + 6)));
      const hAt = c.indexOf('## 仲尼之言');
      check('通用标题长词整体消费：标题行内 仲尼 不成链',
        hAt >= 0 && !d.links.some((l) => l.from > hAt && l.from < hAt + '## 仲尼之言'.length) && !d.links.some((l) => l.term === '仲尼'),
        JSON.stringify(d.links.filter((l) => l.term === '仲尼')));
    }
    {
      const c = await contentOf16('同题文档乙.md');
      const d = await linksOf16('同题文档乙.md');
      const ambAt = c.indexOf('仲尼考与仲尼之言');
      const soloAt = c.indexOf('内部的仲尼') + 3;
      const zhong = d.links.filter((l) => l.term === '仲尼');
      check('歧义别名与通用标题长词整体消费（[仲尼考],[仲尼之言] 内无链接）',
        ambAt >= 0 && !d.links.some((l) => l.from >= ambAt && l.from < ambAt + 8),
        JSON.stringify(zhong));
      check('其后的独立 仲尼 精确成链（同节首次，偏移准确）',
        zhong.length === 1 && zhong[0].from === soloAt && zhong[0].to === soloAt + 2,
        JSON.stringify(zhong));
    }
    {
      const d = await linksOf16('儒家概念表.json');
      check('JSON 文档作为链接来源', d.links.some((l) => l.term === '孔子' && l.target.path === '孔子.md') && d.links.some((l) => l.term === '论语讲稿'));
      check('JSON 自身 title 不自链', !d.links.some((l) => l.target?.path === '儒家概念表.json'));
    }
    {
      const c = await contentOf16('编码与链接.md');
      const d = await linksOf16('编码与链接.md');
      const zone = (needle) => {
        const i = c.indexOf(needle);
        return [i, i + needle.length];
      };
      const inZone = (l, [a, b]) => l.from < b && l.to > a;
      check('行内代码内不链', !d.links.some((l) => inZone(l, zone('\u0060孔子\u0060'))));
      check('既有链接文字与目标不链', !d.links.some((l) => inZone(l, zone('[孔子](https://example.org/kongzi)'))));
      check('URL 内不链', !d.links.some((l) => inZone(l, zone('https://example.org/孔子'))));
      check('围栏代码内不链且 wikilink 不解析',
        !d.links.some((l) => inZone(l, zone('孔子 在围栏内不链接'))) && !d.links.some((l) => l.term === '孔子' && inZone(l, zone('[[孔子]] 在围栏内也不解析'))));
      check('HTML 标签间正文可链', d.links.filter((l) => l.term === '孔子').length === 1 && d.links[0]?.from === c.indexOf('孔子在标签之间'));
    }

    // (b) 反向链接：内容/计数/片段/排序；旧接口兼容
    {
      const bl = await backOf16('孔子.md');
      check('反向链接非空且按次数降序', bl.ready && bl.backlinks.length >= 8 &&
        bl.backlinks.every((b, i) => i === 0 || bl.backlinks[i - 1].count >= b.count), JSON.stringify(bl.backlinks.map((b) => [b.path, b.count])));
      const lyj = bl.backlinks.find((b) => b.path === '论语讲稿.md');
      check('论语讲稿 提及 孔子 计数正确（auto 孔子/仲尼/夫子 + wiki×2）', lyj?.count === 5, JSON.stringify(lyj));
      check('片段含命中词与原文偏移', lyj?.snippets?.length >= 1 && lyj.snippets.every((s) => s.text.includes(s.term) && Number.isInteger(s.offset)));
      const c = await contentOf16('论语讲稿.md');
      check('片段偏移指向真实提及（auto 精确 / wikilink 落在区间内）',
        lyj.snippets.every((s) => c.slice(s.offset, s.offset + s.term.length) === s.term ||
          c.slice(s.offset, s.offset + 80).includes(s.term)), JSON.stringify(lyj.snippets));
      // 高亮区间由链接精确 from/to 拼出，绝不能用文本搜索（否则 孔子家语 内部的 孔子 会被误标）
      const s0 = lyj.snippets[0];
      check('首片段恰为 都提到 后的 孔子（原文偏移精确）',
        s0.term === '孔子' && s0.offset === c.indexOf('都提到孔子') + 3, JSON.stringify(s0));
      check('高亮用精确区间而非文本首现（首现 孔子 在 孔子家语 内部）',
        lyj.snippets.every((s) => Number.isInteger(s.hiFrom) && Number.isInteger(s.hiTo) && s.text.slice(s.hiFrom, s.hiTo) === s.term) &&
        s0.text.includes('孔子家语') && s0.text.indexOf('孔子') < s0.hiFrom && s0.text.slice(s0.hiFrom - 3, s0.hiFrom) === '都提到',
        JSON.stringify(s0));
      const wsnip = lyj.snippets.find((s) => s.term === '孔夫子');
      check('wikilink 片段高亮显示文字且语法已解包',
        !!wsnip && wsnip.offset === c.indexOf('[[孔子|孔夫子]]') && wsnip.text.slice(wsnip.hiFrom, wsnip.hiTo) === '孔夫子' && !wsnip.text.includes('[['),
        JSON.stringify(wsnip));
      check('全部片段为纯文本（无行首标题记号/代码/链接/wikilink 语法残留）',
        bl.backlinks.every((b) => b.snippets.every((s) => !/(^|\s)#{1,6}(\s|$)|[`#]\s|\]\]|\]\(|\[\[|\*\*/.test(s.text))),
        JSON.stringify(bl.backlinks.flatMap((b) => b.snippets.map((s) => s.text)).filter((t) => /(^|\s)#{1,6}(\s|$)|[`#]\s|\]\]|\]\(|\[\[|\*\*/.test(t))));
      const kjyBl = bl.backlinks.find((b) => b.path === '孔子家语.md');
      const c2 = await contentOf16('孔子家语.md');
      const snip2 = kjyBl?.snippets.find((s) => s.offset === c2.indexOf('孔子在新的一节'));
      check('片段剥除行首 Markdown 记号（## 第二节 → 第二节）且高亮精确',
        !!snip2 && snip2.text.includes('第二节') && !snip2.text.includes('##') && snip2.text.slice(snip2.hiFrom, snip2.hiTo) === '孔子',
        JSON.stringify(snip2));
      check('无提及文档反向链接为空', (await backOf16('编码与链接.md')).backlinks.length === 0);
      const old = await j16('/api/backlinks?path=' + encodeURIComponent('孔子.md'));
      check('旧 /api/backlinks 兼容（文件清单形状）', old.body.backlinks?.length === bl.backlinks.length && old.body.backlinks.every((f) => f.path && f.name && f.ext), JSON.stringify(old.body.backlinks?.slice(0, 2)));
    }

    // (c) 词条搜索 / 预览
    {
      const t = await j16('/api/links/terms?q=' + encodeURIComponent('孔')).then((x) => x.body);
      check('前缀搜索含 孔子/孔子家语', t.terms.some((x) => x.term === '孔子') && t.terms.some((x) => x.term === '孔子家语'));
      check('搜索不含排除名/单字', !t.terms.some((x) => ['天', '讲稿1', '未命名'].includes(x.term)));
      const t2 = await j16('/api/links/terms?q=' + encodeURIComponent('论')).then((x) => x.body);
      check('别名 论语 也可搜到', t2.terms.some((x) => x.term === '论语'));
      const p = await j16('/api/links/preview?path=' + encodeURIComponent('孔子.md')).then((x) => x.body);
      check('预览含标题与摘录', p.title === '孔子' && typeof p.excerpt === 'string' && p.excerpt.length > 0 && p.excerpt.length <= 220, JSON.stringify(p).slice(0, 120));
    }

    // (d) 忽略：本篇忽略后标记、反链计数变化、存在数据源外的状态文件
    {
      const before = (await backOf16('孔子.md')).backlinks.find((b) => b.path === '论语讲稿.md').count;
      r16 = await post16('/api/links/ignore', { path: '论语讲稿.md', term: '孔子', targetPath: '孔子.md', ignore: true });
      check('忽略接口返回成功', r16.body.ok === true && r16.body.ignoredCount === 1, JSON.stringify(r16.body));
      const d = await linksOf16('论语讲稿.md');
      check('被忽略链接带 ignored 标记', d.links.some((l) => l.term === '孔子' && l.kind === 'auto' && l.ignored === true));
      const after = (await backOf16('孔子.md')).backlinks.find((b) => b.path === '论语讲稿.md').count;
      // 忽略按（本篇, 词条, 目标）三者定位：孔子 的 1 处 auto + 2 处 [[孔子]] wiki 一并忽略
      check('忽略后反向链接计数减少（同词同目标共 3 处）', after === before - 3, `${before} -> ${after}`);
      const igFile = path.join(dataDir16, 'sources', ds16, 'linkIgnores.json');
      check('忽略状态存在数据源之外', fs.existsSync(igFile) && JSON.parse(fs.readFileSync(igFile, 'utf8')).length === 1, igFile);
      r16 = await post16('/api/links/ignore', { path: '论语讲稿.md', term: '孔子', targetPath: '孔子.md', ignore: false });
      check('取消忽略后恢复', (await linksOf16('论语讲稿.md')).links.every((l) => !l.ignored) && (await backOf16('孔子.md')).backlinks.find((b) => b.path === '论语讲稿.md').count === before);
    }

    // (e) 屏蔽词表：命中的词条不再自动链；状态存数据源之外
    {
      r16 = await put16('/api/links/blocklist', { terms: ['仲尼'] });
      check('屏蔽词表保存成功', r16.body.ok === true && JSON.stringify(r16.body.terms) === '["仲尼"]', JSON.stringify(r16.body));
      const bl = await j16('/api/links/blocklist').then((x) => x.body);
      check('读取屏蔽词表', JSON.stringify(bl.terms) === '["仲尼"]');
      const d = await linksOf16('论语讲稿.md');
      check('屏蔽词条不再自动链（wikilink 不受影响）',
        !d.links.some((l) => l.term === '仲尼' && l.kind === 'auto') && d.links.some((l) => l.kind === 'wiki'));
      check('屏蔽词状态存数据源之外', fs.existsSync(path.join(dataDir16, 'sources', ds16, 'linkBlocklist.json')));
      await put16('/api/links/blocklist', { terms: [] });
      check('清空屏蔽词表后恢复', (await linksOf16('论语讲稿.md')).links.some((l) => l.term === '仲尼' && l.kind === 'auto'));
      // 屏蔽长词同样整体消费：屏蔽 孔子家语 后，其内部的 孔子 不得回退成链
      {
        const c = await contentOf16('论语讲稿.md');
        const wantKzjy = c.indexOf('孔子家语与论语都提到孔子');
        await put16('/api/links/blocklist', { terms: ['孔子家语'] });
        const d = await linksOf16('论语讲稿.md');
        check('屏蔽长词整体消费：孔子家语 区间内无链接且自身不成链',
          wantKzjy >= 0 && !d.links.some((l) => l.kind === 'auto' && l.term === '孔子家语') &&
          !d.links.some((l) => l.kind === 'auto' && l.from >= wantKzjy && l.from < wantKzjy + 4) &&
          d.links.some((l) => l.kind === 'wiki' && l.term === '孔子家语'),
          JSON.stringify(d.links.filter((l) => l.term === '孔子' || l.term === '孔子家语')));
        check('屏蔽长词之外的独立 孔子 仍精确成链',
          d.links.some((l) => l.term === '孔子' && l.from === c.indexOf('都提到孔子') + 3 && l.to === l.from + 2));
        await put16('/api/links/blocklist', { terms: [] });
        const d2 = await linksOf16('论语讲稿.md');
        check('清空后最长匹配恢复（孔子家语 重新胜出）',
          d2.links.some((l) => l.term === '孔子家语' && l.from === wantKzjy) &&
          !d2.links.some((l) => l.term === '孔子' && l.from >= wantKzjy && l.from < wantKzjy + 4));
      }
    }

    // (f) 只读操作后语料字节不变
    {
      const after16 = sha256dir16(DS);
      const keys = new Set([...Object.keys(before16), ...Object.keys(after16)]);
      const diffs = [...keys].filter((k) => before16[k] !== after16[k]);
      check('所有只读操作后数据源字节不变（含文件清单一致）', diffs.length === 0 && Object.keys(after16).length === Object.keys(before16).length, diffs.join(','));
    }

    // (g) 缓存文件与重启复用
    {
      const cache = path.join(dataDir16, 'links', ds16 + '.json');
      check('缓存文件创建在数据目录 links/ 下', fs.existsSync(cache), cache);
      let cv = null;
      try { cv = JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { /* ignore */ }
      check('缓存内容含各文件外发链接', !!cv && Object.keys(cv.files || {}).length === 14 && (cv.files['论语讲稿.md']?.links || []).length > 0);
      await stop16();
      await spawn16(); // 同一数据目录重启：自动恢复数据源并复用缓存
      const st = await waitReady16();
      check('重启后链接索引就绪', st.ready === true && st.buildSeq >= 1, JSON.stringify(st));
      const d = await linksOf16('论语讲稿.md');
      check('重启后链接结果一致', d.links.some((l) => l.term === '孔子家语' && l.kind === 'auto'));
    }

    // (h) 增量更新：磁盘追加提及 → chokidar → 反向链接在秒级更新
    {
      fs.appendFileSync(N16('讲稿1.md'), '\n## 追加节\n\n孔子在新节里又出现一次。\n');
      const t0 = Date.now();
      let count = 0;
      for (;;) {
        const bl = await backOf16('孔子.md');
        const hit = bl.backlinks.find((b) => b.path === '讲稿1.md');
        count = hit ? hit.count : 0;
        if (count === 2) break;
        if (Date.now() - t0 > 8000) break;
        await new Promise((s) => setTimeout(s, 200));
      }
      const ms = Date.now() - t0;
      check('磁盘追加提及后反向链接秒级更新（≈3s 内）', count === 2 && ms <= 4000, `count=${count} ${ms}ms`);
      console.log(`  ℹ 监听增量更新耗时=${ms}ms（含 chokidar 去抖）`);
    }

    // (i) 改名：链接/反链跟随新路径；忽略记录迁移
    {
      // 先建两条忽略：有旁注的按 id 跟随，无旁注的按路径迁移（目标路径也随改名迁移）
      await post16('/api/links/ignore', { path: '论语讲稿.md', term: '礼乐考', targetPath: '礼乐记.md', ignore: true });
      await post16('/api/links/ignore', { path: '未命名.md', term: '仲尼', targetPath: '孔子.md', ignore: true });
      r16 = await post16('/api/file/rename', { dsId: ds16, path: '礼乐记.md', newName: '礼乐记传' });
      check('改名目标文档成功（标题保留）', r16.body.ok === true && r16.body.path === '礼乐记传.md' && r16.body.titleUpdated === false, JSON.stringify(r16.body));
      await waitReady16();
      const d = await linksOf16('论语讲稿.md');
      check('自动链接改指新路径', d.links.some((l) => l.term === '礼乐考' && l.kind === 'auto' && l.target.path === '礼乐记传.md'));
      check('wikilink 锚点也跟随新路径', d.links.some((l) => l.kind === 'wiki' && l.target?.path === '礼乐记传.md' && l.target?.heading === '礼乐源流'));
      check('忽略条目的目标路径随迁移（链接仍被忽略）',
        d.links.some((l) => l.term === '礼乐考' && l.kind === 'auto' && l.target.path === '礼乐记传.md' && l.ignored === true));
      const blNew = await backOf16('礼乐记传.md');
      const blOld = await backOf16('礼乐记.md');
      check('反向链接跟随新路径', blNew.backlinks.length >= 1 && blOld.backlinks.length === 0, JSON.stringify([blNew.backlinks.length, blOld.backlinks.length]));
      r16 = await post16('/api/file/rename', { dsId: ds16, path: '未命名.md', newName: '未命名草稿' });
      check('无旁注文档改名成功', r16.body.ok === true && r16.body.path === '未命名草稿.md', JSON.stringify(r16.body));
      await waitReady16();
      const d2 = await linksOf16('未命名草稿.md');
      check('路径键忽略记录随改名迁移', d2.links.some((l) => l.term === '仲尼' && l.ignored === true), JSON.stringify(d2.links));
      // 清理忽略，避免影响后续断言
      await post16('/api/links/ignore', { clearAll: true });
    }

    // (j) 删除：链接与词条移除，wikilink 变缺失
    {
      r16 = await post16('/api/file/delete', { dsId: ds16, path: '礼乐记传.md' });
      check('删除目标文档成功', r16.body.ok === true, JSON.stringify(r16.body).slice(0, 120));
      await waitReady16();
      const d = await linksOf16('论语讲稿.md');
      check('指向已删文档的自动链接消失', !d.links.some((l) => l.target?.path === '礼乐记传.md' && l.kind === 'auto'));
      check('wikilink 变为缺失', d.links.some((l) => l.kind === 'wiki-missing' && l.term === '礼乐考'), JSON.stringify(d.links.filter((l) => l.kind !== 'auto').map((l) => [l.term, l.kind])));
      const t = await j16('/api/links/terms?q=' + encodeURIComponent('礼乐考')).then((x) => x.body);
      check('已删文档词条不再可搜', t.terms.length === 0, JSON.stringify(t.terms));
      check('已删文档反向链接为空', (await backOf16('礼乐记传.md')).backlinks.length === 0);
    }

    // (k) 旁注别名变化 → 词表更新
    {
      const metaAbs = N16('孔子.md.meta.json');
      const m = JSON.parse(fs.readFileSync(metaAbs, 'utf8'));
      m.aliases = [...m.aliases, '尼父'];
      fs.writeFileSync(metaAbs, JSON.stringify(m, null, 2) + '\n');
      const t0 = Date.now();
      let ok = false;
      for (;;) {
        const d = await linksOf16('文艺复兴.md');
        if (d.links.some((l) => l.term === '尼父' && l.target?.path === '孔子.md')) { ok = true; break; }
        if (Date.now() - t0 > 8000) break;
        await new Promise((s) => setTimeout(s, 200));
      }
      check('旁注新增别名后词表更新并成链', ok);
    }

    // (l) 性能：ds-perf 副本千文件全量构建 + 单文件增量
    {
      const t0 = Date.now();
      r16 = await post16('/api/config', { baseDir: PERF });
      check('切换到 ds-perf 副本', r16.body.ok === true && r16.body.status.counts.files === 1000, JSON.stringify(r16.body.status?.counts));
      let st;
      for (;;) {
        st = (await j16('/api/links/status')).body;
        if (st.ready && st.files > 0) break;
        await new Promise((s) => setTimeout(s, 100));
      }
      const fullWall = Date.now() - t0;
      check('千文件全量构建 < 10s', st.lastFullMs < 10000, JSON.stringify(st));
      console.log(`  ℹ 性能：全量构建 wall=${fullWall}ms 计算=${st.lastFullMs}ms 词条=${st.terms} 链接=${st.links} 文件=${st.files}`);
      // 增量：向一个文档追加另一文档标题的提及（词条表不变 → 仅重提该文件）
      const target = path.join(PERF, '分区00', '组0', '文档0000.md');
      const before = fs.readFileSync(target, 'utf8');
      fs.appendFileSync(target, '\n另见：性能测试文档 1。\n');
      const t1 = Date.now();
      let seq = st.buildSeq;
      let updated = null;
      for (;;) {
        const s2 = (await j16('/api/links/status')).body;
        if (s2.buildSeq > seq && s2.lastUpdateMs !== st.lastUpdateMs) { updated = s2; break; }
        if (Date.now() - t1 > 8000) break;
        await new Promise((s) => setTimeout(s, 50));
      }
      const incWall = Date.now() - t1;
      check('单文件增量更新 < 500ms（计算耗时）', !!updated && updated.lastUpdateMs < 500, JSON.stringify(updated));
      check('增量后链接计数增加', !!updated && updated.links > st.links, `${st.links} -> ${updated && updated.links}`);
      console.log(`  ℹ 性能：单文件增量 wall=${incWall}ms（含监听去抖） 计算=${updated ? updated.lastUpdateMs : '?'}ms`);
      fs.writeFileSync(target, before); // 还原，保持副本可重复验收
    }
  } finally {
    await stop16();
    fs.rmSync(tmp16, { recursive: true, force: true });
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
