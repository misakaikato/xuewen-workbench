// 反馈第 2 批回归：模型导入/下载/取消的阶段与进度、事件循环不被阻塞、
// 清库分批与中断续建、构建前置检查、「等待文本索引」状态先于 await 切换。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeTmpDir } from './tmpdirs.mjs';

const tmp = makeTmpDir('wb-ragfb-');
let pass = 0, fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + ': ' + JSON.stringify(detail)); }
}
const section = (t) => console.log('\n' + t);

// ---------- 假下载源（参照 test-download.mjs）：供 probe 与文件 GET ----------
const ONNX_REPO = 'Xenova/bge-m3';
const ONNX_FILES = {
  'config.json': Buffer.from(JSON.stringify({ file: 'config', pad: 'x'.repeat(4096) })),
  'tokenizer.json': Buffer.from(JSON.stringify({ file: 'tok', pad: 'x'.repeat(8192) })),
  'tokenizer_config.json': Buffer.from(JSON.stringify({ file: 'tokcfg', pad: 'x'.repeat(2048) })),
  'special_tokens_map.json': Buffer.from(JSON.stringify({ file: 'stm', pad: 'x'.repeat(2048) })),
  'onnx/model_fp16.onnx': crypto.randomBytes(4 * 1024 * 1024),
};
let slowMode = false; // 慢速流式：拉长下载窗口，供取消用例观察中间进度
const server = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  const rel = req.url.replace(/^\/.*?\/resolve\/main\//, '');
  if (req.method === 'HEAD') {
    if (ONNX_FILES[rel]) { res.writeHead(200, { 'Content-Length': String(ONNX_FILES[rel].length) }); res.end(); }
    else { res.writeHead(404); res.end(); }
    return;
  }
  const buf = ONNX_FILES[rel];
  if (!buf) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Length': String(buf.length), 'Accept-Ranges': 'bytes' });
  if (!slowMode) { res.end(buf); return; }
  let off = 0;
  const timer = setInterval(() => {
    if (off >= buf.length) { clearInterval(timer); res.end(); return; }
    const next = Math.min(buf.length, off + 16384);
    res.write(buf.subarray(off, next));
    off = next;
  }, 2);
  res.on('close', () => clearInterval(timer));
});
const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// 必须在导入 embed.js 前设置：HOSTS 在模块加载期读取
process.env.WORKBENCH_RAG_MODEL_HOSTS = `http://127.0.0.1:${port}`;
process.env.WORKBENCH_RAG_EMBED = 'onnx';

const { EmbedService } = await import('../server/rag/embed.js');
const { RagManager } = await import('../server/rag/manager.js');
const { DIM } = await import('../server/rag/embed.js');

// ---------- 小节 1：导入（后台任务 + 进度 + 不阻塞） ----------
section('导入：立即返回、进度单调、阶段 copy→verify、不阻塞事件循环');
{
  const dataDir = path.join(tmp, 'd-import');
  const srcDir = path.join(tmp, 'src-import');
  fs.mkdirSync(srcDir, { recursive: true });
  // macOS 走 mlx 文件集（含 model.safetensors）；约 50MB
  const big = crypto.randomBytes(50 * 1024 * 1024);
  fs.writeFileSync(path.join(srcDir, 'model.safetensors'), big);
  for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json']) {
    fs.writeFileSync(path.join(srcDir, f), JSON.stringify({ file: f, pad: 'x'.repeat(2048) }));
  }
  const embed = new EmbedService(dataDir);

  const samples = []; // 阶段序列 + status 耗时（外部轮询）
  const inHook = [];  // hook 内的 status 耗时（并发可见性）
  embed._importCopyHook = async () => {
    const t = process.hrtime.bigint();
    embed.status();
    inHook.push(Number(process.hrtime.bigint() - t) / 1e6);
    await sleep(1); // 略微放慢，保证轮询能观察到中间进度
  };
  const t0 = Date.now();
  const r = embed.importDir(srcDir);
  check('导入立即返回 started', r.ok === true && r.started === true, r);
  check('导入调用在 200ms 内返回', Date.now() - t0 < 200, Date.now() - t0);
  const pollTimer = setInterval(() => {
    const st = embed.status();
    if (st.progress) samples.push({ phase: st.progress.phase, bytes: st.progress.overallBytes });
  }, 3);
  await embed._downloadTask;
  clearInterval(pollTimer);
  const st = embed.status();
  check('导入完成后进入 ready', st.state === 'ready' && st.backend === 'mlx', st.state);
  check('导入期间并发 status() 均在 200ms 内', inHook.length > 0 && inHook.every((ms) => ms < 200), inHook);
  const phases = [...new Set(samples.map((s) => s.phase))];
  check('阶段依次为 copy、verify', phases[0] === 'copy' && phases.includes('verify'), phases);
  const byteSamples = samples.map((s) => s.bytes);
  const monotonic = byteSamples.every((v, i) => i === 0 || v >= byteSamples[i - 1]);
  check('总体字节进度单调不减', byteSamples.length > 1 && monotonic, byteSamples.slice(0, 5));
  const mid = samples.find((s) => s.phase === 'copy' && s.bytes > 0 && s.bytes < 50 * 1024 * 1024);
  check('copy 阶段观察到中间进度（非 0 非 100）', !!mid, samples.slice(0, 8));
  const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'models', 'bge-m3', 'mlx-fp16', 'model.json'), 'utf8'));
  const bigEntry = manifest.files.find((x) => x.path === 'model.safetensors');
  const bigSha = crypto.createHash('sha256').update(big).digest('hex');
  check('清单 sha 与源文件一致', bigEntry && bigEntry.sha256 === bigSha, bigEntry);
}

