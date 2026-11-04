// G2/G3（反馈第 4 批·上）：扫描异步化的一致性与不阻塞验证。
// - G2：旧同步扫描（git show <BASELINE>:server/scanner.js，落在临时目录，不留仓库）与
//   新 scanTreeAsync 的结果深比较必须完全相等（现有语料 + 临时造 5000 文件语料）。
// - G3：异步扫描 5000 文件期间，10ms 计时器回调最大延迟 ≤ 100ms（事件循环不再被阻塞）；
//   scanned 单调递增，最终等于文件总数。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { makeTmpDir } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = makeTmpDir('wb-scan-async-');

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

// ---------- 旧同步版本：从固定基线取到临时目录（lagWatch 一并；监听用不到，chokidar 以空壳模块代替） ----------
// 基线固定为 v0.1.7（5250c0f），它是最后一个只有同步 scanTree 的版本；不能用 main，main 已是新实现
const BASELINE = '5250c0f';
const oldDir = path.join(tmp, 'old-scanner');
fs.mkdirSync(oldDir, { recursive: true });
fs.writeFileSync(path.join(oldDir, 'scanner.js'), execFileSync('git', ['-C', ROOT, 'show', `${BASELINE}:server/scanner.js`]));
fs.writeFileSync(path.join(oldDir, 'lagWatch.js'), execFileSync('git', ['-C', ROOT, 'show', `${BASELINE}:server/lagWatch.js`]));
// 基线 scanner.js 顶层 import chokidar；对照只用它的 scanTree，给一个空壳模块即可加载
fs.mkdirSync(path.join(oldDir, 'node_modules', 'chokidar'), { recursive: true });
fs.writeFileSync(path.join(oldDir, 'node_modules', 'chokidar', 'package.json'), JSON.stringify({ name: 'chokidar', type: 'module', main: 'index.js' }));
fs.writeFileSync(path.join(oldDir, 'node_modules', 'chokidar', 'index.js'), "export default { watch() { throw new Error('基线监听不参与对照'); } };\n");
const oldScanner = await import(pathToFileURL(path.join(oldDir, 'scanner.js')).href);
const { scanTreeAsync } = await import(pathToFileURL(path.join(ROOT, 'server', 'scanner.js')).href);

// ---------- 临时语料：5000 文件、多层目录、隐藏文件、旁注、不支持的扩展名、空目录 ----------
function makeCorpus() {
  const dir = path.join(tmp, 'corpus');
  fs.mkdirSync(dir, { recursive: true });
  const exts = ['.md', '.md', '.md', '.txt', '.json', '.html', '.docx'];
  let n = 0;
  for (let a = 0; a < 10; a++) {
    for (let b = 0; b < 10; b++) {
      const sub = path.join(dir, `第${a}辑`, `卷${b}`);
      fs.mkdirSync(sub, { recursive: true });
      for (let i = 0; i < 50; i++) {
        const ext = exts[(n + i) % exts.length];
        const name = `文档${String(n).padStart(5, '0')}${ext}`;
        const body = ext === '.json' ? JSON.stringify({ title: `文档${n}`, items: [n, n + 1] }) : `# 文档${n}\n\n学而时习之，不亦说乎。${'重复行\n'.repeat(20)}`;
        fs.writeFileSync(path.join(sub, name), body);
        n++;
      }
      // 旁注、派生文件、隐藏文件、不支持的扩展名
      fs.writeFileSync(path.join(sub, '有旁注.md'), '# 有旁注\n');
      fs.writeFileSync(path.join(sub, '有旁注.md.meta.json'), JSON.stringify({ id: 'doc_x', title: '有旁注' }));
      fs.writeFileSync(path.join(sub, '.笔记.annotations.json'), '[]');
      fs.writeFileSync(path.join(sub, '.hidden.md'), '# 隐藏文件\n');
      fs.writeFileSync(path.join(sub, '图片.png'), Buffer.from([0x89, 0x50]));
      fs.writeFileSync(path.join(sub, '表格.csv'), 'a,b\n');
    }
    fs.mkdirSync(path.join(dir, `第${a}辑`, '空目录'), { recursive: true });
  }
  // .derived 加工数据目录（showMetaFiles 开关打开时才进树）
  const derived = path.join(dir, '.derived');
  fs.mkdirSync(derived, { recursive: true });
  fs.writeFileSync(path.join(derived, 'concepts.jsonl'), '{"name":"孔子"}\n');
  fs.mkdirSync(path.join(derived, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(derived, 'sub', 'graph.graphml'), '<graphml/>');
  // 隐藏目录（永远不进扫描）
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), 'x');
  return dir;
}
const corpus = makeCorpus();

