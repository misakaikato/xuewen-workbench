// 主服务：Express API。语料配置、扫描状态、目录树、文件读写（原子写+备份+冲突检测）、
// 检索、引用解析、集合与元数据映射、最近记录与常用入口、Word 能力诊断。
import './logInit.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { listLibs, upsertLib, removeLib as removeLibFromStore, setActiveLib as setActiveLibInStore, getState, setState, backupDir, getUiSettings, saveUiSettings, dataDir, renameWithRetry, cacheDir } from './store.js';
import { isWithin } from './paths.js';
import { caseRenameAction } from './renamePlan.js';
import { Scanner, SUPPORTED_EXTS, SIDECAR_SUFFIX, TRASH_DIR, isSidecar } from './scanner.js';
import { hostOpenPath, revealInFolder } from './hostOpen.js';
import { logsDir, createLogWriter } from './logger.js';
import { pendingIncident, ackIncidents, readIncidents, exportDiagnostics } from './diagnostics.js';
import { planImport, applyImport, contentHash } from './meta.js';
import { getTrashHandler } from './trash.js';
import { mountUpdateRoutes, getUpdateBridge, disabledUpdateState } from './update.js';
import { installHostBridges, postBoot, postReady, hosted, rpc } from './host.js';
import { RagManager } from './rag/manager.js';
import { mountRag } from './rag/routes.js';
import { AgentHub } from './agent/manager.js';
import { mountAgent } from './agent/routes.js';
import { Indexer } from './indexer.js';
import { parseWord, wordCapability } from './word.js';
import { LinkIndex } from './links.js';
import { loadDerived, loadTopics, DERIVED_DIR } from './derived.js';
import { decodeText, encodingLabel } from './textDecode.js';

const PORT = process.env.WORKBENCH_PORT || 7410;
const HOST = process.env.WORKBENCH_HOST || '127.0.0.1'; // 默认只监听本机，局域网访问需显式设 WORKBENCH_HOST=0.0.0.0
const STATIC_DIR = process.env.WORKBENCH_STATIC_DIR || null; // 设置后托管已构建的前端（Electron 用）
const PROC_START = Date.now();
const app = express();
app.use(express.json({ limit: '20mb' }));

// Host / Origin 校验：本机接口只接受白名单主机名，防 DNS rebinding 与跨站请求。
// 无 Origin 的请求（本机 curl / 进程）放行；带 Origin 的必须指向白名单主机。
function hostnameOf(header) {
  try { return new URL(header).hostname; } catch { /* 非完整 URL（Host 头） */ }
  try { return new URL('http://' + header).hostname; } catch { return ''; }
}
const HOST_ALLOW = new Set(['127.0.0.1', 'localhost', '[::1]']);
if (HOST && !HOST_ALLOW.has(HOST)) HOST_ALLOW.add(HOST);
const hostWarnAt = new Map(); // 来源 -> 上次 WARN 时间戳（1 分钟内只记一次）
function warnOnce(kind, req) {
  const key = kind + ':' + (req.headers.host || '') + ':' + (req.headers.origin ?? '');
  const now = Date.now();
  if (now - (hostWarnAt.get(key) || 0) < 60000) return;
  hostWarnAt.set(key, now);
  console.warn('[http] ' + kind + ' ' + req.method + ' ' + req.path + ' host=' + (req.headers.host || '') + ' origin=' + (req.headers.origin ?? ''));
}
app.use((req, res, next) => {
  if (!HOST_ALLOW.has(hostnameOf(req.headers.host || ''))) {
    warnOnce('forbidden-host', req);
    return res.status(403).json({ error: 'forbidden-host' });
  }
  if (req.headers.origin !== undefined) {
    const origin = req.headers.origin;
    if (origin === 'null' || !HOST_ALLOW.has(hostnameOf(origin))) {
      warnOnce('forbidden-origin', req);
      return res.status(403).json({ error: 'forbidden-origin' });
    }
  }
  next();
});

// 慢请求 / 5xx 日志：响应状态 ≥ 500 或耗时 ≥ 3000ms 记一条；SSE 与模型下载只按状态记（不计耗时）
const SLOW_SKIP = ['/api/agent/chat', '/api/rag/model/download'];
app.use((req, res, next) => {
  const t0 = Date.now();
  const skipSlow = SLOW_SKIP.includes(req.path);
  res.on('finish', () => {
    const ms = Date.now() - t0;
    const status = res.statusCode;
    if (status >= 500 || (!skipSlow && ms >= 3000)) {
      console.warn('[http] ' + req.method + ' ' + req.path + ' ' + status + ' ' + ms + 'ms');
    }
  });
  next();
});

// 界面日志上报写入 renderer.log（tag: renderer）
const rendererLog = createLogWriter({ dir: logsDir(dataDir()), name: 'renderer' });

// ---------- 资料库运行时（多库并行：各自 scanner/indexer/链接索引） ----------

