// 中断恢复第 2 批（specs/2026-11-03-interrupted-2-backend.md G2）：逐条模拟中断，断言数据不静默丢失、功能不永久坏掉。
// 进程内：H1 运行时解压、M3 模型下载跳过、M4 暂停持久化、M5 切块参数、M1 对话索引重建、M2 截断行。
// 拉起后端（假 OpenAI 兼容端点）：H2 复制失败回滚、M2 上下文续接/半截回复/会话损坏回退/删除、
// M5 构建中改切块参数 409、L11 划线记录与 L13 mcp.json 坏文件保留、skill 临时目录。
// 运行：node scripts/test-interrupted-backend.mjs
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = makeTmpDir('wb-intback-');
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
    await sleep(50);
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
const ls = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

// ---------- 假模型下载源（M3）：HEAD 给大小，GET 记录请求 ----------
const ONNX_FILES = {
  'config.json': Buffer.from(JSON.stringify({ file: 'config', pad: 'x'.repeat(4096) })),
  'tokenizer.json': Buffer.from(JSON.stringify({ file: 'tok', pad: 'x'.repeat(8192) })),
  'tokenizer_config.json': Buffer.from(JSON.stringify({ file: 'tokcfg', pad: 'x'.repeat(2048) })),
  'special_tokens_map.json': Buffer.from(JSON.stringify({ file: 'stm', pad: 'x'.repeat(2048) })),
  'onnx/model_fp16.onnx': crypto.randomBytes(2 * 1024 * 1024),
};
const hubGets = [];
const hubServer = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  const rel = req.url.replace(/^\/.*?\/resolve\/main\//, '');
  const buf = ONNX_FILES[rel];
  if (!buf) { res.writeHead(404); res.end(); return; }
  if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': String(buf.length) }); res.end(); return; }
  hubGets.push(rel);
  res.writeHead(200, { 'Content-Length': String(buf.length), 'Accept-Ranges': 'bytes' });
  res.end(buf);
});
const hubPort = await new Promise((resolve) => hubServer.listen(0, '127.0.0.1', () => resolve(hubServer.address().port)));
atExit(() => { hubServer.closeAllConnections(); hubServer.close(); });

// 进程内导入的后端模块在加载期读取这些环境变量（数据目录、下载源、嵌入后端）
process.env.WORKBENCH_DATA_DIR = path.join(tmp, 'inproc-data');
process.env.WORKBENCH_RAG_MODEL_HOSTS = `http://127.0.0.1:${hubPort}`;
process.env.WORKBENCH_RAG_EMBED = 'onnx';
const { EmbedService, DIM } = await import('../server/rag/embed.js');
const { RagManager } = await import('../server/rag/manager.js');
const { AgentHub } = await import('../server/agent/manager.js');

// 捕获进程内的 WARN（同时照常输出）
const warns = [];
const origWarn = console.warn.bind(console);
console.warn = (...a) => { warns.push(a.join(' ')); origWarn(...a); };

