// 主服务：Express API。语料配置、扫描状态、目录树、文件读写（原子写+备份+冲突检测）、
// 检索、引用解析、集合与元数据映射、最近记录与常用入口、Word 能力诊断。
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { listLibs, upsertLib, removeLib as removeLibFromStore, setActiveLib as setActiveLibInStore, getState, setState, backupDir, getUiSettings, saveUiSettings, dataDir } from './store.js';
import { Scanner, SUPPORTED_EXTS, SIDECAR_SUFFIX, TRASH_DIR, isSidecar } from './scanner.js';
import { planImport, applyImport, contentHash } from './meta.js';
import { getTrashHandler } from './trash.js';
import { mountUpdateRoutes, getUpdateBridge, disabledUpdateState } from './update.js';
import { RagManager } from './rag/manager.js';
import { mountRag } from './rag/routes.js';
import { AgentHub } from './agent/manager.js';
import { mountAgent } from './agent/routes.js';
import { Indexer } from './indexer.js';
import { parseWord, wordCapability } from './word.js';
import { LinkIndex } from './links.js';

const PORT = process.env.WORKBENCH_PORT || 7410;
const HOST = process.env.WORKBENCH_HOST || undefined; // 未设置时保持原行为（监听所有地址）
const STATIC_DIR = process.env.WORKBENCH_STATIC_DIR || null; // 设置后托管已构建的前端（Electron 用）
const app = express();
app.use(express.json({ limit: '20mb' }));

// ---------- 资料库运行时（多库并行：各自 scanner/indexer/链接索引） ----------

class Lib {
  constructor(meta) {
    this.id = meta.id;
    this.name = meta.name;
    this.baseDir = meta.baseDir;
    this.scanner = new Scanner();
    this.indexer = new Indexer();
    this.linkIndex = new LinkIndex();
    this.indexing = Promise.resolve(); // 最近一次索引构建，供需要“立即可检索”的写操作等待
    this.scanner.on('scan-done', (snapshot) => {
      this.indexing = (async () => {
        try {
          await this.indexer.build(snapshot);
          await this.linkIndex.rebuild(snapshot, this.indexer); // 自动内链索引随文本索引之后增量更新
        } catch (e) {
          console.error(`[${this.name}] 索引构建失败:`, e.message);
        }
        // 已有 RAG 索引的库自动增量（从未建过的不自动）
        ragManager.onScanComplete(this.id);
      })();
    });
  }

  // 绑定目录并完成首次扫描 + 开监听（目录不可达时地出异常，由调用方处理）
  async start() {
    this.scanner.setBaseDir(this.baseDir);
    this.indexer.reset(this.id, this.baseDir);
    this.linkIndex.reset(this.id, this.baseDir);
    await this.scanner.rescan();
    this.scanner.startWatch();
  }

  stop() {
    this.scanner.stopWatch();
  }

  // 重扫并等待索引完成（若监听触发的扫描正在进行，先等它结束，避免拿到旧快照）
  async rescanAndIndex() {
    while (this.scanner.scanning) await new Promise((r) => setTimeout(r, 50));
    await this.scanner.rescan();
    await this.indexing;
  }
}

const libs = new Map(); // id -> Lib（已打开的资料库）

// RAG 管理器：全局共享嵌入服务，按库隔离索引（knowledge/<dsId>/rag.db）
const ragManager = new RagManager({
  dataDir: dataDir(),
  knowledgeDir: path.join(dataDir(), 'knowledge'),
  getLib: (dsId) => {
    const lib = libs.get(dsId);
    if (!lib) return null;
    return {
      snapshot: lib.scanner.snapshot,
      getText: (p) => lib.indexer.texts.get(p) ?? null,
      whenIndexed: () => lib.indexing,
    };
  },
});
app.use('/api/rag', mountRag(ragManager, resolveLib));

// 智能助手（pi agent）：工具闭包经 resolveLib 拿当前库；llm 配置变化时同步 models.json
const agentHub = new AgentHub({
  dataDir: dataDir(),
  getLib: () => libs.get(activeId) || null,
  ragManager,
  getRagConfig: () => ragManager.llm,
});
ragManager.onLlmChanged = () => agentHub._syncModelsJson();
app.use('/api/agent', mountAgent(agentHub, resolveLib));
let activeId = null;
let libVersion = 0; // 增/删/激活变化计数，进入 config.generation 复合值

const libMeta = (l) => ({ id: l.id, name: l.name, baseDir: l.baseDir, status: l.scanner.status() });

function emptyStatus() {
  return {
    baseDir: null, scanning: false, watching: false, generation: 0, scannedAt: null,
    counts: null, dirErrors: [], fileErrors: [],
  };
}

function configResponse() {
  const active = libs.get(activeId) || null;
  return {
    configured: !!active,
    baseDir: active?.baseDir || null,
    dsId: active?.id || null,
    generation: libVersion * 1000000 + (active?.scanner.generation || 0),
    status: active ? active.scanner.status() : emptyStatus(),
    libraries: [...libs.values()].map(libMeta),
    activeId,
  };
}

// 按请求定位资料库：query.ds / body.dsId / body.dataSourceId，缺省为当前激活库；
// 显式指定的 id 未打开时抛 404，无任何库时返回 null
function resolveLib(req) {
  // 仅用 query.ds 定位目标库；body 里的 dsId/dataSourceId 保持旧语义（stale 守卫），不参与定位
  const want = req.query?.ds || null;
  if (want) {
    const lib = libs.get(String(want));
    if (!lib) throw Object.assign(new Error('资料库未打开'), { status: 404 });
    return lib;
  }
  return libs.get(activeId) || null;
}

function requireLib(res, req) {
  let lib = null;
  try {
    lib = resolveLib(req);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
    return null;
  }
  if (!lib || !lib.scanner.baseDir || !lib.scanner.snapshot) {
    res.status(409).json({ error: '尚未打开资料库或扫描未完成' });
    return null;
  }
  return lib;
}

