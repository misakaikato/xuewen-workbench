// 知识库根目录短暂不可达：保留上次快照、不发 scan-done、关掉失效监听；目录回来后自动重扫并重开监听。
// 真实临时目录 + 真实 chokidar 监听（不 mock 文件系统）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir } from './tmpdirs.mjs';
const { Scanner } = await import('../server/scanner.js');

const tmp = makeTmpDir('wb-scan-recover-');
const lib = path.join(tmp, 'lib');
const moved = path.join(tmp, 'lib-moved');
fs.mkdirSync(path.join(lib, '笔记'), { recursive: true });
fs.writeFileSync(path.join(lib, '笔记', '甲.md'), '# 甲');
fs.writeFileSync(path.join(lib, '乙.md'), '# 乙');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + what);
    await pause(50);
  }
}
let checks = 0;
const ok = (name, cond, detail) => { assert.ok(cond, name + ' ' + JSON.stringify(detail ?? '')); checks++; console.log('PASS', name); };

const s = new Scanner();
s.probeIntervalMs = 200;
let scanDone = 0;
s.on('scan-done', () => { scanDone++; });
s.setBaseDir(lib);
await s.rescan();
s.startWatch();
ok('初始扫描 2 个文件、监听已开', s.snapshot.files.length === 2 && s.status().watching, s.status());

// 根目录移走：保留快照、不发 scan-done、监听关闭、标记不可达
fs.renameSync(lib, moved);
const before = scanDone;
await s.rescan();
ok('不可达：快照文件数不变', s.snapshot.files.length === 2, s.snapshot.files.length);
ok('不可达：未发 scan-done', scanDone === before, { before, scanDone });
const st = s.status();
ok('不可达：状态带原因、监听已关', !!st.unreachable && st.unreachable.reason === '不存在或已被移走' && st.watching === false, st);
ok('不可达：快照里不出现根目录错误', s.snapshot.dirErrors.length === 0, s.snapshot.dirErrors);

// 再扫一次仍不可达：since 不变
const since = st.unreachable.since;
await s.rescan();
ok('持续不可达：since 不变', s.status().unreachable?.since === since, s.status().unreachable);

// 目录回来：探测自动重扫、清除不可达、重开监听
fs.renameSync(moved, lib);
await until(() => !s.unreachable, 5000, '探测恢复');
ok('恢复：不可达已清除', s.status().unreachable === null, s.status());
ok('恢复：监听已重开', s.status().watching === true, s.status());
ok('恢复：重扫发出 scan-done', scanDone > before, scanDone);

// 监听真的在工作：新建文件后自动重扫进快照
fs.writeFileSync(path.join(lib, '丙.md'), '# 丙');
await until(() => s.snapshot.files.some((f) => f.path === '丙.md'), 8000, '新文件进入快照');
ok('恢复后监听生效：新文件自动进入快照', true);

// stopWatch 后不再探测、不再重开监听
fs.renameSync(lib, moved);
await s.rescan();
s.stopWatch();
fs.renameSync(moved, lib);
await pause(800);
ok('stopWatch 后：探测停止、不重开监听', s.status().watching === false && !!s.status().unreachable, s.status());

// 首次扫描就不可达（没有旧快照）：照旧写入带错误的快照，目录出现后自动恢复
const s2 = new Scanner();
s2.probeIntervalMs = 200;
const lib2 = path.join(tmp, 'lib2');
s2.setBaseDir(lib2);
await s2.rescan();
s2.startWatch();
ok('首扫不可达：写入空快照并标记不可达，不开监听', s2.snapshot.files.length === 0 && !!s2.status().unreachable && !s2.status().watching, s2.status());
fs.mkdirSync(lib2);
fs.writeFileSync(path.join(lib2, '丁.md'), '# 丁');
await until(() => !s2.unreachable && s2.snapshot.files.length === 1, 5000, '首扫不可达后恢复');
ok('首扫不可达：目录出现后自动扫描并开监听', s2.status().watching === true, s2.status());
s2.stopWatch();

console.log(`\n${checks} checks passed`);
process.exit(0);