// ---------- H1：MLX 运行时解压中断 ----------
section('H1 运行时：半截 runtime 被删掉重新解压；取消后不留 runtime.tmp-*，下次能解压成功');
{
  // 真 tarball：python3 桩（-m venv <dir> 时建 venv 的 python 桩），标准库 40 个模块 + os.py（排在最后）
  const stage = path.join(tmp, 'h1-stage');
  const libRel = 'python/lib/python3.12';
  fs.mkdirSync(path.join(stage, 'python', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(stage, libRel), { recursive: true });
  fs.writeFileSync(path.join(stage, 'python', 'bin', 'python3'), `#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  mkdir -p "$3/bin"
  printf '#!/bin/sh\\nexit 0\\n' > "$3/bin/python"
  chmod +x "$3/bin/python"
fi
exit 0
`);
  fs.chmodSync(path.join(stage, 'python', 'bin', 'python3'), 0o755);
  const mods = [];
  for (let i = 0; i < 40; i++) {
    const rel = `${libRel}/mod${String(i).padStart(2, '0')}.py`;
    fs.writeFileSync(path.join(stage, rel), '# ' + i + '\n');
    mods.push(rel);
  }
  fs.writeFileSync(path.join(stage, libRel, 'os.py'), '# os\n');
  const mkBundle = (dataDir) => {
    const bundle = path.join(dataDir, 'mlx-env-bundle');
    fs.mkdirSync(path.join(bundle, 'wheels'), { recursive: true });
    const tarball = path.join(bundle, 'python.tar.gz');
    const r = spawnSync('tar', ['-czf', tarball, '-C', stage, 'python/bin/python3', ...mods, `${libRel}/os.py`], { stdio: 'pipe' });
    if (r.status !== 0) throw new Error('造 tarball 失败: ' + r.stderr);
    return tarball;
  };
  // uv 桩恒失败：走离线捆绑路径（路径 B）
  const stubDir = path.join(tmp, 'h1-stub');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'uv'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(stubDir, 'uv'), 0o755);
  const withPath = (dir, fn) => {
    const prev = process.env.PATH;
    process.env.PATH = dir + ':' + prev;
    return Promise.resolve().then(fn).finally(() => { process.env.PATH = prev; });
  };

  // 1) 只解压了前 20 项的 runtime（有 python3、没有标准库）
  {
    const dataDir = path.join(tmp, 'h1-half');
    const tarball = mkBundle(dataDir);
    const runtime = path.join(dataDir, 'py', 'runtime');
    fs.mkdirSync(runtime, { recursive: true });
    const first20 = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).stdout.trim().split('\n').slice(0, 20);
    spawnSync('tar', ['-xzf', tarball, '-C', runtime, ...first20]);
    fs.writeFileSync(path.join(runtime, 'python', 'stale-from-half.txt'), 'x');
    check('前置：半截 runtime 有 python3、没有 os.py',
      fs.existsSync(path.join(runtime, 'python', 'bin', 'python3')) && !fs.existsSync(path.join(runtime, libRel, 'os.py')));
    const embed = new EmbedService(dataDir);
    const phases = [];
    let err = null;
    await withPath(stubDir, () => embed.ensureVenv((ph, d) => phases.push(ph + '|' + d))).catch((e) => { err = e; });
    check('置备成功', !err, err && err.message);
    check('半截 runtime 被删掉（旧文件不在）', !fs.existsSync(path.join(runtime, 'python', 'stale-from-half.txt')));
    check('重新解压：有标准库 os.py 与完成标记', fs.existsSync(path.join(runtime, libRel, 'os.py')) && fs.existsSync(path.join(runtime, '.wb-complete')));
    check('经过「解压 Python 运行时」阶段', phases.includes('env-extract|解压 Python 运行时'), phases);
    check('venv 写了完成标记', fs.existsSync(path.join(embed.venvDir, '.wb-complete')));
    check('没有残留 runtime.tmp-*', !ls(path.join(dataDir, 'py')).some((n) => n.startsWith('runtime.tmp-')), ls(path.join(dataDir, 'py')));
  }

  // 2) 解压中取消：tar 桩先产出半截目录结构再挂住，被杀后临时目录删除；换回真 tar 后能解压成功
  {
    const dataDir = path.join(tmp, 'h1-cancel');
    mkBundle(dataDir);
    const slowDir = path.join(tmp, 'h1-slow-tar');
    fs.mkdirSync(slowDir, { recursive: true });
    fs.copyFileSync(path.join(stubDir, 'uv'), path.join(slowDir, 'uv'));
    fs.chmodSync(path.join(slowDir, 'uv'), 0o755);
    const started = path.join(slowDir, 'started');
    fs.writeFileSync(path.join(slowDir, 'tar'), `#!/bin/sh
dest=""; prev=""
for a in "$@"; do if [ "$prev" = "-C" ]; then dest="$a"; fi; prev="$a"; done
mkdir -p "$dest/python/bin" "$dest/python/lib/python3.12"
printf '#!/bin/sh\\nexit 0\\n' > "$dest/python/bin/python3"
echo "$dest" > ${JSON.stringify(started)}
exec sleep 30
`);
    fs.chmodSync(path.join(slowDir, 'tar'), 0o755);
    const embed = new EmbedService(dataDir);
    embed.state = 'downloading'; // 模拟下载任务中，cancel() 才会杀子进程
    let err = null;
    const p = withPath(slowDir, () => embed.ensureVenv()).catch((e) => { err = e; });
    await waitFor(() => fs.existsSync(started), 10000, 'tar 桩开始解压');
    const tmpDest = fs.readFileSync(started, 'utf8').trim();
    check('解压目标是 runtime.tmp-*（不直接写 runtime）', path.basename(tmpDest).startsWith('runtime.tmp-') && fs.existsSync(path.join(tmpDest, 'python', 'bin', 'python3')), tmpDest);
    check('取消返回 ok', embed.cancel().ok === true);
    const t0 = Date.now();
    await p;
    check('取消后置备抛错（不等 tar 桩睡完）', !!err && Date.now() - t0 < 10000, err && err.message);
    check('取消后 runtime.tmp-* 已删除', !ls(path.join(dataDir, 'py')).some((n) => n.startsWith('runtime.tmp-')), ls(path.join(dataDir, 'py')));
    check('取消后没有 runtime（半截不会被当作已解压）', !fs.existsSync(path.join(dataDir, 'py', 'runtime')));
    embed._cancelFlag = false;
    embed.state = 'missing';
    let err2 = null;
    await withPath(stubDir, () => embed.ensureVenv()).catch((e) => { err2 = e; });
    check('下次重新解压可以成功', !err2 && fs.existsSync(path.join(dataDir, 'py', 'runtime', '.wb-complete')), err2 && err2.message);
  }
}

// ---------- M3：模型下载跨重启 ----------
section('M3 模型下载：已完成且大小一致的文件不重下；清单原子写入且 sha256 齐全');
{
  const dataDir = path.join(tmp, 'm3');
  const dir = path.join(dataDir, 'models', 'bge-m3', 'onnx-fp16');
  fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true });
  // 上次已完成并改名：config.json、tokenizer.json（大小一致）；model_fp16.onnx 大小不对（应重下）
  fs.writeFileSync(path.join(dir, 'config.json'), ONNX_FILES['config.json']);
  fs.writeFileSync(path.join(dir, 'tokenizer.json'), ONNX_FILES['tokenizer.json']);
  fs.writeFileSync(path.join(dir, 'onnx', 'model_fp16.onnx'), Buffer.alloc(1000));
  hubGets.length = 0;
  const embed = new EmbedService(dataDir);
  embed.download();
  await embed._downloadTask;
  const st = embed.status();
  check('下载完成 ready', st.state === 'ready', { state: st.state, error: st.error });
  check('大小一致的 config.json / tokenizer.json 没有再 GET', !hubGets.includes('config.json') && !hubGets.includes('tokenizer.json'), hubGets);
  check('大小不一致的 model_fp16.onnx 重新下载', hubGets.includes('onnx/model_fp16.onnx'), hubGets);
  check('缺的文件照常下载', hubGets.includes('tokenizer_config.json') && hubGets.includes('special_tokens_map.json'), hubGets);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
  const shaOk = Object.entries(ONNX_FILES).every(([f, buf]) => manifest.files.find((x) => x.path === f)?.sha256 === crypto.createHash('sha256').update(buf).digest('hex'));
  check('清单含全部文件且 sha256 与内容一致（含跳过的文件）', manifest.files.length === 5 && shaOk, manifest.files.map((x) => x.path));
  check('清单目录没有残留临时文件', !ls(dir).some((n) => n.includes('.tmp-')), ls(dir));
}