class Lib {
  constructor(meta) {
    this.id = meta.id;
    this.name = meta.name;
    this.baseDir = meta.baseDir;
    this.scanner = new Scanner();
    // 文件树是否显示元数据/派生文件（.annotations.json 等），来自全局界面设置
    this.scanner.showMetaFiles = !!getUiSettings().showMetaFiles;
    this.indexer = new Indexer();
    this.linkIndex = new LinkIndex();
    this.indexing = Promise.resolve(); // 最近一次索引构建，供需要“立即可检索”的写操作等待
    // 索引进度（经 /api/status 下发）：phase 为 text/links/null，结束后回到 null，失败另记 indexError。
    // 连续重扫会开新链：旧链的进度/复位都带链守卫，不覆盖新链的状态（指示不闪烁）
    this.indexState = { phase: null, done: 0, total: 0, startedAt: null };
    this.indexError = null;
    this.scanner.on('scan-done', (snapshot) => this._beginIndexing(snapshot));
  }

  // 扫描完成后串行建文本索引与内链索引；进度写入 indexState（带链守卫，旧链不覆盖新链）
  _beginIndexing(snapshot) {
    let run;
    run = (async () => {
      const total = snapshot.files.length;
      const startedAt = Date.now();
      const isCurrent = () => this.indexing === run;
      this.indexError = null;
      this.indexState = { phase: 'text', done: 0, total, startedAt };
      try {
        await this.indexer.build(snapshot, (done) => {
          if (isCurrent()) this.indexState = { phase: 'text', done, total, startedAt };
        });
        if (isCurrent()) this.indexState = { phase: 'links', done: 0, total, startedAt };
        await this.linkIndex.rebuild(snapshot, this.indexer, (done) => {
          if (isCurrent()) this.indexState = { phase: 'links', done, total, startedAt };
        }); // 自动内链索引随文本索引之后增量更新
      } catch (e) {
        if (isCurrent()) this.indexError = String(e?.message || e);
        console.error(`[${this.name}] 索引构建失败:`, e.message);
      } finally {
        if (isCurrent()) this.indexState = { phase: null, done: 0, total: 0, startedAt: null };
      }
      // 已有 RAG 索引的库自动增量（从未建过的不自动）
      ragManager.onScanComplete(this.id);
    })();
    this.indexing = run;
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
  addOrActivateLibrary: (baseDir) => addOrActivateLibrary(baseDir),
  removeLibrary: (dsId) => (dsId ? removeLibraryById(dsId) : { ok: false, error: '需要 dsId' }),
});
ragManager.onLlmChanged = () => agentHub._syncModelsJson();
// 总开关 ui-settings.agentEnabled：关闭时不做模型探测等外部初始化，路由拒绝生成与写操作（409）
agentHub.setEnabled(getUiSettings().agentEnabled);
app.use('/api/agent', mountAgent(agentHub, resolveLib, { isEnabled: () => getUiSettings().agentEnabled }));
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
  if (!isWithin(abs, baseNorm)) {
    throw Object.assign(new Error('路径越界'), { status: 403 });
  }
  try {
    const realBase = fs.realpathSync(baseNorm);
    // 目标存在则校验目标 realpath；不存在则向上找最近存在的祖先目录校验，
    // 防止「库内符号链接目录 + 新建文件」把文件写进库外。
    let probe = abs;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const real = fs.realpathSync(probe);
    if (!isWithin(real, realBase)) {
      throw Object.assign(new Error('符号链接指向数据源之外'), { status: 403 });
    }
  } catch (e) {
    if (e.status) throw e;
    // 库根可能暂不可达（扫描失败场景），此时仅做静态前缀校验
  }
  return abs;
}

function findFile(lib, rel) {
  const snap = lib.scanner.snapshot;
  return snap.files.find((f) => f.path === rel) || snap.derivedFiles?.find((f) => f.path === rel) || null;
}

function readTextPreserve(abs) {
  return decodeText(fs.readFileSync(abs));
}

async function writeTextAtomic(abs, content, bom) {
  const tmp = abs + '.wb-tmp-' + process.pid;
  fs.writeFileSync(tmp, (bom ? '﻿' : '') + content, 'utf8');
  try {
    renameWithRetry(tmp, abs);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    throw e;
  }
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
// 添加或激活资料库（路由与 agent 设置工具共用）
async function addOrActivateLibrary(baseDir) {
  const raw = String(baseDir || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return { ok: false, error: '缺少资料库目录' };
  const p = path.normalize(raw);
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) throw new Error('不是目录');
    fs.accessSync(p, fs.constants.R_OK);
  } catch (e) {
    return { ok: false, error: '目录不可访问: ' + e.message };
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
  } else {
    const runtime = libs.get(lib.id);
    // 启动时不可达、目录已恢复：重新扫描并开监听（此时目录可访问性已在上方校验过）
    if (!runtime.scanner.snapshot) {
      try {
        await runtime.start();
      } catch (e) {
        console.error('[' + lib.name + '] 恢复扫描失败:', e.message);
      }
    }
    if (activeId !== lib.id) {
      activeId = lib.id;
      libVersion++;
      agentHub.onLibSwitch();
    }
  }
  return { ok: true, dsId: lib.id, name: lib.name, baseDir: lib.baseDir };
}

// 从工作区移除资料库（不删磁盘文件）
function removeLibraryById(dsId) {
  const lib = libs.get(dsId);
  if (!lib) return { ok: false, error: '资料库未打开' };
  try { lib.stop(); } catch { /* ignore */ }
  libs.delete(dsId);
  ragManager.remove(dsId);
  const { activeId: nextActive } = removeLibFromStore(dsId);
  if (activeId === dsId) activeId = nextActive;
  libVersion++;
  agentHub.onLibSwitch();
  return { ok: true, activeId };
}