// 路径安全：限制在指定资料库 baseDir 内（跟随符号链接校验真实路径）
function resolveWithin(lib, rel) {
  const abs = path.resolve(lib.scanner.baseDir, rel);
  const baseNorm = path.resolve(lib.scanner.baseDir);
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

function findFile(lib, rel) {
  return lib.scanner.snapshot.files.find((f) => f.path === rel);
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

// 保存后同步旁注 content_hash：仅当旁注存在且为 JSON 对象时更新哈希字段，
// 其余键与顺序保持不变；从不新建旁注；非法旁注不动。失败不影响保存结果。
function syncSidecarHash(abs, wroteBuf) {
  const metaAbs = abs + SIDECAR_SUFFIX;
  let raw;
  try {
    raw = fs.readFileSync(metaAbs, 'utf8');
  } catch {
    return; // 无旁注
  }
  const hash = contentHash(wroteBuf);
  try {
    const meta = JSON.parse(raw);
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return; // 非对象：不动
    if (meta.content_hash === hash) return;
    const field = /\"content_hash\"\s*:\s*\"[^\"]*\"/.exec(raw);
    let text;
    if (field) {
      // 原地替换哈希值，保持其余字节不变
      text = raw.slice(0, field.index) + '"content_hash": ' + JSON.stringify(hash) + raw.slice(field.index + field[0].length);
    } else {
      meta.content_hash = hash;
      text = JSON.stringify(meta, null, 2) + '\n';
    }
    writeTextAtomic(metaAbs, text, false);
  } catch (e) {
    if (e instanceof SyntaxError) return; // 非法 JSON：保持原样
    console.error('旁注 content_hash 更新失败:', e.message);
  }
}

// ---------- 资料库配置 ----------

app.get('/api/config', (req, res) => {
  res.json(configResponse());
});

// 新增/打开资料库；同目录已打开则仅激活（老语义的“切换”兼容：末次指定者为当前）
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
  const lib = upsertLib(p);
  if (!libs.has(lib.id)) {
    const runtime = new Lib(lib);
    libs.set(lib.id, runtime);
    activeId = lib.id;
    libVersion++;
    agentHub.onLibSwitch(); // 切库：销毁其他库的 agent session（防串上下文）
    try {
      await runtime.start();
    } catch (e) {
      console.error('[' + lib.name + '] 首扫失败:', e.message);
    }
  } else if (activeId !== lib.id) {
    activeId = lib.id;
    libVersion++;
    agentHub.onLibSwitch();
  }
  res.json({ ok: true, ...configResponse() });
});

// 已打开资料库清单（含各自扫描状态）
app.get('/api/libraries', (req, res) => {
  res.json({ libraries: [...libs.values()].map(libMeta), activeId, generation: libVersion * 1000000 });
});

app.post('/api/library/activate', (req, res) => {
  const id = String(req.body?.ds || req.body?.dsId || '');
  if (!libs.has(id)) return res.status(404).json({ error: '资料库未打开' });
  activeId = id;
  libVersion++;
  setActiveLibInStore(id);
  agentHub.onLibSwitch(); // 切库：销毁其他库的 agent session
  res.json({ ok: true, ...configResponse() });
});

// 从工作区移除：停监听、卸内存实例；磁盘语料与派生数据（草稿/最近/集合/备份）全保留
app.post('/api/library/remove', async (req, res) => {
  const id = String(req.body?.ds || req.body?.dsId || '');
  const lib = libs.get(id);
  if (!lib) return res.status(404).json({ error: '资料库未打开' });
  try {
    lib.stop();
  } catch { /* ignore */ }
  libs.delete(id);
  ragManager.remove(id);
  const { activeId: nextActive } = removeLibFromStore(id);
  if (activeId === id) activeId = nextActive;
  libVersion++;
  agentHub.onLibSwitch(); // 库变更：清理不属于当前库的 session
  res.json({ ok: true, activeId, libraries: [...libs.values()].map(libMeta) });
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

app.post('/api/rescan', async (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  await lib.scanner.rescan();
  res.json({ ok: true, status: lib.scanner.status() });
});

// ---------- 应用更新（桥接由 Electron 主进程注入；无桥接时停用） ----------

mountUpdateRoutes(app);

// ---------- 界面设置（外观主题；不依赖数据源，未配置时也可用） ----------

app.get('/api/ui-settings', (req, res) => {
  res.json(getUiSettings());
});

app.put('/api/ui-settings', (req, res) => {
  const { theme, autoUpdate } = req.body || {};
  const patch = {};
  if (theme !== undefined) {
    if (!['A', 'B', 'C'].includes(theme)) {
      return res.status(400).json({ error: 'theme 必须是 A、B 或 C' });
    }
    patch.theme = theme;
  }
  if (autoUpdate !== undefined) {
    if (typeof autoUpdate !== 'boolean') {
      return res.status(400).json({ error: 'autoUpdate 必须是布尔值' });
    }
    patch.autoUpdate = autoUpdate;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: '缺少可更新字段（theme / autoUpdate）' });
  }
  const next = saveUiSettings(patch);
  res.json({ ok: true, ...next });
});

app.get('/api/status', (req, res) => {
  const active = libs.get(activeId) || null;
  const libStatuses = {};
  for (const [id, l] of libs) {
    libStatuses[id] = { scanning: l.scanner.scanning, watching: !!l.scanner.watcher, scannedAt: l.scanner.snapshot?.scannedAt || null };
  }
  const bridge = getUpdateBridge();
  res.json({
    dsId: activeId, ...(active ? active.scanner.status() : emptyStatus()), libs: libStatuses,
    update: bridge ? bridge.state() : disabledUpdateState(),
  });
});

// ---------- 目录树与统计 ----------

function buildTree(files, dirList = []) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  // 空目录也要出现（如刚新建的文件夹）；隐藏目录（.xxx）不单独展示
  const ensureDir = (rel) => {
    let node = root;
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (!node.dirs.has(parts[i])) {
        node.dirs.set(parts[i], { name: parts[i], path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] });
      }
      node = node.dirs.get(parts[i]);
    }
  };
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
  for (const d of dirList) if (!d.split('/').some((p) => p.startsWith('.'))) ensureDir(d);
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
  const lib = requireLib(res, req);
  if (!lib) return;
  res.json({ dsId: lib.id, tree: buildTree(lib.scanner.snapshot.files, lib.scanner.snapshot.dirs) });
});

app.get('/api/stats', (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const files = lib.scanner.snapshot.files;
  const topDist = new Map();
  for (const f of files) {
    const top = f.dir ? f.dir.split('/')[0] : '(根目录)';
    topDist.set(top, (topDist.get(top) || 0) + 1);
  }
  const recent = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 12);
  res.json({
    dsId: lib.id,
    scannedAt: lib.scanner.snapshot.scannedAt,
    counts: {
      total: files.length,
      md: files.filter((f) => f.ext === '.md').length,
      json: files.filter((f) => f.ext === '.json').length,
      txt: files.filter((f) => f.ext === '.txt').length,
      doc: files.filter((f) => f.ext === '.doc').length,
      docx: files.filter((f) => f.ext === '.docx').length,
      dirs: lib.scanner.snapshot.dirCount,
      dirErrors: lib.scanner.snapshot.dirErrors.length,
      fileErrors: lib.scanner.snapshot.fileErrors.length,
    },
    distribution: [...topDist.entries()]
      .map(([dir, count]) => ({ dir, count }))
      .sort((a, b) => b.count - a.count),
    recentModified: recent,
  });
});

// ---------- 文件读取与保存 ----------

