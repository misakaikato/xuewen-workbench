// Word 解析模块：带缓存的解析入口与缓存回收；解析本身在 wordParse.js。
// 派生的预览 HTML 与正文缓存存放在应用数据目录，不写入语料目录
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cacheDirAsync, knowledgeDir } from './store.js';
import { writeFileAtomicAsync } from './atomicFile.js';
import { withActivity, setActivity } from './lagWatch.js';
import { findSoffice } from './wordParse.js';
import { convertInWorker, WORD_TIMEOUT_MS } from './wordPool.js';

export async function wordCapability() {
  const soffice = await findSoffice();
  return {
    docx: { supported: true, engine: 'mammoth' },
    doc: soffice
      ? { supported: true, engine: 'libreoffice+mammoth', soffice }
      : {
          supported: true,
          engine: 'word-extractor',
          limitation:
            '未检测到 LibreOffice，.doc 以纯文本方式提取（不含图片与表格样式）。安装 LibreOffice 后可获得完整排版预览。',
        },
  };
}

// 资产目录名 <缓存键>-<mtime>：/api/word/asset 校验与缓存回收共用
export const WORD_ASSET_KEY = /^[0-9a-f]{40}-\d+(\.\d+)?$/;
const WORD_CACHE_FILE = /^word-([0-9a-f]{40})\.json$/;

/** 缓存键：由文档相对路径算出，解析缓存 word-<键>.json 与图片目录 word-assets/<键>-<mtime> 共用 */
export function wordCacheKey(relPath) {
  return crypto.createHash('sha1').update(relPath).digest('hex');
}

// 解析 Word 文件，带缓存（格式版本 + mtime 失效；旧版缓存不命中）。转换在 worker 线程里跑（wordPool.js），
// 主线程只读写缓存。缓存两种形态：成功 { v, mtimeMs, result }、失败 { v, mtimeMs, failed: { code, message, at } }。
// 失败缓存让建索引不再反复重试同一份解析超时或出错的文档；force（用户主动打开）时无视失败缓存重试一次。
// 缓存写不进去（如 Windows 上缓存文件被占用）只记 WARN，结果照常返回或抛出，下次再解析。
// 返回 { html, text, engine, warning? }；失败抛出带 code 的 Error，message 是给界面看的中文原因。
const WORD_CACHE_VERSION = 3;
// 缓存的 JSON 解析与序列化在主线程上同步进行，超过它记 WARN（大文档的缓存可达数十 MB）
const SYNC_SLOW_MS = 100;

// 在主线程上同步执行 fn：登记活动（阻塞时 [lag] 行点名），超过 SYNC_SLOW_MS 记 WARN
function timedSync(step, relPath, fn) {
  const endActivity = setActivity(step + ' ' + relPath);
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - t0;
    endActivity();
    if (ms > SYNC_SLOW_MS) console.warn(`[word] 主线程处理慢：${relPath} ${step} ${Math.round(ms)}ms`);
  }
}

function failureMessage(e) {
  if (e.code === 'WORD_TIMEOUT') return `解析超时（超过 ${Math.round(WORD_TIMEOUT_MS / 1000)} 秒），已跳过。可在阅读页重新打开以重试。`;
  if (e.code === 'WORD_WORKER_CRASH') return '解析进程意外退出，已跳过。可在阅读页重新打开以重试。';
  if (e.code === 'WORD_WORKER_UNAVAILABLE') return '解析线程无法启动，请重启应用后再试。';
  return '无法解析此文档：' + e.message;
}

export async function parseWord(dsId, absPath, relPath, mtimeMs, { force = false } = {}) {
  const key = wordCacheKey(relPath);
  const cacheRoot = await cacheDirAsync(dsId);
  const cacheFile = path.join(cacheRoot, 'word-' + key + '.json');
  let cached = null;
  try {
    const raw = await fs.promises.readFile(cacheFile, 'utf8');
    cached = timedSync('读 Word 缓存', relPath, () => JSON.parse(raw));
  } catch { /* 无缓存或无法解析：重新解析文档 */ }
  if (cached && cached.v === WORD_CACHE_VERSION && cached.mtimeMs === mtimeMs) {
    if (cached.result) return cached.result;
    if (cached.failed && !force) throw Object.assign(new Error(cached.failed.message), { code: 'WORD_SKIPPED' });
  }

  let result;
  try {
    result = await convertInWorker({ dsId, absPath, cacheRoot, cacheKey: key, mtimeMs }, relPath);
  } catch (e) {
    const message = failureMessage(e);
    console.warn('[word] ' + relPath + '：' + message);
    // 线程起不来是环境问题，不记到文档头上
    if (e.code !== 'WORD_WORKER_UNAVAILABLE') {
      await writeCache(cacheFile, { v: WORD_CACHE_VERSION, mtimeMs, failed: { code: e.code || 'WORD_ERROR', message, at: new Date().toISOString() } }, relPath);
    }
    throw Object.assign(new Error(message), { code: e.code || 'WORD_ERROR' });
  }
  await writeCache(cacheFile, { v: WORD_CACHE_VERSION, mtimeMs, result }, relPath);
  return result;
}

async function writeCache(cacheFile, entry, relPath) {
  try {
    const text = timedSync('写 Word 缓存', relPath, () => JSON.stringify(entry, null, 2));
    await writeFileAtomicAsync(cacheFile, text);
  } catch (e) {
    console.warn(`[word] 缓存写入失败（本次结果照常使用）：${relPath}：${e.code || e.message}`);
  }
}

// 仅提取正文（用于搜索索引），失败时返回 null
export async function extractWordText(dsId, absPath, relPath, mtimeMs) {
  try {
    const r = await withActivity('解析 Word ' + relPath, () => parseWord(dsId, absPath, relPath, mtimeMs));
    return r.text || '';
  } catch {
    return null;
  }
}

// 回收 Word 缓存：删除快照里已不存在的文档对应的 word-<键>.json 与 word-assets/<键>-* 目录。
// 保留的键由快照里每个 Word 文档的 relPath 经 wordCacheKey 算出；只认上面两种命名，其余文件不动。
// shouldStop() 为真（本轮扫描被取代或新扫描已开始）时立即停止。返回删除的条目数。
export async function reclaimWordCache(dsId, snapshot, shouldStop = () => false) {
  const keep = new Set();
  for (const f of [...snapshot.files, ...(snapshot.derivedFiles || [])]) {
    if (f.ext === '.doc' || f.ext === '.docx') keep.add(wordCacheKey(f.path));
  }
  const cacheRoot = path.join(knowledgeDir(dsId), 'cache');
  const stale = [];
  for (const name of await fs.promises.readdir(cacheRoot).catch(() => [])) {
    const key = WORD_CACHE_FILE.exec(name)?.[1];
    if (key && !keep.has(key)) stale.push(path.join(cacheRoot, name));
  }
  const assets = path.join(cacheRoot, 'word-assets');
  for (const name of await fs.promises.readdir(assets).catch(() => [])) {
    if (WORD_ASSET_KEY.test(name) && !keep.has(name.slice(0, 40))) stale.push(path.join(assets, name));
  }
  let removed = 0;
  for (const p of stale) {
    if (shouldStop()) break;
    try {
      await fs.promises.rm(p, { recursive: true, force: true });
      removed++;
    } catch (e) {
      console.warn(`[word] 回收缓存失败：${p}：${e.code || e.message}`);
    }
  }
  if (removed) console.log(`[word] 回收已删除文档的 Word 缓存 ${removed} 项（${dsId}）`);
  return removed;
}
