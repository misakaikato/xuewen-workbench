// Word 解析 worker：在独立线程里跑 wordParse.convertWord，转换计算不占后端主线程。
// 主线程（wordPool.js）每次只给一个 worker 派一件事：{ t: 'convert', id, args }，
// 回 { t: 'result', id, result } 或 { t: 'error', id, error }。
import { parentPort } from 'node:worker_threads';
import { convertWord } from './wordParse.js';

parentPort.on('message', async (msg) => {
  if (msg?.t !== 'convert') return;
  try {
    parentPort.postMessage({ t: 'result', id: msg.id, result: await convertWord(msg.args) });
  } catch (e) {
    parentPort.postMessage({ t: 'error', id: msg.id, error: String(e?.message || e) });
  }
});
