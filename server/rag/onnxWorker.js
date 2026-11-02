// ONNX 推理 worker：加载 tokenizer 与推理会话，向量后处理（f16→f32、CLS、L2）的唯一实现。
// 消息按到达顺序串行处理：{ t: 'embed', id, texts, maxLength } 回 { t: 'result', id, vecs } 或 { t: 'error', id, error }；
// { t: 'close' } 排在已收到的 embed 之后执行 process.exit(0)（优雅关闭，此时不在原生调用中）。
// 日志经 { t: 'log', level, message } 上报，由主线程转写 console（worker 的 console 不进 backend.log）。
import { parentPort, workerData } from 'node:worker_threads';

const { dir, modelPath, eps } = workerData;

function postLog(level, message) {
  parentPort.postMessage({ t: 'log', level, message });
}

async function load() {
  const { AutoTokenizer, env } = await import('@huggingface/transformers');
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  const ort = await import('onnxruntime-node');
  const tokenizer = await AutoTokenizer.from_pretrained(dir);
  // 按 eps 顺序尝试并降级 cpu（与旧 _loadOnnx 相同）
  const t0 = Date.now();
  let session = null;
  let usedEp = 'cpu';
  for (const ep of [...eps, 'cpu']) {
    try {
      session = await ort.InferenceSession.create(modelPath, { executionProviders: [ep] });
      usedEp = ep;
      break;
    } catch (e) {
      postLog('error', `ONNX EP ${ep} 不可用，降级: ${String(e.message || e).slice(0, 120)}`);
    }
  }
  if (!session) throw new Error('ONNX 会话创建失败（含 cpu）');
  postLog('info', `ONNX 会话就绪：EP=${usedEp}，耗时 ${Date.now() - t0}ms`);
  return { tokenizer, session, ort, ep: usedEp };
}

// 分批推理：每批 8 条，输出 L2 归一化的 CLS 向量
async function embedAll({ tokenizer, session, ort }, texts, maxLength) {
  const out = [];
  for (let i = 0; i < texts.length; i += 8) {
    const batch = texts.slice(i, i + 8);
    const enc = await tokenizer(batch, { padding: true, truncation: true, max_length: maxLength });
    const feeds = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(enc.input_ids.data), enc.input_ids.dims),
      attention_mask: new ort.Tensor('int64', BigInt64Array.from(enc.attention_mask.data), enc.attention_mask.dims),
    };
    const r = await session.run(feeds);
    // 输出名不假设（可能叫 last_hidden_state / token_embeddings），取首个
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

async function handle(ctx, msg) {
  if (msg.t === 'close') {
    process.exit(0);
    return;
  }
  if (msg.t !== 'embed') return;
  try {
    const vecs = await embedAll(ctx, msg.texts, msg.maxLength || 1024);
    parentPort.postMessage({ t: 'result', id: msg.id, vecs }, vecs.map((v) => v.buffer));
  } catch (e) {
    parentPort.postMessage({ t: 'error', id: msg.id, error: String(e.message || e) });
  }
}

load().then((ctx) => {
  parentPort.postMessage({ t: 'ready', ep: ctx.ep });
  // 串行处理：每条消息排队在前一条完成之后；close 因此排在已收到的 embed 之后
  let chain = Promise.resolve();
  parentPort.on('message', (msg) => {
    chain = chain.then(() => handle(ctx, msg)).catch((e) => {
      postLog('error', 'worker 处理消息失败: ' + String(e.message || e));
    });
  });
}).catch((e) => {
  parentPort.postMessage({ t: 'fatal', error: String(e.message || e) });
  process.exit(1);
});