// ---------- 小节 2：导入取消 ----------
section('导入取消：半截文件被清理，状态回到原值');
{
  const dataDir = path.join(tmp, 'd-import-cancel');
  const srcDir = path.join(tmp, 'src-import'); // 复用上一节的源目录
  const embed = new EmbedService(dataDir);
  let cancelled = false;
  embed._importCopyHook = async (copied, total) => {
    if (!cancelled && total > 1048576) { cancelled = true; embed.cancel(); } // 在大文件中途取消
    await sleep(1);
  };
  const r = embed.importDir(srcDir);
  check('取消用例导入仍立即返回', r.ok === true && r.started === true, r);
  await embed._downloadTask;
  const st = embed.status();
  check('取消后状态回到 missing', st.state === 'missing', st.state);
  check('取消后 canCancel 为 false', st.canCancel === false, st.canCancel);
  const modelDir = path.join(dataDir, 'models', 'bge-m3', 'mlx-fp16');
  const parts = fs.existsSync(modelDir) ? fs.readdirSync(modelDir, { recursive: true }) : [];
  check('半截 .part 已删除', !parts.some((p) => String(p).includes('.part')), parts);
  check('未写入清单', !fs.existsSync(path.join(modelDir, 'model.json')));
  const again = embed.cancel();
  check('无任务时取消返回错误', again.ok === false && /没有进行中的任务/.test(again.error), again);
}

// ---------- 小节 3：缺文件导入 ----------
section('缺文件导入：同步返回 ok:false');
{
  const embed = new EmbedService(path.join(tmp, 'd-import-miss'));
  const badDir = path.join(tmp, 'src-miss');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'config.json'), '{}');
  const r = embed.importDir(badDir);
  check('缺文件同步返回 {ok:false,error}', r.ok === false && /缺少文件/.test(r.error), r);
  const r2 = embed.importDir(path.join(tmp, 'no-such-dir'));
  check('目录不存在同步返回 {ok:false,error}', r2.ok === false && /目录不存在/.test(r2.error), r2);
  const embed2 = new EmbedService(path.join(tmp, 'd-import-miss'));
  check('状态未被失败导入污染', embed2.status().state === 'missing', embed2.status().state);
}

