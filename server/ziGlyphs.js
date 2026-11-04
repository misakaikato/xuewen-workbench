// 字形演变：查看某个字时按需从 zi.tools 字統网取它的代表字形（/api/zi/<字> 的 tubrief），缓存在
// <数据目录>/ziglyphs/，之后不再联网。数据格式与 ~/Projects/zi-tools-mcp 的 zi_evolution 同源。
//
// 不让请求占住连接：没有缓存时只登记「想要」并立即返回 pending，前端每秒轮询一次；前端不看了（卸载、换字）
// 会撤销登记，没撤销但超过 STALE_MS 没人再问的字（页面关掉等）也直接丢掉，都不请求。队列每次取最近被问到的字，真实请求串行、相邻间隔 ≥ 600ms；
// 每次发请求前再查一遍开关，关掉后排队的也不发。
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicAsync } from './atomicFile.js';

const API = (process.env.WORKBENCH_ZITOOLS_API || 'https://zi.tools/api').replace(/\/+$/, '');
export const SITE = 'https://zi.tools/zi/';
const CACHE_VERSION = 1;
const MIN_INTERVAL_MS = 600;
const TIMEOUT_MS = 20000;
const STALE_MS = 4000; // 前端每秒轮询；连续约 4 次没问到就当作不看了
const ERROR_TTL_MS = 60000; // 失败结果保留多久（期间轮询直接返回失败，不反复请求）
const USER_AGENT = 'xuewen-workbench (personal use; on-demand)';
// 与 server/ziyi.js 的 HAN_RE 同一汉字范围
const HAN_RE = /^[㐀-䶿一-鿿豈-﫿\u{20000}-\u{3FFFF}]$/u;
const PNG_B64 = 'iVBORw0KGgo'; // PNG 文件头的 base64

export const STYLE_NAMES = {
  甲骨: '甲骨文', 金: '金文', 簡: '简帛', 篆: '篆书', 隸: '隶书', 楷: '楷书',
  行: '行书', 草: '草书', 印: '印刷', 石: '石经', 標: '标准字形',
};
export const styleName = (s) => (Object.hasOwn(STYLE_NAMES, s) ? STYLE_NAMES[s] : s);

const httpError = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** tubrief 的一行：[来源键, id, 字形所属字, 字, PNG base64, 书体, 时代, 出处, …]；只留 PNG */
function rowToItem(r) {
  if (!Array.isArray(r) || typeof r[4] !== 'string' || !r[4].startsWith(PNG_B64)) return null;
  const s = (x) => (typeof x === 'string' ? x : '');
  return { variant: s(r[2]), style: s(r[5]), period: s(r[6]), label: s(r[7]), png: r[4] };
}

export class ZiGlyphs {
  /** enabled：每次真实请求前再查的开关 */
  constructor(dir, { enabled = () => true } = {}) {
    this.dir = dir;
    this.enabled = enabled;
    this.wanted = new Map(); // 字 -> 最近一次被问到的时间（排队中）
    this.running = null; // 正在请求的字
    this.errors = new Map(); // 字 -> { message, at }
    this.pumping = false;
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

  /**
   * 问一次某字的字形：{ status: 'ok', rec } | { status: 'pending' } | { status: 'error', message, rec? }。
   * 排队或正在取时返回 pending（并刷新「还在看」）；refresh 时不看缓存、清掉失败记录重新排队。
   */
  async peek(ch, { refresh = false } = {}) {
    if (typeof ch !== 'string' || !HAN_RE.test(ch)) throw httpError(400, '只能查单个汉字的字形');
    if (this.running === ch) return { status: 'pending' };
    if (this.wanted.has(ch)) {
      this.wanted.set(ch, Date.now());
      return { status: 'pending' };
    }
    if (refresh) {
      this.errors.delete(ch);
    } else {
      const err = this.errors.get(ch);
      const hit = await this._readCache(ch);
      // 刚失败过：一段时间内直接报失败（附上旧缓存，界面照样显示），不反复请求
      if (err && Date.now() - err.at < ERROR_TTL_MS) return { status: 'error', message: err.message, rec: hit };
      if (hit) return { status: 'ok', rec: hit };
    }
    this.wanted.set(ch, Date.now());
    void this._pump();
    return { status: 'pending' };
  }

  /** 前端不再看这个字（卸载、换字）：还没开始请求的撤销；正在请求的照常完成并缓存 */
  cancel(ch) {
    this.wanted.delete(ch);
  }

  _dropStale() {
    const now = Date.now();
    for (const [ch, at] of this.wanted) if (now - at > STALE_MS) this.wanted.delete(ch);
  }

  /** 最近被问到的字优先 */
  _next() {
    let best = null;
    for (const [ch, at] of this.wanted) if (!best || at > best[1]) best = [ch, at];
    return best?.[0] ?? null;
  }

  async _pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        this._dropStale();
        if (!this.wanted.size) break;
        if (!this.enabled()) { this.wanted.clear(); break; }
        const wait = this.lastAt + MIN_INTERVAL_MS - Date.now();
        if (wait > 0) {
          await sleep(wait);
          continue; // 等待期间可能有更新的字、或有字过期、或开关被关掉，重新挑
        }
        const ch = this._next();
        this.wanted.delete(ch);
        this.running = ch;
        try {
          await this._fetchAndStore(ch);
          this.errors.delete(ch);
        } catch (e) {
          this.errors.set(ch, { message: e.message || String(e), at: Date.now() });
        } finally {
          this.running = null;
          this.lastAt = Date.now();
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  async _fetchAndStore(ch) {
    const data = await request(`${API}/zi/${encodeURIComponent(ch)}`);
    const rows = data?.yi?.tubrief;
    const items = Array.isArray(rows) ? rows.map(rowToItem).filter(Boolean) : [];
    const rec = { v: CACHE_VERSION, char: ch, fetchedAt: new Date().toISOString(), items };
    await fs.promises.mkdir(this.dir, { recursive: true });
    await writeJsonAtomicAsync(this._file(ch), rec);
    return rec;
  }
}

/**
 * GET JSON。404 视为未收录（{}）；返回的 JSON 里既没有 yi、也没有 zi.tools 正常响应都会带的 font / __zi 时，
 * 当作限流或出错页（502，不缓存），免得把错误当成「没有字形」永久存下。
 */
async function request(url) {
  let res;
  let body;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return {};
    if (!res.ok) throw httpError(502, `zi.tools 返回 ${res.status}`);
    body = await res.text();
  } catch (e) {
    if (e.status) throw e;
    const why = e?.name === 'TimeoutError' ? '超时' : (e?.cause?.code || e?.message || String(e));
    throw httpError(502, `连不上 zi.tools（${why}）`);
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw httpError(502, 'zi.tools 返回的不是 JSON');
  }
  if (!data || typeof data !== 'object' || (!data.yi && !('font' in data) && !('__zi' in data))) {
    throw httpError(502, 'zi.tools 返回的内容无法识别');
  }
  return data;
}