// ---------- M4 / M5：RAG 暂停持久化与切块参数 ----------
const mkCorpus = (name, nFiles) => {
  const files = [];
  const texts = new Map();
  for (let i = 0; i < nFiles; i++) {
    const p = `f${String(i).padStart(2, '0')}.txt`;
    const paras = [];
    for (let j = 0; j < 6; j++) paras.push(`${name}第${i}篇第${j}段` + '内容填充。'.repeat(40));
    const text = paras.join('\n\n');
    texts.set(p, text);
    files.push({ path: p, name: p, base: p.slice(0, -4), ext: '.txt', mtimeMs: 1700000000000 + i, size: text.length, dir: '' });
  }
  return { files, texts };
};
const vector = () => { const v = new Float32Array(DIM); v[0] = 1; return v; };
const mkMgr = (root, id, corpus, embedMs = 0) => {
  const getLib = (dsId) => dsId === id ? { snapshot: { files: corpus.files }, getText: (p) => corpus.texts.get(p) ?? null, whenIndexed: () => Promise.resolve() } : null;
  const mgr = new RagManager({ dataDir: path.join(root, 'data'), knowledgeDir: path.join(root, 'k'), getLib });
  mgr.embedCalls = 0;
  mgr.embed.embed = async (t) => {
    mgr.embedCalls += t.length;
    if (embedMs) await sleep(embedMs);
    return t.map(vector);
  };
  return mgr;
};
const chunkRows = (ix) => ix.store.db.prepare('SELECT path, ordinal, text FROM chunks ORDER BY path, ordinal').all();

section('M4 暂停持久化：暂停后新建 manager，扫描完成与启动续建都不自动构建，状态为 paused');
{
  const root = path.join(tmp, 'm4');
  const corpus = mkCorpus('暂停', 12);
  const mgr = mkMgr(root, 'ds4', corpus, 80);
  const ix = mgr.index('ds4');
  const bp = mgr.build('ds4', {});
  await waitFor(() => ix.done >= 2, 10000, '构建进行到第 2 个文件');
  mgr.pause('ds4');
  const r = await bp;
  check('构建停在 paused', r.paused === true && ix.status().state === 'paused', r);
  const doneBefore = ix.store.stats().filesDone;
  mgr.remove('ds4'); // 模拟退出：关闭 rag.db

  const mgr2 = mkMgr(root, 'ds4', corpus);
  const ix2 = mgr2.index('ds4');
  check('重启后状态显示 paused', ix2.status().state === 'paused', ix2.status().state);
  mgr2.onScanComplete('ds4');
  ix2.autoBuild(); // 启动续建（server/index.js boot）走同一入口
  await sleep(300);
  check('扫描完成与启动续建都没有开始构建（未调用嵌入）', mgr2.embedCalls === 0 && ix2.status().state === 'paused', { calls: mgr2.embedCalls, state: ix2.status().state });
  check('已完成的文件进度保留', ix2.store.stats().filesDone === doneBefore, ix2.store.stats());
  const r2 = await mgr2.build('ds4', {});
  check('用户主动开始构建：撤销暂停并建完', r2.ok === true && ix2.status().state === 'ready', r2);
  check('建完后 meta 里没有 paused', ix2.store.metaGet('paused') == null);
  mgr2.remove('ds4');
  const mgr3 = mkMgr(root, 'ds4', corpus);
  check('之后重启不再显示 paused', mgr3.index('ds4').status().state === 'ready', mgr3.index('ds4').status().state);
  mgr3.remove('ds4');
}

section('M5 切块参数：首次构建中途暂停后改参数，续建提示 configChanged 且不混合；构建中改切块参数 409');
{
  const corpus = mkCorpus('切块', 10);
  // 参照：直接用新参数一次建完（检索参数按 dsId 存在全局数据目录，参照库用另一个 dsId）
  const ref = mkMgr(path.join(tmp, 'm5-ref'), 'ds5ref', corpus);
  ref.saveConfig('ds5ref', { chunk: { maxChars: 200 } });
  await ref.build('ds5ref', {});
  const refRows = chunkRows(ref.index('ds5ref'));

  const mgr = mkMgr(path.join(tmp, 'm5'), 'ds5', corpus, 80);
  const ix = mgr.index('ds5');
  const bp = mgr.build('ds5', {});
  await waitFor(() => ix.done >= 3, 10000, '首次构建进行到第 3 个文件');
  let e409 = null;
  try { mgr.saveConfig('ds5', { chunk: { maxChars: 200 } }); } catch (e) { e409 = e; }
  check('构建进行中保存切块参数：409「构建进行中，暂停或完成后再修改」', e409?.status === 409 && e409.message === '构建进行中，暂停或完成后再修改', e409 && e409.message);
  let eSearch = null;
  try { mgr.saveConfig('ds5', { search: { topN: 40 } }); } catch (e) { eSearch = e; }
  check('构建进行中保存检索参数照常保存', !eSearch && ix.cfg.search.topN === 40, eSearch && eSearch.message);
  mgr.pause('ds5');
  await bp;
  check('首次构建记下了构建中指纹 building_cfg（还没有 index_cfg）', !!ix.store.metaGet('building_cfg') && !ix.store.metaGet('index_cfg'));
  const doneFiles = ix.store.stats().filesDone;
  mgr.saveConfig('ds5', { chunk: { maxChars: 200 } }); // 暂停后可改
  const st = ix.status();
  check('暂停后改切块参数：status.configChanged = true', st.configChanged === true && doneFiles > 0, { configChanged: st.configChanged, doneFiles });
  const r = await mgr.build('ds5', {});
  check('续建成功', r.ok === true, r);
  const rows = chunkRows(ix);
  check('续建结果与新参数一次建完完全一致（没有新旧切块混合）', JSON.stringify(rows) === JSON.stringify(refRows), { got: rows.length, ref: refRows.length });
  check('续建后 configChanged 消失', ix.status().configChanged === false);
  mgr.remove('ds5');
  ref.remove('ds5ref');
}

