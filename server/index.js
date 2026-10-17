// 主服务：Express API。语料配置、扫描状态、目录树、文件读写（原子写+备份+冲突检测）、
// 检索、引用解析、集合与元数据映射、最近记录与常用入口、Word 能力诊断。
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { getConfig, saveConfig, dsIdFor, getState, setState, backupDir } from './store.js';
import { Scanner, SUPPORTED_EXTS } from './scanner.js';
import { Indexer } from './indexer.js';
import { parseWord, wordCapability } from './word.js';

const PORT = process.env.WORKBENCH_PORT || 7410;
const app = express();
app.use(express.json({ limit: '20mb' }));

const scanner = new Scanner();
const indexer = new Indexer();

let currentDsId = null;

scanner.on('scan-done', async (snapshot) => {
  if (currentDsId && scanner.baseDir) {
    try {
      await indexer.build(snapshot);
    } catch (e) {
      console.error('索引构建失败:', e.message);
    }
  }
});

function requireSource(res) {
  if (!scanner.baseDir || !scanner.snapshot) {
    res.status(409).json({ error: '尚未配置数据源或扫描未完成' });
    return false;
  }
  return true;
}

// 路径安全：限制在当前 baseDir 内（跟随符号链接校验真实路径）
function resolveWithin(rel) {
  const abs = path.resolve(scanner.baseDir, rel);
  const baseNorm = path.resolve(scanner.baseDir);
  if (abs !== baseNorm && !abs.startsWith(baseNorm + path.sep)) {
    throw Object.assign(new Error('路径越界'), { status: 403 });
  }
  try {
    const real = fs.realpathSync(abs);
    const realBase = fs.realpathSync(baseNorm);
    if (real !== realBase && !real.startsWith(realBase + path.sep)) {
      throw Object.assign(new Error('符号链接指向数据源之外'), { status: 403 });
    }
  } catch (e) {
    if (e.status) throw e;
    // 文件可能不存在（如另存场景），仅校验静态路径
  }
  return abs;
}

function findFile(rel) {
  return scanner.snapshot.files.find((f) => f.path === rel);
}

function readTextPreserve(abs) {
  const buf = fs.readFileSync(abs);
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const content = (bom ? buf.subarray(3) : buf).toString('utf8');
  return { content, bom };
}

async function writeTextAtomic(abs, content, bom) {
  const tmp = abs + '.wb-tmp-' + process.pid;
  fs.writeFileSync(tmp, (bom ? '﻿' : '') + content, 'utf8');
  fs.renameSync(tmp, abs);
}

// ---------- 数据源配置 ----------

app.get('/api/config', (req, res) => {
  const cfg = getConfig();
  res.json({
    configured: !!cfg,
    baseDir: cfg?.baseDir || null,
    dsId: cfg?.dsId || null,
    generation: scanner.generation,
    status: scanner.status(),
  });
});

app.post('/api/config/test', async (req, res) => {
  const { baseDir } = req.body || {};
  if (!baseDir || !String(baseDir).trim()) {
    return res.json({ ok: false, error: '请输入目录路径' });
  }
  const p = path.normalize(String(baseDir).trim().replace(/^["']|["']$/g, ''));
  const out = { ok: false, path: p, exists: false, readable: false, writable: false };
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return res.json({ ...out, error: '路径存在但不是目录' });
    out.exists = true;
    fs.accessSync(p, fs.constants.R_OK);
    out.readable = true;
    try {
      fs.accessSync(p, fs.constants.W_OK);
      const probe = path.join(p, '.wb-write-test-' + process.pid);
      fs.writeFileSync(probe, 't');
      fs.unlinkSync(probe);
      out.writable = true;
    } catch {
      out.writable = false;
    }
    out.ok = true;
  } catch (e) {
    out.error = out.exists ? '目录不可读: ' + e.code : '目录不存在或无法访问: ' + e.code;
  }
  res.json(out);
});

app.post('/api/config', async (req, res) => {
  const { baseDir } = req.body || {};
  const p = path.normalize(String(baseDir || '').trim().replace(/^["']|["']$/g, ''));
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) throw new Error('不是目录');
    fs.accessSync(p, fs.constants.R_OK);
  } catch (e) {
    return res.status(400).json({ error: '目录不可访问: ' + e.message });
  }
  const cfg = saveConfig(p);
  currentDsId = cfg.dsId;
  scanner.setBaseDir(p);
  indexer.reset(cfg.dsId, p);
  await scanner.rescan();
  scanner.startWatch();
  res.json({ ok: true, ...cfg, status: scanner.status() });
});

app.post('/api/rescan', async (req, res) => {
  if (!scanner.baseDir) return res.status(409).json({ error: '尚未配置数据源' });
  await scanner.rescan();
  res.json({ ok: true, status: scanner.status() });
});

app.get('/api/status', (req, res) => {
  res.json({ dsId: currentDsId, ...scanner.status() });
});

// ---------- 目录树与统计 ----------

function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/');
      if (!node.dirs.has(parts[i])) {
        node.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [] });
      }
      node = node.dirs.get(parts[i]);
    }
    node.files.push(f);
  }
  function serialize(node) {
    return {
      name: node.name,
      path: node.path,
      dirs: [...node.dirs.values()].map(serialize),
      files: node.files.map((f) => ({ ...f })),
    };
  }
  return serialize(root);
}

