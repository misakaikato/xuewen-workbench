// 内链提取分步化的一致性与不阻塞验证。
// - L1：extractLinks（同步）与 extractLinksSteps（逐步驱动）的结果与 main 版 extractLinks 逐项相同
//   （git show main:server/linkMatch.js，落在临时目录，不留仓库）。两边 MATCH_ENGINE_VERSION 不同
//   说明匹配口径有意改过，跳过对照。
// - L2：LinkIndex.rebuild 处理含 5M 字符单行 JSON 与 1M 字符 Markdown 的库期间，10ms 计时器回调
//   最大延迟 ≤ 100ms；索引里的自动链接与同步 extractLinks 一致。
// 用法：node scripts/test-links-async.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { makeTmpDir } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = makeTmpDir('wb-links-async-');
process.env.WORKBENCH_DATA_DIR = path.join(tmp, 'data');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('  ✓', name);
  } catch (e) {
    fail++;
    console.log('  ✗', name, '—', e.message);
  }
};

const NEW = await import(pathToFileURL(path.join(ROOT, 'server', 'linkMatch.js')).href);
const oldDir = path.join(tmp, 'old-linkmatch');
fs.mkdirSync(oldDir, { recursive: true });
for (const f of ['linkMatch.js', 't2s.js']) {
  fs.writeFileSync(path.join(oldDir, f), execFileSync('git', ['-C', ROOT, 'show', 'main:server/' + f]));
}
const OLD = await import(pathToFileURL(path.join(oldDir, 'linkMatch.js')).href);

const drain = (gen) => {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
};

// ---------- 夹具：确定性伪随机词表与文本 ----------
let seed = 20261103;
const rnd = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n);
const pick = (a) => a[rnd(a.length)];
const CHARS = '学而时习之不亦说乎有朋自远方来不亦乐乎人不知而不愠不亦君子乎吾日三省吾身为人谋而不忠乎与朋友交而不信乎传不习乎';

// 词表：标题、同名两文档（歧义）、日期前缀、标题锚点、拉丁词、屏蔽词、概念（force）
const terms = [];
const entries = [];
for (let i = 0; i < 400; i++) {
  let t = '';
  for (let k = 3 + rnd(4); k > 0; k--) t += CHARS[rnd(CHARS.length)];
  terms.push(t);
  entries.push({ term: t, path: `卷${i % 20}/${t}.md`, kind: 'title' });
  if (i % 9 === 0) entries.push({ term: t, path: `重名/${t}.md`, kind: 'title' });
  if (i % 11 === 0) entries.push({ term: `2022-0${1 + (i % 9)}-1${i % 10}-${t}`, path: `日记/${i}.md`, kind: 'title' });
  if (i % 13 === 0) entries.push({ term: t + '篇', path: `卷${i % 20}/${t}.md`, heading: t + '篇', kind: 'heading' });
}
for (const w of ['Confucius', 'Mencius', 'Analects', 'Ren']) {
  terms.push(w);
  entries.push({ term: w, path: `en/${w}.md`, kind: 'title' });
}
entries.push({ term: '君子', path: 'concept:君子', kind: 'concept', force: true });
const blocklist = [terms[3], terms[7]];