// ---------- M1：conversations.json 写坏 ----------
const hubOpts = (dataDir) => ({ dataDir, getLib: () => null, ragManager: {}, getRagConfig: () => ({}) });
section('M1 对话索引：半截 conversations.json 改名保留，从 jsonl 重建');
{
  const dataDir = path.join(tmp, 'm1');
  const dirA = path.join(dataDir, 'knowledge', 'dsA', 'conversations', 'default');
  const dirB = path.join(dataDir, 'knowledge', 'dsB', 'conversations', 'default');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const long = '请总结一下论语第一篇讲的学习方法和它对今天读书人的意义到底在哪里呢';
  fs.writeFileSync(path.join(dirA, 'aaaaaaaaaaaa.jsonl'), JSON.stringify({ role: 'user', text: long, at: '2026-11-01T00:00:00.000Z' }) + '\n' + JSON.stringify({ role: 'assistant', text: '答', at: '2026-11-01T00:00:01.000Z' }) + '\n');
  fs.writeFileSync(path.join(dirB, 'bbbbbbbbbbbb.jsonl'), JSON.stringify({ role: 'user', text: '第二个对话', at: '2026-11-02T00:00:00.000Z' }) + '\n');
  const piName = '2026-11-01T00-00-00-000Z_aaaaaaaaaaaa-00000000-0000-4000-8000-000000000000.jsonl';
  fs.writeFileSync(path.join(dirA, piName), JSON.stringify({ type: 'session', version: 3, id: 'aaaaaaaaaaaa-00000000-0000-4000-8000-000000000000', timestamp: '2026-11-01T00:00:00.000Z', cwd: tmp }) + '\n');
  const half = '{\n  "conversations": [\n    {\n      "id": "aaaaaaaaaaaa",\n      "title": "请总';
  fs.writeFileSync(path.join(dataDir, 'conversations.json'), half);
  const before = warns.length;
  const hub = new AgentHub(hubOpts(dataDir));
  const list = hub.listConversations();
  const a = list.find((c) => c.id === 'aaaaaaaaaaaa');
  const b = list.find((c) => c.id === 'bbbbbbbbbbbb');
  check('重建出 2 条对话', list.length === 2 && !!a && !!b, list.map((c) => c.id));
  check('标题取第一条用户消息前 30 字', a?.title === long.slice(0, 30) && b?.title === '第二个对话', [a?.title, b?.title]);
  check('dsId 取所在目录', a?.dsId === 'dsA' && b?.dsId === 'dsB');
  check('时间取文件修改时间', a?.updatedAt === fs.statSync(path.join(dirA, 'aaaaaaaaaaaa.jsonl')).mtime.toISOString(), a?.updatedAt);
  check('按文件名找回 pi 会话文件', a?.piSessionFile === piName, a?.piSessionFile);
  const corrupt = ls(dataDir).filter((n) => n.startsWith('conversations.json.corrupt-'));
  check('坏文件保留为 conversations.json.corrupt-*，内容原样', corrupt.length === 1 && fs.readFileSync(path.join(dataDir, corrupt[0]), 'utf8') === half, corrupt);
  check('conversations.json 已改写为可解析的重建结果', JSON.parse(fs.readFileSync(path.join(dataDir, 'conversations.json'), 'utf8')).conversations.length === 2);
  check('记了一行 WARN', warns.slice(before).some((w) => w.includes('conversations.json 无法解析')), warns.slice(before));
  hub.newConversation('新的', 'dsA');
  check('之后写入不丢已重建的对话', hub.listConversations().length === 3);
}

section('M2 截断行：最后一行没有换行符时，追加后各行都能解析');
{
  const dataDir = path.join(tmp, 'm2-trunc');
  const hub = new AgentHub(hubOpts(dataDir));
  const c1 = hub.newConversation('截断', 'dsT');
  const f1 = hub._convFile(c1.id);
  fs.writeFileSync(f1, JSON.stringify({ role: 'user', text: '甲', at: 'x' })); // 完整 JSON 但缺换行
  hub._append(c1.id, { role: 'assistant', text: '乙', at: 'y' });
  const h1 = hub.history(c1.id);
  check('完整行缺换行：追加后两行都能解析', h1.length === 2 && h1[0].text === '甲' && h1[1].text === '乙', h1);
  const c2 = hub.newConversation('截断2', 'dsT');
  const f2 = hub._convFile(c2.id);
  fs.writeFileSync(f2, JSON.stringify({ role: 'user', text: '甲', at: 'x' }) + '\n{"role":"assistant","text":"半');
  hub._append(c2.id, { role: 'user', text: '丙', at: 'z' });
  const h2 = hub.history(c2.id);
  check('半截行：新记录不与坏行粘连，可解析', h2.length === 2 && h2[0].text === '甲' && h2[1].text === '丙', h2);
  check('文件以换行结尾', fs.readFileSync(f2, 'utf8').endsWith('\n'));
}

// ---------- 拉起后端：假 OpenAI 兼容端点 ----------
// chat 请求按 plan 返回文本、工具调用或持续流式；请求体含 BAD_HISTORY_MARKER 时按格式错误返回 400
const fake = { bodies: [], plan: [] };
const sse = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const fakeServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    let messages = [];
    try { messages = JSON.parse(body).messages || []; } catch { /* 非 JSON */ }
    const text = JSON.stringify(messages.filter((m) => m.role !== 'system'));
    fake.bodies.push(text);
    const step = text.includes('BAD_HISTORY_MARKER') ? { fail400: true } : (fake.plan.shift() || { text: '完成' });
    if (step.fail400) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: "Invalid 'messages[3]': bad history", type: 'invalid_request_error' } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write(sse({ role: 'assistant', content: '' }));
    if (step.slow) {
      // 持续流式不结束，直到连接断开（后端被杀）
      const timer = setInterval(() => res.write(sse({ content: '长文片段。'.repeat(10) })), 100);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (step.toolCall) {
      res.write(sse({ tool_calls: [{ index: 0, id: step.toolCall.id, type: 'function', function: { name: step.toolCall.name, arguments: step.toolCall.arguments } }] }));
      res.write(sse({}, 'tool_calls'));
    } else {
      res.write(sse({ content: step.text }));
      res.write(sse({}, 'stop'));
    }
    res.end('data: [DONE]\n\n');
  });
});
const fakePort = await freePort();
await new Promise((resolve) => fakeServer.listen(fakePort, '127.0.0.1', resolve));
atExit(() => { fakeServer.closeAllConnections(); fakeServer.close(); });