app.get('/api/file', async (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const rel = String(req.query.path || '');
  try {
    const abs = resolveWithin(lib, rel);
    const f = findFile(lib, rel);
    if (!f) return res.status(404).json({ error: '文件不在当前扫描结果中（可能已被移动或删除）', missing: true });
    const ext = f.ext;
    if (ext === '.md' || ext === '.json' || ext === '.txt') {
      const { content, bom } = readTextPreserve(abs);
      return res.json({
        dsId: lib.id, path: rel, name: f.name, ext,
        type: ext === '.md' ? 'markdown' : ext === '.json' ? 'json' : 'text',
        content, bom, mtimeMs: f.mtimeMs, size: f.size, readonly: false,
      });
    }
    const parsed = await parseWord(lib.id, abs, rel, f.mtimeMs);
    res.json({
      dsId: lib.id, path: rel, name: f.name, ext, type: 'word',
      html: parsed.html, text: parsed.text, engine: parsed.engine, warning: parsed.warning || null,
      mtimeMs: f.mtimeMs, size: f.size, readonly: true,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/file/raw', (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  try {
    const abs = resolveWithin(lib, String(req.query.path || ''));
    res.download(abs);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 在系统文件管理器中定位显示（Finder / 资源管理器 / xdg-open）；路径必须在当前资料库内且存在
app.post('/api/reveal', (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const rel = String(req.body?.path || '');
  try {
    const abs = resolveWithin(lib, rel);
    let isDir = false;
    try {
      isDir = fs.statSync(abs).isDirectory();
    } catch {
      return res.status(404).json({ error: '路径不存在（可能已被移动或删除）' });
    }
    let cmd;
    let args;
    if (process.platform === 'win32') {
      cmd = 'explorer.exe';
      args = isDir ? [abs] : ['/select,' + abs];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = isDir ? [abs] : ['-R', abs];
    } else {
      cmd = 'xdg-open';
      args = [isDir ? abs : path.dirname(abs)];
    }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    res.json({ ok: true, revealed: rel });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 显式保存：写回数据源原文件（仅 md/json）。原子写入 + 备份 + mtime 冲突检测
app.put('/api/file', async (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const { path: rel, content, baseMtimeMs, dsId } = req.body || {};
  if (dsId && dsId !== lib.id) {
    return res.status(409).json({ error: '数据源已切换，请刷新后重试', stale: true });
  }
  const f = findFile(lib, rel);
  const ext = path.posix.extname(String(rel)).toLowerCase();
  if (!['.md', '.json', '.txt'].includes(ext)) {
    return res.status(400).json({ error: '该格式不支持直接写回，请使用另存副本' });
  }
  try {
    const abs = resolveWithin(lib, rel);
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
      const bdir = path.join(backupDir(lib.id), path.dirname(rel));
      fs.mkdirSync(bdir, { recursive: true });
      fs.copyFileSync(abs, path.join(bdir, path.basename(rel) + '.' + stamp + '.bak'));
      const { bom } = readTextPreserve(abs);
      const text = String(content ?? '');
      await writeTextAtomic(abs, text, bom);
      // 与实际写入字节（含 BOM）一致地更新旁注 content_hash
      syncSidecarHash(abs, Buffer.from((bom ? '﻿' : '') + text, 'utf8'));
    } else {
      if (f) return res.status(409).json({ error: '文件状态不一致，请重新扫描' });
      return res.status(404).json({ error: '文件已被外部删除，未重新创建。可将内容另存为新文件。', missing: true });
    }
    const st = fs.statSync(abs);
    await lib.scanner.rescan();
    res.json({ ok: true, mtimeMs: st.mtimeMs });
  } catch (e) {
    res.status(e.status || 500).json({ error: '写入失败: ' + e.message });
  }
});

// 另存为新文件（如 Word 转 Markdown 副本）
app.post('/api/file/save-as', async (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const { path: rel, content, dsId } = req.body || {};
  if (dsId && dsId !== lib.id) {
    return res.status(409).json({ error: '数据源已切换，请刷新后重试', stale: true });
  }
  const ext = path.posix.extname(String(rel)).toLowerCase();
  if (!['.md', '.json'].includes(ext)) {
    return res.status(400).json({ error: '副本仅支持保存为 .md 或 .json' });
  }
  try {
    const abs = resolveWithin(lib, rel);
    if (fs.existsSync(abs)) return res.status(409).json({ error: '目标文件已存在', exists: true });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await writeTextAtomic(abs, String(content ?? ''), false);
    await lib.scanner.rescan();
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: '写入失败: ' + e.message });
  }
});

// ---------- 新建文档 / 文件夹 ----------

const DOC_TYPES = ['文章', '讲稿', '知乎'];
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const badRequest = (msg, extra = {}) => Object.assign(new Error(msg), { status: 400, extra });

// 文件/文件夹名校验：禁止分隔符、Windows 保留字符与保留名、隐藏名、末尾点/空格
function validateEntryName(raw) {
  const name = String(raw ?? '').normalize('NFC').trim();
  if (!name) throw badRequest('名称不能为空', { invalidName: true });
  if (name === '.' || name === '..') throw badRequest('名称无效', { invalidName: true });
  if (/[/\\<>:"|?*\u0000-\u001f\u007f]/.test(name)) throw badRequest('名称不能包含 / \\ < > : " | ? * 或控制字符', { invalidName: true });
  if (name.startsWith('.')) throw badRequest('名称不能以点开头', { invalidName: true });
  if (/[. ]$/.test(name)) throw badRequest('名称不能以点或空格结尾', { invalidName: true });
  if (WIN_RESERVED.test(name)) throw badRequest('名称为 Windows 保留名', { invalidName: true });
  if (Buffer.byteLength(name, 'utf8') > 200) throw badRequest('名称过长', { invalidName: true });
  return name;
}

// 目录：必须为数据源内相对路径，不允许绝对路径与 ..
function validateRelDir(raw) {
  const s = String(raw ?? '').split('\\').join('/');
  if (path.isAbsolute(s) || path.win32.isAbsolute(s) || /^[a-zA-Z]:/.test(s)) throw badRequest('目录必须是数据源内的相对路径');
  const parts = s.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) throw badRequest('目录不能包含 ..');
  return parts.join('/');
}

function pathTaken(abs) {
  try { fs.lstatSync(abs); return true; } catch { return false; }
}

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 在数据源某目录下新建 Markdown 文档（同时写 <文件名>.meta.json 旁注）或子文件夹
// body: { dsId|dataSourceId, dir, kind: 'md'|'folder', name, title?, docType?: 文章|讲稿|知乎 }
app.post('/api/file/create', async (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const b = req.body || {};
  const dsId = b.dsId ?? b.dataSourceId;
  if (dsId && dsId !== lib.id) {
    return res.status(409).json({ error: '数据源已切换，请刷新后重试', stale: true });
  }
  // 兼容 type 字段：md/folder 视为 kind，文章/讲稿/知乎 视为 docType
  const kind = b.kind ?? (['md', 'folder'].includes(b.type) ? b.type : 'md');
  const docType = b.docType ?? (DOC_TYPES.includes(b.type) ? b.type : '文章');
  try {
    if (!['md', 'folder'].includes(kind)) throw badRequest('不支持的类型: ' + kind);
    const dir = validateRelDir(b.dir);
    const dirAbs = resolveWithin(lib, dir);
    let st;
    try { st = fs.statSync(dirAbs); } catch { return res.status(404).json({ error: '目标目录不存在: ' + (dir || '/') }); }
    if (!st.isDirectory()) throw badRequest('目标不是目录');

    if (kind === 'folder') {
      const name = validateEntryName(b.name);
      const rel = dir ? dir + '/' + name : name;
      const abs = resolveWithin(lib, rel);
      if (pathTaken(abs)) return res.status(409).json({ error: '同名文件或文件夹已存在', exists: true, path: rel });
      fs.mkdirSync(abs);
      await lib.rescanAndIndex();
      return res.json({ ok: true, kind, path: rel });
    }

    if (!DOC_TYPES.includes(docType)) throw badRequest('文档类型必须是 ' + DOC_TYPES.join(' / '));
    let name = validateEntryName(String(b.name ?? '').trim() || b.title);
    if (!/\.md$/i.test(name)) name = validateEntryName(name + '.md');
    const title = String(b.title ?? '').replace(/[\r\n]+/g, ' ').trim() || name.replace(/\.md$/i, '');
    const rel = dir ? dir + '/' + name : name;
    const abs = resolveWithin(lib, rel);
    const metaAbs = abs + SIDECAR_SUFFIX;
    if (pathTaken(abs) || pathTaken(metaAbs)) {
      return res.status(409).json({ error: pathTaken(abs) ? '同名文档已存在' : '同名元数据文件已存在（' + name + SIDECAR_SUFFIX + '）', exists: true, path: rel });
    }
    const now = new Date();
    // 初始内容模板：标准（# 标题）/ 空白 / 标题+日期；content_hash 始终与实际字节一致
    const tpl = ['blank', 'title', 'title-date'].includes(b.bodyTemplate) ? b.bodyTemplate : 'title';
    const body =
      tpl === 'blank' ? '' :
      tpl === 'title-date' ? '# ' + title + '\n\n- 日期：' + localDate(now) + '\n\n' :
      '# ' + title + '\n';
    const meta = {
      id: 'doc_' + crypto.randomUUID(),
      title,
      type: docType,
      date: localDate(now),
      source_url: '',
      aliases: [],
      tags: [],
      content_hash: contentHash(Buffer.from(body, 'utf8')), // 与实际写入字节一致
      created_at: now.toISOString(),
    };
    await writeTextAtomic(abs, body, false);
    try {
      await writeTextAtomic(metaAbs, JSON.stringify(meta, null, 2) + '\n', false);
    } catch (e) {
      try { fs.unlinkSync(abs); } catch { /* ignore */ }
      throw e;
    }
    await lib.rescanAndIndex();
    const f = findFile(lib, rel);
    res.json({ ok: true, kind, path: rel, meta, mtimeMs: f?.mtimeMs ?? null });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, ...(e.extra || {}) });
  }
});

// ---------- 复制 / 创建副本 ----------

// 为副本生成不冲突的名称：名称.EXT -> 名称 - 副本.EXT（再冲突则 副本 2、3…）；目录同理
function dupName(base, ext, taken) {
  for (let i = 1; ; i++) {
    const n = `${base} - 副本${i > 1 ? ' ' + i : ''}${ext}`;
    if (!taken(n)) return n;
  }
}

// 复制后重生成旁注 id，避免重复 id 问题；非法 JSON 的旁注原样复制（问题会照常提示）
function copySidecarWithNewId(srcAbs, dstAbs) {
  try {
    const raw = fs.readFileSync(srcAbs, 'utf8');
    try {
      const meta = JSON.parse(raw);
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
        meta.id = 'doc_' + crypto.randomUUID();
        return fs.writeFileSync(dstAbs, JSON.stringify(meta, null, 2) + '\n');
      }
    } catch { /* 非法 JSON：原样复制 */ }
    fs.writeFileSync(dstAbs, raw);
  } catch { /* 源旁注不存在：跳过 */ }
}

// 复制文档/文件夹（含旁注；目录递归，内部旁注一并重生成 id）。targetDir 缺省为源所在目录
app.post('/api/file/duplicate', async (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const b = req.body || {};
  if (b.dsId && b.dsId !== lib.id) return res.status(409).json({ error: '数据源已切换，请刷新后重试', stale: true });
  try {
    const rel = validateEntryPath(String(b.path || ''));
    const srcAbs = resolveWithin(lib, rel);
    let st;
    try { st = fs.statSync(srcAbs); } catch { return res.status(404).json({ error: '源路径不存在（可能已被移动或删除）', missing: true }); }
    const isDir = st.isDirectory();
    const srcDir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    const targetDir = b.targetDir != null ? validateRelDir(String(b.targetDir)) : srcDir;
    const dstDirAbs = resolveWithin(lib, targetDir);
    const dstDirStat = fs.statSync(dstDirAbs);
    if (!dstDirStat.isDirectory()) throw badRequest('目标不是目录');
    if (targetDir === rel || targetDir.startsWith(rel + '/')) throw badRequest('不能复制到自身内部');

    const fileName = path.posix.basename(rel);
    const ext = isDir ? '' : path.posix.extname(fileName);
    const base = ext ? fileName.slice(0, -ext.length) : fileName;
    const taken = (n) => pathTaken(path.join(dstDirAbs, n));
    const newName = dupName(base, ext, taken);
    const newRel = targetDir ? targetDir + '/' + newName : newName;
    const dstAbs = path.join(dstDirAbs, newName);

    if (isDir) {
      fs.cpSync(srcAbs, dstAbs, { recursive: true });
      // 目录内所有旁注重生成 id
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f);
          else if (isSidecar(e.name)) {
            const doc = f.slice(0, -SIDECAR_SUFFIX.length);
            const tmp = f + '.wb-tmp-' + process.pid;
            try { fs.renameSync(f, tmp); copySidecarWithNewId(tmp, f); } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
          }
        }
      };
      walk(dstAbs);
    } else {
      fs.copyFileSync(srcAbs, dstAbs);
      copySidecarWithNewId(srcAbs + SIDECAR_SUFFIX, dstAbs + SIDECAR_SUFFIX);
    }
    await lib.rescanAndIndex();
    res.json({ ok: true, path: newRel, kind: isDir ? 'folder' : ext.replace('.', '') || 'file' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 被操作条目的相对路径：非根、不含 ..、不在 .trash 内、不是旁注本身
function validateEntryPath(raw) {
  const rel = validateRelDir(raw);
  if (!rel) throw badRequest('不能操作数据源根目录');
  if (rel.split('/')[0] === TRASH_DIR) throw badRequest('不能操作回收站中的条目');
  if (isSidecar(path.posix.basename(rel))) throw badRequest('元数据文件随文档一起操作，不能单独处理');
  return rel;
}

function checkDsId(lib, b, res) {
  const dsId = b.dsId ?? b.dataSourceId;
  if (dsId && dsId !== lib.id) {
    res.status(409).json({ error: '数据源已切换，请刷新后重试', stale: true });
    return false;
  }
  return true;
}

// 读取条目：{ rel, abs, isDir, metaAbs|null }
function loadEntry(lib, raw) {
  const rel = validateEntryPath(raw);
  const abs = resolveWithin(lib, rel);
  let st;
  try { st = fs.lstatSync(abs); } catch { throw Object.assign(new Error('条目不存在: ' + rel), { status: 404 }); }
  const isDir = st.isDirectory();
  const metaAbs = !isDir && pathTaken(abs + SIDECAR_SUFFIX) ? abs + SIDECAR_SUFFIX : null;
  return { rel, abs, isDir, metaAbs };
}

// 依次执行重命名步骤；任一步失败则逆序回滚已完成的步骤
function renameAll(steps) {
  const done = [];
  try {
    for (const [from, to] of steps) {
      fs.renameSync(from, to);
      done.push([from, to]);
    }
  } catch (e) {
    for (const [from, to] of done.reverse()) {
      try { fs.renameSync(to, from); } catch (re) { console.error('回滚失败:', re.message); }
    }
    throw e;
  }
}

const sameCaseInsensitive = (a, b) => a !== b && a.toLowerCase() === b.toLowerCase();

// 将条目（及旁注）移动到 newRel；处理仅大小写变化的重命名
function relocate(lib, entry, newRel) {
  if (newRel === entry.rel) throw badRequest('名称或位置未改变');
  const newAbs = resolveWithin(lib, newRel);
  const caseOnly = sameCaseInsensitive(entry.rel, newRel);
  const newMeta = newAbs + SIDECAR_SUFFIX;
  if (!caseOnly && pathTaken(newAbs)) {
    throw Object.assign(new Error('目标位置已存在同名' + (entry.isDir ? '条目' : '文档') + ': ' + newRel), { status: 409, extra: { exists: true } });
  }
  if (!entry.isDir && !caseOnly && pathTaken(newMeta)) {
    throw Object.assign(new Error('目标位置已存在同名元数据文件: ' + newRel + SIDECAR_SUFFIX), { status: 409, extra: { exists: true } });
  }
  const steps = [];
  const pushStep = (from, to) => {
    if (sameCaseInsensitive(from, to)) {
      const tmp = from + '.wb-case-' + process.pid;
      steps.push([from, tmp], [tmp, to]);
    } else steps.push([from, to]);
  };
  pushStep(entry.abs, newAbs);
  if (entry.metaAbs) pushStep(entry.metaAbs, newMeta);
  renameAll(steps);
  return { newAbs, newMeta: entry.metaAbs ? newMeta : null, steps };
}

const stemOf = (name) => name.slice(0, name.length - path.extname(name).length);

// 重命名/移动时让编辑备份随行：backupDir/<旧目录>/<旧名>.*.bak → <新目录>/<新名>.*.bak；
// 文件夹则整目录搬迁（逐文件合并，目标已存在则跳过）。失败只记日志，不影响条目操作。
function moveBackups(dsId, oldRel, newRel, isDir) {
  const bdir = backupDir(dsId);
  // 只删空目录，绝不误删遗留备份
  const pruneEmpty = (d) => {
    let cur = path.resolve(d);
    const stop = path.resolve(bdir);
    while (cur.startsWith(stop + path.sep)) {
      try {
        fs.rmdirSync(cur);
      } catch {
        return;
      }
      cur = path.dirname(cur);
    }
  };
  if (isDir) {
    const fromDir = path.join(bdir, ...oldRel.split('/'));
    if (!fs.existsSync(fromDir)) return;
    const toDir = path.join(bdir, ...newRel.split('/'));
    fs.mkdirSync(toDir, { recursive: true });
    const walk = (src, dst) => {
      for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, ent.name);
        const d = path.join(dst, ent.name);
        if (ent.isDirectory()) {
          fs.mkdirSync(d, { recursive: true });
          walk(s, d);
          pruneEmpty(s);
        } else if (!fs.existsSync(d)) {
          fs.renameSync(s, d);
        }
      }
    };
    walk(fromDir, toDir);
    pruneEmpty(fromDir);
    return;
  }
  const oldDirRel = path.posix.dirname(oldRel) === '.' ? '' : path.posix.dirname(oldRel);
  const newDirRel = path.posix.dirname(newRel) === '.' ? '' : path.posix.dirname(newRel);
  const oldBdir = path.join(bdir, ...oldDirRel.split('/').filter(Boolean));
  if (!fs.existsSync(oldBdir)) return;
  const oldBase = path.posix.basename(oldRel);
  const newBase = path.posix.basename(newRel);
  let movedAny = false;
  for (const f of fs.readdirSync(oldBdir)) {
    if (!f.startsWith(oldBase + '.') || !f.endsWith('.bak')) continue;
    const suffix = f.slice(oldBase.length); // .<时间戳>.bak
    const targetDir = path.join(bdir, ...newDirRel.split('/').filter(Boolean));
    const target = path.join(targetDir, newBase + suffix);
    if (fs.existsSync(target)) continue; // 冲突：跳过
    fs.mkdirSync(targetDir, { recursive: true });
    fs.renameSync(path.join(oldBdir, f), target);
    movedAny = true;
  }
  if (movedAny) pruneEmpty(oldBdir);
}

app.post('/api/file/rename', async (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const b = req.body || {};
  if (!checkDsId(lib, b, res)) return;
  try {
    const entry = loadEntry(lib, b.path);
    const oldName = path.posix.basename(entry.rel);
    let newName = validateEntryName(b.newName);
    if (!entry.isDir) {
      const ext = path.extname(oldName);
      if (ext && !newName.toLowerCase().endsWith(ext.toLowerCase())) newName = validateEntryName(newName + ext);
    }
    if (isSidecar(newName)) throw badRequest('名称不能以 .meta.json 结尾', { invalidName: true });
    const dir = path.posix.dirname(entry.rel);
    const newRel = dir === '.' ? newName : dir + '/' + newName;
    const moved = relocate(lib, entry, newRel);
    let titleUpdated = false;
    if (moved.newMeta) {
      // 旧标题等于旧文件名主体时，标题随新名称更新；id 永不改变
      try {
        const raw = fs.readFileSync(moved.newMeta, 'utf8');
        const meta = JSON.parse(raw);
        if (meta && typeof meta === 'object' && meta.title === stemOf(oldName)) {
          meta.title = stemOf(newName);
          await writeTextAtomic(moved.newMeta, JSON.stringify(meta, null, 2) + '\n', false);
          titleUpdated = true;
        }
      } catch (e) {
        if (!(e instanceof SyntaxError)) {
          renameAll([...moved.steps].reverse().map(([f, t]) => [t, f]));
          throw e;
        }
        // 旁注不是合法 JSON：保持原样，不修改
      }
    }
    try {
      moveBackups(lib.id, entry.rel, newRel, entry.isDir);
    } catch (be) {
      console.error('备份随迁失败:', be.message);
    }
    lib.linkIndex.notifyRename(entry.rel, newRel, entry.isDir); // 忽略记录随行
    await lib.rescanAndIndex();
    res.json({ ok: true, kind: entry.isDir ? 'folder' : 'file', oldPath: entry.rel, path: newRel, sidecar: !!moved.newMeta, titleUpdated });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, ...(e.extra || {}) });
  }
});

app.post('/api/file/move', async (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const b = req.body || {};
  if (!checkDsId(lib, b, res)) return;
  try {
    const entry = loadEntry(lib, b.path);
    const targetDir = validateRelDir(b.targetDir);
    if (targetDir.split('/')[0] === TRASH_DIR) throw badRequest('不能移动到回收站，请使用删除');
    if (entry.isDir && (targetDir === entry.rel || targetDir.startsWith(entry.rel + '/'))) {
      throw badRequest('不能把文件夹移动到它自身或其子文件夹中');
    }
    const dirAbs = resolveWithin(lib, targetDir);
    let st;
    try { st = fs.statSync(dirAbs); } catch { return res.status(404).json({ error: '目标目录不存在: ' + (targetDir || '/') }); }
    if (!st.isDirectory()) throw badRequest('目标不是目录');
    const name = path.posix.basename(entry.rel);
    const newRel = targetDir ? targetDir + '/' + name : name;
    const moved = relocate(lib, entry, newRel);
    try {
      moveBackups(lib.id, entry.rel, newRel, entry.isDir);
    } catch (be) {
      console.error('备份随迁失败:', be.message);
    }
    lib.linkIndex.notifyRename(entry.rel, newRel, entry.isDir); // 忽略记录随行
    await lib.rescanAndIndex();
    res.json({ ok: true, kind: entry.isDir ? 'folder' : 'file', oldPath: entry.rel, path: newRel, sidecar: !!moved.newMeta });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, ...(e.extra || {}) });
  }
});

function trashStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

// 删除 = 移入回收站：先原子移入 .trash/<时间戳>__<名称>/（含旁注与来源说明），
// 若宿主注册了系统回收站，再把该批次目录交给系统回收站；失败则保留在 .trash/。
app.post('/api/file/delete', async (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const b = req.body || {};
  if (!checkDsId(lib, b, res)) return;
  try {
    const entry = loadEntry(lib, b.path);
    const name = path.posix.basename(entry.rel);
    const trashRoot = path.join(lib.scanner.baseDir, TRASH_DIR);
    fs.mkdirSync(trashRoot, { recursive: true });
    let batchName = trashStamp() + '__' + name;
    for (let i = 2; pathTaken(path.join(trashRoot, batchName)); i++) batchName = trashStamp() + '-' + i + '__' + name;
    const batchAbs = path.join(trashRoot, batchName);
    fs.mkdirSync(batchAbs);
    const steps = [[entry.abs, path.join(batchAbs, name)]];
    if (entry.metaAbs) steps.push([entry.metaAbs, path.join(batchAbs, name + SIDECAR_SUFFIX)]);
    try {
      renameAll(steps);
    } catch (e) {
      try { fs.rmdirSync(batchAbs); } catch { /* ignore */ }
      throw e;
    }
    try {
      fs.writeFileSync(path.join(batchAbs, '.trashinfo.json'), JSON.stringify({
        originalPath: entry.rel, kind: entry.isDir ? 'folder' : 'file', sidecar: !!entry.metaAbs, deletedAt: new Date().toISOString(),
      }, null, 2) + '\n');
    } catch { /* 说明文件失败不影响删除 */ }
    let trashedTo = 'local';
    const osTrash = getTrashHandler();
    if (osTrash) {
      try { await osTrash(batchAbs); trashedTo = 'os'; } catch (e) { console.error('系统回收站失败，保留在 .trash/:', e.message); }
    }
    await lib.rescanAndIndex();
    res.json({
      ok: true, kind: entry.isDir ? 'folder' : 'file', path: entry.rel, sidecar: !!entry.metaAbs, trashedTo,
      trashPath: trashedTo === 'local' ? TRASH_DIR + '/' + batchName : null,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, ...(e.extra || {}) });
  }
});