// 文本片段：覆盖跳过区（围栏/行内代码/链接/图片/URL/HTML/wikilink/引用定义/YAML）、分节、CRLF、包装吸收
const BODY_PIECES = [
  () => pick(terms), () => pick(terms), () => pick(terms),
  () => CHARS.slice(rnd(40), 40 + rnd(20)), () => '，', () => '。',
  () => '\n', () => '\n\n', () => '\r\n',
  () => '`' + pick(terms) + '`', () => '``x`` ',
  () => '[[' + pick(terms) + ']]', () => '[[' + pick(terms) + '|显示]]', () => '[[缺失' + rnd(9) + ']]',
  () => '[' + pick(terms) + '](docs/a' + rnd(9) + '.md)', () => '![' + pick(terms) + '](img.png)', () => '[x][ref]',
  () => '\n[ref]: http://e.com\n', () => ' https://example.com/' + pick(terms) + ' ', () => '<span>' + pick(terms) + '</span>',
  () => '《' + pick(terms) + '》', () => `2022-0${1 + rnd(9)}-1${rnd(10)}-` + pick(terms), () => pick(terms) + '（三）',
  () => '重名/' + pick(terms) + '.md', () => ' ' + pick(['Confucius', 'Mencius', 'Renaissance', 'Ren', 'analects']) + ' ',
  () => '\n```js\n' + pick(terms) + '\n', () => '\n```\n', () => '\n~~~\n',
];
const PIECES = [...BODY_PIECES, () => '\n## ' + pick(terms) + '\n', () => '\n----\n', () => '\n===\n'];
function randText(target, pieces = PIECES) {
  let s = rnd(4) === 0 ? '---\ntitle: x\n---\n' : '';
  while (s.length < target) s += pick(pieces)();
  return s;
}
// 压缩成一行的记录 JSON：每 4 条记录提及一个词条
function bigJson(chars) {
  const recs = [];
  for (let i = 0; JSON.stringify(recs).length < chars; i += 500) {
    for (let k = i; k < i + 500; k++) recs.push({ id: k, title: `条目${k}`, body: '记录正文' + k + (k % 4 === 0 ? pick(terms) : ''), tags: ['标签', `t${k % 50}`] });
  }
  return JSON.stringify({ records: recs });
}
// 书籍体量的 Markdown：每 2000 字一章，标题只有章名（标题锚点进词表，数量按真实书籍）
function bigMd(chars) {
  let md = '# 全书\n\n';
  for (let i = 0; md.length < chars; i++) md += `## 第${i}章 ${pick(terms)}\n\n` + randText(2000, BODY_PIECES) + '\n\n';
  return md;
}

// ---------- L1：结果逐项一致 ----------
console.log('== L1 分步提取与 main 版逐项一致 ==');
check('导出 extractLinksSteps', () => assert.equal(typeof NEW.extractLinksSteps, 'function'));
{
  const cases = [
    ['单行 JSON', bigJson(400000)],
    ['大 Markdown', bigMd(300000)],
    ['未闭合围栏', '```\n' + bigMd(150000)],
  ];
  for (let k = 0; k < 120; k++) cases.push(['随机' + k, randText(k < 100 ? rnd(3000) : 70000 + rnd(80000))]);
  const idxNew = NEW.buildAutoIndex(entries, blocklist);
  const firstDiff = (label, fn) => {
    for (const [name, t] of cases) {
      const r = fn(t);
      if (!r.ok) throw new Error(`${label}：${name}（${t.length} 字符）不一致`);
    }
  };
  check(`${cases.length} 段文本：逐步驱动 extractLinksSteps == 同步 extractLinks`, () => {
    firstDiff('steps', (t) => {
      const a = NEW.extractLinks(t, idxNew, { selfPath: '卷3/x.md' });
      const b = drain(NEW.extractLinksSteps(t, idxNew, { selfPath: '卷3/x.md' }));
      return { ok: JSON.stringify(a) === JSON.stringify(b) };
    });
  });
  if (OLD.MATCH_ENGINE_VERSION !== NEW.MATCH_ENGINE_VERSION) {
    console.log(`  （跳过 main 对照：引擎版本 ${OLD.MATCH_ENGINE_VERSION} → ${NEW.MATCH_ENGINE_VERSION}，匹配口径有意变更）`);
  } else {
    const idxOld = OLD.buildAutoIndex(entries, blocklist);
    let total = 0;
    check(`${cases.length} 段文本：extractLinks 新 == main`, () => {
      firstDiff('extractLinks', (t) => {
        const a = NEW.extractLinks(t, idxNew, { selfPath: '卷3/x.md' });
        total += a.length;
        return { ok: JSON.stringify(a) === JSON.stringify(OLD.extractLinks(t, idxOld, { selfPath: '卷3/x.md' })) };
      });
    });
    check(`${cases.length} 段文本：computeSkipRanges 新 == main`, () => {
      firstDiff('computeSkipRanges', (t) => ({ ok: JSON.stringify(NEW.computeSkipRanges(t)) === JSON.stringify(OLD.computeSkipRanges(t)) }));
    });
    check('对照样本确有链接产出（非空比较）', () => assert.ok(total > 1000, `链接总数 ${total}`));
  }
}