app.get('/api/tree', (req, res) => {
  if (!requireSource(res)) return;
  res.json({ dsId: currentDsId, tree: buildTree(scanner.snapshot.files) });
});

app.get('/api/stats', (req, res) => {
  if (!requireSource(res)) return;
  const files = scanner.snapshot.files;
  const topDist = new Map();
  for (const f of files) {
    const top = f.dir ? f.dir.split('/')[0] : '(根目录)';
    topDist.set(top, (topDist.get(top) || 0) + 1);
  }
  const recent = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 12);
  res.json({
    dsId: currentDsId,
    scannedAt: scanner.snapshot.scannedAt,
    counts: {
      total: files.length,
      md: files.filter((f) => f.ext === '.md').length,
      json: files.filter((f) => f.ext === '.json').length,
      doc: files.filter((f) => f.ext === '.doc').length,
      docx: files.filter((f) => f.ext === '.docx').length,
      dirs: scanner.snapshot.dirCount,
      dirErrors: scanner.snapshot.dirErrors.length,
      fileErrors: scanner.snapshot.fileErrors.length,
    },
    distribution: [...topDist.entries()]
      .map(([dir, count]) => ({ dir, count }))
      .sort((a, b) => b.count - a.count),
    recentModified: recent,
  });
});

// ---------- 文件读取与保存 ----------