// ---------- 小节 4：下载（阶段序列 + 总体进度 + 取消） ----------
section('下载：probe→download→verify、总体进度单调、取消删半截');
{
  const dataDir = path.join(tmp, 'd-dl');
  const embed = new EmbedService(dataDir);
  const samples = [];
  const pollTimer = setInterval(() => {
    const st = embed.status();
    if (st.progress) samples.push({ phase: st.progress.phase, bytes: st.progress.overallBytes, file: st.progress.file });
  }, 3);
  const r = embed.download();
  check('下载立即返回 started', r.ok === true && r.started === true, r);
  const r2 = embed.download();
  check('下载中重复请求返回 already（不会有两个下载）', r2.ok === true && r2.already === true, r2);
  await embed._downloadTask;
  clearInterval(pollTimer);
  const st = embed.status();
  check('下载完成后 ready（onnx）', st.state === 'ready' && st.backend === 'onnx', { state: st.state, backend: st.backend });
  const phases = [...new Set(samples.map((s) => s.phase).filter(Boolean))];
  const iProbe = phases.indexOf('probe'), iDl = phases.indexOf('download'), iVf = phases.indexOf('verify');
  check('阶段依次经过 probe、download、verify', iProbe >= 0 && iDl > iProbe && iVf > iDl, phases);
  const byteSamples = samples.map((s) => s.bytes);
  const monotonic = byteSamples.every((v, i) => i === 0 || v >= byteSamples[i - 1]);
  check('总体字节进度单调不减', byteSamples.length > 1 && monotonic, byteSamples.slice(0, 6));
  const onnxSha = crypto.createHash('sha256').update(ONNX_FILES['onnx/model_fp16.onnx']).digest('hex');
  check('下载后清单 sha 正确', st.sha === onnxSha, st.sha);
}

section('下载取消：半截 .part 删除，状态回到 missing，可重新下载');
{
  slowMode = true;
  const dataDir = path.join(tmp, 'd-dl-cancel');
  const embed = new EmbedService(dataDir);
  embed.download();
  let cancelled = false;
  for (let i = 0; i < 2000 && !cancelled; i++) {
    const st = embed.status();
    if (st.progress && st.progress.file === 'onnx/model_fp16.onnx' && st.progress.bytes > 0) {
      embed.cancel();
      cancelled = true;
    } else await sleep(3);
  }
  check('在大文件下载中观察到中间进度并发出取消', cancelled);
  await embed._downloadTask;
  const st = embed.status();
  check('取消后状态回到 missing', st.state === 'missing', st.state);
  const onnxDir = path.join(dataDir, 'models', 'bge-m3', 'onnx-fp16');
  const parts = fs.existsSync(onnxDir) ? fs.readdirSync(path.join(onnxDir, 'onnx'), { withFileTypes: true }).map((d) => d.name) : [];
  check('半截 .part 已删除', !parts.some((p) => p.endsWith('.part')), parts);
  check('未写入清单', !fs.existsSync(path.join(onnxDir, 'model.json')));
  slowMode = false;
  embed.download(); // 从头重下
  await embed._downloadTask;
  const st2 = embed.status();
  check('取消后可从头重新下载到 ready', st2.state === 'ready', st2.state);
}