// ---------- L2：建内链不阻塞事件循环 ----------
console.log('== L2 建内链不阻塞事件循环 ==');
{
  const { LinkIndex } = await import(pathToFileURL(path.join(ROOT, 'server', 'links.js')).href);
  const base = path.join(tmp, 'corpus');
  fs.mkdirSync(base, { recursive: true });
  const texts = new Map();
  const files = [];
  const add = (p, text) => {
    texts.set(p, text);
    files.push({ path: p, name: path.posix.basename(p), ext: path.posix.extname(p), mtimeMs: 1, size: Buffer.byteLength(text) });
  };
  for (let i = 0; i < 300; i++) add(`卷${i % 20}/${terms[i]}.md`, `# ${terms[i]}\n\n${randText(400)}\n`);
  add('大/记录.json', bigJson(5000000));
  add('大/全书.md', bigMd(1000000));

  const li = new LinkIndex();
  li.reset('links-async', base);
  let maxDelay = 0;
  let lastTick = Date.now();
  const iv = setInterval(() => {
    const now = Date.now();
    maxDelay = Math.max(maxDelay, now - lastTick - 10);
    lastTick = now;
  }, 10);
  await li.rebuild({ files, sidecars: [] }, { texts });
  // 等计时器再走一拍：rebuild 收尾的同步段（反链、写缓存）结束后才轮到它，否则收尾阻塞量不到
  await new Promise((r) => setTimeout(r, 30));
  clearInterval(iv);
  check('建内链期间 10ms 计时器最大回调延迟 ≤ 100ms', () => {
    assert.ok(li.ready, '内链索引未就绪');
    assert.ok(maxDelay <= 100, `最大延迟 ${maxDelay}ms`);
  });
  check('夹具规模：链接数足以暴露逐条链接的同步开销', () => {
    assert.ok(li.stats.links >= 20000, `链接数 ${li.stats.links}`);
  });
  check('大文件的自动链接与同步 extractLinks 一致', () => {
    for (const p of ['大/记录.json', '大/全书.md']) {
      const got = li.linksOf(p).filter((l) => l.kind === 'auto').map((l) => ({ from: l.from, to: l.to, term: l.term, norm: l.norm, target: l.target }));
      // 索引里自动链接与 wikilink 合并后按 from 稳定排序，对照同样排序
      const want = NEW.extractLinks(texts.get(p), li.autoIndex, { selfPath: p })
        .map((l) => ({ from: l.from, to: l.to, term: l.term, norm: l.norm, target: l.target }))
        .sort((a, b) => a.from - b.from);
      assert.ok(want.length > 0, `${p} 应有自动链接`);
      assert.deepStrictEqual(got, want, p);
    }
  });
  // 对照：同一进程内对大 JSON 同步提取会显著阻塞计时器（证明分步的意义，不参与断言）
  let syncDelay = 0;
  let last2 = Date.now();
  const iv2 = setInterval(() => {
    const now = Date.now();
    syncDelay = Math.max(syncDelay, now - last2 - 10);
    last2 = now;
  }, 10);
  await new Promise((r) => setTimeout(r, 30));
  NEW.extractLinks(texts.get('大/记录.json'), li.autoIndex, {});
  await new Promise((r) => setTimeout(r, 30));
  clearInterval(iv2);
  console.log(`  （对照：同步提取 5M 字符 JSON 期间计时器最大延迟 ${syncDelay}ms，分步建内链 ${maxDelay}ms）`);
}

