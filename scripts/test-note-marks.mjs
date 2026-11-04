// 笔记定位规则：noteQueries / locateNote 纯函数测试（三个阅读器共用的同一份规则）。
import assert from 'node:assert/strict';
const { noteQueries, locateNote } = await import('../src/lib/searchLocation.ts');
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS', name); }

test('空引文无候选', () => assert.deepEqual(noteQueries(''), []));
test('纯空白引文无候选', () => assert.deepEqual(noteQueries(' \n\t '), []));
test('1 字引文无候选', () => assert.deepEqual(noteQueries(' 仁 '), []));
test('短引文本身就是候选', () => assert.deepEqual(noteQueries('克己复礼'), ['克己复礼']));
test('多行全短：只留最长的', () => assert.deepEqual(noteQueries('学而\n克己复礼\n为仁'), ['克己复礼']));
test('首行短标题不当候选', () => {
  const q = noteQueries('第一章\n这是一段足够长的正文内容');
  assert.ok(!q.includes('第一章'), JSON.stringify(q));
  assert.deepEqual(q, ['这是一段足够长的正文内容']);
});
test('长行按 60% 下限过滤、长的优先', () => {
  const q = noteQueries('一二三四五六七\n一二三四五六七八九十一二三四五\n甲乙丙丁戊己庚辛壬癸');
  assert.deepEqual(q, ['一二三四五六七八九十一二三四五', '甲乙丙丁戊己庚辛壬癸']);
});
test('候选截前 80 字', () => assert.equal(noteQueries('字'.repeat(120))[0].length, 80));

test('渲染文本整句命中', () => {
  assert.deepEqual(locateNote('前文加粗的词后文，这是带格式的一句话。', '前文加粗的词后文，这是带格式的一句话'), [{ from: 0, to: 18 }]);
});
test('多处出现全部命中', () => {
  assert.deepEqual(locateNote('甲乙丙丁甲乙丙丁', '甲乙丙丁'), [{ from: 0, to: 4 }, { from: 4, to: 8 }]);
});
test('忽略空白与换行', () => assert.deepEqual(locateNote('前文\n加粗', '前文 加粗'), [{ from: 0, to: 5 }]));
test('忽略全半角与大小写', () => assert.deepEqual(locateNote('运行 NPM run dev 即可', 'ｎｐｍ ＲＵＮ'), [{ from: 3, to: 10 }]));
test('首个候选不中时用下一个', () => {
  // 第一候选（较长行）在正文里不存在，第二候选命中
  assert.deepEqual(locateNote('正文里只有甲乙丙丁戊己庚辛壬', '这一行在正文里不存在的文字内容\n甲乙丙丁戊己庚辛壬'), [{ from: 5, to: 14 }]);
});
test('命中第一个候选后不再标其它候选', () => {
  const display = '长句甲乙丙丁戊己庚辛壬癸在这里。另有短句子丑寅卯辰巳午在那里。';
  assert.deepEqual(locateNote(display, '长句甲乙丙丁戊己庚辛壬癸\n短句子丑寅卯辰巳午'), [{ from: 0, to: 12 }]);
});
test('都不命中返回空', () => assert.deepEqual(locateNote('毫不相干的正文', '找不到的引文内容'), []));
test('空引文不命中', () => assert.deepEqual(locateNote('任意正文', ''), []));

console.log(`\n${checks} checks passed`);
