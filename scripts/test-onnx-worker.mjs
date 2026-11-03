// ONNX worker 回归：夹具模型 + 真实 bge-m3 分词器，验证 worker 推理与旧同步实现逐维一致、
// 推理期间主线程不阻塞、dispose/崩溃后的生命周期、优雅关闭与日志上报。夹具与分词器放 os.tmpdir()，不入库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTmpDir } from './tmpdirs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);
const TOKENIZER_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json'];
const MODEL = 'bge-m3';
const DIM = 256; // 夹具输出维度

let checks = 0;
function test(name, fn) {
  return Promise.resolve(fn()).then(() => { checks++; console.log('PASS ' + name); });
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve(code === 0 ? { ok: true, err } : { ok: false, err: err.slice(-2000) }));
    p.on('error', (e) => resolve({ ok: false, err: String(e) }));
  });
}

async function skip(reason) {
  console.log('SKIP（' + reason + '）');
  process.exit(0);
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Node fetch 直连可达时优先；走系统代理的环境回退 curl（fetch 不读 HTTP(S)_PROXY）
  try {
    const res = await fetch(url);
    if (res.ok) {
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return;
    }
    throw new Error('HTTP ' + res.status);
  } catch {
    const r = await run('curl', ['-fsSL', '--retry', '3', '-o', dest, url]);
    if (!r.ok) throw new Error(String(r.err || 'curl 不可用'));
  }
}

const texts3 = [
  '雪拥蓝关马不前，云横秦岭家何在。',
  '苹果香蕉和梨子都是常见的水果。',
  '梯度下降是一种优化算法，广泛用于机器学习。',
];
const BASE = '机器学习的核心目标是从数据中学习规律，并用这些规律对新样本做出预测。模型在训练集上优化参数，在验证集上调节超参数，最终在测试集上评估泛化能力。优化器沿损失函数的负梯度方向更新权重，学习率控制每一步的步长。';
const textOf = (n) => BASE.repeat(Math.ceil(n / BASE.length)).slice(0, n);
const texts64 = Array.from({ length: 64 }, (_, i) => '第' + i + '篇：' + textOf(500));

// 改动前（git show HEAD:server/rag/embed.js）的同步 _loadOnnx 逻辑复刻，仅供对比
function f16To32Ref(h) {
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const b = h[i];
    const s = (b & 0x8000) >> 15;
    const e = (b & 0x7c00) >> 10;
    const f = b & 0x03ff;
    if (e === 0) out[i] = (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    else if (e === 0x1f) out[i] = f ? NaN : (s ? -1 : 1) * Infinity;
    else out[i] = (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  return out;
}

async function oldSyncRuntime(dir, modelPath) {
  const { AutoTokenizer, env } = await import('@huggingface/transformers');
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  const ort = await import('onnxruntime-node');
  const tokenizer = await AutoTokenizer.from_pretrained(dir);
  const want = (process.env.WORKBENCH_RAG_ONNX_EP || 'cpu').split(',');
  let session = null;
  let usedEp = 'cpu';
  for (const ep of [...want, 'cpu']) {
    try {
      session = await ort.InferenceSession.create(modelPath, { executionProviders: [ep] });
      usedEp = ep;
      break;
    } catch { /* 降级 */ }
  }
  if (!session) throw new Error('ONNX 会话创建失败（含 cpu）');
  return {
    kind: 'onnx',
    ep: usedEp,
    embed: async (texts, opts = {}) => {
      const maxLen = opts.maxLength || 1024;
      const out = [];
      for (let i = 0; i < texts.length; i += 8) {
        const batch = texts.slice(i, i + 8);
        const enc = await tokenizer(batch, { padding: true, truncation: true, max_length: maxLen });
        const feeds = {
          input_ids: new ort.Tensor('int64', BigInt64Array.from(enc.input_ids.data), enc.input_ids.dims),
          attention_mask: new ort.Tensor('int64', BigInt64Array.from(enc.attention_mask.data), enc.attention_mask.dims),
        };
        const r = await session.run(feeds);
        const t = Object.values(r)[0];
        const raw = t.type === 'float16' ? f16To32Ref(t.data) : t.data instanceof Float32Array ? t.data : Float32Array.from(t.data);
        const dims = t.dims;
        const dim = dims[2];
        for (let b = 0; b < dims[0]; b++) {
          const v = new Float32Array(dim);
          let nrm = 0;
          for (let j = 0; j < dim; j++) {
            const x = raw[b * dims[1] * dim + j];
            v[j] = x;
            nrm += x * x;
          }
          nrm = Math.sqrt(nrm) || 1;
          for (let j = 0; j < dim; j++) v[j] /= nrm;
          out.push(v);
        }
      }
      return out;
    },
  };
}

function maxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function measureMaxLag(fn) {
  return new Promise((resolve, reject) => {
    let max = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const d = now - last;
      last = now;
      if (d > max) max = d;
    }, 20);
    Promise.resolve(fn()).then(
      () => { clearInterval(timer); resolve(max); },
      (e) => { clearInterval(timer); reject(e); }
    );
  });
}