// ---------- 元数据旁注问题报告（只报告，不自动修复） ----------

const metaIssueCache = new WeakMap(); // snapshot -> issues

function computeMetaIssues(lib, snapshot) {
  if (metaIssueCache.has(snapshot)) return metaIssueCache.get(snapshot);
  const issues = [];
  const sidecarSet = new Set(snapshot.sidecars || []);
  const byId = new Map();
  for (const sc of snapshot.sidecars || []) {
    const target = sc.slice(0, sc.length - SIDECAR_SUFFIX.length);
    let id = null;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(lib.scanner.baseDir, sc), 'utf8'));
      if (meta && typeof meta.id === 'string') id = meta.id;
    } catch {
      issues.push({ kind: 'invalid', sidecar: sc, target, message: '元数据文件不是合法 JSON' });
    }
    if (id) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(sc);
    }
    if (!pathTaken(path.join(lib.scanner.baseDir, target))) {
      // 同名文档在别处且自身没有旁注：很可能是在应用外被移动/重命名
      const targetName = path.posix.basename(target);
      const candidates = snapshot.files
        .filter((f) => f.name === targetName && !sidecarSet.has(f.path + SIDECAR_SUFFIX))
        .map((f) => f.path);
      issues.push(candidates.length
        ? { kind: 'moved', sidecar: sc, target, id, candidates, message: '文档疑似在应用外被移动，元数据仍在原处' }
        : { kind: 'orphan', sidecar: sc, target, id, message: '元数据对应的文档不存在' });
    }
  }
  for (const [id, list] of byId) {
    if (list.length > 1) issues.push({ kind: 'duplicateId', id, sidecars: list, message: '多个元数据文件使用了相同 id' });
  }
  metaIssueCache.set(snapshot, issues);
  return issues;
}