// ---------- 小节 5：清库分批 + 中断续建 ----------
section('清库分批：进度可见、不阻塞、中断后续建结果一致');
{
  const mkCorpus = (nFiles, chunksPer) => {
    const corpus = path.join(tmp, 'corpus-clear');
    fs.mkdirSync(corpus, { recursive: true });
    for (let i = 0; i < nFiles; i++) {
      const paras = [];
      for (let j = 0; j < chunksPer; j++) paras.push('第' + j + '段' + '内容填充。'.repeat(140)); // 每段超上限独立成块
      fs.writeFileSync(path.join(corpus, 'f' + i + '.txt'), paras.join('\n\n'));
    }
    const files = fs.readdirSync(corpus).map((n) => {
      const abs = path.join(corpus, n);
      const st = fs.statSync(abs);
      return { path: n, name: n, base: n.slice(0, -4), ext: '.txt', mtimeMs: st.mtimeMs, size: st.size, dir: '' };
    });
    const texts = new Map(files.map((f) => [f.path, fs.readFileSync(path.join(corpus, f.path), 'utf8')]));
    return { files, texts };
  };
  const { files, texts } = mkCorpus(20, 1000); // 2 万块
  const mkMgr = (id) => {
    const getLib = (dsId) => dsId === id ? {
      snapshot: { files },
      getText: (p) => texts.get(p) ?? null,
      whenIndexed: () => Promise.resolve(),
    } : null;
    return new RagManager({ dataDir: path.join(tmp, 'data-' + id), knowledgeDir: path.join(tmp, 'k-' + id), getLib });
  };
  const vector = () => { const v = new Float32Array(DIM); v[0] = 1; return v; };

  // 参照：一次跑完
  const refMgr = mkMgr('ref');
  refMgr.embed.embed = async (t) => t.map(vector);
  await refMgr.build('ref', { rebuild: true });
  const refStats = refMgr.index('ref').store.stats();
  check('参照库有 2 万块', refStats.chunks >= 20000, refStats);

  // 中断：先建满 2 万块，再 rebuild 并在第 3 批后抛错
  const mgr = mkMgr('intr');
  mgr.embed.embed = async (t) => t.map(vector);
  await mgr.build('intr', { rebuild: true });
  const ix = mgr.index('intr');
  check('中断前库里已有 2 万块', ix.store.stats().chunks >= 20000, ix.store.stats());
  const clearSamples = [];
  let batches = 0;
  ix._clearBatchHook = (done, total) => {
    batches++;
    const t = process.hrtime.bigint();
    const st = ix.status(); // 清理期间的并发 status
    clearSamples.push({ done, total, ms: Number(process.hrtime.bigint() - t) / 1e6, phase: st.phase, clearing: st.clearing });
    if (batches >= 3) throw new Error('模拟中断');
  };
  const r = await mgr.build('intr', { rebuild: true });
  check('中断后构建返回 ok:false', r.ok === false && /模拟中断/.test(r.error), r);
  const stErr = ix.status();
  check('中断后状态为 error', stErr.state === 'error', stErr.state);
  check('清理阶段有进度（done/total）', clearSamples.length >= 3 && clearSamples[2].total >= 20000 && clearSamples[2].done > 0, clearSamples[2]);
  check('清理期间 phase 为「清理旧索引」', clearSamples.every((s) => s.phase === '清理旧索引'), clearSamples.map((s) => s.phase));
  check('清理期间 status() 在 200ms 内', clearSamples.every((s) => s.ms < 200), clearSamples.map((s) => s.ms));
  const doneSeq = clearSamples.map((s) => s.done);
  check('清理进度单调不减', doneSeq.every((v, i) => i === 0 || v >= doneSeq[i - 1]), doneSeq);
  const leftover = ix.store.stats();
  check('中断后库里仍有残留（未清完）', leftover.chunks > 0, leftover);

  // 续建：不再中断，先清余量再全量重建
  ix._clearBatchHook = null;
  const r2 = await mgr.build('intr', { rebuild: true });
  check('续建成功', r2.ok === true, r2);
  const fin = ix.store.stats();
  check('续建后文件数与参照一致', fin.files === refStats.files, { fin: fin.files, ref: refStats.files });
  check('续建后块数与参照一致', fin.chunks === refStats.chunks, { fin: fin.chunks, ref: refStats.chunks });
}

// ---------- 小节 6：构建前置检查 ----------
section('构建前置检查：无快照返回错误且进入状态');
{
  const getLib = () => null; // 无快照
  const mgr = new RagManager({ dataDir: path.join(tmp, 'data-pre'), knowledgeDir: path.join(tmp, 'k-pre'), getLib });
  const r = await mgr.build('pre', {});
  check('无快照返回 ok:false', r.ok === false && /尚未扫描完成/.test(r.error), r);
  const st = mgr.index('pre').status();
  check('错误进入状态（state=error）', st.state === 'error' && /尚未扫描完成/.test(st.error), { state: st.state, error: st.error });
}

// ---------- 小节 7：等待文本索引（状态先于 await） ----------
section('等待文本索引：立即 building，暂停直接停在 paused');
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const files = [{
    path: 'a.md', name: 'a.md', base: 'a', ext: '.md',
    mtimeMs: fs.statSync(path.join(tmp, 'corpus-clear', 'f0.txt')).mtimeMs, size: 10, dir: '',
  }];
  const getLib = (id) => id === 'wait' ? {
    snapshot: { files },
    getText: () => '# 甲\n\n孔子',
    whenIndexed: () => gate,
  } : null;
  const mgr = new RagManager({ dataDir: path.join(tmp, 'data-wait'), knowledgeDir: path.join(tmp, 'k-wait'), getLib });
  let embedCalls = 0;
  mgr.embed.embed = async (t) => { embedCalls += t.length; return t.map(() => { const v = new Float32Array(DIM); v[0] = 1; return v; }); };
  const ix = mgr.index('wait');
  const bp = mgr.build('wait', {}); // 不 await：先断言同步切换
  const st = ix.status();
  check('调用后立即 building', st.state === 'building', st.state);
  check('phase 为「等待文本索引」', st.phase === '等待文本索引', st.phase);
  const pr = ix.pause();
  check('等待期间暂停返回 ok', pr.ok === true, pr);
  check('暂停后状态为 pausing', ix.status().state === 'pausing', ix.status().state);
  release();
  const r = await bp;
  check('等待结束后直接停在 paused', r.ok === true && r.paused === true && ix.status().state === 'paused', { r, st: ix.status().state });
  check('未开始嵌入（不调用 embed）', embedCalls === 0, embedCalls);
}

