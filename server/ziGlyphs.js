// 字形演变：查看某个字时按需从 zi.tools 字統网取它的代表字形（/api/zi/<字> 的 tubrief），缓存在
// <数据目录>/ziglyphs/，之后不再联网。只取正在查看的字，不批量、不预取；真实请求串行且相邻间隔 ≥ 600ms，
// 同一字的并发请求合并。数据格式与 ~/Projects/zi-tools-mcp 的 zi_evolution 同源。
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicAsync } from './atomicFile.js';

const API = (process.env.WORKBENCH_ZITOOLS_API || 'https://zi.tools/api').replace(/\/+$/, '');
export const SITE = 'https://zi.tools/zi/';
const CACHE_VERSION = 1;
const MIN_INTERVAL_MS = 600;
const TIMEOUT_MS = 20000;
const USER_AGENT = 'xuewen-workbench (personal use; on-demand)';
// 与 server/ziyi.js 的 HAN_RE 同一汉字范围
const HAN_RE = /^[㐀-䶿一-鿿豈-﫿\u{20000}-\u{3FFFF}]$/u;
const PNG_B64 = 'iVBORw0KGgo'; // PNG 文件头的 base64

export const STYLE_NAMES = {
  甲骨: '甲骨文', 金: '金文', 簡: '简帛', 篆: '篆书', 隸: '隶书', 楷: '楷书',
  行: '行书', 草: '草书', 印: '印刷', 石: '石经', 標: '标准字形',
};

const httpError = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** tubrief 的一行：[来源键, id, 字形所属字, 字, PNG base64, 书体, 时代, 出处, …]；只留 PNG */
function rowToItem(r) {
  if (!Array.isArray(r) || typeof r[4] !== 'string' || !r[4].startsWith(PNG_B64)) return null;
  const s = (x) => (typeof x === 'string' ? x : '');
  return { variant: s(r[2]), style: s(r[5]), period: s(r[6]), label: s(r[7]), png: r[4] };
}

export class ZiGlyphs {
  constructor(dir) {
    this.dir = dir;
    this.inflight = new Map(); // 字 -> Promise
    this.chain = Promise.resolve();
    this.lastAt = 0;
  }

  _file(ch) {
    return path.join(this.dir, `${ch.codePointAt(0).toString(16)}.json`);
  }

  async _readCache(ch) {
    try {
      const rec = JSON.parse(await fs.promises.readFile(this._file(ch), 'utf8'));
      return rec && rec.v === CACHE_VERSION && rec.char === ch && Array.isArray(rec.items) ? rec : null;
    } catch {
      return null; // 没有或坏了：重新取，原子写覆盖
    }
  }

  /** 取一个字的字形演变：先读缓存；refresh 时强制重取 */
  async get(ch, { refresh = false } = {}) {
    if (typeof ch !== 'string' || !HAN_RE.test(ch)) throw httpError(400, '只能查单个汉字的字形');
    if (!refresh) {
      const hit = await this._readCache(ch);
      if (hit) return hit;
    }
    if (this.inflight.has(ch)) return this.inflight.get(ch);
    const p = this._fetchAndStore(ch).finally(() => this.inflight.delete(ch));
    this.inflight.set(ch, p);
    return p;
  }

  /** 真实请求排成一队，相邻两次至少间隔 MIN_INTERVAL_MS */
  _throttled(fn) {
    const run = this.chain.then(async () => {
      const wait = this.lastAt + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        this.lastAt = Date.now();
      }
    });
    this.chain = run.catch(() => {});
    return run;
  }

  async _fetchAndStore(ch) {
    const data = await this._throttled(() => request(`${API}/zi/${encodeURIComponent(ch)}`));
    const rows = data?.yi?.tubrief;
    const items = Array.isArray(rows) ? rows.map(rowToItem).filter(Boolean) : [];
    const rec = { v: CACHE_VERSION, char: ch, fetchedAt: new Date().toISOString(), items };
    await fs.promises.mkdir(this.dir, { recursive: true });
    await writeJsonAtomicAsync(this._file(ch), rec);
    return rec;
  }
}

/** GET JSON；404 视为未收录（返回空对象），其余失败抛 502 */
async function request(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? '超时' : (e?.cause?.code || e?.message || String(e));
    throw httpError(502, `连不上 zi.tools（${why}）`);
  }
  if (res.status === 404) return {};
  if (!res.ok) throw httpError(502, `zi.tools 返回 ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw httpError(502, 'zi.tools 返回的不是 JSON');
  }
}
