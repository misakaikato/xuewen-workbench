// Word 解析模块：docx 用 mammoth；doc 优先 LibreOffice 转换，缺失时回退 word-extractor 纯文本
// 派生的预览 HTML 与正文缓存存放在应用数据目录，不写入语料目录
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import { cacheDir, readJson, writeJsonAtomic } from './store.js';

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

function textToHtml(text) {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `<p>${escapeHtml(line)}</p>` : ''))
    .join('\n');
}

async function docxToHtml(absPath) {
  const [htmlRes, textRes] = await Promise.all([
    mammoth.convertToHtml({ path: absPath }),
    mammoth.extractRawText({ path: absPath }),
  ]);
  return { html: htmlRes.value, text: textRes.value, engine: 'mammoth' };
}

async function docViaSoffice(absPath, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
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
  if (!fs.existsSync(converted)) throw new Error('LibreOffice 转换未产生输出文件');
  return docxToHtml(converted);
}

async function docViaExtractor(absPath) {
  const doc = await extractor.extract(absPath);
  const text = doc.getBody() || '';
  return { html: textToHtml(text), text, engine: 'word-extractor' };
}

// 解析 Word 文件，带缓存（按 mtime 失效）。返回 { html, text, engine, warning? }
export async function parseWord(dsId, absPath, relPath, mtimeMs) {
  const ext = path.extname(absPath).toLowerCase();
  const key = crypto.createHash('sha1').update(relPath).digest('hex');
  const cacheFile = path.join(cacheDir(dsId), 'word-' + key + '.json');
  const cached = readJson(cacheFile, null);
  if (cached && cached.mtimeMs === mtimeMs) return cached.result;

  let result;
  if (ext === '.docx') {
    result = await docxToHtml(absPath);
  } else if (ext === '.doc') {
    const soffice = await findSoffice();
    if (soffice) {
      try {
        result = await docViaSoffice(absPath, path.join(cacheDir(dsId), 'word-convert'));
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
  writeJsonAtomic(cacheFile, { mtimeMs, result });
  return result;
}

// 仅提取正文（用于搜索索引），失败时返回 null
export async function extractWordText(dsId, absPath, relPath, mtimeMs) {
  try {
    const r = await parseWord(dsId, absPath, relPath, mtimeMs);
    return r.text || '';
  } catch {
    return null;
  }
}