app.get('/api/meta/issues', (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const issues = computeMetaIssues(lib, lib.scanner.snapshot);
  res.json({ dsId: lib.id, scannedAt: lib.scanner.snapshot.scannedAt, total: issues.length, issues });
});

// ---------- AI 元数据导入（JSONL → 旁注） ----------

// 导入行 path 校验：拒绝反斜杠/绝对路径/../盘符，且必须与规范化相对路径完全一致，再限制在数据源内
function resolveDocPathFor(lib, raw) {
  const s = String(raw);
  if (s.includes('\\')) throw badRequest('path 越界');
  const rel = validateRelDir(s);
  if (rel !== s) throw badRequest('path 越界'); // . 段、空段、被规范化们一律拒绝
  return resolveWithin(lib, rel);
}

// body: { dsId, jsonl: string, mode: 'preview'|'apply', overwrite?: boolean }
// 逐行解析校验并给出计划；apply 时重新计算同一计划后写入（只写旁注，绝不改文档），完成后重扫重建索引
app.post('/api/meta/import', async (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const b = req.body || {};
  if (!checkDsId(lib, b, res)) return;
  const mode = b.mode ?? 'preview';
  if (!['preview', 'apply'].includes(mode)) return res.status(400).json({ error: 'mode 必须是 preview 或 apply' });
  if (typeof b.jsonl !== 'string') return res.status(400).json({ error: 'jsonl 必须是字符串' });
  const nonEmpty = b.jsonl.split(/\r?\n/).filter((l) => l.trim()).length;
  if (nonEmpty > 20000) return res.status(400).json({ error: '非空行数超过上限 20000' });
  try {
    const args = { baseDir: lib.scanner.baseDir, text: b.jsonl, overwrite: b.overwrite === true, resolveDocPath: (raw) => resolveDocPathFor(lib, raw) };
    const { summary, items, errors } = mode === 'apply' ? applyImport(args) : planImport(args);
    if (mode === 'apply') await lib.rescanAndIndex();
    res.json({ dsId: lib.id, mode, overwrite: b.overwrite === true, summary, items, errors });
  } catch (e) {
    res.status(e.status || 500).json({ error: '导入失败: ' + e.message });
  }
});