// ---------- L3：JSON 与 HTML 很多的库（如下载目录里解开的应用包）建内链不阻塞 ----------
console.log('== L3 大量 JSON 与 HTML 的库建内链不阻塞 ==');
{
  const { LinkIndex } = await import(pathToFileURL(path.join(ROOT, 'server', 'links.js')).href);
  const base = path.join(tmp, 'corpus-l3');
  fs.mkdirSync(base, { recursive: true });
  const texts = new Map();
  const files = [];
  const add = (p, text) => {
    texts.set(p, text);
    files.push({ path: p, name: path.posix.basename(p), ext: path.posix.extname(p), mtimeMs: 1, size: Buffer.byteLength(text) });
  };
  for (let i = 0; i < 30; i++) {
    const rows = Array.from({ length: 30000 }, (_, j) => ({ id: j, name: '条目' + j, note: 'x'.repeat(60) }));
    add(`包/数据${i}.json`, JSON.stringify({ title: '数据表' + i, rows }));
  }
  for (let i = 0; i < 5; i++) {
    const links = Array.from({ length: 120000 }, (_, j) => `<a href="页${j % 50}.html">第${j}项</a>`).join('');
    add(`包/页面${i}.html`, `<html><body>${links}</body></html>`);
  }
  for (let i = 0; i < 50; i++) add(`包/页${i}.html`, `<p>页${i}</p>`);

  const li = new LinkIndex();
  li.reset('links-l3', base);
  const measure = async (fn) => {
    let max = 0;
    let last = Date.now();
    const iv = setInterval(() => {
      const now = Date.now();
      max = Math.max(max, now - last - 10);
      last = now;
    }, 10);
    await fn();
    await new Promise((r) => setTimeout(r, 30));
    clearInterval(iv);
    return max;
  };
  const d1 = await measure(() => li.rebuild({ files, sidecars: [] }, { texts }));
  console.log(`  （约 ${Math.round([...texts.values()].reduce((s, t) => s + t.length, 0) / 1e6)}M 字符；首次建内链期间计时器最大延迟 ${d1}ms）`);
  check('L3 首次建内链期间 10ms 计时器最大回调延迟 ≤ 100ms', () => assert.ok(li.ready && d1 <= 100, `最大延迟 ${d1}ms`));
  check('L3 JSON 的 title 仍作为词条', () => assert.ok(li.vocab.some((v) => v.term === '数据表7'), '缺少「数据表7」'));
  check('L3 HTML 链接照常提取', () => assert.ok(li.linksOf('包/页面0.html').length > 0, '页面0 没有链接'));

  // 文件没变的第二次重建：不再整篇解析 JSON
  const parse = JSON.parse;
  let bigParses = 0;
  JSON.parse = (s, ...a) => {
    if (typeof s === 'string' && s.length > 1e6) bigParses++;
    return parse(s, ...a);
  };
  try {
    await li.rebuild({ files, sidecars: [] }, { texts });
  } finally {
    JSON.parse = parse;
  }
  check('L3 文件未变时重建不再整篇解析 JSON', () => assert.ok(bigParses === 0, `整篇解析 ${bigParses} 次`));

  // 重启：新实例从磁盘缓存恢复（逐行读取），期间同样不阻塞，结果与缓存前一致
  const li2 = new LinkIndex();
  li2.reset('links-l3', base);
  let extracted = 0;
  for (const m of ['extractFor', 'extractHtmlFor']) {
    const orig = li2[m].bind(li2);
    li2[m] = (...a) => { extracted++; return orig(...a); };
  }
  const d2 = await measure(() => li2.rebuild({ files, sidecars: [] }, { texts }));
  check('L3 重启后复用磁盘缓存，不重新提取', () => assert.ok(extracted === 0, `重新提取 ${extracted} 个文件`));
  console.log(`  （重启后从缓存恢复期间计时器最大延迟 ${d2}ms）`);
  check('L3 重启后从缓存恢复期间最大回调延迟 ≤ 100ms', () => assert.ok(li2.ready && d2 <= 100, `最大延迟 ${d2}ms`));
  check('L3 重启后链接与缓存前一致', () => {
    for (const p of ['包/页面0.html', '包/数据3.json']) assert.deepStrictEqual(li2.linksOf(p), li.linksOf(p), p);
  });
  extracted = 0;
  li2.invalidate();
  await li2.rebuild({ files, sidecars: [] }, { texts });
  check('L3 「重新扫描」（invalidate）后全量重算', () => assert.ok(extracted === files.length, `重新提取 ${extracted}/${files.length}`));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