// ---------- G2：结果逐项一致 ----------
console.log('== G2 新旧扫描结果一致 ==');
for (const showMetaFiles of [false, true]) {
  for (const [label, target] of [
    ['临时语料(5000 文件)', corpus],
    ['仓库语料 test-data/ds-a', path.join(ROOT, 'test-data', 'ds-a')],
  ]) {
    const oldResult = oldScanner.scanTree(target, { showMetaFiles });
    const newAsync = await scanTreeAsync(target, { showMetaFiles });
    check(`${label} showMetaFiles=${showMetaFiles}：新异步 == 旧同步`, () => {
      assert.deepStrictEqual(newAsync, oldResult);
    });
  }
}

// ---------- G3：扫描不阻塞事件循环 + scanned 单调递增 ----------
console.log('== G3 异步扫描不阻塞事件循环 ==');
{
  let maxDelay = 0;
  let lastTick = Date.now();
  let timerFired = false;
  const iv = setInterval(() => {
    const now = Date.now();
    if (timerFired) maxDelay = Math.max(maxDelay, now - lastTick - 10);
    lastTick = now;
    timerFired = true;
  }, 10);
  const progressSeen = [];
  // setImmediate 探测链：扫描若是同步阻塞，链在扫描期间一次都跑不到；分片让出则能跑多次
  let yields = 0;
  let alive = true;
  (function probe() {
    if (!alive) return;
    yields++;
    setImmediate(probe);
  })();
  const result = await scanTreeAsync(corpus, {
    onProgress: (n) => progressSeen.push(n),
  });
  alive = false;
  clearInterval(iv);
  check('扫描期间 10ms 计时器最大回调延迟 ≤ 100ms', () => {
    assert.ok(maxDelay <= 100, `最大延迟 ${maxDelay}ms`);
  });
  check('扫描期间 setImmediate 探测链持续推进（分片让出生效）', () => {
    assert.ok(yields >= 1, `让出次数 ${yields}`);
  });
  check('scanned 单调递增', () => {
    for (let i = 1; i < progressSeen.length; i++) {
      assert.ok(progressSeen[i] >= progressSeen[i - 1], `${progressSeen[i - 1]} -> ${progressSeen[i]}`);
    }
  });
  check('scanned 最终等于文件总数', () => {
    assert.ok(progressSeen.length > 0, '应有进度回调');
    assert.equal(progressSeen[progressSeen.length - 1], result.files.length);
  });
  check('临时语料确为不少于 5000 个被扫描文件', () => {
    assert.ok(result.files.length >= 5000, `实际 ${result.files.length}`);
  });
  // 对照：同一进程内同步扫描会显著阻塞计时器（证明异步化的意义，不参与断言）
  let syncDelay = 0;
  let last2 = Date.now();
  const iv2 = setInterval(() => {
    const now = Date.now();
    syncDelay = Math.max(syncDelay, now - last2 - 10);
    last2 = now;
  }, 10);
  oldScanner.scanTree(corpus, {});
  clearInterval(iv2);
  console.log(`  （对照：旧同步扫描期间计时器最大延迟 ${syncDelay}ms，新异步 ${maxDelay}ms）`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
