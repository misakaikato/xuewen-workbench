// 嵌入运行时：模型下载/导入 + 三后端（mock / onnx / mlx sidecar），输出 L2 归一化向量。
// - mock：确定性哈希向量（e2e 与无模型冒烟，env WORKBENCH_RAG_EMBED=mock）
// - onnx：@huggingface/transformers + onnxruntime-node（Xenova/bge-m3 fp16；win CUDA EP 为 M2 实测点，当前 CPU）
// - mlx：Python sidecar（mlx-embeddings + mlx-community/bge-m3-mlx-fp16），mac 默认，uv 自动置备 venv
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { T2S_MAP } from '../t2s.js';
import { withActivity } from '../lagWatch.js';
import { pickFetch, probeHosts, downloadFile, remoteSize } from './download.js';
import { renameWithRetryAsync, writeJsonAtomic } from '../atomicFile.js';

export const MODEL_ID = 'bge-m3';
export const DIM = 1024;

const REPOS = {
  mlx: { repo: 'mlx-community/bge-m3-mlx-fp16', dir: 'mlx-fp16', files: ['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json'] },
  onnx: { repo: 'Xenova/bge-m3', dir: 'onnx-fp16', files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_fp16.onnx'] },
};
// 源列表；WORKBENCH_RAG_MODEL_HOSTS（逗号分隔）可覆盖，供测试/离线环境替换
const HOSTS = (process.env.WORKBENCH_RAG_MODEL_HOSTS || 'https://huggingface.co,https://hf-mirror.com')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

// 本机下载模型用的后端：环境变量强制 onnx/mlx 时用它，否则 mac 用 mlx、其余平台用 onnx
function downloadKind() {
  const forced = process.env.WORKBENCH_RAG_EMBED;
  return forced === 'onnx' || forced === 'mlx' ? forced : (process.platform === 'darwin' ? 'mlx' : 'onnx');
}

// MLX sidecar 最小依赖集（实证对齐 resources-mlx/requirements.txt；vendor 前向后不再依赖 mlx-embeddings）
export const MLX_REQUIREMENTS = [
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
    this.state = 'missing'; // missing | downloading | importing | ready | error
    this.progress = _emptyProgress();
    this.error = null;
    this.backend = null; // 实际使用的后端（ready 后有值）
    this.runtime = { state: 'idle', phase: null, startedAt: null, error: null }; // 运行时加载状态（ensureReady 维护）
    this._runtime = null; // { kind, embed(texts) }
    this._loading = null;
    this._downloadTask = null;
    this._cancelFlag = false;
    this._activeProc = null; // 置备环境期间的可杀子进程（取消用）
    this._taskKind = null; // 'download' | 'import'
    this._bytesDone = 0; // 已完成文件的累计字节数
    this._curFileCounted = false; // 当前文件是否已计入 _bytesDone（完成后到下一个文件开始前为 true）
    this._totalKnownAll = null; // 全部文件大小是否已知（导入已知，下载逐个揭示）
    this._importCopyHook = null; // 测试钩子：导入复制每个 chunk 后回调
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

  /** 另一种后端（本机不下载的那种）的模型目录：其中的 .part 不会再被续传，启动清理时删除 */
  foreignModelDir() {
    return this.modelDir(downloadKind() === 'mlx' ? 'onnx' : 'mlx');
  }

  /** 下载或导入进行中（期间模型目录里的 .part 可能正在写入） */
  busy() {
    return this.state === 'downloading' || this.state === 'importing';
  }

  manifestPath(kind) {
    return path.join(this.modelDir(kind), 'model.json');
  }

  _manifestOk(kind) {
    try {
      const m = JSON.parse(fs.readFileSync(this.manifestPath(kind), 'utf8'));
      if (!m || m.model !== MODEL_ID || !Array.isArray(m.files) || m.files.length === 0) return false;
      const dir = this.modelDir(kind);
      return m.files.every((x) => fs.existsSync(path.join(dir, x.path)));
    } catch {
      return false;
    }
  }

  _setPhase(phase, phaseDetail = '') {
    this.progress.phase = phase;
    this.progress.phaseDetail = phaseDetail;
  }

  // 总体进度：全部文件大小已知时按字节精确计算；否则按文件数折算并标 estimated（A1）
  _recalcOverall() {
    const p = this.progress;
    // 当前文件完成后其字节已计入 _bytesDone、done 已加一，不能再叠加（否则总进度先冲高、换文件时回落）
    const curBytes = this._curFileCounted ? 0 : p.bytes;
    const curTotal = this._curFileCounted ? 0 : p.total;
    p.overallBytes = this._bytesDone + curBytes;
    const allKnown = this._totalKnownAll != null || (p.done + (curTotal > 0 ? 1 : 0) >= p.files);
    p.overallTotal = this._totalKnownAll != null ? this._totalKnownAll : this._bytesDone + curTotal;
    p.estimated = !allKnown;
    if (allKnown && p.overallTotal > 0) {
      p.percent = Math.min(100, (p.overallBytes / p.overallTotal) * 100);
      p.etaSeconds = p.speedBps > 0 && p.overallBytes < p.overallTotal
        ? Math.round((p.overallTotal - p.overallBytes) / p.speedBps) : null;
    } else {
      const cur = curTotal > 0 ? Math.min(1, curBytes / curTotal) : 0;
      p.percent = p.files > 0 ? Math.min(100, ((p.done + cur) / p.files) * 100) : null;
      p.etaSeconds = null;
    }
  }

  _resetProgress(files) {
    this._bytesDone = 0;
    this._curFileCounted = false;
    this.progress = { ..._emptyProgress(), files, startedAt: Date.now() };
  }

  // 任务结束（取消/失败）后按清单回探状态：旧清单仍完整则回到 ready，否则 missing
  _restoreStateAfterTask() {
    this._taskKind = null;
    this._activeProc = null;
    this.error = null;
    this.state = (this._manifestOk('mlx') || this._manifestOk('onnx')) ? 'ready' : 'missing';
  }

  _dropRuntime() {
    if (this._runtime?.dispose) this._runtime.dispose();
    this._runtime = null;
    this._loading = null;
    this.runtime = { state: 'idle', phase: null, startedAt: null, error: null };
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

  /** 进行中的下载/导入任务（全局 /api/status 每秒带一次，只读内存不碰磁盘）；空闲为 null */
  task() {
    return this.busy() ? { state: this.state, progress: { ...this.progress } } : null;
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
      progress: (this.state === 'downloading' || this.state === 'importing') ? { ...this.progress } : null,
      canCancel: this.state === 'downloading' || this.state === 'importing',
      runtime: { ...this.runtime },
      error: this.error,
    };
  }

  /** 下载模型（当前平台只下所需后端）；幂等：已就绪直接返回，下载中返回 already；force=true 已就绪也重下 */
  download({ force = false } = {}) {
    if (this.state === 'downloading' || this.state === 'importing') return { ok: true, already: true };
    if (this.state === 'ready' && !force) return { ok: true, ready: true };
    const kind = downloadKind();
    const spec = REPOS[kind];
    const dir = this.modelDir(kind);
    fs.mkdirSync(dir, { recursive: true });
    this.state = 'downloading';
    this.error = null;
    this._cancelFlag = false;
    this._taskKind = 'download';
    this._totalKnownAll = null;
    this._resetProgress(spec.files.length);
    this._downloadTask = this._runDownload(kind, spec, dir).catch((e) => {
      // _runDownload 已处理取消与常规错误，这里只记录意外退出
      console.error('[rag] 下载任务异常退出: ' + String(e?.message || e));
      this._restoreStateAfterTask();
    });
    return { ok: true, started: true };
  }

  /** 取消下载/导入/环境置备：删除半截文件，状态回探（旧清单完整则 ready） */
  cancel() {
    if (this.state !== 'downloading' && this.state !== 'importing') return { ok: false, error: '没有进行中的任务' };
    this._cancelFlag = true;
    if (this._activeProc) {
      try { this._activeProc.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
    return { ok: true };
  }

  /** 后台下载：mac 先置备 venv → 探测可达源 → 按可达顺序逐个文件断点续传 */
  async _runDownload(kind, spec, dir) {
    const t0 = Date.now();
    let curPart = null; // 正在下载的半截文件（取消时删除，失败保留供续传）
    try {
      if (kind === 'mlx') {
        this._setPhase('env-install', '准备 Python 环境');
        await this.ensureVenv((phase, detail) => this._setPhase(phase, detail));
      }
      const { fetchImpl, kind: fetchKind } = pickFetch();
      const log = (msg) => console.log('[rag] ' + msg);
      console.log('[rag] 模型下载开始: ' + kind + '，fetch=' + fetchKind);
      this._setPhase('probe', '探测下载源');
      const hosts = await probeHosts(HOSTS, spec.repo, { fetchImpl, log });
      if (!hosts.length) throw new Error('无法连接 huggingface.co 与 hf-mirror.com，请检查网络或代理');
      if (this._cancelFlag) throw new Error('已取消');
      const manifest = { model: MODEL_ID, kind, files: [] };
      for (const f of spec.files) {
        await withActivity('下载模型 ' + f, async () => {
          const dest = path.join(dir, f);
          curPart = dest + '.part';
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const urls = hosts.map((h) => `${h}/${spec.repo}/resolve/main/${f}`);
          this.progress.file = f;
          this.progress.bytes = 0;
          this.progress.total = 0;
          this._curFileCounted = false;
          this.progress.host = '';
          this.progress.attempt = 0;
          this.progress.speedBps = 0;
          this._setPhase('download', `下载 ${f}（第 ${manifest.files.length + 1}/${spec.files.length} 个文件）`);
          // 上次已下完并改名的文件：大小与远端一致就不重下（sha256 仍在下面统一计算）
          const have = fs.existsSync(dest) ? fs.statSync(dest).size : -1;
          const remote = have >= 0 ? await remoteSize(urls, { fetchImpl }) : 0;
          if (have >= 0 && remote > 0 && have === remote) {
            log(`跳过 ${f}：本地已有完整文件（${have} 字节）`);
          } else {
            await downloadFile({
              urls, dest, fetchImpl,
              isCancelled: () => this._cancelFlag,
              onProgress: (p) => {
                this.progress.bytes = p.bytes;
                this.progress.total = p.total;
                this.progress.host = p.host;
                this.progress.attempt = p.attempt;
                this.progress.speedBps = p.speedBps;
                this._recalcOverall();
                if (this._cancelFlag) throw new Error('已取消');
              },
              log,
            });
          }
          curPart = null; // 已 rename 落盘
          this._setPhase('verify', '校验 ' + f);
          const sha = await sha256File(dest);
          const bytes = fs.statSync(dest).size;
          manifest.files.push({ path: f, sha256: sha, bytes });
          this.progress.done++;
          this.progress.bytes = bytes;
          this.progress.total = bytes;
          this._bytesDone += bytes;
          this._curFileCounted = true;
          this._recalcOverall();
        });
      }
      writeJsonAtomic(this.manifestPath(kind), manifest);
      this._shaCache = manifest.files.find((x) => x.path.includes('safetensors') || x.path.endsWith('.onnx'))?.sha256 || null;
      this.state = 'ready';
      this.backend = kind;
      this._taskKind = null;
      this._dropRuntime(); // 重新加载
      console.log('[rag] 模型下载完成: ' + kind + '，耗时 ' + (Date.now() - t0) + 'ms');
    } catch (e) {
      const cancelled = this._cancelFlag;
      if (cancelled && curPart) {
        try { fs.rmSync(curPart, { force: true }); } catch { /* 忽略 */ }
      }
      if (cancelled) {
        this._restoreStateAfterTask();
        console.log('[rag] 模型下载已取消');
        return;
      }
      this.state = 'error';
      this.error = String(e.message || e);
      this._taskKind = null;
      console.error('[rag] 模型下载失败: ' + this.error);
    }
  }

  /** 手动导入模型目录：同步校验参数后立即返回，复制/校验在后台跑（进度走 status 轮询） */
  importDir(dir) {
    if (this.state === 'downloading' || this.state === 'importing') return { ok: false, error: '已有下载或导入任务进行中' };
    if (!dir || typeof dir !== 'string' || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return { ok: false, error: '目录不存在: ' + dir };
    }
    const kind = process.platform === 'darwin' && fs.existsSync(path.join(dir, 'model.safetensors')) ? 'mlx' : 'onnx';
    const spec = REPOS[kind];
    const need = spec.files.filter((f) => !fs.existsSync(path.join(dir, f)));
    if (need.length) return { ok: false, error: '缺少文件: ' + need.join(', ') };
    const sizes = new Map(spec.files.map((f) => [f, fs.statSync(path.join(dir, f)).size]));
    const dest = this.modelDir(kind);
    fs.mkdirSync(dest, { recursive: true });
    this.state = 'importing';
    this.error = null;
    this._cancelFlag = false;
    this._taskKind = 'import';
    this._totalKnownAll = [...sizes.values()].reduce((a, b) => a + b, 0);
    this._resetProgress(spec.files.length);
    this._setPhase('copy', '');
    this._downloadTask = this._runImport(kind, spec, dir, dest, sizes).catch((e) => {
      // _runImport 已处理取消与常规错误，这里只记录意外退出
      console.error('[rag] 导入任务异常退出: ' + String(e?.message || e));
      this._restoreStateAfterTask();
    });
    return { ok: true, started: true };
  }

  /** 后台导入：逐文件流式复制（边读边算 sha256），全部复制完重读目标文件校验，最后写清单 */
  async _runImport(kind, spec, dir, dest, sizes) {
    const t0 = Date.now();
    let curPart = null; // 正在写的半截文件（取消/失败时清理）
    const entries = [];
    try {
      for (const f of spec.files) {
        const src = path.join(dir, f);
        const dst = path.join(dest, f);
        fs.mkdirSync(path.dirname(dst), { recursive: true }); // 嵌套子目录（onnx/ 等）
        this.progress.file = f;
        this.progress.total = sizes.get(f);
        this.progress.bytes = 0;
        this._curFileCounted = false;
        this._setPhase('copy', '复制 ' + f);
        const same = path.resolve(src) === path.resolve(dst);
        const sha = same ? await sha256File(dst) : await this._copyStream(src, dst + '.part', () => { curPart = dst + '.part'; });
        if (!same) {
          await fs.promises.rename(dst + '.part', dst); // 原子替换，旧文件只在新文件完整后失效
          curPart = null;
        }
        entries.push({ path: f, sha256: sha, bytes: sizes.get(f) });
        this.progress.bytes = sizes.get(f);
        this.progress.done++;
        this._bytesDone += sizes.get(f);
        this._curFileCounted = true;
        this._recalcOverall();
      }
      for (const e of entries) {
        if (this._cancelFlag) throw new Error('已取消');
        this.progress.file = e.path;
        this._setPhase('verify', '校验 ' + e.path);
        const again = await sha256File(path.join(dest, e.path));
        if (again !== e.sha256) throw new Error('导入校验失败：' + e.path + ' 写入内容与源不一致');
      }
      const manifest = { model: MODEL_ID, kind, files: entries };
      writeJsonAtomic(this.manifestPath(kind), manifest);
      this._shaCache = manifest.files.find((x) => x.path.includes('safetensors') || x.path.endsWith('.onnx'))?.sha256 || null;
      this.state = 'ready';
      this.backend = kind;
      this._taskKind = null;
      this._dropRuntime();
      console.log('[rag] 模型导入完成: ' + kind + '，耗时 ' + (Date.now() - t0) + 'ms');
    } catch (e) {
      if (curPart) {
        try { fs.rmSync(curPart, { force: true }); } catch { /* 忽略 */ }
      }
      if (this._cancelFlag) {
        this._restoreStateAfterTask();
        console.log('[rag] 模型导入已取消');
        return;
      }
      this.state = 'error';
      this._taskKind = null;
      this.error = e?.code === 'ENOSPC' || e?.code === 'EDQUOT'
        ? '磁盘空间不足，导入中断（已清理半截文件）'
        : String(e.message || e);
      console.error('[rag] 模型导入失败: ' + this.error);
    }
  }

  /** 流式复制并同步计算 sha256；每写完一块更新进度，中途可取消 */
  async _copyStream(src, partPath, onStart) {
    const h = crypto.createHash('sha256');
    const total = fs.statSync(src).size;
    const self = this;
    let copied = 0;
    onStart?.();
    const tap = async function* (chunks) {
      for await (const chunk of chunks) {
        if (self._cancelFlag) throw new Error('已取消');
        h.update(chunk);
        copied += chunk.length;
        self.progress.bytes = copied;
        const el = self.progress.startedAt ? (Date.now() - self.progress.startedAt) / 1000 : 0;
        self.progress.speedBps = el > 0.2 ? Math.round((self._bytesDone + copied) / el) : 0;
        self._recalcOverall();
        if (self._importCopyHook) await self._importCopyHook(copied, total);
        yield chunk;
      }
    };
    await pipeline(fs.createReadStream(src), tap, fs.createWriteStream(partPath));
    return h.digest('hex');
  }

  /** 置备 sidecar venv：优先 uv（开发机）；打包版从捆绑资源离线引导（python-build-standalone + wheels）。
   * 解压与安装都是异步 spawn，不阻塞事件循环；onPhase 上报阶段（env-extract / env-install）。
   * 全部依赖装完写 .wb-complete 标记；无标记的旧环境先导入自检（60s），不过则删掉重备；
   * 安装失败或被取消时删除 venvDir，不畱下半截环境 */
  async ensureVenv(onPhase = null) {
    const py = this.venvPython();
    const doneMark = path.join(this.venvDir, '.wb-complete');
    const run = (cmd, args, opts = {}, timeoutMs = 0) =>
      new Promise((resolve) => {
        const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts });
        this._activeProc = p; // 供 cancel 杀进程
        let err = '';
        const timer = timeoutMs > 0 ? setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* 已退出 */ } }, timeoutMs) : null;
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (c) => {
          this._activeProc = null;
          if (timer) clearTimeout(timer);
          resolve(c === 0 ? { ok: true } : { ok: false, err: err.slice(-800) });
        });
        p.on('error', (e) => {
          this._activeProc = null;
          if (timer) clearTimeout(timer);
          resolve({ ok: false, err: String(e) });
        });
      });
    if (fs.existsSync(py)) {
      if (fs.existsSync(doneMark)) return;
      // python 在但无完成标记：可能是安装中断的半截环境，导入自检判定
      console.log('[rag] venv 无完成标记，执行导入自检');
      const probe = await run(py, ['-c', 'import mlx.core, transformers, tokenizers'], {}, 60000);
      if (probe.ok) {
        await fs.promises.writeFile(doneMark, String(Date.now()) + '\n');
        return;
      }
      console.log('[rag] 导入自检未通过，删除旧 venv 重新置备: ' + probe.err);
      await fs.promises.rm(this.venvDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(this.venvDir), { recursive: true });
    const installPkgs = async (mk) => {
      // 离线路径逐包安装：进度按包计数（n/N）；uv 在线路径一次性联合解析，无法逐包计数
      for (let i = 0; i < MLX_REQUIREMENTS.length; i++) {
        onPhase?.('env-install', `安装依赖 ${i + 1}/${MLX_REQUIREMENTS.length}`);
        const r = await mk(MLX_REQUIREMENTS[i]);
        if (!r.ok) throw new Error('安装依赖 ' + MLX_REQUIREMENTS[i] + ' 失败: ' + r.err);
      }
    };
    try {
      // 路径 A：uv（开发机，联网）：一次性联合解析安装，避免逐包安装相互升降级
      const uvOk = await run('uv', ['--version']);
      if (uvOk.ok) {
        onPhase?.('env-install', '创建虚拟环境');
        let r = await run('uv', ['venv', '--python', '3.12', this.venvDir]);
        if (!r.ok) throw new Error('uv venv 失败: ' + r.err);
        onPhase?.('env-install', `安装依赖（共 ${MLX_REQUIREMENTS.length} 个包）`);
        r = await run('uv', ['pip', 'install', '--python', py, ...MLX_REQUIREMENTS]);
        if (!r.ok) throw new Error('uv pip install 失败: ' + r.err);
      } else {
        // 路径 B：打包版捆绑资源（离线）：python-build-standalone + wheels
        const resources = process.resourcesPath // Electron 打包版
          ? path.join(process.resourcesPath, 'mlx-env')
          : path.join(this.dataDir, 'mlx-env-bundle'); // 兼容手动放置
        const tarball = path.join(resources, 'python.tar.gz');
        const wheels = path.join(resources, 'wheels');
        if (!fs.existsSync(tarball) || !fs.existsSync(wheels)) {
          throw new Error('MLX 环境不可用：无 uv 且无捆绑资源（重装应用或安装 uv 后重试）');
        }
        const basePy = await this._ensurePyRuntime(tarball, onPhase, run);
        onPhase?.('env-install', '创建虚拟环境');
        let r = await run(basePy, ['-m', 'venv', this.venvDir]);
        if (!r.ok) throw new Error('venv 创建失败: ' + r.err);
        await installPkgs((pkg) => run(py, ['-m', 'pip', 'install', '--no-index', '--find-links', wheels, '--no-deps', pkg]));
      }
      await fs.promises.writeFile(doneMark, String(Date.now()) + '\n');
    } catch (e) {
      // 失败或被取消：删除半截环境，避免下次被当作可用（下次从头置备）
      await fs.promises.rm(this.venvDir, { recursive: true, force: true }).catch(() => { /* 删除失败只能报原错 */ });
      throw e;
    }
  }

  /** 离线路径的可重定位 python：解压到 dataDir/py/runtime（tar 内顶层为 python/），返回解释器路径。
   * 先解压到同级临时目录 runtime.tmp-<ts>，解释器与标准库都在才改名为 runtime，再写完成标记；
   * 无标记的 runtime（旧版本留下或解压中断的半截）整个删掉重新解压；失败或被取消时删临时目录 */
  async _ensurePyRuntime(tarball, onPhase, run) {
    const pyDir = path.dirname(this.venvDir);
    const runtime = path.join(pyDir, 'runtime');
    const mark = path.join(runtime, '.wb-complete');
    const basePy = path.join(runtime, 'python', 'bin', 'python3');
    if (fs.existsSync(mark)) return basePy;
    if (fs.existsSync(runtime)) {
      console.log('[rag] Python 运行时无完成标记，删除后重新解压');
      await fs.promises.rm(runtime, { recursive: true, force: true });
    }
    // 进程被强退时 catch 不会执行，残留的临时目录在下一次解压前清掉
    for (const name of await fs.promises.readdir(pyDir).catch(() => [])) {
      if (name.startsWith('runtime.tmp-')) await fs.promises.rm(path.join(pyDir, name), { recursive: true, force: true });
    }
    const tmp = path.join(pyDir, 'runtime.tmp-' + Date.now());
    try {
      await fs.promises.mkdir(tmp, { recursive: true });
      onPhase?.('env-extract', '解压 Python 运行时');
      const r = await run('tar', ['-xzf', tarball, '-C', tmp]);
      if (!r.ok) throw new Error('解压 Python 运行时失败: ' + r.err);
      for (const rel of ['python/bin/python3', 'python/lib/python3.12/os.py']) {
        if (!fs.existsSync(path.join(tmp, ...rel.split('/')))) throw new Error('Python 运行时不完整：缺少 ' + rel);
      }
      await renameWithRetryAsync(tmp, runtime);
    } catch (e) {
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => { /* 删除失败只能报原错 */ });
      throw e;
    }
    await fs.promises.writeFile(mark, String(Date.now()) + '\n');
    return basePy;
  }

  /** 惰性加载运行时；ready 前置检查模型。加载期间的阶段走 this.runtime（status 可见） */
  async ensureReady() {
    if (this._runtime) return this._runtime;
    if (this.state === 'downloading' || this.state === 'importing') throw new Error('模型正在下载或导入中');
    if (process.env.WORKBENCH_RAG_EMBED === 'mock') {
      const delay = Number(process.env.WORKBENCH_RAG_MOCK_LOAD_MS) || 0; // 仅供 e2e 控制加载时长，只作用于 mock
      if (delay > 0) {
        this.runtime = { state: 'loading', phase: 'start', startedAt: Date.now(), error: null };
        await new Promise((r) => setTimeout(r, delay));
      }
      const embedDelay = Number(process.env.WORKBENCH_RAG_MOCK_EMBED_MS) || 0; // 仅供 e2e 拉长构建，只作用于 mock
      this._runtime = {
        kind: 'mock',
        embed: async (texts) => {
          if (embedDelay > 0) await new Promise((r) => setTimeout(r, embedDelay));
          return texts.map(mockVec);
        },
      };
      this.state = 'ready';
      this.backend = 'mock';
      this.runtime = { state: 'ready', phase: null, startedAt: null, error: null };
      return this._runtime;
    }
    if (this.state !== 'ready') {
      const kind = process.platform === 'darwin' ? 'mlx' : 'onnx';
      if (!this._manifestOk(kind)) throw new Error('模型未就绪（请先下载或导入）');
      this.state = 'ready';
    }
    const kind = this.detectBackend();
    if (!this._loading) {
      // 运行时加载耗时不可估计（A3）：只给阶段与已用时间，不给百分比
      this.runtime = { state: 'loading', phase: kind === 'mlx' ? 'env' : 'start', startedAt: Date.now(), error: null };
      this._loading = this._load(kind);
    }
    const t0 = Date.now();
    try {
      this._runtime = await this._loading;
      this.backend = this._runtime.kind;
      this.runtime = { state: 'ready', phase: null, startedAt: null, error: null };
      console.log('[rag] 运行时加载完成: ' + this._runtime.kind + (this._runtime.ep ? ' EP=' + this._runtime.ep : '') + '，耗时 ' + (Date.now() - t0) + 'ms');
    } catch (e) {
      this._loading = null;
      this.runtime = { state: 'error', phase: null, startedAt: null, error: String(e.message || e) };
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
          this._dropRuntime();
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
    if (this.runtime.state === 'loading') this.runtime.phase = 'env';
    await this.ensureVenv((phase) => {
      if (this.runtime.state === 'loading') this.runtime.phase = phase === 'env-extract' || phase === 'env-install' ? 'env' : this.runtime.phase;
    });
    if (this.runtime.state === 'loading') this.runtime.phase = 'start';
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
        this._dropRuntime();
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
    this._dropRuntime();
  }
}

// 模型任务的进度快照（下载/导入共用）
function _emptyProgress() {
  return {
    file: '', bytes: 0, total: 0, done: 0, files: 0, host: '', attempt: 0, speedBps: 0,
    phase: '', phaseDetail: '', overallBytes: 0, overallTotal: 0, percent: null, estimated: false,
    etaSeconds: null, startedAt: null,
  };
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
