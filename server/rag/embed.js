// 嵌入运行时：模型下载/导入 + 三后端（mock / onnx / mlx sidecar），输出 L2 归一化向量。
// - mock：确定性哈希向量（e2e 与无模型冒烟，env WORKBENCH_RAG_EMBED=mock）
// - onnx：@huggingface/transformers + onnxruntime-node（Xenova/bge-m3 fp16；win CUDA EP 为 M2 实测点，当前 CPU）
// - mlx：Python sidecar（mlx-embeddings + mlx-community/bge-m3-mlx-fp16），mac 默认，uv 自动置备 venv
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { T2S_MAP } from '../t2s.js';
import { withActivity } from '../lagWatch.js';
import { pickFetch, probeHosts, downloadFile } from './download.js';

export const MODEL_ID = 'bge-m3';
export const DIM = 1024;

const REPOS = {
  mlx: { repo: 'mlx-community/bge-m3-mlx-fp16', dir: 'mlx-fp16', files: ['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json'] },
  onnx: { repo: 'Xenova/bge-m3', dir: 'onnx-fp16', files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_fp16.onnx'] },
};
// 源列表；WORKBENCH_RAG_MODEL_HOSTS（逗号分隔）可覆盖，供测试/离线环境替换
const HOSTS = (process.env.WORKBENCH_RAG_MODEL_HOSTS || 'https://huggingface.co,https://hf-mirror.com')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

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

export class EmbedService {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.modelsDir = path.join(dataDir, 'models', MODEL_ID);
    this.venvDir = path.join(dataDir, 'py', 'rag-venv');
    this.state = 'missing'; // missing | downloading | ready | error
    this.progress = { file: '', bytes: 0, total: 0, done: 0, files: 0, host: '', attempt: 0, speedBps: 0 };
    this.error = null;
    this.backend = null; // 实际使用的后端（ready 后有值）
    this._runtime = null; // { kind, embed(texts) }
    this._loading = null;
    this._downloadTask = null;
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

  /** 下载模型（当前平台只下所需后端）；幂等：已就绪直接返回，下载中返回 already */
  download() {
    if (this.state === 'downloading') return { ok: true, already: true };
    if (this.state === 'ready') return { ok: true, ready: true };
    const kind = process.platform === 'darwin' ? 'mlx' : 'onnx';
    const spec = REPOS[kind];
    const dir = this.modelDir(kind);
    fs.mkdirSync(dir, { recursive: true });
    this.state = 'downloading';
    this.error = null;
    this.progress = { file: '', bytes: 0, total: 0, done: 0, files: spec.files.length, host: '', attempt: 0, speedBps: 0 };
    this._downloadTask = this._runDownload(kind, spec, dir).catch((e) => {
      this.state = 'error';
      this.error = String(e.message || e);
      console.error('[rag] 模型下载失败: ' + this.error);
    });
    return { ok: true, started: true };
  }

  /** 后台下载：mac 先置备 venv → 探测可达源 → 按可达顺序逐个文件断点续传 */
  async _runDownload(kind, spec, dir) {
    const t0 = Date.now();
    if (kind === 'mlx') await this.ensureVenv();
    const { fetchImpl, kind: fetchKind } = pickFetch();
    const log = (msg) => console.log('[rag] ' + msg);
    console.log('[rag] 模型下载开始: ' + kind + '，fetch=' + fetchKind);
    const hosts = await probeHosts(HOSTS, spec.repo, { fetchImpl, log });
    if (!hosts.length) throw new Error('无法连接 huggingface.co 与 hf-mirror.com，请检查网络或代理');
    const manifest = { model: MODEL_ID, kind, files: [] };
    for (const f of spec.files) {
      await withActivity('下载模型 ' + f, async () => {
        const dest = path.join(dir, f);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const urls = hosts.map((h) => `${h}/${spec.repo}/resolve/main/${f}`);
        this.progress.file = f;
        this.progress.bytes = 0;
        this.progress.total = 0;
        this.progress.host = '';
        this.progress.attempt = 0;
        this.progress.speedBps = 0;
        await downloadFile({
          urls, dest, fetchImpl,
          onProgress: (p) => {
            this.progress.bytes = p.bytes;
            this.progress.total = p.total;
            this.progress.host = p.host;
            this.progress.attempt = p.attempt;
            this.progress.speedBps = p.speedBps;
          },
          log,
        });
        manifest.files.push({ path: f, sha256: await sha256File(dest), bytes: fs.statSync(dest).size });
        this.progress.done++;
      });
    }
    fs.writeFileSync(this.manifestPath(kind), JSON.stringify(manifest, null, 2));
    this._shaCache = manifest.files.find((x) => x.path.includes('safetensors') || x.path.endsWith('.onnx'))?.sha256 || null;
    this.state = 'ready';
    this.backend = kind;
    if (this._runtime?.dispose) this._runtime.dispose();
    this._runtime = null; // 重新加载
    console.log('[rag] 模型下载完成: ' + kind + '，耗时 ' + (Date.now() - t0) + 'ms');
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
    if (this._runtime?.dispose) this._runtime.dispose();
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
    const t0 = Date.now();
    try {
      this._runtime = await this._loading;
      this.backend = this._runtime.kind;
      console.log('[rag] 运行时加载完成: ' + this._runtime.kind + (this._runtime.ep ? ' EP=' + this._runtime.ep : '') + '，耗时 ' + (Date.now() - t0) + 'ms');
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
    // tokenizer 与推理会话都移入 worker_threads：onnxruntime-node 的 create/run 是同步原生调用，
    // 直接在主线程会阻塞事件循环。win 包内默认 DirectML，失败降级 cpu（与旧实现相同）。
    const dir = this.modelDir('onnx');
    const modelPath = path.join(dir, 'onnx', 'model_fp16.onnx');
    if (!fs.existsSync(modelPath)) throw new Error('缺少 ONNX 权重: onnx/model_fp16.onnx');
    const eps = (process.env.WORKBENCH_RAG_ONNX_EP || (process.platform === 'win32' ? 'dml' : 'cpu')).split(',');
    const worker = new Worker(new URL('./onnxWorker.js', import.meta.url), { workerData: { dir, modelPath, eps } });
    const pending = new Map(); // seq -> { resolve, reject }
    let seq = 0;
    let usedEp = 'cpu';
    let settled = false; // ready 或 fatal 已结算
    let closing = false; // 已进入优雅关闭：新请求立即报错
    let exited = false;
    let deadErr = null;
    let closeTimer = null;
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    // worker 意外退出：挂起请求全部报错；就绪后退出则清空运行时，下次调用重建
    const failAll = (err) => {
      deadErr = deadErr || err;
      for (const p of pending.values()) p.reject(deadErr);
      pending.clear();
      if (settled) {
        if (this._runtime && this._runtime._worker === worker) {
          this._runtime = null;
          this._loading = null;
        }
      } else {
        readyReject(deadErr);
      }
    };

    worker.on('error', (e) => failAll(new Error('ONNX worker 错误: ' + String(e.message || e))));
    worker.on('exit', (code) => {
      exited = true;
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      failAll(new Error(code === 0 ? 'ONNX worker 已退出' : 'ONNX worker 意外退出（code=' + code + '）'));
    });
    worker.on('message', (msg) => {
      if (msg.t === 'ready') {
        settled = true;
        usedEp = msg.ep;
        readyResolve();
        return;
      }
      if (msg.t === 'fatal') {
        failAll(new Error(msg.error));
        return;
      }
      if (msg.t === 'log') {
        const level = msg.level === 'info' ? 'log' : msg.level;
        console[level]('[rag] ' + msg.message);
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.t === 'result') p.resolve(msg.vecs);
      else p.reject(new Error(msg.error));
    });

    await ready;
    if (deadErr) throw deadErr; // ready 后、返回前就退出的极端竞态

    return {
      kind: 'onnx',
      ep: usedEp,
      _worker: worker,
      embed: (texts, opts = {}) => {
        if (closing || exited || deadErr) return Promise.reject(deadErr || new Error('ONNX worker 已关闭'));
        const id = ++seq;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          worker.postMessage({ t: 'embed', id, texts, maxLength: opts.maxLength || 1024 });
        });
      },
      dispose: () => {
        // 优雅关闭：不再接受新请求，已发出的请求照常等结果；close 排在 worker 已收到的 embed 之后
        if (closing) return;
        closing = true;
        worker.postMessage({ t: 'close' });
        closeTimer = setTimeout(() => {
          closeTimer = null;
          if (!exited) console.warn('[rag] ONNX worker 关闭超时（60s），保留线程');
        }, 60000);
        if (closeTimer.unref) closeTimer.unref();
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
      embed: async (texts, opts = {}) => {
        const maxLen = opts.maxLength || 1024;
        const out = [];
        for (let i = 0; i < texts.length; i += 16) {
          const r = await call({ cmd: 'embed', texts: texts.slice(i, i + 16), max_length: maxLen });
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

  async embed(texts, opts = {}) {
    const rt = await this.ensureReady();
    return withActivity('向量推理 ' + texts.length + ' 段', () => rt.embed(texts, opts));
  }

  dispose() {
    if (this._runtime && this._runtime.dispose) this._runtime.dispose();
    this._runtime = null;
    this._loading = null;
  }
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