const dataDir = path.join(tmp, 'srv-data');
const corpus = path.join(tmp, 'srv-corpus');
const agentDir = path.join(dataDir, 'agents', 'default');
fs.mkdirSync(corpus, { recursive: true });
fs.writeFileSync(path.join(corpus, '论语.md'), '# 论语\n\n学而时习之，不亦说乎。');
fs.mkdirSync(path.join(corpus, '资料'), { recursive: true });
fs.writeFileSync(path.join(corpus, '资料', 'a.md'), '# 甲\n\n正文');
fs.writeFileSync(path.join(corpus, '资料', 'a.md.meta.json'), JSON.stringify({ id: 'doc_src_a', title: '甲' }, null, 2) + '\n');
fs.writeFileSync(path.join(corpus, '资料', '坏.md'), '读不到');
fs.writeFileSync(path.join(corpus, '单.md'), '读不到');
fs.writeFileSync(path.join(corpus, '好.md'), '# 好\n');
fs.writeFileSync(path.join(corpus, '好.md.meta.json'), JSON.stringify({ id: 'doc_src_good', title: '好' }, null, 2) + '\n');
fs.mkdirSync(path.join(corpus, 'rag'), { recursive: true });
for (let i = 0; i < 16; i++) fs.writeFileSync(path.join(corpus, 'rag', `r${i}.txt`), `第${i}篇。` + '检索用的正文。'.repeat(30));
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'llm-settings.json'), JSON.stringify({
  enabled: true, baseUrl: `http://127.0.0.1:${fakePort}/v1`, model: 'test-model', apiKey: 'x', thinkingLevel: 'off', mode: 'auto',
}));
fs.writeFileSync(path.join(dataDir, 'ui-settings.json'), JSON.stringify({ agentEnabled: true }));
const halfMcp = '{\n  "mcpServers": {\n    "old-server": {\n      "command": "node",\n      "args": ["old.js"';
fs.writeFileSync(path.join(agentDir, 'mcp.json'), halfMcp);
fs.mkdirSync(path.join(agentDir, 'skills', '.leftover.tmp-0123abcd'), { recursive: true });
fs.writeFileSync(path.join(agentDir, 'skills', '.leftover.tmp-0123abcd', 'SKILL.md'), '# 安装中断的残留');

let srv = null;
async function startBackend() {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1', WORKBENCH_DATA_DIR: dataDir, WORKBENCH_RAG_EMBED: 'mock', WORKBENCH_RAG_MOCK_EMBED_MS: '150' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', () => {}); // 日志在 backend.log
  const exited = new Promise((r) => proc.on('exit', r));
  atExit(() => { try { proc.kill('SIGKILL'); } catch { /* 已退出 */ } });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(base + '/api/config')).ok; } catch { return false; } }, 30000, '后端就绪');
  srv = { proc, base, exited };
  return srv;
}
async function killBackend() {
  srv.proc.kill('SIGKILL');
  await srv.exited;
}
const call = async (method, url, body) => {
  const r = await fetch(srv.base + url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
};
function openChat(sessionId, text) {
  const events = [];
  const ended = (async () => {
    const r = await fetch(srv.base + '/api/agent/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, text }),
    });
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (line.startsWith('data: ')) {
          try { events.push(JSON.parse(line.slice(6))); } catch { /* 非 JSON 行 */ }
        }
      }
    }
    return events;
  })();
  return { events, ended };
}
const chatDone = async (sessionId, text) => {
  const c = openChat(sessionId, text);
  const events = await Promise.race([c.ended, sleep(30000).then(() => { throw new Error('对话超时：' + text); })]);
  return { events, text: events.filter((e) => e.t === 'delta').map((e) => e.v).join(''), errors: events.filter((e) => e.t === 'error') };
};
const backendLog = () => { try { return fs.readFileSync(path.join(dataDir, 'logs', 'backend.log'), 'utf8'); } catch { return ''; } };
const convMeta = (id) => JSON.parse(fs.readFileSync(path.join(dataDir, 'conversations.json'), 'utf8')).conversations.find((c) => c.id === id);

await startBackend();
const lib = await call('POST', '/api/config', { baseDir: corpus });
if (lib.status !== 200) throw new Error('添加资料库失败: ' + lib.text);
const dsId = lib.json.dsId;
const convDir = path.join(dataDir, 'knowledge', dsId, 'conversations', 'default');

