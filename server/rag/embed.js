// 嵌入运行时：模型下载/导入 + 三后端（mock / onnx / mlx sidecar），输出 L2 归一化向量。
// - mock：确定性哈希向量（e2e 与无模型冒烟，env WORKBENCH_RAG_EMBED=mock）
// - onnx：@huggingface/transformers + onnxruntime-node（Xenova/bge-m3 fp16；win CUDA EP 为 M2 实测点，当前 CPU）
// - mlx：Python sidecar（mlx-embeddings + mlx-community/bge-m3-mlx-fp16），mac 默认，uv 自动置备 venv
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { T2S_MAP } from '../t2s.js';

export const MODEL_ID = 'bge-m3';
export const DIM = 1024;

const REPOS = {
  mlx: { repo: 'mlx-community/bge-m3-mlx-fp16', dir: 'mlx-fp16', files: ['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json'] },
  onnx: { repo: 'Xenova/bge-m3', dir: 'onnx-fp16', files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_fp16.onnx'] },
};
const HOSTS = ['https://huggingface.co', 'https://hf-mirror.com'];

// MLX sidecar 最小依赖集（实证对齐 resources-mlx/requirements.txt；vendor 前向后不再依赖 mlx-embeddings）
const MLX_REQUIREMENTS = [
  'anyio', 'click', 'filelock', 'h11', 'httpcore2', 'httpx2', 'huggingface-hub', 'idna',
  'mlx', 'mlx-metal', 'numpy', 'packaging', 'pyyaml', 'regex', 'requests', 'safetensors',
  'tokenizers', 'tqdm', 'transformers', 'truststore', 'typing-extensions',
];

// 繁→简归一化（逐字符 1:1 映射，与链接索引同源）
export function t2s(text) {
  let out = '';
  for (const ch of text) out += T2S_MAP[ch] || ch;
  return out;
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function downloadTo(url, dest, onBytes) {
  return new Promise((resolve, reject) => {
    fetch(url, { redirect: 'follow' })
      .then((r) => {
        if (!r.ok || !r.body) return reject(new Error(`HTTP ${r.status} ${url}`));
        const total = Number(r.headers.get('content-length')) || 0;
        let got = 0;
        const out = fs.createWriteStream(dest);
        const reader = r.body.getReader();
        const pump = () => reader.read().then(({ done, value }) => {
          if (done) return out.end(() => resolve({ bytes: got, total }));
          out.write(value);
          got += value.length;
          if (onBytes) onBytes(got, total);
          return pump();
        });
        pump().catch(reject);
      })
      .catch(reject);
  });
}

export class EmbedService {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.modelsDir = path.join(dataDir, 'models', MODEL_ID);
    this.venvDir = path.join(dataDir, 'py', 'rag-venv');
    this.state = 'missing'; // missing | downloading | ready | error
    this.progress = { file: '', bytes: 0, total: 0, done: 0, files: 0 };
    this.error = null;
    this.backend = null; // 实际使用的后端（ready 后有值）
    this._runtime = null; // { kind, embed(texts) }
    this._loading = null;
    if (process.env.WORKBENCH_RAG_EMBED === 'mock') {
      this.state = 'ready';
      this.backend = 'mock';
    } else {
      // 重启恢复：任一后端的清单有效即就绪，sha 从清单读回
      for (const kind of ['mlx', 'onnx']) {
        if (this._manifestOk(kind)) {
          this.state = 'ready';
          try {
            const m = JSON.parse(fs.readFileSync(this.manifestPath(kind), 'utf8'));
            this._shaCache = m.files.find((x) => x.path.includes('safetensors') || x.path.endsWith('.onnx'))?.sha256 || null;
          } catch { /* 忽略坏清单 */ }
          break;
        }
      }
    }
  }

  modelDir(kind) {
    return path.join(this.modelsDir, REPOS[kind].dir);
  }

  manifestPath(kind) {
    return path.join(this.modelDir(kind), 'model.json');
  }

  _manifestOk(kind) {
    try {
      const m = JSON.parse(fs.readFileSync(this.manifestPath(kind), 'utf8'));
      return m && m.model === MODEL_ID && Array.isArray(m.files) && m.files.length > 0;
    } catch {
      return false;
    }
  }

  /** 本机可用后端探测：mlx（mac + venv + 权重）> onnx（权重）；env 强制指定优先 */
  detectBackend() {
    const forced = process.env.WORKBENCH_RAG_EMBED;
    if (forced === 'mock' || forced === 'onnx' || forced === 'mlx') return forced;
    const onnxOk = this._manifestOk('onnx');
    if (process.platform === 'darwin') {
      // 有 mlx 权重即选 mlx（venv 在加载时按需置备，不存在不是否决条件）
      return this._manifestOk('mlx') ? 'mlx' : 'onnx';
    }
    return 'onnx';
  }

  venvPython() {
    return path.join(this.venvDir, 'bin', 'python');
  }

  status() {
    const backend = this.backend || this.detectBackend();
    return {
      state: this.state,
      backend,
      ep: this._runtime?.ep || null,
      id: MODEL_ID,
      dim: DIM,
      sha: this._shaCache || null,
      progress: this.state === 'downloading' ? this.progress : null,
      error: this.error,
    };
  }

  /** 下载模型（当前平台只下所需后端的文件）；幂等：已就绪直接返回 */
  async download() {
    if (this.state === 'downloading') return { ok: true };
    if (this.state === 'ready') return { ok: true };
    const kind = process.platform === 'darwin' ? 'mlx' : 'onnx';
    const spec = REPOS[kind];
    const dir = this.modelDir(kind);
    fs.mkdirSync(dir, { recursive: true });
    this.state = 'downloading';
    this.error = null;
    this.progress = { file: '', bytes: 0, total: 0, done: 0, files: spec.files.length };
    try {
      if (kind === 'mlx') await this.ensureVenv();
      const manifest = { model: MODEL_ID, kind, files: [] };
      for (const f of spec.files) {
        const dest = path.join(dir, f);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        this.progress.file = f;
        this.progress.bytes = 0;
        this.progress.total = 0;
        let ok = false;
        let lastErr = null;
        for (const host of HOSTS) {
          try {
            const r = await downloadTo(`${host}/${spec.repo}/resolve/main/${f}`, dest + '.part', (b, t) => {
              this.progress.bytes = b;
              if (t) this.progress.total = t;
            });
            fs.renameSync(dest + '.part', dest);
            ok = true;
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (!ok) throw lastErr || new Error('下载失败: ' + f);
        manifest.files.push({ path: f, sha256: await sha256File(dest), bytes: fs.statSync(dest).size });
        this.progress.done++;
      }
      fs.writeFileSync(this.manifestPath(kind), JSON.stringify(manifest, null, 2));
      this._shaCache = manifest.files.find((x) => x.path.includes('safetensors') || x.path.endsWith('.onnx'))?.sha256 || null;
      this.state = 'ready';
      this.backend = kind;
      this._runtime = null; // 重新加载
      return { ok: true };
    } catch (e) {
      this.state = 'error';
      this.error = String(e.message || e);
      return { ok: false, error: this.error };
    }
  }

  /** 手动导入模型目录（含权重文件的目录，写入清单） */
  async importDir(dir) {
    const kind = process.platform === 'darwin' && fs.existsSync(path.join(dir, 'model.safetensors')) ? 'mlx' : 'onnx';
    const spec = REPOS[kind];
    const need = spec.files.filter((f) => !fs.existsSync(path.join(dir, f)));
    if (need.length) return { ok: false, error: '缺少文件: ' + need.join(', ') };
    const dest = this.modelDir(kind);
    fs.mkdirSync(dest, { recursive: true });
    const manifest = { model: MODEL_ID, kind, files: [] };
    for (const f of spec.files) {
      const dst = path.join(dest, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true }); // 嵌套子目录（onnx/ 等）
      const src = path.join(dir, f);
      if (path.resolve(src) !== path.resolve(dst)) fs.copyFileSync(src, dst);
      manifest.files.push({ path: f, sha256: await sha256File(dst), bytes: fs.statSync(dst).size });
    }
    fs.writeFileSync(this.manifestPath(kind), JSON.stringify(manifest, null, 2));
    this.state = 'ready';
    this.backend = kind;
    this._runtime = null;
    return { ok: true, kind };
  }

  /** 置备 sidecar venv：优先 uv（开发机）；打包版从捆绑资源离线引导（python-build-standalone + wheels） */
  async ensureVenv() {
    const py = this.venvPython();
    if (fs.existsSync(py)) return;
    fs.mkdirSync(path.dirname(this.venvDir), { recursive: true });
    const run = (cmd, args, opts = {}) =>
      new Promise((resolve) => {
        const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts });
        let err = '';
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (c) => resolve(c === 0 ? { ok: true } : { ok: false, err: err.slice(-800) }));
        p.on('error', (e) => resolve({ ok: false, err: String(e) }));
      });
    // 路径 A：uv（开发机，联网）
    const uvOk = await run('uv', ['--version']);
    if (uvOk.ok) {
      let r = await run('uv', ['venv', '--python', '3.12', this.venvDir]);
      if (!r.ok) throw new Error('uv venv 失败: ' + r.err);
      r = await run('uv', ['pip', 'install', '--python', py, ...MLX_REQUIREMENTS]);
      if (!r.ok) throw new Error('uv pip install 失败: ' + r.err);
      return;
    }
    // 路径 B：打包版捆绑资源（离线）：python-build-standalone + wheels
    const resources = process.resourcesPath // Electron 打包版
      ? path.join(process.resourcesPath, 'mlx-env')
      : path.join(this.dataDir, 'mlx-env-bundle'); // 兼容手动放置
    const tarball = path.join(resources, 'python.tar.gz');
    const wheels = path.join(resources, 'wheels');
    if (!fs.existsSync(tarball) || !fs.existsSync(wheels)) {
      throw new Error('MLX 环境不可用：无 uv 且无捆绑资源（重装应用或安装 uv 后重试）');
    }
    // 解压可重定位 python 到 dataDir/py/runtime（tar 内顶层为 python/）
    const runtime = path.join(path.dirname(this.venvDir), 'runtime');
    if (!fs.existsSync(path.join(runtime, 'python', 'bin', 'python3'))) {
      fs.mkdirSync(runtime, { recursive: true });
      const { execFileSync } = await import('node:child_process');
      execFileSync('tar', ['-xzf', tarball, '-C', runtime]);
    }
    const basePy = path.join(runtime, 'python', 'bin', 'python3');
    let r = await run(basePy, ['-m', 'venv', this.venvDir]);
    if (!r.ok) throw new Error('venv 创建失败: ' + r.err);
    r = await run(py, ['-m', 'pip', 'install', '--no-index', '--find-links', wheels, '--no-deps', ...MLX_REQUIREMENTS]);
    if (!r.ok) throw new Error('离线 pip install 失败: ' + r.err);
  }

  /** 惰性加载运行时；ready 前置检查模型 */
  async ensureReady() {
    if (this._runtime) return this._runtime;
    if (process.env.WORKBENCH_RAG_EMBED === 'mock') {
      this._runtime = { kind: 'mock', embed: (texts) => Promise.resolve(texts.map(mockVec)) };
      this.state = 'ready';
      this.backend = 'mock';
      return this._runtime;
    }
    if (this.state !== 'ready') {
      const kind = process.platform === 'darwin' ? 'mlx' : 'onnx';
      if (!this._manifestOk(kind)) throw new Error('模型未就绪（请先下载或导入）');
      this.state = 'ready';
    }
    this._loading ??= this._load(this.detectBackend());
    try {
      this._runtime = await this._loading;
      this.backend = this._runtime.kind;
    } catch (e) {
      this._loading = null;
      throw e;
    }
    return this._runtime;
  }

  async _load(kind) {
    if (kind === 'mlx') return this._loadMlx();
    if (kind === 'onnx') return this._loadOnnx();
    return { kind: 'mock', embed: (texts) => Promise.resolve(texts.map(mockVec)) };
  }

  async _loadOnnx() {
    // tokenizer 走 transformers.js；推理会话直用 onnxruntime-node（可指定执行提供者：
    // win 包内自带 DirectML（RTX 直接可用，零安装），cuda 需自编/边车（M2 实测点），
    // mac 为 CPU。创建失败自动降级到 cpu 并记录实际后端。
    const { AutoTokenizer, env } = await import('@huggingface/transformers');
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    const ort = await import('onnxruntime-node');
    const dir = this.modelDir('onnx');
    const modelPath = path.join(dir, 'onnx', 'model_fp16.onnx');
    if (!fs.existsSync(modelPath)) throw new Error('缺少 ONNX 权重: onnx/model_fp16.onnx');
    const tokenizer = await AutoTokenizer.from_pretrained(dir);
    const want = (process.env.WORKBENCH_RAG_ONNX_EP || (process.platform === 'win32' ? 'dml' : 'cpu')).split(',');
    let session = null;
    let usedEp = 'cpu';
    for (const ep of [...want, 'cpu']) {
      try {
        session = await ort.InferenceSession.create(modelPath, { executionProviders: [ep] });
        usedEp = ep;
        break;
      } catch (e) {
        this.error = null; // 降级不算错误，但记入日志
        console.error(`[rag] ONNX EP ${ep} 不可用，降级: ${String(e.message || e).slice(0, 120)}`);
      }
    }
    if (!session) throw new Error('ONNX 会话创建失败（含 cpu）');
    const epUsed = usedEp;
    return {
      kind: 'onnx',
      ep: epUsed,
      embed: async (texts) => {
        const out = [];
        for (let i = 0; i < texts.length; i += 8) {
          const batch = texts.slice(i, i + 8);
          const enc = await tokenizer(batch, { padding: true, truncation: true, max_length: 1024 });
          const feeds = {
            input_ids: new ort.Tensor('int64', BigInt64Array.from(enc.input_ids.data), enc.input_ids.dims),
            attention_mask: new ort.Tensor('int64', BigInt64Array.from(enc.attention_mask.data), enc.attention_mask.dims),
          };
          const r = await session.run(feeds);
          // 输出名不假设（Xenova 导出可能叫 last_hidden_state / token_embeddings），取首个
          const t = Object.values(r)[0];
          const raw = t.type === 'float16' ? f16To32(t.data) : t.data instanceof Float32Array ? t.data : Float32Array.from(t.data);
          const dims = t.dims; // [B, L, D]
          const dim = dims[2];
          for (let b = 0; b < dims[0]; b++) {
            const v = new Float32Array(dim);
            let nrm = 0;
            for (let j = 0; j < dim; j++) {
              const x = raw[b * dims[1] * dim + j]; // CLS = 位置 0
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

  async _loadMlx() {
    await this.ensureVenv();
    const py = this.venvPython();
    // 打包后本文件在 asar 内，python 读不了 asar——sidecar 脚本随 asarUnpack 放在 .unpacked
    const script = path.join(
      path.dirname(fileURLToPath(import.meta.url)).replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`),
      'mlx-embed.py'
    );
    const dir = this.modelDir('mlx');
    const proc = spawn(py, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    // 进程早退/失败：立即拒绝全部挂起调用，不让上层等到超时
    const onDead = (why) => {
      for (const [, fn] of pending) fn({ seq: -1, error: 'sidecar 已退出: ' + why + ' ' + String(stderr).slice(-300) });
      pending.clear();
    };
    proc.on('error', (e) => onDead(String(e.message || e)));
    proc.on('exit', (code) => {
      if (code !== 0 && pending.size) onDead('code=' + code);
    });
    const pending = new Map();
    let buf = '';
    let seqN = 0;
    proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.seq && pending.has(msg.seq)) {
            pending.get(msg.seq)(msg);
            pending.delete(msg.seq);
          }
        } catch { /* 忽略坏行 */ }
      }
    });
    const call = (payload, timeoutMs = 600000) =>
      new Promise((resolve, reject) => {
        const seq = ++seqN;
        payload.seq = seq;
        const timer = setTimeout(() => {
          pending.delete(seq);
          reject(new Error('sidecar 超时: ' + String(stderr).slice(-300)));
        }, timeoutMs);
        pending.set(seq, (msg) => {
          clearTimeout(timer);
          if (msg.error) reject(new Error(String(msg.error)));
          else resolve(msg);
        });
        proc.stdin.write(JSON.stringify(payload) + '\n');
      });
    await call({ cmd: 'load', dir, dim: DIM });
    proc.on('exit', () => {
      if (this._runtime && this._runtime.kind === 'mlx') {
        this._runtime = null;
        this._loading = null;
      }
    });
    return {
      kind: 'mlx',
      embed: async (texts) => {
        const out = [];
        for (let i = 0; i < texts.length; i += 16) {
          const r = await call({ cmd: 'embed', texts: texts.slice(i, i + 16) });
          for (const v of r.vectors) out.push(Float32Array.from(v));
        }
        return out;
      },
      dispose: () => {
        try {
          proc.kill();
        } catch { /* 忽略 */ }
      },
    };
  }

  async embed(texts) {
    const rt = await this.ensureReady();
    return rt.embed(texts);
  }

  dispose() {
    if (this._runtime && this._runtime.dispose) this._runtime.dispose();
    this._runtime = null;
    this._loading = null;
  }
}

// fp16 位模式 → float32（ORT float16 输出为 Uint16Array 位模式）
function f16To32(h) {
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

// 确定性哈希向量（e2e）：对文本做字符 trigram 哈希叠加，同义近形文本向量相近
function mockVec(text) {
  const v = new Float32Array(DIM);
  const t = t2s(text);
  for (let i = 0; i + 2 < t.length + 2; i++) {
    const g = t.slice(Math.min(i, Math.max(0, t.length - 3)), Math.min(i, t.length - 3) + 3) || t.slice(0, 3);
    let h = 2166136261;
    for (let j = 0; j < g.length; j++) h = ((h ^ g.charCodeAt(j)) * 16777619) >>> 0;
    v[h % DIM] += 1;
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}