// ---------- 小节 8：ensureVenv 路径 A（uv 在线）：一次性联合安装 ----------
section('ensureVenv 路径 A：一次性联合安装（打桩 uv）');
{
  const stubDir = path.join(tmp, 'uv-stub');
  fs.mkdirSync(stubDir, { recursive: true });
  const callsFile = path.join(stubDir, 'calls.log');
  const embed = new EmbedService(path.join(tmp, 'd-venv'));
  fs.writeFileSync(path.join(stubDir, 'uv'), `#!/bin/sh
echo "$@" >> ${JSON.stringify(callsFile)}
if [ "$1" = "venv" ]; then mkdir -p "$4/bin"; : > "$4/bin/python"; fi
exit 0
`);
  fs.chmodSync(path.join(stubDir, 'uv'), 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = stubDir + ':' + prevPath;
  const phases = [];
  try {
    await embed.ensureVenv((ph, detail) => phases.push(ph + '|' + detail));
  } finally {
    process.env.PATH = prevPath;
  }
  const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n');
  const installs = calls.filter((l) => l.startsWith('pip install'));
  check('uv 路径只调一次 pip install（一次性联合解析）', installs.length === 1, installs);
  const { MLX_REQUIREMENTS } = await import('../server/rag/embed.js');
  check('pip install 带全部依赖包', MLX_REQUIREMENTS.every((pkg) => installs[0].includes(pkg)), installs[0]);
  check('phaseDetail 为「安装依赖（共 N 个包）」且不含逐包计数',
    phases.includes('env-install|安装依赖（共 ' + MLX_REQUIREMENTS.length + ' 个包）') &&
    !phases.some((x) => /安装依赖 \d+\//.test(x)), phases);
  await embed.ensureVenv((ph, detail) => phases.push(ph + '|' + detail));
  const calls2 = fs.readFileSync(callsFile, 'utf8').trim().split('\n');
  check('venv 已存在时幂等返回（不再安装）', calls2.length === calls.length, calls2.length);
}

// ---------- 小节 9：ensureVenv 半截环境（取消清理 / 自检重建 / 自检补标记） ----------
section('ensureVenv：安装中取消删环境；无标记环境自检后重建或补标记');
{
  const mkUvStub = (stubDir, callsFile, opts = {}) => {
    fs.mkdirSync(stubDir, { recursive: true });
    // pip 计数+首睡等杀（用例 1）；venv 创建可执行 python 桩
    const slowFirst = opts.slowFirst
      ? `if [ "$1" = "pip" ]; then
  n=$(cat ${JSON.stringify(path.join(stubDir, 'count'))} 2>/dev/null || echo 0)
  echo $((n+1)) > ${JSON.stringify(path.join(stubDir, 'count'))}
  if [ "$n" -ge 1 ]; then exit 0; fi
  echo $$ > ${JSON.stringify(path.join(stubDir, 'pid'))}
  sleep 30
fi`
      : '';
    fs.writeFileSync(path.join(stubDir, 'uv'), `#!/bin/sh
echo "$@" >> ${JSON.stringify(callsFile)}
if [ "$1" = "venv" ]; then
  mkdir -p "$4/bin"
  printf '#!/bin/sh\\nexit 0\\n' > "$4/bin/python"
  chmod +x "$4/bin/python"
  exit 0
fi
${slowFirst}
exit 0
`);
    fs.chmodSync(path.join(stubDir, 'uv'), 0o755);
  };
  const mkPyStub = (pyPath, probeLog, ok) => {
    fs.mkdirSync(path.dirname(pyPath), { recursive: true });
    fs.writeFileSync(pyPath, `#!/bin/sh
echo "$@" >> ${JSON.stringify(probeLog)}
if [ "$1" = "-c" ]; then ${ok ? 'exit 0' : 'echo ModuleNotFoundError: No module named mlx >&2; exit 1'}; fi
exit 0
`);
    fs.chmodSync(pyPath, 0o755);
  };
  const withPath = (dir, fn) => {
    const prev = process.env.PATH;
    process.env.PATH = dir + ':' + prev;
    return Promise.resolve(fn()).finally(() => { process.env.PATH = prev; });
  };

  // 1) 安装进行中取消：venvDir 删除，再次置备走完并写标记
  {
    const stubDir = path.join(tmp, 'uv-stub-cancel');
    const callsFile = path.join(stubDir, 'calls.log');
    mkUvStub(stubDir, callsFile, { slowFirst: true });
    const embed = new EmbedService(path.join(tmp, 'd-venv-cancel'));
    embed.state = 'downloading'; // 模拟下载任务中，使 cancel() 可杀安装进程
    const p = withPath(stubDir, () => embed.ensureVenv());
    let started = false;
    for (let i = 0; i < 500 && !started; i++) {
      started = fs.existsSync(path.join(stubDir, 'pid'));
      if (!started) await sleep(10);
    }
    check('取消用例：安装进程已启动', started);
    const cr = embed.cancel();
    check('取消返回 ok', cr.ok === true, cr);
    let threw = null;
    await p.catch((e) => { threw = e; });
    check('取消后 ensureVenv 抛错', !!threw && /uv pip install 失败/.test(threw.message), threw && threw.message);
    check('取消后 venvDir 被删除（不留半截环境）', !fs.existsSync(embed.venvDir), embed.venvDir);
    embed._cancelFlag = false;
    embed.state = 'missing';
    await withPath(stubDir, () => embed.ensureVenv());
    check('再次置备能走完并写入标记', fs.existsSync(path.join(embed.venvDir, '.wb-complete')));
  }

  // 2) 有 python 无标记，自检失败：删旧 venv 重建
  {
    const stubDir = path.join(tmp, 'uv-stub-rebuild');
    const callsFile = path.join(stubDir, 'calls.log');
    mkUvStub(stubDir, callsFile);
    const dataDir = path.join(tmp, 'd-venv-rebuild');
    const venv = path.join(dataDir, 'py', 'rag-venv');
    const probeLog = path.join(tmp, 'probe-fail.log');
    mkPyStub(path.join(venv, 'bin', 'python'), probeLog, false);
    const embed = new EmbedService(dataDir);
    await withPath(stubDir, () => embed.ensureVenv());
    check('自检桩被调用', fs.existsSync(probeLog) && fs.readFileSync(probeLog, 'utf8').includes('-c'));
    check('自检失败后 venv 被重建并写标记', fs.existsSync(path.join(venv, '.wb-complete')));
    const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8') : '';
    check('重建走了 uv venv + pip install', calls.includes('venv') && calls.includes('pip install'), calls);
  }

  // 3) 有 python 无标记，自检成功：补标记，不重建
  {
    const stubDir = path.join(tmp, 'uv-stub-keep');
    const callsFile = path.join(stubDir, 'calls.log');
    mkUvStub(stubDir, callsFile);
    const dataDir = path.join(tmp, 'd-venv-keep');
    const venv = path.join(dataDir, 'py', 'rag-venv');
    const probeLog = path.join(tmp, 'probe-ok.log');
    mkPyStub(path.join(venv, 'bin', 'python'), probeLog, true);
    const embed = new EmbedService(dataDir);
    await withPath(stubDir, () => embed.ensureVenv());
    check('自检通过补写标记', fs.existsSync(path.join(venv, '.wb-complete')));
    check('未重建（无 uv 调用）', !fs.existsSync(callsFile));
    await withPath(stubDir, () => embed.ensureVenv());
    const probes = fs.existsSync(probeLog) ? fs.readFileSync(probeLog, 'utf8').trim().split('\n') : [];
    check('标记存在时幂等（不再自检）', probes.length === 1, probes);
  }
}

// ---------- 收尾 ----------
server.closeAllConnections();
await new Promise((r) => server.close(r));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