section('H2 复制：中途失败不留「副本」与临时目录；正常复制成功');
{
  const bad = path.join(corpus, '资料', '坏.md');
  fs.chmodSync(bad, 0o000);
  const r = await call('POST', '/api/file/duplicate', { path: '资料' });
  const leftovers = () => ls(corpus).filter((n) => n.includes('.wb-copy-'));
  check('源目录里有读不到的文件：复制返回错误', r.status >= 400 && !!r.json?.error, r.status + ' ' + r.text);
  check('库里没有「资料 - 副本」', !fs.existsSync(path.join(corpus, '资料 - 副本')));
  check('没有残留 .wb-copy-*', leftovers().length === 0, leftovers());
  fs.chmodSync(bad, 0o644);
  const r2 = await call('POST', '/api/file/duplicate', { path: '资料' });
  check('正常复制文件夹成功', r2.status === 200 && r2.json?.path === '资料 - 副本', r2.text);
  const dupMeta = JSON.parse(fs.readFileSync(path.join(corpus, '资料 - 副本', 'a.md.meta.json'), 'utf8'));
  check('副本内容完整、旁注 id 重新生成', fs.existsSync(path.join(corpus, '资料 - 副本', '坏.md')) && dupMeta.id !== 'doc_src_a' && dupMeta.title === '甲', dupMeta);
  check('复制成功后同样没有临时目录', leftovers().length === 0, leftovers());

  const single = path.join(corpus, '单.md');
  fs.chmodSync(single, 0o000);
  const r3 = await call('POST', '/api/file/duplicate', { path: '单.md' });
  check('单文件读不到：返回错误且没有「单 - 副本.md」与临时文件', r3.status >= 400 && !fs.existsSync(path.join(corpus, '单 - 副本.md')) && leftovers().length === 0, r3.status + ' ' + leftovers());
  fs.chmodSync(single, 0o644);
  const r4 = await call('POST', '/api/file/duplicate', { path: '好.md' });
  const goodMeta = JSON.parse(fs.readFileSync(path.join(corpus, '好 - 副本.md.meta.json'), 'utf8'));
  check('单文件正常复制：文档与旁注都在、id 重新生成、无临时文件',
    r4.status === 200 && fs.readFileSync(path.join(corpus, '好 - 副本.md'), 'utf8') === '# 好\n' && goodMeta.id !== 'doc_src_good' && leftovers().length === 0, r4.text);
}

section('M5 构建进行中经接口保存切块参数：409 并带提示；检索参数照常保存');
{
  const b = await call('POST', '/api/rag/index/build', { rebuild: false });
  check('开始构建', b.status === 200, b.text);
  const r = await call('PUT', '/api/rag/config', { chunk: { maxChars: 300 } });
  check('构建中改切块参数 → 409「构建进行中，暂停或完成后再修改」', r.status === 409 && r.json?.error === '构建进行中，暂停或完成后再修改', r.status + ' ' + r.text);
  const r2 = await call('PUT', '/api/rag/config', { search: { topN: 35 } });
  check('构建中改检索参数 → 200', r2.status === 200 && r2.json?.config?.search?.topN === 35, r2.text);
  const cfg = await call('GET', '/api/rag/config');
  check('切块参数没有被改动', cfg.json?.config?.chunk?.maxChars === 600, cfg.json?.config?.chunk);
  await call('POST', '/api/rag/index/pause', {});
  await waitFor(async () => (await call('GET', '/api/rag/status')).json?.index?.state === 'paused', 15000, '构建暂停');
  check('暂停后停在 paused', true);
}

section('L11 / L13：半截划线记录与 mcp.json 改名保留，之后的写入不清空其他内容');
{
  const a1 = await call('POST', '/api/notes/append', { sourcePath: '论语.md', quote: '学而时习之', note: '第一条' });
  check('追加第一条划线', a1.status === 200 && a1.json?.annotations === 1, a1.text);
  const annDir = path.join(corpus, '阅读笔记');
  const annFile = path.join(annDir, '.论语.annotations.json');
  const halfAnn = '[\n  {\n    "at": "2026-11-01T00:00:00.000Z",\n    "source": "论语.md",\n    "quote": "旧划线';
  fs.writeFileSync(annFile, halfAnn);
  const a2 = await call('POST', '/api/notes/append', { sourcePath: '论语.md', quote: '不亦说乎', note: '第二条' });
  check('划线记录写坏后仍能追加', a2.status === 200, a2.text);
  const annCorrupt = ls(annDir).filter((n) => n.startsWith('.论语.annotations.json.corrupt-'));
  check('坏的划线记录保留为 .corrupt-*，内容原样', annCorrupt.length === 1 && fs.readFileSync(path.join(annDir, annCorrupt[0]), 'utf8') === halfAnn, ls(annDir));
  const ann = JSON.parse(fs.readFileSync(annFile, 'utf8'));
  check('新记录可解析，只含本次条目', Array.isArray(ann) && ann.length === 1 && ann[0].quote === '不亦说乎', ann);
  check('划线记录损坏记了 WARN', /WARN .*划线记录无法解析/.test(backendLog()));

  const m = await call('POST', '/api/agent/mcp-server', { name: 'new-server', config: { command: 'node', args: ['new.js'] } });
  const mcpCorrupt = ls(agentDir).filter((n) => n.startsWith('mcp.json.corrupt-'));
  check('新增 MCP 服务器成功，响应提示原配置另存', m.status === 200 && /mcp\.json\.corrupt-/.test(m.json?.warning || ''), m.text);
  check('坏的 mcp.json 保留为 .corrupt-*，内容原样（old-server 还在）', mcpCorrupt.length === 1 && fs.readFileSync(path.join(agentDir, mcpCorrupt[0]), 'utf8') === halfMcp, ls(agentDir));
  const mcp = JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp.json'), 'utf8'));
  check('新 mcp.json 可解析且含新服务器', !!mcp.mcpServers?.['new-server'], mcp);
  check('WARN 写明原配置在 .corrupt 文件里', new RegExp(`WARN .*mcp\\.json 无法解析，已另存为 ${mcpCorrupt[0]?.replace(/\./g, '\\.')}`).test(backendLog()));
  const m2 = await call('POST', '/api/agent/mcp-server', { name: 'second', config: { command: 'node' } });
  const mcp2 = JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp.json'), 'utf8'));
  check('再新增不清空已有服务器', m2.status === 200 && !m2.json?.warning && !!mcp2.mcpServers['new-server'] && !!mcp2.mcpServers.second, mcp2);

  const st = await call('GET', '/api/agent/status');
  check('技能列表不含点开头的安装残留', !st.json.skills.some((s) => s.includes('leftover')), st.json.skills);
  const zip = new AdmZip();
  zip.addFile('myskill/SKILL.md', Buffer.from('# 我的技能\n'));
  const sk = await call('POST', '/api/agent/skill', { zipBase64: zip.toBuffer().toString('base64'), fileName: 'myskill.zip' });
  const skills = (await call('GET', '/api/agent/status')).json.skills;
  check('zip 安装技能成功且不留临时目录', sk.status === 200 && skills.includes('myskill') && !ls(path.join(agentDir, 'skills')).some((n) => n.startsWith('.myskill.tmp-')), { status: sk.status, skills });

  const am = await call('PUT', '/api/agent/agents-md', { content: '补充规则：先查索引' });
  const amRaw = fs.readFileSync(path.join(agentDir, 'AGENTS.md'), 'utf8');
  check('AGENTS.md 保存成功（保留 frontmatter）且无临时文件', am.status === 200 && amRaw.startsWith('---\n') && amRaw.includes('补充规则：先查索引') && !ls(agentDir).some((n) => n.startsWith('AGENTS.md.tmp-')), amRaw.slice(0, 40));
  const ack = await call('POST', '/api/diagnostics/ack', {});
  const ackRaw = fs.readFileSync(path.join(dataDir, 'logs', 'incident-ack.json'), 'utf8');
  check('诊断确认文件可解析且无临时文件', ack.status === 200 && !!JSON.parse(ackRaw).at && !ls(path.join(dataDir, 'logs')).some((n) => n.includes('incident-ack.json.tmp-')));
}

