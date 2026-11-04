// Word 解析线程池（主线程侧）：转换跑在 wordWorker.js，主线程只排队、计时、收结果。
// - 同一文件（absPath + mtimeMs）排队或执行中再次请求时复用同一个 Promise；
// - 单个任务超过 WORD_TIMEOUT_MS：终止所在 worker，任务以 code WORD_TIMEOUT 失败；
// - worker 运行中崩溃：在途任务以 WORD_WORKER_CRASH 失败；worker 还没起来就出错（如模块加载失败）
//   以 WORD_WORKER_UNAVAILABLE 失败——这是环境问题而不是文档问题，调用方不应据此记失败缓存。
// worker 一律 unref，不阻止进程退出。
import { Worker } from 'node:worker_threads';

export const WORD_TIMEOUT_MS = Number(process.env.WORKBENCH_WORD_TIMEOUT_MS) || 120000;

let size = 2;
let seq = 0;
const idle = []; // 空闲 worker
const busy = new Map(); // worker -> { id, job, timer }
const online = new WeakSet(); // 已成功启动的 worker
const queue = []; // { args, label, resolve, reject }
const inflight = new Map(); // absPath + mtimeMs -> Promise

const coded = (code, message) => Object.assign(new Error(message), { code });

/** 设置并发数（1–8）：调大按队列需要多起 worker；调小时多余的空闲 worker 立即退出，忙的做完再退 */
export function setWordPoolSize(n) {
  size = n;
  while (idle.length && idle.length + busy.size > size) idle.pop().terminate();
  console.log('[word] 解析并发数：' + n);
  pump();
}

/** 在 worker 里解析一个 Word；args 为 wordParse.convertWord 的参数，label 用于日志（相对路径） */
export function convertInWorker(args, label) {
  const key = args.absPath + '\u0000' + args.mtimeMs;
  const hit = inflight.get(key);
  if (hit) return hit;
  const p = new Promise((resolve, reject) => {
    queue.push({ args, label, resolve, reject });
    pump();
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** 终止全部 worker，排队中的任务以 WORD_WORKER_CRASH 失败 */
export async function closeWordPool() {
  for (const job of queue.splice(0)) job.reject(coded('WORD_WORKER_CRASH', '解析线程池已关闭'));
  const all = [...idle.splice(0), ...busy.keys()];
  for (const [w, cur] of busy) {
    clearTimeout(cur.timer);
    busy.delete(w);
    cur.job.reject(coded('WORD_WORKER_CRASH', '解析线程池已关闭'));
  }
  await Promise.all(all.map((w) => w.terminate()));
}

function pump() {
  while (queue.length) {
    let w = idle.pop();
    if (!w) {
      if (busy.size >= size) return;
      w = spawn();
    }
    run(w, queue.shift());
  }
}

function spawn() {
  const w = new Worker(new URL('./wordWorker.js', import.meta.url));
  w.unref();
  w.on('online', () => online.add(w));
  w.on('message', (msg) => {
    const cur = busy.get(w);
    if (!cur || msg?.id !== cur.id) return;
    if (msg.t === 'result') finish(w, cur, null, msg.result);
    else if (msg.t === 'error') finish(w, cur, new Error(msg.error));
  });
  w.on('error', (e) => lost(w, e));
  w.on('exit', (code) => lost(w, new Error('退出码 ' + code)));
  return w;
}

function run(w, job) {
  const id = ++seq;
  const timer = setTimeout(() => {
    if (busy.get(w)?.id !== id) return;
    busy.delete(w);
    w.terminate();
    job.reject(coded('WORD_TIMEOUT', `超过 ${WORD_TIMEOUT_MS}ms`));
    pump();
  }, WORD_TIMEOUT_MS);
  timer.unref();
  busy.set(w, { id, job, timer });
  console.log('[word] 开始解析 ' + job.label);
  w.postMessage({ t: 'convert', id, args: job.args });
}

function finish(w, cur, err, result) {
  clearTimeout(cur.timer);
  busy.delete(w);
  if (busy.size + idle.length < size) idle.push(w);
  else w.terminate();
  if (err) cur.job.reject(err);
  else cur.job.resolve(result);
  pump();
}

// worker 出错或退出：从池里摘掉；在途任务按是否已启动区分崩溃与不可用
function lost(w, e) {
  const i = idle.indexOf(w);
  if (i >= 0) idle.splice(i, 1);
  const cur = busy.get(w);
  if (!cur) return; // 主动终止（超时、缩容、关闭）或空闲时退出，无在途任务
  clearTimeout(cur.timer);
  busy.delete(w);
  if (online.has(w)) {
    cur.job.reject(coded('WORD_WORKER_CRASH', String(e?.message || e)));
  } else {
    console.error('[word] 解析线程启动失败：' + String(e?.message || e));
    cur.job.reject(coded('WORD_WORKER_UNAVAILABLE', String(e?.message || e)));
  }
  pump();
}
