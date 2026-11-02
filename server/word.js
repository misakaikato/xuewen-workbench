// Word 解析模块：docx 用 mammoth；doc 优先 LibreOffice 转换，缺失时回退 word-extractor 纯文本
// 派生的预览 HTML 与正文缓存存放在应用数据目录，不写入语料目录
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import { cacheDir, readJson, writeJsonAtomic } from './store.js';
import { withActivity } from './lagWatch.js';

const extractor = new WordExtractor();

let sofficePathCache;

export async function findSoffice() {
  if (sofficePathCache !== undefined) return sofficePathCache;
  const candidates = [
    'soffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
  ];
  for (const c of candidates) {
    const ok = await new Promise((resolve) => {
      execFile(c, ['--version'], { timeout: 8000 }, (err) => resolve(!err));
    });
    if (ok) {
      sofficePathCache = c;
      return c;
    }
  }
  sofficePathCache = null;
  return null;
}

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

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 图片外置：不内嵌 data URI（26MB docx 会产生 36MB JSON 响应），写到
// cacheDir(dsId)/word-assets/<路径哈希>-<mtime>/img-<n>.<ext>，HTML 中引用 /api/word/asset。
// SVG 例外：直接打开 SVG 文件可执行其中的脚本，不从应用源站提供，保持 data URI 内嵌。
const IMG_EXT_BY_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };

function makeImageSink(dsId, dirKey, mtimeMs) {
  const base = path.join(cacheDir(dsId), 'word-assets');
  const dir = path.join(base, `${dirKey}-${mtimeMs}`);
  let n = 0;
  let cleaned = false;
  return {
    convertImage: mammoth.images.imgElement(async (image) => {
      if (!cleaned) {
        cleaned = true;
        try {
          fs.mkdirSync(base, { recursive: true });
          // 同一路径哈希只保留最新 mtime 的资产目录
          for (const d of fs.readdirSync(base)) {
            if (d.startsWith(dirKey + '-') && d !== path.basename(dir)) {
              fs.rmSync(path.join(base, d), { recursive: true, force: true });
            }
          }
          fs.mkdirSync(dir, { recursive: true });
        } catch { /* 资产目录不可写时退回 data URI */ }
      }
      const b64 = await image.readAsBase64String();
      if (image.contentType === 'image/svg+xml') {
        return { src: `data:${image.contentType};base64,${b64}` };
      }
      const ext = IMG_EXT_BY_TYPE[image.contentType] || 'png';
      const name = `img-${++n}.${ext}`;
      try {
        fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
        return {
          src: `/api/word/asset?ds=${encodeURIComponent(dsId)}&key=${encodeURIComponent(path.basename(dir))}&name=${encodeURIComponent(name)}`,
          loading: 'lazy',
          decoding: 'async',
        };
      } catch {
        return { src: `data:${image.contentType};base64,${b64}` };
      }
    }),
  };
}

function textToHtml(text) {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `<p>${escapeHtml(line)}</p>` : ''))
    .join('\n');
}

async function docxToHtml(absPath, sink = null) {
  const [htmlRes, textRes] = await Promise.all([
    mammoth.convertToHtml({ path: absPath }, sink ? { convertImage: sink.convertImage } : {}),
    mammoth.extractRawText({ path: absPath }),
  ]);
  return { html: htmlRes.value, text: textRes.value, engine: 'mammoth' };
}

async function docViaSoffice(absPath, cacheDir, sink = null) {
  // 每次转换独立临时目录：并发同名文件互不串扰，只读本次新产生的 docx，用完即删。
  const workDir = fs.mkdtempSync(path.join(cacheDir, 'convert-'));
  try {
    await new Promise((resolve, reject) => {
      execFile(
        sofficePathCache,
        ['--headless', '--convert-to', 'docx', '--outdir', workDir, absPath],
        { timeout: 60000 },
        (err, _stdout, stderr) => (err ? reject(new Error(stderr || String(err))) : resolve())
      );
    });
    const converted = path.join(
      workDir,
      path.basename(absPath, path.extname(absPath)) + '.docx'
    );
    // 正常退出但没有产物 → 视为失败（由 parseWord 回退 word-extractor）
    if (!fs.existsSync(converted)) throw new Error('LibreOffice 转换未产生输出文件');
    return await docxToHtml(converted, sink);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
  }
}

async function docViaExtractor(absPath) {
  const doc = await extractor.extract(absPath);
  const text = doc.getBody() || '';
  return { html: textToHtml(text), text, engine: 'word-extractor' };
}

// 解析 Word 文件，带缓存（格式版本 + mtime 失效；旧版内嵌 data URI 的缓存不命中）。
// 返回 { html, text, engine, warning? }
const WORD_CACHE_VERSION = 2;

export async function parseWord(dsId, absPath, relPath, mtimeMs) {
  const ext = path.extname(absPath).toLowerCase();
  const key = crypto.createHash('sha1').update(relPath).digest('hex');
  const cacheFile = path.join(cacheDir(dsId), 'word-' + key + '.json');
  const cached = readJson(cacheFile, null);
  if (cached && cached.v === WORD_CACHE_VERSION && cached.mtimeMs === mtimeMs) return cached.result;

  let result;
  const sink = makeImageSink(dsId, key, mtimeMs);
  if (ext === '.docx') {
    result = await docxToHtml(absPath, sink);
  } else if (ext === '.doc') {
    const soffice = await findSoffice();
    if (soffice) {
      try {
        result = await docViaSoffice(absPath, cacheDir(dsId), sink);
        result.engine = 'libreoffice+mammoth';
      } catch (e) {
        result = await docViaExtractor(absPath);
        result.warning = 'LibreOffice 转换失败（' + e.message + '），已回退为纯文本提取。';
      }
    } else {
      result = await docViaExtractor(absPath);
      result.warning =
        '未检测到 LibreOffice，.doc 以纯文本方式展示。安装 LibreOffice 并重启应用后可获得完整排版。';
    }
  } else {
    throw new Error('不支持的 Word 格式: ' + ext);
  }
  writeJsonAtomic(cacheFile, { v: WORD_CACHE_VERSION, mtimeMs, result });
  return result;
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