section('M2 助手：第二轮带上第一轮；重启后用 pi 会话接上完整上下文（含读过的文档）');
const TRANSCRIPT_HEAD = '以下是本对话此前的问答记录';
let convA;
{
  convA = (await call('POST', '/api/agent/session', { title: '续接' })).json.id;
  fake.plan = [
    { toolCall: { id: 'call_read', name: 'read_doc', arguments: JSON.stringify({ path: '论语.md' }) } },
    { text: '第一轮回答：讲学习' },
  ];
  const r1 = await chatDone(convA, '第一轮问题：论语开篇讲什么');
  check('第一轮完成（读文档后回答）', r1.text.includes('第一轮回答') && !r1.errors.length, r1.errors);
  fake.plan = [{ text: '第二轮回答' }];
  let mark = fake.bodies.length;
  const r2 = await chatDone(convA, '第二轮问题');
  const req2 = fake.bodies[mark] || '';
  check('第二轮完成', r2.text.includes('第二轮回答') && !r2.errors.length, r2.errors);
  check('第二轮请求含第一轮的问、答与读过的文档', req2.includes('第一轮问题：论语开篇讲什么') && req2.includes('第一轮回答：讲学习') && req2.includes('不亦说乎'), req2.slice(0, 300));
  const meta = convMeta(convA);
  check('对话元数据记下 piSessionFile 且文件存在', !!meta?.piSessionFile && fs.existsSync(path.join(convDir, meta.piSessionFile)), meta);

  await killBackend();
  await startBackend();
  fake.plan = [{ text: '第三轮回答' }];
  mark = fake.bodies.length;
  const r3 = await chatDone(convA, '第三轮问题');
  const req3 = fake.bodies[mark] || '';
  check('重启后第三轮完成', r3.text.includes('第三轮回答') && !r3.errors.length, r3.errors);
  check('重启后请求仍含第一轮的问、答与读过的文档', req3.includes('第一轮问题：论语开篇讲什么') && req3.includes('第一轮回答：讲学习') && req3.includes('不亦说乎'), req3.slice(0, 300));
  check('重启后请求含第二轮', req3.includes('第二轮问题') && req3.includes('第二轮回答'));
  check('走的是完整会话恢复（不是文字历史回退）', !req3.includes(TRANSCRIPT_HEAD));
}

section('M2 生成到一半被杀：重启后历史里有 interrupted 的半截回复');
{
  fake.plan = [{ slow: true }];
  const c = openChat(convA, '第四轮：写一篇长文');
  c.ended.catch(() => { /* 后端被杀，连接中断 */ });
  const partialFile = path.join(convDir, convA + '.partial.json');
  const partial = await waitFor(() => {
    try {
      const p = JSON.parse(fs.readFileSync(partialFile, 'utf8'));
      return p.text ? p : null;
    } catch {
      return null;
    }
  }, 15000, '进行中记录落盘');
  check('生成中写出了进行中记录', partial.text.includes('长文片段'), partial.text.slice(0, 40));
  await killBackend();
  check('被杀后进行中记录还在', fs.existsSync(partialFile));
  await startBackend();
  check('启动后进行中记录已并入历史并删除', !fs.existsSync(partialFile));
  const s = await call('GET', '/api/agent/session/' + convA);
  const msgs = s.json?.messages || [];
  const last = msgs[msgs.length - 1];
  check('历史最后一条是 interrupted 的半截回复，正文为落盘内容', last?.role === 'assistant' && last.interrupted === true && last.text === partial.text, last);
  check('半截回复之前是本轮的用户消息', msgs[msgs.length - 2]?.text === '第四轮：写一篇长文', msgs[msgs.length - 2]);
}

section('M2 pi 会话文件损坏：退回文字历史接上，记 WARN');
{
  const oldPi = convMeta(convA).piSessionFile;
  await killBackend();
  fs.writeFileSync(path.join(convDir, oldPi), 'garbage\nnot json\n');
  await startBackend();
  fake.plan = [{ text: '第五轮回答' }];
  const mark = fake.bodies.length;
  const r5 = await chatDone(convA, '第五轮问题');
  const req5 = fake.bodies[mark] || '';
  check('会话文件损坏时对话照常完成', r5.text.includes('第五轮回答') && !r5.errors.length, r5.errors);
  check('请求带上显示历史的问答文字（含第一轮与中断的半截回复）', req5.includes(TRANSCRIPT_HEAD) && req5.includes('第一轮问题：论语开篇讲什么') && req5.includes('长文片段'), req5.slice(0, 300));
  check('记了 WARN', /WARN .*pi 会话文件无法打开，改用文字历史接上/.test(backendLog()));
  const newPi = convMeta(convA).piSessionFile;
  check('新建了会话文件并记回元数据', !!newPi && newPi !== oldPi && fs.existsSync(path.join(convDir, newPi)), { oldPi, newPi });
}