app.get('/api/file', async (req, res) => {
  if (!requireSource(res)) return;
  const rel = String(req.query.path || '');
  try {
    const abs = resolveWithin(rel);
    const f = findFile(rel);
    if (!f) return res.status(404).json({ error: '文件不在当前扫描结果中（可能已被移动或删除）', missing: true });
    const ext = f.ext;
    if (ext === '.md' || ext === '.json') {
      const { content, bom } = readTextPreserve(abs);
      return res.json({
        dsId: currentDsId, path: rel, name: f.name, ext, type: ext === '.md' ? 'markdown' : 'json',
        content, bom, mtimeMs: f.mtimeMs, size: f.size, readonly: false,
      });
    }
    const parsed = await parseWord(currentDsId, abs, rel, f.mtimeMs);
    res.json({
      dsId: currentDsId, path: rel, name: f.name, ext, type: 'word',
      html: parsed.html, text: parsed.text, engine: parsed.engine, warning: parsed.warning || null,
      mtimeMs: f.mtimeMs, size: f.size, readonly: true,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/file/raw', (req, res) => {
  if (!requireSource(res)) return;
  try {
    const abs = resolveWithin(String(req.query.path || ''));
    res.download(abs);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 显式保存：写回数据源原文件（仅 md/json）。原子写入 + 备份 + mtime 冲突检测
app.put('/api/file', async (req, res) => {
  if (!requireSource(res)) return;
  const { path: rel, content, baseMtimeMs, dsId } = req.body || {};
  if (dsId && dsId !== currentDsId) {
    return res.status(409).json({ error: '数据源已切换，请刷新后重试', stale: true });
  }
  const f = findFile(rel);
  const ext = path.posix.extname(String(rel)).toLowerCase();
  if (!['.md', '.json'].includes(ext)) {
    return res.status(400).json({ error: '该格式不支持直接写回，请使用另存副本' });
  }
  try {
    const abs = resolveWithin(rel);
    const exists = fs.existsSync(abs);
    if (exists) {
      const cur = fs.statSync(abs);
      if (baseMtimeMs != null && Math.abs(cur.mtimeMs - baseMtimeMs) > 1) {
        const { content: current } = readTextPreserve(abs);
        return res.status(409).json({
          error: '文件已被外部修改', conflict: true, current, currentMtimeMs: cur.mtimeMs,
        });
      }
      // 备份原文件
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bdir = path.join(backupDir(currentDsId), path.dirname(rel));
      fs.mkdirSync(bdir, { recursive: true });
      fs.copyFileSync(abs, path.join(bdir, path.basename(rel) + '.' + stamp + '.bak'));
      const { bom } = readTextPreserve(abs);
      await writeTextAtomic(abs, String(content ?? ''), bom);
    } else {
      if (f) return res.status(409).json({ error: '文件状态不一致，请重新扫描' });
      return res.status(404).json({ error: '文件已被外部删除，未重新创建。可将内容另存为新文件。', missing: true });
    }
    const st = fs.statSync(abs);
    await scanner.rescan();
    res.json({ ok: true, mtimeMs: st.mtimeMs });
  } catch (e) {
    res.status(e.status || 500).json({ error: '写入失败: ' + e.message });
  }
});

// 另存为新文件（如 Word 转 Markdown 副本）
app.post('/api/file/save-as', async (req, res) => {
  if (!requireSource(res)) return;
  const { path: rel, content, dsId } = req.body || {};
  if (dsId && dsId !== currentDsId) {
    return res.status(409).json({ error: '数据源已切换，请刷新后重试', stale: true });
  }
  const ext = path.posix.extname(String(rel)).toLowerCase();
  if (!['.md', '.json'].includes(ext)) {
    return res.status(400).json({ error: '副本仅支持保存为 .md 或 .json' });
  }
  try {
    const abs = resolveWithin(rel);
    if (fs.existsSync(abs)) return res.status(409).json({ error: '目标文件已存在', exists: true });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await writeTextAtomic(abs, String(content ?? ''), false);
    await scanner.rescan();
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: '写入失败: ' + e.message });
  }
});

// ---------- 检索与引用 ----------

app.get('/api/search', (req, res) => {
  if (!requireSource(res)) return;
  const q = String(req.query.q || '');
  const types = req.query.types ? String(req.query.types).split(',') : null;
  const dir = String(req.query.dir || '');
  const excludeDirs = req.query.exclude ? String(req.query.exclude).split(',') : [];
  res.json({ dsId: currentDsId, ...indexer.search(q, { types, dir, excludeDirs }) });
});

app.get('/api/refs/resolve', (req, res) => {
  if (!requireSource(res)) return;
  const name = String(req.query.name || '');
  const collection = req.query.collection ? String(req.query.collection) : null;
  let dirs = null;
  if (collection) {
    const cols = getState(currentDsId, 'collections', []);
    const col = cols.find((c) => c.name === collection);
    if (col) dirs = col.dirs;
  }
  res.json({ dsId: currentDsId, ...indexer.resolveRef(name, dirs) });
});

// 供前端做正文自动链接的文件名清单（完整名与主体名）
app.get('/api/refs/names', (req, res) => {
  if (!requireSource(res)) return;
  const names = indexer.files.map((f) => ({
    name: f.name, base: f.base, path: f.path, ext: f.ext, dir: f.dir,
  }));
  const cols = getState(currentDsId, 'collections', []);
  res.json({ dsId: currentDsId, names, collections: cols });
});

app.get('/api/backlinks', (req, res) => {
  if (!requireSource(res)) return;
  const f = findFile(String(req.query.path || ''));
  if (!f) return res.status(404).json({ error: '文件不存在' });
  res.json({ dsId: currentDsId, backlinks: indexer.backlinks(f) });
});

// ---------- 最近记录 / 常用入口 / 集合 / 元数据映射 ----------

app.post('/api/recents', (req, res) => {
  if (!currentDsId) return res.status(409).json({ error: '未配置数据源' });
  const { path: rel } = req.body || {};
  let recents = getState(currentDsId, 'recents', []);
  recents = [{ path: rel, at: Date.now() }, ...recents.filter((r) => r.path !== rel)].slice(0, 30);
  setState(currentDsId, 'recents', recents);
  res.json({ ok: true });
});

app.get('/api/recents', (req, res) => {
  if (!currentDsId) return res.json({ recents: [] });
  const recents = getState(currentDsId, 'recents', []);
  const alive = scanner.snapshot
    ? recents.map((r) => ({ ...r, exists: !!findFile(r.path), file: findFile(r.path) || null }))
    : recents;
  res.json({ dsId: currentDsId, recents: alive });
});

app.get('/api/pins', (req, res) => {
  if (!currentDsId) return res.json({ pins: [] });
  const pins = getState(currentDsId, 'pins', []);
  const alive = scanner.snapshot
    ? pins.map((p) => ({ ...p, exists: !!findFile(p.path) }))
    : pins;
  res.json({ dsId: currentDsId, pins: alive });
});

app.post('/api/pins', (req, res) => {
  if (!currentDsId) return res.status(409).json({ error: '未配置数据源' });
  const { path: rel, action } = req.body || {};
  let pins = getState(currentDsId, 'pins', []);
  if (action === 'remove') pins = pins.filter((p) => p.path !== rel);
  else if (!pins.some((p) => p.path === rel)) pins.push({ path: rel, at: Date.now() });
  setState(currentDsId, 'pins', pins);
  res.json({ ok: true, pins });
});

app.get('/api/collections', (req, res) => {
  if (!currentDsId) return res.json({ collections: [] });
  const cols = getState(currentDsId, 'collections', []);
  // 标记目录是否仍存在
  const dirs = new Set((scanner.snapshot?.files || []).map((f) => f.dir));
  const withStatus = cols.map((c) => ({
    ...c,
    validDirs: c.dirs.filter((d) => dirs.has(d) || d === ''),
    missingDirs: c.dirs.filter((d) => !dirs.has(d) && d !== ''),
  }));
  res.json({ dsId: currentDsId, collections: withStatus });
});

app.put('/api/collections', (req, res) => {
  if (!currentDsId) return res.status(409).json({ error: '未配置数据源' });
  const cols = Array.isArray(req.body?.collections) ? req.body.collections : [];
  setState(currentDsId, 'collections', cols);
  res.json({ ok: true });
});

app.get('/api/metadata', (req, res) => {
  if (!currentDsId) return res.json({ mappings: [] });
  res.json({ dsId: currentDsId, mappings: getState(currentDsId, 'metadata', []) });
});

app.put('/api/metadata', (req, res) => {
  if (!currentDsId) return res.status(409).json({ error: '未配置数据源' });
  setState(currentDsId, 'metadata', Array.isArray(req.body?.mappings) ? req.body.mappings : []);
  res.json({ ok: true });
});

// 预览某个 JSON 文件的结构，辅助配置映射
app.get('/api/metadata/inspect', (req, res) => {
  if (!requireSource(res)) return;
  try {
    const abs = resolveWithin(String(req.query.path || ''));
    const { content } = readTextPreserve(abs);
    const data = JSON.parse(content);
    const shape = (v, depth) => {
      if (depth > 3) return Array.isArray(v) ? '[...]' : typeof v;
      if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
      if (v && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v).slice(0, 12).map(([k, val]) => [k, shape(val, depth + 1)]));
      }
      return typeof v;
    };
    res.json({ ok: true, shape: shape(data, 0), sample: JSON.stringify(data).slice(0, 3000) });
  } catch (e) {
    res.status(400).json({ error: 'JSON 解析失败: ' + e.message });
  }
});

// 主题/概念聚合：基于用户配置的元数据映射
app.get('/api/topics', (req, res) => {
  if (!requireSource(res)) return;
  const mappings = getState(currentDsId, 'metadata', []);
  const topicCount = new Map();
  const conceptCount = new Map();
  const errors = [];
  for (const m of mappings) {
    try {
      const abs = resolveWithin(m.file);
      const data = JSON.parse(readTextPreserve(abs).content);
      const items = m.itemPath
        ? m.itemPath.split('.').reduce((o, k) => (o ? o[k] : undefined), data)
        : data;
      if (!Array.isArray(items)) {
        errors.push({ file: m.file, reason: '条目路径未指向数组' });
        continue;
      }
      for (const it of items) {
        const topics = it?.[m.fields?.topics];
        const concepts = it?.[m.fields?.concepts];
        const fileName = it?.[m.fields?.file];
        for (const t of Array.isArray(topics) ? topics : topics ? [topics] : []) {
          if (!topicCount.has(t)) topicCount.set(t, { topic: t, count: 0, files: [] });
          const e = topicCount.get(t);
          e.count++;
          if (fileName) e.files.push(String(fileName));
        }
        for (const c of Array.isArray(concepts) ? concepts : concepts ? [concepts] : []) {
          if (!conceptCount.has(c)) conceptCount.set(c, { concept: c, count: 0, files: [] });
          const e = conceptCount.get(c);
          e.count++;
          if (fileName) e.files.push(String(fileName));
        }
      }
    } catch (e) {
      errors.push({ file: m.file, reason: e.message });
    }
  }
  res.json({
    dsId: currentDsId,
    configured: mappings.length > 0,
    topics: [...topicCount.values()].sort((a, b) => b.count - a.count),
    concepts: [...conceptCount.values()].sort((a, b) => b.count - a.count),
    errors,
  });
});

app.get('/api/word-capability', async (req, res) => {
  res.json(await wordCapability());
});

// ---------- 启动 ----------

async function boot() {
  const cfg = getConfig();
  if (cfg) {
    try {
      fs.accessSync(cfg.baseDir, fs.constants.R_OK);
      currentDsId = cfg.dsId;
      scanner.setBaseDir(cfg.baseDir);
      indexer.reset(cfg.dsId, cfg.baseDir);
      await scanner.rescan();
      scanner.startWatch();
      console.log('已恢复数据源:', cfg.baseDir);
    } catch (e) {
      console.error('上次数据源不可访问:', e.message);
    }
  }
  app.listen(PORT, () => console.log('语料工作台后端已启动: http://localhost:' + PORT));
}

boot();