// ---------- 检索与引用 ----------

app.get('/api/search', (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const q = String(req.query.q || '');
  const types = req.query.types ? String(req.query.types).split(',') : null;
  const dir = String(req.query.dir || '');
  const excludeDirs = req.query.exclude ? String(req.query.exclude).split(',') : [];
  res.json({ dsId: lib.id, ...lib.indexer.search(q, { types, dir, excludeDirs }) });
});

app.get('/api/refs/resolve', (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const name = String(req.query.name || '');
  const collection = req.query.collection ? String(req.query.collection) : null;
  let dirs = null;
  if (collection) {
    const cols = getState(lib.id, 'collections', []);
    const col = cols.find((c) => c.name === collection);
    if (col) dirs = col.dirs;
  }
  res.json({ dsId: lib.id, ...lib.indexer.resolveRef(name, dirs) });
});

// 供前端做正文自动链接的文件名清单（完整名与主体名）
app.get('/api/refs/names', (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const names = lib.indexer.files.map((f) => ({
    name: f.name, base: f.base, path: f.path, ext: f.ext, dir: f.dir,
  }));
  const cols = getState(lib.id, 'collections', []);
  res.json({ dsId: lib.id, names, collections: cols });
});

app.get('/api/backlinks', (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const f = findFile(lib, String(req.query.path || ''));
  if (!f) return res.status(404).json({ error: '文件不存在' });
  // 由自动内链索引支撑（旧版为文本包含扫描）：返回提及该文档的文件清单，形状兼容
  const backlinks = lib.linkIndex.backlinksOf(f.path)
    .map((b) => findFile(lib, b.path))
    .filter(Boolean);
  res.json({ dsId: lib.id, backlinks });
});

// ---------- 自动内链（词条）与反向链接 ----------

app.get('/api/links/doc', (req, res) => {
  const lib = resolveLib(req);
  if (!lib) return res.status(409).json({ error: '尚未打开资料库' });
  const p = String(req.query.path || '');
  res.json({ dsId: lib.id, path: p, ...lib.linkIndex.status(), links: lib.linkIndex.linksOf(p) });
});

app.get('/api/links/backlinks', (req, res) => {
  const lib = resolveLib(req);
  if (!lib) return res.status(409).json({ error: '尚未打开资料库' });
  const p = String(req.query.path || '');
  res.json({ dsId: lib.id, path: p, ...lib.linkIndex.status(), backlinks: lib.linkIndex.backlinksOf(p) });
});

// 全库被引用计数：path -> 引用它的文档数（引用徽标用，一次请求返回全部）
app.get('/api/links/counts', (req, res) => {
  const lib = resolveLib(req);
  if (!lib) return res.status(409).json({ error: '尚未打开资料库' });
  const counts = {};
  for (const [target, srcs] of lib.linkIndex.backlinks) {
    if (srcs.size) counts[target] = srcs.size;
  }
  res.json({ dsId: lib.id, counts });
});

app.get('/api/links/terms', (req, res) => {
  const lib = resolveLib(req);
  if (!lib) return res.status(409).json({ error: '尚未打开资料库' });
  res.json({ dsId: lib.id, ...lib.linkIndex.status(), terms: lib.linkIndex.terms(String(req.query.q || '')) });
});

app.get('/api/links/preview', (req, res) => {
  const lib = resolveLib(req);
  if (!lib) return res.status(409).json({ error: '尚未打开资料库' });
  const p = String(req.query.path || '');
  const v = lib.linkIndex.previewOf(p);
  if (!v) return res.status(404).json({ error: '文档不在链接索引中' });
  res.json(v);
});

app.get('/api/links/status', (req, res) => {
  const lib = resolveLib(req);
  if (!lib) return res.json({ ready: false, building: false });
  res.json({ dsId: lib.id, ...lib.linkIndex.status() });
});