section('M2 续上的会话首轮报格式错误：退回文字历史重发本轮，记 WARN');
{
  const convB = (await call('POST', '/api/agent/session', { title: '格式' })).json.id;
  fake.plan = [{ text: 'B 第一轮回答' }];
  await chatDone(convB, 'B 第一轮问题');
  const piB = path.join(convDir, convMeta(convB).piSessionFile);
  await killBackend();
  // 在会话末尾接一条端点会拒绝的消息（JSON 合法、结构可读，模拟会话内容与端点不兼容）
  const lines = fs.readFileSync(piB, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const lastEntry = lines[lines.length - 1];
  const userEntry = [...lines].reverse().find((e) => e.type === 'message' && e.message?.role === 'user');
  const bad = JSON.parse(JSON.stringify(userEntry));
  bad.id = 'badbad01';
  bad.parentId = lastEntry.id;
  bad.message.content = [{ type: 'text', text: 'BAD_HISTORY_MARKER' }];
  fs.appendFileSync(piB, JSON.stringify(bad) + '\n');
  await startBackend();
  fake.plan = [{ text: 'B 回退后的回答' }];
  const mark = fake.bodies.length;
  const rB = await chatDone(convB, 'B 第二轮问题');
  const reqs = fake.bodies.slice(mark);
  check('首轮请求被 400 拒绝后自动重发并完成，界面没有错误', rB.text.includes('B 回退后的回答') && !rB.errors.length, { errors: rB.errors, n: reqs.length });
  check('第一次请求带着坏会话（被拒），第二次是文字历史', reqs.length === 2 && reqs[0].includes('BAD_HISTORY_MARKER') && !reqs[1].includes('BAD_HISTORY_MARKER') && reqs[1].includes(TRANSCRIPT_HEAD) && reqs[1].includes('B 第一轮问题'), reqs.map((x) => x.slice(0, 120)));
  check('重发的请求里本轮问题只出现一次', (reqs[1] || '').split('B 第二轮问题').length - 1 === 1);
  const hist = (await call('GET', '/api/agent/session/' + convB)).json.messages;
  check('显示历史：本轮用户消息一条、回答无失败标记', hist.filter((m) => m.text === 'B 第二轮问题').length === 1 && hist[hist.length - 1].text === 'B 回退后的回答' && !hist[hist.length - 1].failure, hist.slice(-2));
  check('记了 WARN', /WARN .*首轮请求报会话格式错误，改用文字历史新建会话/.test(backendLog()));
  check('会话文件换成新建的', convMeta(convB).piSessionFile !== path.basename(piB));
}

section('M2 回退后重发仍报格式错误：保留原会话文件，丢弃回退会话；之后仍可回退成功');
{
  const convC = (await call('POST', '/api/agent/session', { title: '回退失败' })).json.id;
  fake.plan = [{ text: 'C 第一轮回答' }];
  await chatDone(convC, 'C 第一轮问题');
  const piName = convMeta(convC).piSessionFile;
  const piC = path.join(convDir, piName);
  await killBackend();
  const lines = fs.readFileSync(piC, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const userEntry = [...lines].reverse().find((e) => e.type === 'message' && e.message?.role === 'user');
  const bad = JSON.parse(JSON.stringify(userEntry));
  bad.id = 'badbad02';
  bad.parentId = lines[lines.length - 1].id;
  bad.message.content = [{ type: 'text', text: 'BAD_HISTORY_MARKER' }];
  fs.appendFileSync(piC, JSON.stringify(bad) + '\n');
  await startBackend();
  const filesOfC = () => ls(convDir).filter((n) => n.includes(`_${convC}-`));
  fake.plan = [{ fail400: true }]; // 文字历史重发同样被拒（问题不在原会话）
  const r1 = await chatDone(convC, 'C 第二轮问题');
  check('重发仍失败：界面收到错误', r1.errors.length === 1, r1.errors);
  check('元数据仍指向原会话文件', convMeta(convC).piSessionFile === piName, convMeta(convC).piSessionFile);
  await waitFor(() => filesOfC().length === 1, 3000, '回退会话文件被删除');
  check('回退会话的文件已删除，只剩原会话文件', filesOfC().length === 1 && filesOfC()[0] === piName, filesOfC());
  check('记了 WARN', /WARN .*改用文字历史重发仍失败，保留原 pi 会话文件/.test(backendLog()));
  fake.plan = [{ text: 'C 回退成功' }];
  const r2 = await chatDone(convC, 'C 第三轮问题');
  check('下一轮重新打开原会话、回退后成功', r2.text.includes('C 回退成功') && !r2.errors.length, r2.errors);
  check('成功后改用新会话文件', convMeta(convC).piSessionFile !== piName && filesOfC().includes(convMeta(convC).piSessionFile), filesOfC());
}

section('M2 编辑消息原子重写；删除对话一并删除 pi 会话文件与进行中记录');
{
  const e = await call('PUT', `/api/agent/session/${convA}/message/0`, { text: '改过的第一问' });
  const h = (await call('GET', '/api/agent/session/' + convA)).json.messages;
  check('编辑消息生效且无临时文件', e.status === 200 && h[0].text === '改过的第一问' && !ls(convDir).some((n) => n.includes('.tmp-')), ls(convDir).filter((n) => n.includes('.tmp-')));
  const meta = convMeta(convA);
  const piFile = path.join(convDir, meta.piSessionFile);
  const partialFile = path.join(convDir, convA + '.partial.json');
  fs.writeFileSync(partialFile, '{}'); // 模拟遗留的进行中记录
  check('删除前 pi 会话文件存在', fs.existsSync(piFile));
  const d = await call('DELETE', '/api/agent/session/' + convA);
  check('删除对话后显示记录、pi 会话文件、进行中记录都不存在',
    d.status === 200 && !fs.existsSync(path.join(convDir, convA + '.jsonl')) && !fs.existsSync(piFile) && !fs.existsSync(partialFile), ls(convDir));
}

await killBackend();
console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
