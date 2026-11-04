// 走查修复的纯逻辑测试：fsErrorText 中文原因、带扩展名的 wikilink 按文件名解析。
import assert from 'node:assert/strict';
const { fsErrorText } = await import('../server/fsErrors.js');
const { LinkIndex } = await import('../server/links.js');
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS', name); }
const err = (code, message = 'x') => Object.assign(new Error(message), { code });

test('ENOENT → 不存在或已被移走', () => assert.equal(fsErrorText(err('ENOENT')), '不存在或已被移走'));
test('EACCES / EPERM → 没有访问权限', () => {
  assert.equal(fsErrorText(err('EACCES')), '没有访问权限');
  assert.equal(fsErrorText(err('EPERM')), '没有访问权限');
});
test('ENOTDIR / EBUSY / ETIMEDOUT / EIO 有中文原因', () => {
  for (const c of ['ENOTDIR', 'EBUSY', 'ETIMEDOUT', 'EIO', 'ELOOP', 'EMFILE', 'ENFILE']) assert.ok(!/[A-Z]{4,}/.test(fsErrorText(err(c))), c);
});
test('未知错误码兜底带码', () => assert.equal(fsErrorText(err('EXDEV')), '访问失败（EXDEV）'));
test('无错误码用 message', () => assert.equal(fsErrorText(new Error('不是目录')), '不是目录'));
test('非错误对象', () => assert.equal(fsErrorText('坏了'), '坏了'));

function indexWith(paths) {
  const li = new LinkIndex();
  li.buildResolve([], { files: paths.map((p) => ({ path: p, ext: p.slice(p.lastIndexOf('.')) })) });
  return li;
}
test('子目录里的文件：[[文件名.ext]] 唯一解析', () => {
  assert.deepEqual(indexWith(['链接/儒家概念表.json', '笔记/甲.md']).resolveWiki('儒家概念表.json'), { status: 'unique', path: '链接/儒家概念表.json' });
});
test('两个子目录有同名文件：返回候选', () => {
  const r = indexWith(['甲/同名.json', '乙/同名.json']).resolveWiki('同名.json');
  assert.equal(r.status, 'candidates');
  assert.deepEqual(r.paths, ['乙/同名.json', '甲/同名.json'].sort());
});
test('根目录有同名路径：仍按路径唯一解析', () => {
  assert.deepEqual(indexWith(['同名.json', '乙/同名.json']).resolveWiki('同名.json'), { status: 'unique', path: '同名.json' });
});
test('带目录的写法：保持后缀匹配', () => {
  assert.deepEqual(indexWith(['资料/链接/儒家概念表.json']).resolveWiki('链接/儒家概念表.json'), { status: 'unique', path: '资料/链接/儒家概念表.json' });
});
test('文件名大小写不敏感', () => {
  assert.deepEqual(indexWith(['docs/Readme.MD']).resolveWiki('readme.md'), { status: 'unique', path: 'docs/Readme.MD' });
});
test('不存在仍是缺失', () => assert.deepEqual(indexWith(['a/b.md']).resolveWiki('不存在.json'), { status: 'missing' }));

console.log(`\n${checks} checks passed`);