// —— 准备夹具与分词器，并组装临时 WORKBENCH_DATA_DIR（manifest 按 importDir 格式） ——
async function setupFixture() {
  const uvOk = await run('uv', ['--version']);
  if (!uvOk.ok) await skip('缺少网络或 uv');
  const fixtureDir = path.join(os.tmpdir(), 'xuewen-onnx-fixture');
  const fixtureModel = path.join(fixtureDir, 'onnx', 'model_fp16.onnx');
  if (!fs.existsSync(fixtureModel)) {
    const r = await run('uv', ['run', '--with', 'onnx', '--with', 'numpy', 'python', path.join(here, 'make-onnx-fixture.py'), fixtureDir]);
    if (!r.ok) throw new Error('夹具生成失败: ' + r.err);
  }
  const homeOnnx = path.join(os.homedir(), '.xuewen-workbench', 'models', MODEL, 'onnx-fp16');
  let tokenizerDir;
  if (TOKENIZER_FILES.every((f) => fs.existsSync(path.join(homeOnnx, f)))) {
    tokenizerDir = homeOnnx;
  } else {
    try {
      for (const f of TOKENIZER_FILES) {
        const dest = path.join(fixtureDir, f);
        if (!fs.existsSync(dest)) await download(`https://hf-mirror.com/Xenova/${MODEL}/resolve/main/${f}`, dest);
      }
      tokenizerDir = fixtureDir;
    } catch (e) {
      await skip('缺少网络或 uv: ' + String(e.message || e));
    }
  }

  const tmp = makeTmpDir('wb-onnx-');
  process.env.WORKBENCH_DATA_DIR = path.join(tmp, 'data');
  process.env.WORKBENCH_RAG_EMBED = 'onnx';
  delete process.env.WORKBENCH_RAG_ONNX_EP;
  const modelsDir = path.join(tmp, 'data', 'models', MODEL, 'onnx-fp16');
  fs.mkdirSync(path.join(modelsDir, 'onnx'), { recursive: true });
  const manifest = { model: MODEL, kind: 'onnx', files: [] };
  for (const f of TOKENIZER_FILES) {
    const dest = path.join(modelsDir, f);
    fs.copyFileSync(path.join(tokenizerDir, f), dest);
    manifest.files.push({ path: f, sha256: sha256File(dest), bytes: fs.statSync(dest).size });
  }
  const onnxDest = path.join(modelsDir, 'onnx', 'model_fp16.onnx');
  fs.copyFileSync(fixtureModel, onnxDest);
  manifest.files.push({ path: 'onnx/model_fp16.onnx', sha256: sha256File(onnxDest), bytes: fs.statSync(onnxDest).size });
  fs.writeFileSync(path.join(modelsDir, 'model.json'), JSON.stringify(manifest, null, 2));
  return { tmp, modelsDir };
}

async function buildService(tmp) {
  const { EmbedService } = await import('../server/rag/embed.js');
  return new EmbedService(path.join(tmp, 'data'));
}