app.post('/api/config', async (req, res) => {
  const r = await addOrActivateLibrary(req.body?.baseDir);
  if (!r.ok) return res.status(400).json({ error: r.error });
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
  const r = removeLibraryById(id);
  if (!r.ok) return res.status(404).json({ error: r.error });
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
  let lib = null;
  try {
    lib = resolveLib(req);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  if (!lib) return res.status(409).json({ error: '尚未打开资料库' });
  // 启动时不可达（无快照）的库：目录已恢复则 start（扫描 + 开监听）；仍不可达返回 409
  if (!lib.scanner.snapshot) {
    try {
      fs.accessSync(lib.baseDir, fs.constants.R_OK);
      await lib.start();
    } catch (e) {
      return res.status(409).json({ error: '目录不可访问或扫描失败: ' + e.message });
    }
    return res.json({ ok: true, status: lib.scanner.status() });
  }
  // 用户点「重新扫描」= 期望彻底重建：先让链接索引失效，别按签名/mtime 复用旧结果
  try { lib.linkIndex.invalidate(); } catch { /* 索引未初始化 */ }
  await lib.scanner.rescan();
  res.json({ ok: true, status: lib.scanner.status() });
});

// ---------- 应用更新（桥接由 Electron 主进程注入；无桥接时停用） ----------

installHostBridges();
mountUpdateRoutes(app);

// ---------- 界面设置（外观主题；不依赖数据源，未配置时也可用） ----------

app.get('/api/ui-settings', (req, res) => {
  res.json(getUiSettings());
});

app.put('/api/ui-settings', async (req, res) => {
  const { theme, autoUpdate, notesDir, showMetaFiles, agentEnabled } = req.body || {};
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
  if (agentEnabled !== undefined) {
    if (typeof agentEnabled !== 'boolean') {
      return res.status(400).json({ error: 'agentEnabled 必须是布尔值' });
    }
    patch.agentEnabled = agentEnabled;
  }
  if (showMetaFiles !== undefined) {
    patch.showMetaFiles = !!showMetaFiles;
  }
  if (notesDir !== undefined) {
    const dir = String(notesDir).trim();
    if (!dir || dir.includes('..') || /[\\/]/.test(dir)) {
      return res.status(400).json({ error: '阅读笔记目录必须是单层目录名' });
    }
    patch.notesDir = dir;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: '缺少可更新字段（theme / autoUpdate / notesDir / showMetaFiles / agentEnabled）' });
  }
  const next = saveUiSettings(patch);
  // 助手开关：先落盘（此后新的生成请求即被拒），关闭时再中止进行中的生成，中止完成才返回，
  // 前端据此先停生成、后隐藏入口；打开时按需做启动期推迟的初始化
  if (agentEnabled !== undefined) await agentHub.setEnabled(next.agentEnabled);
  // showMetaFiles 变化：同步到各库 scanner 并重扫，与其他写操作一样等到重扫与索引完成才返回，
  // 前端据此提示「已显示」；重扫失败如实返回（设置本身已保存）
  if (showMetaFiles !== undefined) {
    for (const lib of libs.values()) {
      lib.scanner.showMetaFiles = !!next.showMetaFiles;
    }
    try {
      await Promise.all([...libs.values()].map((l) => l.rescanAndIndex()));
    } catch (e) {
      return res.status(500).json({ error: '设置已保存，但重新扫描失败: ' + e.message });
    }
  }
  res.json({ ok: true, ...next });
});