// 忽略某条自动链接（本篇）：存于应用数据目录的按数据源状态，不写入语料文件
app.post('/api/links/ignore', async (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const b = req.body || {};
  try {
    if (b.clearAll) {
      lib.linkIndex.clearIgnores();
      await lib.linkIndex.rebuild(lib.scanner.snapshot, indexer);
      return res.json({ ok: true, ignoredCount: 0 });
    }
    const p = String(b.path || '');
    if (!findFile(lib, p)) return res.status(404).json({ error: '文件不存在' });
    const ignore = b.ignore !== false;
    const ignoredCount = lib.linkIndex.setIgnore(p, String(b.term || ''), String(b.targetPath || ''), ignore);
    res.json({ ok: true, ignored: ignore, ignoredCount });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 屏蔽词表：命中的词条不自动链接（wikilink 仍可手动使用）
app.get('/api/links/blocklist', (req, res) => {
  const lib = resolveLib(req);
  if (!lib) return res.status(409).json({ error: '尚未打开资料库' });
  res.json({ dsId: lib.id, terms: lib.linkIndex.blocklist(), ignoredCount: lib.linkIndex.ignoredCount() });
});

app.put('/api/links/blocklist', async (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const terms = Array.isArray(req.body?.terms) ? req.body.terms.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()) : null;
  if (!terms) return res.status(400).json({ error: 'terms 必须是字符串数组' });
  lib.linkIndex.saveBlocklist(terms);
  await lib.rescanAndIndex(); // 词表变化 → 全量重算链接（仅用内存文本）
  res.json({ ok: true, terms, ignoredCount: lib.linkIndex.ignoredCount() });
});

// ---------- 最近记录 / 常用入口 / 集合 / 元数据映射 ----------

app.post('/api/recents', (req, res) => {
  const lib = resolveLib(req);
  if (!lib) return res.status(409).json({ error: '尚未打开资料库' });
  const { path: rel } = req.body || {};
  let recents = getState(lib.id, 'recents', []);
  recents = [{ path: rel, at: Date.now() }, ...recents.filter((r) => r.path !== rel)].slice(0, 30);
  setState(lib.id, 'recents', recents);
  res.json({ ok: true });
});

app.get('/api/recents', (req, res) => {
  const lib = resolveLib(req);
  if (!lib) return res.json({ recents: [] });
  const recents = getState(lib.id, 'recents', []);
  const alive = lib.scanner.snapshot
    ? recents.map((r) => ({ ...r, exists: !!findFile(lib, r.path), file: findFile(lib, r.path) || null }))
    : recents;
  res.json({ dsId: lib.id, recents: alive });
});

app.get('/api/pins', (req, res) => {
  const lib = resolveLib(req);
  if (!lib) return res.json({ pins: [] });
  const pins = getState(lib.id, 'pins', []);
  const alive = lib.scanner.snapshot
    ? pins.map((p) => ({ ...p, exists: !!findFile(lib, p.path) }))
    : pins;
  res.json({ dsId: lib.id, pins: alive });
});

app.post('/api/pins', (req, res) => {
  const lib = resolveLib(req);
  if (!lib) return res.status(409).json({ error: '尚未打开资料库' });
  const { path: rel, action } = req.body || {};
  let pins = getState(lib.id, 'pins', []);
  if (action === 'remove') pins = pins.filter((p) => p.path !== rel);
  else if (!pins.some((p) => p.path === rel)) pins.push({ path: rel, at: Date.now() });
  setState(lib.id, 'pins', pins);
  res.json({ ok: true, pins });
});

app.get('/api/collections', (req, res) => {
  const lib = resolveLib(req);
  if (!lib) return res.json({ collections: [] });
  const cols = getState(lib.id, 'collections', []);
  // 标记目录是否仍存在
  const dirs = new Set((lib.scanner.snapshot?.files || []).map((f) => f.dir));
  const withStatus = cols.map((c) => ({
    ...c,
    validDirs: c.dirs.filter((d) => dirs.has(d) || d === ''),
    missingDirs: c.dirs.filter((d) => !dirs.has(d) && d !== ''),
  }));
  res.json({ dsId: lib.id, collections: withStatus });
});

app.put('/api/collections', (req, res) => {
  const lib = resolveLib(req);
  if (!lib) return res.status(409).json({ error: '尚未打开资料库' });
  const cols = Array.isArray(req.body?.collections) ? req.body.collections : [];
  setState(lib.id, 'collections', cols);
  res.json({ ok: true });
});

app.get('/api/metadata', (req, res) => {
  const lib = resolveLib(req);
  if (!lib) return res.json({ mappings: [] });
  res.json({ dsId: lib.id, mappings: getState(lib.id, 'metadata', []) });
});

app.put('/api/metadata', (req, res) => {
  const lib = resolveLib(req);
  if (!lib) return res.status(409).json({ error: '尚未打开资料库' });
  setState(lib.id, 'metadata', Array.isArray(req.body?.mappings) ? req.body.mappings : []);
  res.json({ ok: true });
});

// 预览某个 JSON 文件的结构，辅助配置映射
app.get('/api/metadata/inspect', (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  try {
    const abs = resolveWithin(lib, String(req.query.path || ''));
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
  const lib = requireLib(res, req);
  if (!lib) return;
  const mappings = getState(lib.id, 'metadata', []);
  const topicCount = new Map();
  const conceptCount = new Map();
  const errors = [];
  for (const m of mappings) {
    try {
      const abs = resolveWithin(lib, m.file);
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
    dsId: lib.id,
    configured: mappings.length > 0,
    topics: [...topicCount.values()].sort((a, b) => b.count - a.count),
    concepts: [...conceptCount.values()].sort((a, b) => b.count - a.count),
    errors,
  });
});

app.get('/api/word-capability', async (req, res) => {
  res.json(await wordCapability());
});

// ---------- 前端静态资源（仅在设置 WORKBENCH_STATIC_DIR 时启用） ----------

// index.html 不交由 express.static 直接下发：注入持久化主题（data-theme / __WB_THEME__），
// 让首帧就用对配色；按 mtime 缓存源文件。
const INDEX_FILE = STATIC_DIR ? path.join(STATIC_DIR, 'index.html') : null;
let indexCache = { mtimeMs: -1, html: '' };

function themedIndexHtml() {
  const st = fs.statSync(INDEX_FILE);
  if (indexCache.mtimeMs !== st.mtimeMs) {
    indexCache = { mtimeMs: st.mtimeMs, html: fs.readFileSync(INDEX_FILE, 'utf8') };
  }
  const { theme } = getUiSettings();
  let html = indexCache.html;
  // <html> 开标签：注入 data-theme；C（夜读）追加 dark 类，供 tailwind dark: 变体使用
  html = html.replace(/<html([^>]*)>/, (_m, attrs) => {
    let a = /\sdata-theme=/.test(attrs) ? attrs : attrs + ` data-theme="${theme}"`;
    if (theme === 'C') {
      a = /(^|\s)class="[^"]*"/.test(a) ? a.replace(/class="([^"]*)"/, 'class="$1 dark"') : a + ' class="dark"';
    }
    return '<html' + a + '>';
  });
  // SPA 深链（如 /read/笔记/x.md）下，vite base './' 使 './assets/...' 被解析到路由前缀而落空。
  // 注入 <base href="/"> 兜底（仅当没有 <base> 时），让资源始终从根解析。
  if (!/<base\s/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + '\n    <base href="/">');
  // 服务端注入值优先于 localStorage；/*wb-theme*/ 是内联防闪烁脚本里的占位标记
  const boot = `window.__WB_THEME__=${JSON.stringify(theme)};`;
  if (html.includes('/*wb-theme*/')) html = html.replace('/*wb-theme*/', boot + '/*wb-theme*/');
  else html = html.replace('<script', `<script>${boot}</script><script`);
  return html;
}

if (STATIC_DIR && fs.existsSync(INDEX_FILE)) {
  app.use(express.static(STATIC_DIR, { index: false })); // 资源照常下发，但 index.html 走注入
  // 看似静态资源的路径（末段带静态扩展名）不做 SPA 回退：缺失时直接 404，避免把 HTML 当脚本/样式加载
  const STATIC_EXT = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf)$/i;
  const serveIndex = (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(themedIndexHtml());
  };
  app.get('/', serveIndex);
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    const lastSeg = req.path.split('/').pop() || '';
    if (STATIC_EXT.test(path.posix.extname(lastSeg))) return res.status(404).end();
    serveIndex(req, res); // SPA 路由回退
  });
}

// ---------- 启动 ----------

async function boot() {
  const { libraries, activeId: savedActive } = listLibs();
  // 各库并行恢复（扫描互相独立，串行会人为拉长多库启动时间）
  await Promise.all(libraries.map(async (meta) => {
    const lib = new Lib(meta);
    libs.set(lib.id, lib);
    try {
      fs.accessSync(lib.baseDir, fs.constants.R_OK);
      await lib.start();
      console.log('已恢复资料库:', lib.baseDir);
    } catch (e) {
      // 目录不可达：保留在列表中可移除，但不扫描不监听
      lib.scanner.setBaseDir(lib.baseDir);
      lib.indexer.reset(lib.id, lib.baseDir);
      lib.linkIndex.reset(lib.id, lib.baseDir);
      console.error('[' + lib.name + '] 目录不可访问:', e.message);
    }
  }));
  activeId = libs.has(savedActive) ? savedActive : (libraries[0]?.id ?? null);
  if (activeId) setActiveLibInStore(activeId);
  app.listen(PORT, HOST, () => console.log('语料工作台后端已启动: http://localhost:' + PORT));
}

boot();