async function mainMode() {
  const { tmp, modelsDir } = await setupFixture();
  const svc = await buildService(tmp);
  let oldRt = null;
  try {
    const rt = await svc.ensureReady();
    assert.equal(rt.kind, 'onnx');
    oldRt = await oldSyncRuntime(modelsDir, path.join(modelsDir, 'onnx', 'model_fp16.onnx'));

    // 夹具计算量标定：单批 8 条 × 512 token 的同步推理耗时（要求 ≥ 50ms）
    const tBatch = Date.now();
    await oldRt.embed(Array.from({ length: 8 }, () => textOf(600)), { maxLength: 512 });
    console.log('单批 8 条 × 512 token 同步推理实测：' + (Date.now() - tBatch) + 'ms');

    await test('① worker 与旧同步实现向量逐维一致（≤1e-6）', async () => {
      const workerVecs = await svc.embed(texts3);
      const syncVecs = await oldRt.embed(texts3);
      assert.equal(workerVecs.length, texts3.length);
      assert.equal(syncVecs.length, texts3.length);
      for (let i = 0; i < texts3.length; i++) {
        assert.equal(workerVecs[i].length, DIM);
        assert.equal(syncVecs[i].length, DIM);
        assert.ok(maxDiff(workerVecs[i], syncVecs[i]) <= 1e-6, '第 ' + i + ' 条最大差值 ' + maxDiff(workerVecs[i], syncVecs[i]));
      }
    });

    await test('② 64 条推理期间主线程最大延迟 < 100ms', async () => {
      const lagWorker = await measureMaxLag(() => svc.embed(texts64));
      const lagSync = await measureMaxLag(() => oldRt.embed(texts64));
      console.log('    主线程最大间隔延迟：worker ' + Math.round(lagWorker) + 'ms / 旧同步 ' + Math.round(lagSync) + 'ms（对照，不作断言）');
      assert.ok(lagWorker < 100, 'worker 主线程延迟 ' + lagWorker + 'ms ≥ 100ms');
    });

    await test('③ dispose 后立即 embed 报错、再次调用自动重建', async () => {
      const rt1 = await svc.ensureReady();
      const before = (await rt1.embed([texts3[0]]))[0];
      svc.dispose();
      await assert.rejects(() => rt1.embed([texts3[0]]), /ONNX worker/);
      const after = (await svc.embed([texts3[0]]))[0];
      assert.equal(after.length, DIM);
      assert.ok(maxDiff(after, before) <= 1e-6);
    });

    await test('④ worker 意外退出：挂起请求报错、之后自动恢复', async () => {
      const rt2 = await svc.ensureReady();
      const inflight = rt2.embed(texts64);
      // 投递后立即 terminate（同 tick）：POSIX 下在原生 session.run 中途 terminate 会 abort 整个进程，
      // 因此不等待 worker 进入推理；请求已在主线程 pending 表中挂起，正好覆盖「意外退出 → 挂起请求报错」。
      rt2._worker.terminate();
      await assert.rejects(inflight, /ONNX worker/);
      const recovered = (await svc.embed([texts3[1]]))[0];
      const ref = (await oldRt.embed([texts3[1]]))[0];
      assert.equal(recovered.length, DIM);
      assert.ok(maxDiff(recovered, ref) <= 1e-6);
    });

    await test('⑤ 优雅关闭压力：10 次 dispose 不崩溃、已发请求正常返回', async () => {
      const child = spawn(process.execPath, [SCRIPT, '--stress'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      const code = await new Promise((resolve) => child.on('exit', resolve));
      assert.equal(code, 0, 'stress 子进程退出码 ' + code + '\nstdout: ' + out + '\nstderr: ' + err);
      assert.ok(out.includes('STRESS_OK'), 'stress 未完成\nstdout: ' + out + '\nstderr: ' + err);
    });

    await test('⑥ worker 日志上报：EP 降级与就绪', async () => {
      const lines = [];
      const origError = console.error;
      const origLog = console.log;
      console.error = (...a) => lines.push(a.map(String).join(' '));
      console.log = (...a) => lines.push(a.map(String).join(' '));
      try {
        process.env.WORKBENCH_RAG_ONNX_EP = 'dml';
        svc.dispose(); // 关掉现有 cpu 运行时，重建时用 dml 触发降级
        const rt2 = await svc.ensureReady();
        assert.equal(rt2.kind, 'onnx');
        assert.equal(rt2.ep, 'cpu');
        assert.ok(lines.some((l) => l.includes('ONNX EP dml 不可用')), '缺少 EP 降级日志: ' + lines.join(' | '));
        assert.ok(lines.some((l) => l.includes('ONNX 会话就绪')), '缺少就绪日志: ' + lines.join(' | '));
      } finally {
        console.error = origError;
        console.log = origLog;
        delete process.env.WORKBENCH_RAG_ONNX_EP;
      }
    });

    console.log('\n' + checks + ' checks passed.');
  } finally {
    svc.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0);
}

async function stressMode() {
  const { tmp } = await setupFixture();
  const svc = await buildService(tmp);
  try {
    await svc.embed([texts3[0]]); // 预热，让运行时就绪
    for (let i = 0; i < 10; i++) {
      const rt = await svc.ensureReady();
      const delay = i * 40; // 0, 40, ..., 360ms
      const p = rt.embed(texts64);
      await new Promise((r) => setTimeout(r, delay));
      svc.dispose();
      const vecs = await p;
      assert.equal(vecs.length, 64, '第 ' + i + ' 次 dispose 后已发请求应返回 64 个向量');
      const after = await svc.embed([texts3[0]]);
      assert.equal(after.length, 1);
      assert.equal(after[0].length, DIM);
    }
    console.log('STRESS_OK');
  } finally {
    svc.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0);
}

if (process.argv[2] === '--stress') {
  await stressMode();
} else {
  await mainMode();
}