app.get('/api/status', (req, res) => {
  const active = libs.get(activeId) || null;
  const libStatuses = {};
  for (const [id, l] of libs) {
    libStatuses[id] = {
      scanning: l.scanner.scanning,
      watching: !!l.scanner.watcher,
      scannedAt: l.scanner.snapshot?.scannedAt || null,
      scanned: l.scanner.scanned,
      indexing: l.indexState,
      indexError: l.indexError,
      linksReady: l.linkIndex.ready,
      linksSeq: l.linkIndex.buildSeq,
    };
  }
  const bridge = getUpdateBridge();
  res.json({
    dsId: activeId, ...(active ? active.scanner.status() : emptyStatus()),
    indexing: active ? active.indexState : { phase: null, done: 0, total: 0, startedAt: null },
    indexError: active ? active.indexError : null,
    linksReady: active ? active.linkIndex.ready : false,
    linksSeq: active ? active.linkIndex.buildSeq : 0,
    libs: libStatuses,
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
  const snap = lib.scanner.snapshot;
  // 派生数据文件（.derived/）仅在「显示元数据文件」开关打开时出现在树里；不进 files，不参与索引/检索
  const files = snap.derivedFiles?.length ? [...snap.files, ...snap.derivedFiles] : snap.files;
  res.json({ dsId: lib.id, tree: buildTree(files, snap.dirs) });
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
      html: files.filter((f) => f.ext === '.html' || f.ext === '.htm').length,
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
    if (ext === '.md' || ext === '.json' || ext === '.txt' || ext === '.html' || ext === '.htm' || ext === '.jsonl' || ext === '.graphml') {
      const { content, bom, encoding } = readTextPreserve(abs);
      const isDerived = ext === '.jsonl' || ext === '.graphml';
      const nonUtf8 = encoding !== 'utf-8';
      return res.json({
        dsId: lib.id, path: rel, name: f.name, ext,
        type: ext === '.md' ? 'markdown' : ext === '.json' ? 'json' : ext === '.html' || ext === '.htm' ? 'html' : 'text',
        content, bom, mtimeMs: f.mtimeMs, size: f.size,
        readonly: isDerived || nonUtf8,
        encoding,
        readonlyReason: nonUtf8 ? `此文件为 ${encodingLabel(encoding)} 编码，为避免损坏原文只读显示` : undefined,
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

// 轻量文件元信息（mtime/size）：阅读页监听重扫后据此判断当前文档是否被外部改动
app.get('/api/file/stat', (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const rel = String(req.query.path || '');
  const f = findFile(lib, rel);
  if (!f) return res.status(404).json({ error: '文件不在当前扫描结果中（可能已被移动或删除）', missing: true });
  res.json({ dsId: lib.id, path: rel, mtimeMs: f.mtimeMs, size: f.size });
});

// 在系统文件管理器中定位显示（Finder / 资源管理器 / xdg-open）；路径必须在当前资料库内且存在
// 用系统默认应用打开知识库外部路径（文档内越库根链接，前端已弹确认框）。
// 仅接受绝对路径；打开动作本身由宿主桥接（Electron shell.openPath）或平台 opener 执行。
// 可执行类扩展名：直接用系统默认应用打开可能运行代码，一律拒绝（大小写不敏感）
const EXECUTABLE_EXTS = new Set(['.exe', '.com', '.bat', '.cmd', '.msi', '.msp', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.scr', '.pif', '.lnk', '.hta', '.cpl', '.reg', '.jar', '.app', '.command', '.sh', '.pkg', '.dmg', '.scpt', '.workflow']);

app.post('/api/open-external', async (req, res) => {
  const p = String(req.body?.path || '');
  if (!p || p.includes('\0')) return res.status(400).json({ error: '非法路径' });
  if (!path.isAbsolute(p) && !/^[a-zA-Z]:[\/]/.test(p)) {
    return res.status(400).json({ error: '仅接受绝对路径' });
  }
  if (EXECUTABLE_EXTS.has(path.extname(p).toLowerCase()) || /\.app\/?$/i.test(p)) {
    return res.status(403).json({ error: '出于安全原因不直接打开可执行文件' });
  }
  try {
    await fs.promises.access(p);
  } catch {
    return res.status(404).json({ error: '路径不存在：' + p });
  }
  try {
    await hostOpenPath(p);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '打开失败: ' + e.message });
  }
});

app.post('/api/reveal', async (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const rel = String(req.body?.path || '');
  try {
    const abs = resolveWithin(lib, rel);
    try {
      fs.statSync(abs);
    } catch {
      return res.status(404).json({ error: '路径不存在（可能已被移动或删除）' });
    }
    await revealInFolder(abs);
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
  if (!['.md', '.json', '.txt', '.html', '.htm'].includes(ext)) {
    return res.status(400).json({ error: '该格式不支持直接写回，请使用另存副本' });
  }
  try {
    const abs = resolveWithin(lib, rel);
    const exists = fs.existsSync(abs);
    if (exists) {
      const cur = fs.statSync(abs);
      const existing = readTextPreserve(abs);
      if (existing.encoding !== 'utf-8') {
        return res.status(409).json({
          error: 'non-utf8',
          message: `此文件为 ${encodingLabel(existing.encoding)} 编码，为避免损坏原文不直接写回`,
        });
      }
      if (baseMtimeMs != null && Math.abs(cur.mtimeMs - baseMtimeMs) > 1) {
        return res.status(409).json({
          error: '文件已被外部修改', conflict: true, current: existing.content, currentMtimeMs: cur.mtimeMs,
        });
      }
      // 备份原文件
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bdir = path.join(backupDir(lib.id), path.dirname(rel));
      fs.mkdirSync(bdir, { recursive: true });
      fs.copyFileSync(abs, path.join(bdir, path.basename(rel) + '.' + stamp + '.bak'));
      const { bom } = existing;
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

// 阅读划线笔记：追加到知识库的笔记目录（默认「阅读笔记」），按源文档聚合成一个 md
app.post('/api/notes/append', async (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const { sourcePath, quote, note } = req.body || {};
  if (!String(sourcePath || '').trim()) return res.status(400).json({ error: '缺少 sourcePath' });
  if (!String(quote || '').trim() && !String(note || '').trim()) {
    return res.status(400).json({ error: '引用和笔记不能同时为空' });
  }
  const { notesDir } = getUiSettings();
  try {
    const source = String(sourcePath);
    const stem = path.posix.basename(source).replace(/\.(md|txt|json|docx?|html?)$/i, '') || '未命名';
    const rel = path.posix.join(notesDir, stem + '.md');
    const abs = resolveWithin(lib, rel);
    const first = !fs.existsSync(abs);
    if (!first) {
      const existing = readTextPreserve(abs);
      if (existing.encoding !== 'utf-8') {
        return res.status(409).json({ error: 'non-utf8', message: `笔记文件为 ${encodingLabel(existing.encoding)} 编码，为避免损坏原文不追加` });
      }
    }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const body = String(note || '').trim();
    const quoted = String(quote || '').trim().split(/\r?\n/).map((line) => '> ' + line).join('\n');
    // 锚点：标题文本即锚点（阅读页按标题文本定位），加短随机后缀避免同分钟冲突
    const annAbsForAnchor = path.join(path.dirname(abs), `.${path.basename(abs, '.md')}.annotations.json`);
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(annAbsForAnchor, 'utf8')); } catch { existing = []; }
    const anchor = `${stamp} · ${String(existing.length + 1)}`;
    const block = [first ? `# ${stem} 阅读笔记\n` : '', `## ${anchor}`, quoted, body ? `\n${body}` : '', `\n来源：[${source}](${encodeURI(source)})\n`, ''].filter(Boolean).join('\n');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, (first ? '' : '\n---\n\n') + block, 'utf8');
    // 笔记元数据：标准旁注（仅 schema 允许字段）+ 逐条划线记录（独立 annotations 文件，避免污染 meta schema）
    const metaAbs = abs + SIDECAR_SUFFIX;
    if (!fs.existsSync(metaAbs)) {
      const meta = { id: 'doc_' + crypto.randomUUID(), title: `${stem} 阅读笔记` };
      fs.writeFileSync(metaAbs, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    }
    const annAbs = path.join(path.dirname(abs), `.${path.basename(abs, '.md')}.annotations.json`);
    let ann = [];
    try { ann = JSON.parse(fs.readFileSync(annAbs, 'utf8')); } catch { /* 首次写入 */ }
    if (!Array.isArray(ann)) ann = [];
    ann.push({ at: now.toISOString(), source, quote: String(quote || '').trim(), note: body, anchor });
    fs.writeFileSync(annAbs, JSON.stringify(ann, null, 2) + '\n', 'utf8');
    await lib.scanner.rescan();
    res.json({ ok: true, path: rel, meta: rel + SIDECAR_SUFFIX, annotations: ann.length });
  } catch (e) {
    res.status(e.status || 500).json({ error: '写入笔记失败: ' + e.message });
  }
});

// 某文档关联的阅读笔记：反查笔记目录下的 .annotations.json
app.get('/api/notes/for', async (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const target = String(req.query.path || '');
  if (!target) return res.status(400).json({ error: '缺少 path' });
  const { notesDir } = getUiSettings();
  const notesAbs = path.join(lib.baseDir, notesDir);
  const out = [];
  try {
    if (fs.existsSync(notesAbs)) {
      for (const f of fs.readdirSync(notesAbs)) {
        if (!f.startsWith('.') || !f.endsWith('.annotations.json')) continue;
        try {
          const ann = JSON.parse(fs.readFileSync(path.join(notesAbs, f), 'utf8'));
          if (!Array.isArray(ann)) continue;
          const hits = ann.filter((a) => a && a.source === target);
          if (!hits.length) continue;
          // 对应的笔记文件名：.<笔记名>.annotations.json → <笔记名>.md
          const noteName = f.slice(1, -'.annotations.json'.length) + '.md';
          const noteAbs = path.join(notesAbs, noteName);
          // 旧版笔记没有 anchor 字段：按「annotations 顺序 ↔ 笔记文件里 ## 标题顺序」推断
          const headings = [];
          try {
            const md = fs.readFileSync(noteAbs, 'utf8');
            for (const line of md.split(/\r?\n/)) {
              const m = /^##\s+(.+?)\s*$/.exec(line);
              if (m) headings.push(m[1]);
            }
          } catch { /* 笔记文件不存在则无法推断 */ }
          out.push({
            notePath: path.posix.join(notesDir, noteName),
            count: hits.length,
            latest: hits[hits.length - 1]?.at || null,
            quotes: hits.map((h, i) => ({ quote: h.quote, anchor: h.anchor || headings[i] || null })),
          });
        } catch { /* 坏文件跳过 */ }
      }
    }
    res.json({ ok: true, notes: out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
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
      await fs.promises.cp(srcAbs, dstAbs, { recursive: true }); // 异步复制：大目录不阻塞事件循环
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
  if (caseOnly) {
    // 仅大小写变化：目标存在且与源不是同一文件（大小写敏感卷上真有两个文件）→ 409；
    // 同一文件（不敏感卷）则走下方两步改名；目标不存在（敏感卷）也照常两步改名。
    let targetExists = false;
    let sameInode = false;
    try {
      const s1 = fs.statSync(entry.abs);
      const s2 = fs.statSync(newAbs);
      targetExists = true;
      sameInode = s1.ino === s2.ino && s1.dev === s2.dev;
    } catch {
      // 目标不存在：继续两步改名
    }
    if (caseRenameAction({ caseOnly: true, targetExists, sameInode }) === 'conflict') {
      throw Object.assign(new Error('目标已存在'), { status: 409, extra: { exists: true } });
    }
  } else {
    if (pathTaken(newAbs)) {
      throw Object.assign(new Error('目标位置已存在同名' + (entry.isDir ? '条目' : '文档') + ': ' + newRel), { status: 409, extra: { exists: true } });
    }
    if (!entry.isDir && pathTaken(newMeta)) {
      throw Object.assign(new Error('目标位置已存在同名元数据文件: ' + newRel + SIDECAR_SUFFIX), { status: 409, extra: { exists: true } });
    }
  }
  const steps = [];
  const pushStep = (from, to) => {
    if (sameCaseInsensitive(from, to)) {
      const tmp = from + '.wb-case-' + crypto.randomBytes(6).toString('hex');
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
  // 索引冷启动异步构建，未就绪时 counts 为空；前端据 ready 决定是否补拉
  res.json({ dsId: lib.id, ready: lib.linkIndex.ready, counts });
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
      await lib.linkIndex.rebuild(lib.scanner.snapshot, lib.indexer);
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

// 加工数据：概念表与知识图谱（.derived/concepts.jsonl + graph.jsonl）
app.get('/api/concepts', (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const d = loadDerived(lib.baseDir);
  res.json({
    dsId: lib.id,
    dir: DERIVED_DIR,
    concepts: d.concepts,
    conceptsMissing: d.conceptsMissing,
    graphMissing: d.graphMissing,
    nodeCount: d.graph.nodes.length,
    edgeCount: d.graph.edges.length,
    errors: [...d.conceptErrors, ...d.graphErrors],
  });
});

// 单个概念详情（含反向：哪些文档引用了它、图上邻居）
app.get('/api/concept', (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: '缺少 name' });
  const d = loadDerived(lib.baseDir);
  const c = d.concepts.find((x) => x.name === name || x.aliases.includes(name));
  if (!c) return res.status(404).json({ error: '概念不存在: ' + name });
  const neighbors = d.graph.edges
    .filter((e) => e.from === c.name || e.to === c.name)
    .map((e) => ({ rel: e.rel, dir: e.from === c.name ? 'out' : 'in', other: e.from === c.name ? e.to : e.from }));
  res.json({ concept: c, neighbors });
});

// 主题标签：合并 .meta.json 的人工 tags 与 .derived/topics.jsonl 的 AI 标注
app.get('/api/tags', (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const snap = lib.scanner.snapshot || { files: [], sidecars: [] };
  const ai = loadTopics(lib.baseDir);
  const byTag = new Map(); // tag -> { tag, files: [{path, title, source}] }
  const counts = { manual: 0, ai: 0 };
  for (const f of snap.files || []) {
    if (f.ext !== '.md' && f.ext !== '.json' && f.ext !== '.txt') continue;
    const manual = [];
    const metaRel = f.path + SIDECAR_SUFFIX;
    if ((snap.sidecars || []).includes(metaRel)) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(lib.baseDir, metaRel), 'utf8'));
        if (Array.isArray(m?.tags)) for (const t of m.tags) if (typeof t === 'string' && t.trim()) manual.push(t.trim());
      } catch { /* 非法旁注跳过 */ }
    }
    const auto = ai.byPath.get(f.path)?.topics || [];
    if (!manual.length && !auto.length) continue;
    const title = (() => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(lib.baseDir, metaRel), 'utf8'));
        if (typeof m?.title === 'string' && m.title.trim()) return m.title.trim();
      } catch { /* 忽略 */ }
      const base = f.name;
      return base.slice(0, base.length - f.ext.length);
    })();
    const push = (tag, source) => {
      if (!byTag.has(tag)) byTag.set(tag, { tag, files: [] });
      const e = byTag.get(tag);
      if (!e.files.some((x) => x.path === f.path)) {
        e.files.push({ path: f.path, title, source });
        counts[source === 'manual' ? 'manual' : 'ai']++;
      }
    };
    for (const t of manual) push(t, 'manual');
    for (const t of auto) push(t, 'ai');
  }
  const tags = [...byTag.values()]
    .map((e) => ({
      tag: e.tag,
      count: e.files.length,
      files: e.files,
      source: e.files.every((x) => x.source === 'ai') ? 'ai' : e.files.every((x) => x.source === 'manual') ? 'manual' : 'mixed',
    }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));
  res.json({ dsId: lib.id, dir: DERIVED_DIR, tags, topicsMissing: ai.missing, errors: ai.errors, counts });
});

// 单文档的主题：人工 tags + AI 标注
app.get('/api/tags/doc', (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const target = String(req.query.path || '');
  if (!target) return res.status(400).json({ error: '缺少 path' });
  let manual = [];
  try {
    const m = JSON.parse(fs.readFileSync(path.join(lib.baseDir, target + SIDECAR_SUFFIX), 'utf8'));
    if (Array.isArray(m?.tags)) manual = m.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim());
  } catch { /* 无旁注 */ }
  const ai = loadTopics(lib.baseDir);
  const entry = ai.byPath.get(target) || { topics: [], concepts: [] };
  // 提及的概念：从该文档的内链里反查（target 以 concept: 开头的词条）
  const mentioned = [];
  try {
    const fileLinks = lib.linkIndex?.files?.get(target)?.links || [];
    for (const l of fileLinks) {
      const tp = l.target?.path || '';
      if (tp.startsWith('concept:')) {
        const n = tp.slice('concept:'.length);
        if (!mentioned.includes(n)) mentioned.push(n);
      }
    }
  } catch { /* 索引未就绪时为空 */ }
  res.json({ dsId: lib.id, path: target, manual, ai: entry.topics, coreConcepts: entry.concepts, mentioned, all: [...new Set([...manual, ...entry.topics])] });
});

app.get('/api/word-capability', async (req, res) => {
  res.json(await wordCapability());
});

// Word 预览图片（转换时外置到 word-assets，HTML 只引用此接口）。
// key/name 必须与实际生成格式严格匹配（key=<路径 sha1>-<mtime>，name=img-<n>.<ext>），
// 拒绝 `..` 等 traversing 值；路径校验对 word-assets 根目录做 isWithin 双保险；
// 目录名含 mtime，内容不变 → immutable 长缓存。
const WORD_ASSET_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};
const WORD_ASSET_KEY = /^[0-9a-f]{40}-\d+(\.\d+)?$/;
const WORD_ASSET_NAME = /^img-\d+\.(png|jpeg|gif|webp|bmp)$/;
app.get('/api/word/asset', (req, res) => {
  const lib = requireLib(res, req);
  if (!lib) return;
  const key = String(req.query.key || '');
  const name = String(req.query.name || '');
  if (!WORD_ASSET_KEY.test(key) || !WORD_ASSET_NAME.test(name)) {
    return res.status(400).json({ error: '非法的资产标识' });
  }
  const ct = WORD_ASSET_TYPES[path.extname(name).toLowerCase()];
  if (!ct) return res.status(404).json({ error: '不支持的资产类型' });
  const root = path.join(cacheDir(lib.id), 'word-assets');
  const abs = path.join(root, key, name);
  if (!isWithin(abs, root)) return res.status(403).json({ error: '路径越界' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '资产不存在' });
  res.setHeader('Content-Type', ct);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
});

// ---------- 日志上报与诊断包（只导出不上传） ----------

app.post('/api/log', (req, res) => {
  const entries = req.body?.entries;
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries 必须是数组' });
  if (entries.length > 50) return res.status(400).json({ error: 'entries 最多 50 条' });
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const level = ['ERROR', 'WARN', 'INFO'].includes(e.level) ? e.level : 'INFO';
    let message = typeof e.message === 'string' ? e.message : String(e.message ?? '');
    if (message.length > 4000) message = message.slice(0, 4000);
    const prefix = typeof e.at === 'string' && e.at ? e.at + ' ' : '';
    rendererLog.write(level, 'renderer', prefix + message);
  }
  res.json({ ok: true });
});

app.get('/api/diagnostics/state', (req, res) => {
  res.json({ pending: pendingIncident(dataDir()), logsDir: logsDir(dataDir()) });
});

app.post('/api/diagnostics/ack', (req, res) => {
  ackIncidents(dataDir());
  res.json({ ok: true });
});

app.post('/api/diagnostics/export', async (req, res) => {
  try {
    const outDir = process.env.WORKBENCH_DESKTOP_DIR || undefined;
    const r = await exportDiagnostics({ dataDir: dataDir(), outDir, summary: await buildSummary() });
    try { await revealInFolder(r.file); } catch { /* 定位失败不影响导出 */ }
    res.json({ ok: true, file: r.file });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

function libSummary(lib) {
  const snap = lib.scanner.snapshot;
  const files = {};
  for (const f of snap?.files || []) files[f.ext] = (files[f.ext] || 0) + 1;
  return {
    id: lib.id, name: lib.name, baseDir: lib.baseDir,
    active: lib.id === activeId,
    scanning: lib.scanner.scanning,
    watching: !!lib.scanner.watcher,
    scannedAt: snap?.scannedAt || null,
    files,
    totalBytes: (snap?.files || []).reduce((s, f) => s + f.size, 0),
    dirErrors: snap?.dirErrors?.length || 0,
    fileErrors: snap?.fileErrors?.length || 0,
  };
}

function ragSummary() {
  const st = ragManager.embed.status();
  return {
    model: { state: st.state, backend: st.backend, ep: st.ep, error: st.error, progress: st.progress },
    indices: [...ragManager.indices.entries()].map(([dsId, ix]) => {
      const s = ix.status();
      return { dsId, state: s.state, files: s.files, filesDone: s.filesDone, chunks: s.chunks, dbBytes: s.dbBytes };
    }),
  };
}

function agentSummary() {
  const st = agentHub.status();
  const endpoint = st.endpoint || {};
  return {
    endpointConfigured: !!(endpoint.baseUrl && endpoint.model),
    model: endpoint.model || null,
    mode: st.mode || 'auto',
  };
}

async function buildSummary() {
  const ui = getUiSettings();
  // 托管模式下 GPU 状态经宿主 RPC host.info 取；取不到写 null
  let gpu = null;
  if (hosted) {
    try { gpu = (await rpc('host.info')).gpu ?? null; } catch { /* 保持 null */ }
  }
  return {
    app: { version: process.env.WORKBENCH_APP_VERSION || null, hosted: !!process.versions.electron },
    runtime: {
      electron: process.versions.electron || null,
      node: process.versions.node || null,
      chrome: process.versions.chrome || null,
    },
    os: {
      platform: os.platform(), release: os.release(), arch: os.arch(),
      cpu: os.cpus()[0]?.model || null, cores: os.cpus().length,
      totalMemGB: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
      freeMemGB: Math.round(os.freemem() / 1024 / 1024 / 1024 * 10) / 10,
    },
    host: { gpu },
    dataDir: dataDir(), logsDir: logsDir(dataDir()),
    libraries: [...libs.values()].map(libSummary),
    rag: ragSummary(),
    agent: agentSummary(),
    ui: { theme: ui.theme, autoUpdate: ui.autoUpdate },
    incidents: readIncidents(dataDir(), { limit: 50 }),
  };
}

// ---------- 前端静态资源（仅在设置 WORKBENCH_STATIC_DIR 时启用） ----------

// index.html 不交由 express.static 直接下发：注入持久化主题（data-theme / __WB_THEME__），
// 让首帧就用对配色；按 mtime 缓存源文件。
const INDEX_FILE = STATIC_DIR ? path.join(STATIC_DIR, 'index.html') : null;
let indexCache = { mtimeMs: -1, html: '' };

function themedIndexHtml(nonce) {
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
  else html = html.replace('<script', `<script nonce="${nonce}">${boot}</script><script`);
  // 所有内联 <script> 统一加 nonce（外链脚本不受 nonce 约束，加上也合法）
  html = html.replace(/<script\b([^>]*)>/g, (_m, attrs) => (/\snonce\s*=/.test(attrs) ? `<script${attrs}>` : `<script${attrs} nonce="${nonce}">`));
  return html;
}

if (STATIC_DIR && fs.existsSync(INDEX_FILE)) {
  app.use(express.static(STATIC_DIR, { index: false })); // 资源照常下发，但 index.html 走注入
  // 看似静态资源的路径（末段带静态扩展名）不做 SPA 回退：缺失时直接 404，避免把 HTML 当脚本/样式加载
  const STATIC_EXT = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf)$/i;
  const cspHeader = (nonce) => [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    // 应用自身注入了 <base href=\"/\"> 修 SPA 深链资源解析；'self' 仍能拦外部 base URI
    "base-uri 'self'",
    "frame-src 'none'",
    "form-action 'none'",
  ].join('; ');
  const serveIndex = (req, res) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', cspHeader(nonce));
    res.send(themedIndexHtml(nonce));
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
  // 启动页扫描进度聚合：多库并行扫描时合并成一条文案推送 boot 步骤，250ms 节流
  const bootScan = new Map(); // libId -> { name, scanned }
  let bootLastPush = 0;
  let bootTimer = null;
  const pushBootScan = () => {
    if (!bootScan.size) return;
    const items = [...bootScan.values()];
    postBoot(items.length === 1
      ? '正在扫描资料库：' + items[0].name + '（' + items[0].scanned + ' 个文件）'
      : '正在扫描 ' + items.length + ' 个资料库：' + items.map((it) => it.name + '（' + it.scanned + ' 个文件）').join('、'));
    bootLastPush = Date.now();
  };
  const scheduleBootScan = () => {
    if (!bootScan.size) return;
    const wait = 250 - (Date.now() - bootLastPush);
    if (wait <= 0) {
      pushBootScan();
    } else if (!bootTimer) {
      bootTimer = setTimeout(() => { bootTimer = null; pushBootScan(); }, wait);
      bootTimer.unref?.();
    }
  };
  // 各库并行恢复（扫描互相独立，串行会人为拉长多库启动时间）
  await Promise.all(libraries.map(async (meta) => {
    const lib = new Lib(meta);
    libs.set(lib.id, lib);
    const onProgress = ({ scanned }) => {
      bootScan.set(lib.id, { name: lib.name, scanned });
      scheduleBootScan();
    };
    try {
      fs.accessSync(lib.baseDir, fs.constants.R_OK);
      bootScan.set(lib.id, { name: lib.name, scanned: 0 });
      lib.scanner.on('scan-progress', onProgress);
      const t0 = Date.now();
      await lib.start();
      console.log('[boot] 资料库「' + lib.name + '」就绪: ' + lib.baseDir + '，' + (lib.scanner.snapshot?.files.length ?? 0) + ' 个文件，扫描耗时 ' + (Date.now() - t0) + 'ms');
    } catch (e) {
      // 目录不可达：保留在列表中可移除，但不扫描不监听
      lib.scanner.setBaseDir(lib.baseDir);
      lib.indexer.reset(lib.id, lib.baseDir);
      lib.linkIndex.reset(lib.id, lib.baseDir);
      console.error('[' + lib.name + '] 目录不可访问:', e.message);
    } finally {
      lib.scanner.off('scan-progress', onProgress);
      bootScan.delete(lib.id);
      if (!bootScan.size && bootTimer) {
        clearTimeout(bootTimer);
        bootTimer = null;
      }
      scheduleBootScan(); // 已完成的库从文案中移除
    }
  }));
  // 启动续建：对已打开且已有 RAG 索引（rag.db 存在且 files>0）的库触发一次增量构建，
  // 把上次退出前未完成的进度补上（从未建过索引的库不自动建）。
  for (const lib of libs.values()) {
    if (!lib.scanner.snapshot) continue;
    try {
      const ragDb = path.join(dataDir(), 'knowledge', lib.id, 'rag.db');
      if (!fs.existsSync(ragDb)) continue;
      const ix = ragManager.index(lib.id);
      if (ix._ensureStore().stats().files > 0) {
        ix.build({}).catch((e) => console.error('[boot] RAG 增量续建失败:', e?.message || e));
      }
    } catch (e) {
      console.error('[boot] RAG 续建检查失败:', e?.message || e);
    }
  }
  activeId = libs.has(savedActive) ? savedActive : (libraries[0]?.id ?? null);
  if (activeId) setActiveLibInStore(activeId);
  app.listen(PORT, HOST, () => {
    console.log('服务开始监听: http://localhost:' + PORT + '，距进程启动 ' + (Date.now() - PROC_START) + 'ms');
    postReady(PORT);
  });
}

boot();
