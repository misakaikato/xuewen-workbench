// 智能助手：pi agent SDK 桥（AgentHub）。
// 会话生命周期、workbench 工具集（InlineExtension 注册）、SSE 事件流、持久化。
// agentDir = dataDir/agent/（skills/mcp.json/models.json/sessions），与用户全局 ~/.pi 隔离。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createMcpExtension } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { agentFailure } from './failure.js';
import { MemoryStore, buildMemorySection, memoryDir, FACTS_LIMIT, PINNED_LIMIT } from './memory.js';
import { loadTopics } from '../derived.js';
import { applySettings, readSettings, SETTABLE, buildPatch, normalizeCategory } from './settings.js';
import { generateImage, uniapiKey } from './imagegen.js';

const CONV_META = 'conversations.json';
// 运行模式：auto=全自动 / confirm=破坏性工具需确认 / readonly=仅检索阅读
const READONLY_TOOLS = ['search_corpus', 'rag_search', 'read_doc', 'list_files', 'list_collections', 'corpus_status'];
const DESTRUCTIVE_TOOLS = ['bash', 'save_note', 'word_to_markdown', 'rag_manage', 'open_doc', 'rename_entry', 'move_entry', 'settings_set', 'generate_image'];
const TOOL_NAMES = ['read', 'bash', 'search_corpus', 'rag_search', 'read_doc', 'list_files', 'list_collections', 'corpus_status', 'rag_manage', 'word_to_markdown', 'save_note', 'open_doc', 'remember', 'forget', 'recall', 'consolidate', 'rename_entry', 'move_entry', 'settings_get', 'settings_set', 'generate_image'];

function nowIso() {
  return new Date().toISOString();
}

export class AgentHub {
  constructor({ dataDir, getLib, ragManager, getRagConfig, addOrActivateLibrary, removeLibrary }) {
    this.dataDir = dataDir;
    this.agentId = 'default';
    // Agent 定义目录：agents/<id>/（AGENTS.md / skills / mcp.json / memory）
    this.agentDir = path.join(dataDir, 'agents', this.agentId);
    fs.mkdirSync(path.join(this.agentDir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(this.agentDir, 'memory'), { recursive: true });
    // 记忆三层存储
    this.memory = new MemoryStore(dataDir);
    fs.mkdirSync(path.join(dataDir, 'memory'), { recursive: true });
    this._migrateLegacyAgentDir(dataDir);
    this._ensureAgentsMd();
    this.getLib = getLib; // (dsId?) => Lib | null（当前库）
    this.ragManager = ragManager;
    this.getRagConfig = getRagConfig; // () => llm 配置 {enabled, baseUrl, model, apiKey}
    this.addOrActivateLibrary = addOrActivateLibrary; // (baseDir) => {ok,...}
    this.removeLibrary = removeLibrary; // (dsId) => {ok,...}
    this.live = new Map(); // convId
    this.mode = 'auto'; // auto | confirm | readonly
    this._confirmCb = new Map(); // confirmId → (ok) => void → { session, sse:Set, busy, seq }
    this._modelRuntime = null;
    this._ctxWindow = 0; // 端点模型的真实上下文窗口（0=未知，回退 128000）
    this._syncModelsJson();
    this._detectContextWindow().catch(() => {}); // 启动时探测一次，写正 models.json
  }

  /** 默认 AGENTS.md：身份 + 能力 + 回答风格（用户可编辑） */
  static DEFAULT_AGENTS_MD = `---
name: 学问助手
description: 在用户自己的资料库中检索、阅读、问答与管理的助手
---

# 身份

你是「学问 Workbench」的内嵌助手，帮助用户在自己的资料库中检索、阅读、问答与管理。

# 能力

- 检索资料库：语义检索与关键词检索并行，能定位到具体段落
- 阅读文档：Markdown / 纯文本 / JSON / Word 的正文
- 管理资料库：查看状态、重建索引、整理笔记
- 记忆：跨对话保留用户的偏好与重要结论

# 回答风格

- 回答用中文，简洁分层，用 markdown 格式
- 语料中没有依据时明确说明，不编造
- 出处标注为 [文件名.ext]，便于点击跳转
- 不向用户展示工具调用的细节

---

（以下是你的补充，可自由编辑；系统固定规则会自动追加在后面）
`;

  /** 确保 AGENTS.md 存在（首次写入默认内容） */
  _ensureAgentsMd() {
    const file = path.join(this.agentDir, 'AGENTS.md');
    if (fs.existsSync(file)) return file;
    try {
      fs.mkdirSync(this.agentDir, { recursive: true });
      fs.writeFileSync(file, AgentHub.DEFAULT_AGENTS_MD);
    } catch (e) {
      console.warn('[agent] 写入默认 AGENTS.md 失败:', e.message);
    }
    return file;
  }

  /** 读取 AGENTS.md（剥离 YAML frontmatter） */
  _loadAgentsMd() {
    const file = this._ensureAgentsMd();
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    } catch {
      return '';
    }
  }

  /** 写入 AGENTS.md（保留/更新 frontmatter） */
  saveAgentsMd(content) {
    const file = this._ensureAgentsMd();
    const body = String(content || '').trim();
    const existing = (() => {
      try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
    })();
    const fm = /^---\n([\s\S]*?)\n---/.exec(existing);
    const head = fm ? `---\n${fm[1]}\n---\n\n` : '';
    fs.writeFileSync(file, head + body + '\n');
    return { ok: true };
  }

  /**
   * 旧结构迁移（agent/ → agents/<id>/）：
   * skills 与 mcp.json 保留；旧对话（conversations/、sessions/）按设计丢弃
   */
  _migrateLegacyAgentDir(dataDir) {
    const legacy = path.join(dataDir, 'agent');
    if (!fs.existsSync(legacy)) return;
    try {
      // skills 目录：旧有新的没有时整体搬过来
      const oldSkills = path.join(legacy, 'skills');
      const newSkills = path.join(this.agentDir, 'skills');
      if (fs.existsSync(oldSkills) && fs.readdirSync(oldSkills).length && !fs.readdirSync(newSkills).length) {
        for (const name of fs.readdirSync(oldSkills)) {
          fs.cpSync(path.join(oldSkills, name), path.join(newSkills, name), { recursive: true });
        }
        console.log('[agent] 已迁移 skills:', fs.readdirSync(newSkills).join(', '));
      }
      // mcp.json
      const oldMcp = path.join(legacy, 'mcp.json');
      const newMcp = path.join(this.agentDir, 'mcp.json');
      if (fs.existsSync(oldMcp) && !fs.existsSync(newMcp)) fs.copyFileSync(oldMcp, newMcp);
      // 旧对话：丢弃
      for (const d of ['conversations', 'sessions']) {
        const p = path.join(legacy, d);
        if (fs.existsSync(p)) {
          fs.rmSync(p, { recursive: true, force: true });
          console.log(`[agent] 已丢弃旧对话目录: agent/${d}`);
        }
      }
      // 旧 conversations.json 一并清理（新索引在 dataDir/agent-conversations.json）
      const oldMeta = path.join(legacy, 'conversations.json');
      if (fs.existsSync(oldMeta)) fs.rmSync(oldMeta, { force: true });
      // 旧 models.json 清理（新位置 agents/<id>/models.json）
      const oldModels = path.join(legacy, 'models.json');
      if (fs.existsSync(oldModels)) fs.rmSync(oldModels, { force: true });
      // 空目录清理
      if (fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy);
    } catch (e) {
      console.warn('[agent] 旧目录迁移失败:', e.message);
    }
  }

  // ---------- 端点与模型 ----------

  llm() {
    return this.getRagConfig() || {};
  }

  endpointReady() {
    const c = this.llm();
    return !!(c.baseUrl && c.model);
  }

  /** 由「生成端点」配置生成 agentDir/models.json（provider=workbench，OpenAI 兼容） */
  _syncModelsJson() {
    const c = this.llm();
    const p = path.join(this.agentDir, 'models.json');
    if (!this.endpointReady()) {
      try { fs.unlinkSync(p); } catch { /* 无文件 */ }
      this._disposeAllSessions();
      this._modelRuntime = null;
      return;
    }
    const json = {
      $schema: 'https://pi.dev/schemas/models.schema.json',
      providers: {
        workbench: {
          baseUrl: c.baseUrl.replace(/\/$/, ''),
          api: 'openai-completions',
          apiKey: c.apiKey || 'workbench',
          models: [{ id: c.model, name: c.model, contextWindow: this._ctxWindow || 128000, toolUse: true }],
        },
      },
    };
    fs.writeFileSync(p, JSON.stringify(json, null, 2));
    this._disposeAllSessions(); // 模型/端点变了：现有会话的上下文绑定旧模型，需重建
    this._modelRuntime = null;
  }

  _disposeAllSessions() {
    for (const [id, entry] of this.live) {
      try { if (entry.unsubscribe) entry.unsubscribe(); } catch { /* */ }
      try { entry.session.dispose(); } catch { /* */ }
    }
    this.live.clear();
  }

  async _runtime() {
    if (!this._modelRuntime) {
      this._modelRuntime = await ModelRuntime.create({
        modelsPath: path.join(this.agentDir, 'models.json'),
        authPath: path.join(this.agentDir, 'auth.json'),
      });
    }
    return this._modelRuntime;
  }

  // ---------- 会话元数据与投影 ----------

  _metaPath() {
    return path.join(this.dataDir, CONV_META);
  }

  _meta() {
    try {
      const m = JSON.parse(fs.readFileSync(this._metaPath(), 'utf8'));
      return {
        conversations: Array.isArray(m.conversations) ? m.conversations : [],
        folders: Array.isArray(m.folders) ? m.folders : [],
      };
    } catch {
      return { conversations: [], folders: [] };
    }
  }

  _saveMeta(m) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this._metaPath(), JSON.stringify(m, null, 2));
  }

  /** 对话列表（按库过滤；dsId 省略=当前库） */
  listConversations(dsId = null) {
    const want = dsId ?? this.currentDsId();
    return this._meta().conversations
      .filter((c) => !want || c.dsId === want)
      .map((c) => ({ ...c, busy: this.live.get(c.id)?.busy || false }))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  /** 当前库的 dsId（来自 getLib） */
  currentDsId() {
    return this.getLib()?.id || null;
  }

  /** 对话目录：knowledge/<dsId>/conversations/<agentId>/ */
  _convDir(dsId) {
    return path.join(this.dataDir, 'knowledge', dsId, 'conversations', this.agentId);
  }

  newConversation(title, dsId = null) {
    const id = crypto.randomBytes(6).toString('hex');
    const lib = this.getLib();
    const belong = dsId || lib?.id || null;
    if (!belong) throw new Error('当前没有打开的资料库，无法新建对话');
    const m = this._meta();
    const conv = {
      id,
      title: title || '新对话',
      dsId: belong,
      agentId: this.agentId,
      pinned: false,
      folderId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    m.conversations.push(conv);
    this._saveMeta(m);
    const dir = this._convDir(belong);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._convFile(id), '');
    return conv;
  }

  // ---------- 对话文件夹 ----------

  listFolders(dsId = null) {
    const want = dsId ?? this.currentDsId();
    return this._meta().folders
      .filter((f) => !want || f.dsId === want)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'zh-CN'));
  }

  createFolder(name, dsId = null) {
    const label = String(name || '').trim();
    if (!label) throw new Error('文件夹名不能为空');
    if (/[\\/:*?"<>|]/.test(label)) throw new Error('文件夹名不能包含 / \\ : * ? " < > |');
    const belong = dsId || this.currentDsId();
    if (!belong) throw new Error('当前没有打开的资料库');
    const m = this._meta();
    if (m.folders.some((f) => f.dsId === belong && f.name === label)) throw new Error('同名文件夹已存在');
    const folder = { id: crypto.randomBytes(5).toString('hex'), name: label, dsId: belong, order: m.folders.filter((f) => f.dsId === belong).length };
    m.folders.push(folder);
    this._saveMeta(m);
    return folder;
  }

  renameFolder(id, name) {
    const label = String(name || '').trim();
    if (!label) throw new Error('文件夹名不能为空');
    const m = this._meta();
    const f = m.folders.find((x) => x.id === id);
    if (!f) throw new Error('文件夹不存在');
    f.name = label;
    this._saveMeta(m);
    return f;
  }

  deleteFolder(id) {
    const m = this._meta();
    m.folders = m.folders.filter((f) => f.id !== id);
    // 该文件夹内的对话回到根目录（不删对话）
    for (const c of m.conversations) if (c.folderId === id) c.folderId = null;
    this._saveMeta(m);
    return { ok: true };
  }

  /** 把对话移入文件夹（folderId=null 表示根目录） */
  moveConversation(convId, folderId) {
    const m = this._meta();
    const c = m.conversations.find((x) => x.id === convId);
    if (!c) throw new Error('对话不存在');
    if (folderId && !m.folders.some((f) => f.id === folderId && f.dsId === c.dsId)) {
      throw new Error('目标文件夹不存在或不属于同一资料库');
    }
    c.folderId = folderId || null;
    c.updatedAt = nowIso();
    this._saveMeta(m);
    return c;
  }

  deleteConversation(id) {
    const entry = this.live.get(id);
    if (entry) {
      try { if (entry.unsubscribe) entry.unsubscribe(); } catch { /* */ }
      try { entry.session.dispose(); } catch { /* 忽略 */ }
      this.live.delete(id);
    }
    const m = this._meta();
    m.conversations = m.conversations.filter((c) => c.id !== id);
    this._saveMeta(m);
    for (const f of [this._convFile(id)]) {
      try { fs.unlinkSync(f); } catch { /* 忽略 */ }
    }
    return { ok: true };
  }

  _convFile(id) {
    const conv = this._meta().conversations.find((c) => c.id === id);
    const dsId = conv?.dsId || this.currentDsId();
    if (!dsId) throw new Error('对话不存在或无法确定所属资料库: ' + id);
    return path.join(this._convDir(dsId), id + '.jsonl');
  }

  _touch(id, title) {
    const m = this._meta();
    const c = m.conversations.find((x) => x.id === id);
    if (c) {
      c.updatedAt = nowIso();
      if (title) c.title = title;
      this._saveMeta(m);
    }
  }

  history(id) {
    const out = [];
    try {
      const lines = fs.readFileSync(this._convFile(id), 'utf8').split('\n');
      for (const ln of lines) {
        if (!ln.trim()) continue;
        try { out.push(JSON.parse(ln)); } catch { /* 坏行跳过 */ }
      }
    } catch { /* 无文件 */ }
    return out;
  }

  _append(id, obj) {
    fs.appendFileSync(this._convFile(id), JSON.stringify(obj) + '\n');
  }

  // ---------- pi 会话 ----------

  _workbenchToolsFactory(convId) {
    const hub = this;
    return (pi) => {
      const lib = () => hub.getLib();
      // 内置 bash 也走 confirm 确认链（它是 pi 内置工具，不经过我们自定义工具的 execute 包装）
      pi.on('tool_call', async (event) => {
        if (event.toolName !== 'bash') return undefined;
        const ok = await hub._confirm(convId, 'bash', event.input);
        return ok ? undefined : { block: true, reason: '用户拒绝了该命令的执行' };
      });
      pi.registerTool({
        name: 'search_corpus',
        label: '精确检索语料',
        description: '按关键词精确检索当前资料库（文件名/路径/正文，多词 AND）。返回命中文件与片段。',
        promptSnippet: 'search_corpus(query, types?, dir?) — 关键词精确检索语料。',
        parameters: Type.Object({
          query: Type.String({ description: '关键词，空格分隔多个（AND）' }),
          types: Type.Optional(Type.Array(Type.String(), { description: '扩展名过滤，如 [".md", ".txt"]' })),
          dir: Type.Optional(Type.String({ description: '限定目录（相对路径）' })),
        }),
        execute: async (_id, params) => {
          const l = lib();
          if (!l) return { content: [{ type: 'text', text: '当前没有打开的资料库' }] };
          const r = l.indexer.search(params.query, { types: params.types, dir: params.dir });
          const lines = r.results.slice(0, 15).map((x) => {
            const snip = (x.matches.find((m) => m.field === 'content') || x.matches[0] || { snippet: '' }).snippet.replace(/\s+/g, ' ').slice(0, 120);
            return `- ${x.file.path}${snip ? '：' + snip : ''}`;
          });
          return {
            content: [{ type: 'text', text: `共 ${r.total} 个文件命中（显示前 15）：\n` + lines.join('\n') }],
          };
        },
      });
      pi.registerTool({
        name: 'rag_search',
        label: '智能检索语料',
        description: '语义+关键词混合检索当前资料库，返回最相关的原文段落（含出处文件与标题路径）。回答语料问题前优先用这个工具。',
        promptSnippet: 'rag_search(query, limit?) — 语义混合检索，返回带出处的段落。',
        parameters: Type.Object({
          query: Type.String({ description: '自然语言问题或关键词' }),
          limit: Type.Optional(Type.Number({ description: '返回段落数，默认 8' })),
        }),
        execute: async (_id, params) => {
          try {
            const l = lib();
            const r = await hub.ragManager.search(l.id, params.query, Math.min(30, params.limit || 8));
            const lines = r.hits.map((h) => `- [${h.name}${h.headingPath ? ' · ' + h.headingPath : ''}] ${h.snippet.replace(/\s+/g, ' ').slice(0, 160)}`);
            return {
              content: [{ type: 'text', text: (lines.length ? '相关段落：\n' + lines.join('\n') : '语料中没有找到相关内容') + `\n（${r.took}ms，共 ${r.total ?? r.hits.length} 段）` }],
            };
          } catch (e) {
            return { content: [{ type: 'text', text: '智能检索不可用：' + (e.message || e) }] };
          }
        },
      });
      pi.registerTool({
        name: 'read_doc',
        label: '读取文档',
        description: '读取资料库内一个文档的文本内容（md/txt/json 原文；Word 为提取文本）。超长自动截断。',
        parameters: Type.Object({ path: Type.String({ description: '相对路径，如 笔记/第1章.md' }) }),
        execute: async (_id, params) => {
          const l = lib();
          if (!l) return { content: [{ type: 'text', text: '当前没有打开的资料库' }] };
          try {
            const abs = path.resolve(l.baseDir, params.path);
            if (!abs.startsWith(path.resolve(l.baseDir))) throw new Error('路径越界');
            const ext = path.extname(params.path).toLowerCase();
            let text = '';
            if (ext === '.doc' || ext === '.docx') {
              const f = l.indexer.texts.get(params.path);
              text = f || '';
            } else {
              text = fs.readFileSync(abs, 'utf8');
            }
            const capped = text.length > 20000 ? text.slice(0, 20000) + '\n…（已截断）' : text;
            return { content: [{ type: 'text', text: capped || '（空文件）' }] };
          } catch (e) {
            return { content: [{ type: 'text', text: '读取失败：' + (e.message || e) }] };
          }
        },
      });
      pi.registerTool({
        name: 'list_files',
        label: '浏览目录',
        description: '列出资料库某目录下的文件与子目录（默认根目录）。',
        parameters: Type.Object({ dir: Type.Optional(Type.String({ description: '相对目录，默认根' })) }),
        execute: async (_id, params) => {
          const l = lib();
          if (!l) return { content: [{ type: 'text', text: '当前没有打开的资料库' }] };
          const rel = params.dir || '';
          const snap = l.scanner.snapshot;
          const dirs = [...new Set(snap.files.filter((f) => f.dir === rel).map((f) => f.path))]
            .concat(snap.files.filter((f) => rel === '' ? f.path.includes('/') : f.path.startsWith(rel + '/')))
            .slice(0, 200);
          return { content: [{ type: 'text', text: dirs.length ? dirs.join('\n') : '（空目录）' }] };
        },
      });
      pi.registerTool({
        name: 'corpus_status',
        label: '库与索引状态',
        description: '查看当前资料库概况：文件数/类型分布/扫描状态/RAG 索引状态。',
        parameters: Type.Object({}),
        execute: async () => {
          const l = lib();
          if (!l) return { content: [{ type: 'text', text: '当前没有打开的资料库' }] };
          const st = l.scanner.status ? l.scanner.status() : null;
          const rag = hub.ragManager.status(l.id);
          return {
            content: [{
              type: 'text',
              text: `资料库：${l.name}（${l.baseDir}）\n文件：${st?.counts ? JSON.stringify(st.counts) : snapText(l)}\nRAG 索引：${rag.index.state}，${rag.index.chunks} 块，模型 ${rag.model.state}/${rag.model.backend}`,
            }],
          };
        },
      });
      pi.registerTool({
        name: 'rag_manage',
        label: '管理 RAG 索引',
        description: '管理语义索引**构建**：build（增量构建/续建）、rebuild（全量重建）、pause（暂停）。构建是后台任务，用 corpus_status 查进度。注意：本工具不能修改任何检索/切块参数——改参数要用 settings_set(category="rag", ...)。',
        parameters: Type.Object({ action: Type.Union([Type.Literal('build'), Type.Literal('rebuild'), Type.Literal('pause')]) }),
        execute: async (_id, params) => {
          const l = lib();
          if (!l) return { content: [{ type: 'text', text: '当前没有打开的资料库' }] };
          if (params.action === 'pause') {
            hub.ragManager.pause(l.id);
            return { content: [{ type: 'text', text: '已请求暂停' }] };
          }
          if (params.action === 'rebuild' && !(await hub._confirm(convId, 'rag_manage', params))) {
            return { content: [{ type: 'text', text: '用户取消了重建操作' }] };
          }
          hub.ragManager.build(l.id, { rebuild: params.action === 'rebuild' }).catch(() => {});
          return { content: [{ type: 'text', text: params.action === 'rebuild' ? '已开始全量重建（后台）' : '已开始增量构建（后台）' }] };
        },
      });
      pi.registerTool({
        name: 'list_collections',
        label: '列出逻辑集合',
        description: '列出当前资料库的逻辑集合配置（名称与映射目录）。',
        parameters: Type.Object({}),
        execute: async () => {
          const l = lib();
          if (!l) return { content: [{ type: 'text', text: '当前没有打开的资料库' }] };
          const cols = hub.ragManager ? [] : [];
          try {
            const colsData = JSON.parse(fs.readFileSync(path.join(hub.dataDir, 'knowledge', l.id, 'collections.json'), 'utf8'));
            const lines = (colsData || []).map((c) => `- ${c.name}: ${(c.dirs || []).join(', ')}`);
            return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : '暂无集合配置' }] };
          } catch {
            return { content: [{ type: 'text', text: '暂无集合配置' }] };
          }
        },
      });
      pi.registerTool({
        name: 'word_to_markdown',
        label: 'Word 转 Markdown',
        description: '将一个 Word 文档（.docx）另存为同目录下的 Markdown 副本（不改原件）。',
        parameters: Type.Object({ path: Type.String({ description: 'Word 文件相对路径' }) }),
        execute: async (_id, params) => {
          if (!(await hub._confirm(convId, 'word_to_markdown', params))) {
            return { content: [{ type: 'text', text: '用户取消了此操作' }] };
          }
          const l = lib();
          if (!l) return { content: [{ type: 'text', text: '当前没有打开的资料库' }] };
          try {
            const f = l.indexer.texts.get(params.path);
            if (!f) return { content: [{ type: 'text', text: '未找到该 Word 文档的提取文本' }] };
            const mdPath = params.path.replace(/\.docx?$/i, '.md');
            const abs = path.resolve(l.baseDir, mdPath);
            if (fs.existsSync(abs)) return { content: [{ type: 'text', text: `已存在同名的 Markdown 文件：${mdPath}` }] };
            fs.writeFileSync(abs, `# ${path.basename(params.path, path.extname(params.path))}\n\n${f}\n`);
            return { content: [{ type: 'text', text: `已另存为 ${mdPath}（原件不变）` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: '转换失败：' + (e.message || e) }] };
          }
        },
      });
      pi.registerTool({
        name: 'save_note',
        label: '保存笔记',
        description: '将一段文本保存为资料库中的新 Markdown 笔记文件。',
        parameters: Type.Object({
          title: Type.String({ description: '笔记标题（也是文件名）' }),
          content: Type.String({ description: 'Markdown 内容' }),
        }),
        execute: async (_id, params) => {
          if (!(await hub._confirm(convId, 'save_note', params))) {
            return { content: [{ type: 'text', text: '用户取消了此操作' }] };
          }
          const l = lib();
          if (!l) return { content: [{ type: 'text', text: '当前没有打开的资料库' }] };
          try {
            const safe = params.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
            const rel = `笔记/${safe}.md`;
            const abs = path.resolve(l.baseDir, rel);
            if (fs.existsSync(abs)) return { content: [{ type: 'text', text: `已存在同名笔记：${rel}` }] };
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, `# ${params.title}\n\n${params.content}\n`);
            return { content: [{ type: 'text', text: `已保存笔记到 ${rel}` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: '保存失败：' + (e.message || e) }] };
          }
        },
      });
      pi.registerTool({
        name: 'open_doc',
        label: '打开文档',
        description: '在用户界面上打开一个文档（可选定位到某关键词）。用于把用户引导到原文。',
        parameters: Type.Object({
          path: Type.String({ description: '相对路径' }),
          term: Type.Optional(Type.String({ description: '定位关键词（高亮并滚到该处）' })),
        }),
        execute: async (_id, params) => {
          hub._emit(convId, { t: 'open_doc', path: params.path, term: params.term || '' });
          return { content: [{ type: 'text', text: `已在界面打开 ${params.path}${params.term ? '（定位到「' + params.term + '」）' : ''}` }] };
        },
      });

      // ---------- 条目整理（重命名/移动） ----------
      // 走内部 HTTP 复用 /api/file/{rename,move} 的完整逻辑（sidecar 迁移、备份随迁、大小写处理）
      const callLocalApi = async (apiPath, body) => {
        const port = process.env.WORKBENCH_PORT || 7410;
        const r = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        return j;
      };

      pi.registerTool({
        name: 'rename_entry',
        label: '重命名条目',
        description: '重命名资料库中的文件或文件夹（保留扩展名、同步元数据旁注）。用于用户要求改名时。',
        parameters: Type.Object({
          path: Type.String({ description: '相对路径，如 笔记/第1章.md' }),
          newName: Type.String({ description: '新名称；文件可省略扩展名（自动沿用原扩展名）' }),
        }),
        execute: async (_id, params) => {
          if (!(await hub._confirm(convId, 'rename_entry', params))) {
            return { content: [{ type: 'text', text: '用户取消了此操作' }] };
          }
          const l = lib();
          if (!l) return { content: [{ type: 'text', text: '当前没有打开的资料库' }] };
          try {
            const r = await callLocalApi('/api/file/rename', { path: params.path, newName: params.newName, dsId: l.id });
            return { content: [{ type: 'text', text: `已重命名为 ${r.path}` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: '重命名失败：' + (e.message || e) }], isError: true };
          }
        },
      });

      pi.registerTool({
        name: 'move_entry',
        label: '移动条目',
        description: '把资料库中的文件或文件夹移动到另一个目录（元数据旁注与备份随迁）。用户要求整理文件结构时使用。',
        parameters: Type.Object({
          path: Type.String({ description: '相对路径' }),
          targetDir: Type.String({ description: '目标目录相对路径；传空字符串表示资料库根目录' }),
        }),
        execute: async (_id, params) => {
          if (!(await hub._confirm(convId, 'move_entry', params))) {
            return { content: [{ type: 'text', text: '用户取消了此操作' }] };
          }
          const l = lib();
          if (!l) return { content: [{ type: 'text', text: '当前没有打开的资料库' }] };
          try {
            const r = await callLocalApi('/api/file/move', { path: params.path, targetDir: params.targetDir, dsId: l.id });
            return { content: [{ type: 'text', text: `已移动到 ${r.path}` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: '移动失败：' + (e.message || e) }], isError: true };
          }
        },
      });

      // ---------- 图像生成 ----------
      pi.registerTool({
        name: 'generate_image',
        label: '生成图片',
        description: [
          '根据文字描述生成图片（调用 UniAPI 图像模型），生成后返回图片 URL，界面会直接显示。',
          '适用：配图、插图、封面、示意图。不适用：图表、UI 界面、带精确数值的图。',
          '若画面需要文字，把文字原样写进 prompt 并加引号；不需要文字时明确写「画面中不要出现任何文字」。',
        ].join(' '),
        parameters: Type.Object({
          prompt: Type.String({ description: '画面描述（越具体越好：主体、风格、配色、构图、光照）' }),
          size: Type.Optional(Type.Union([Type.Literal('1024x1024'), Type.Literal('1024x1536'), Type.Literal('1536x1024'), Type.Literal('auto')], { description: '尺寸：方形/竖版/横版/自动，默认方形' })),
        }),
        execute: async (_id, params) => {
          if (!(await hub._confirm(convId, 'generate_image', params))) {
            return { content: [{ type: 'text', text: '用户取消了此操作' }] };
          }
          if (!uniapiKey()) {
            return { content: [{ type: 'text', text: '图像生成未配置：缺少 UniAPI 密钥（~/.config/uniapi/config.json 或 UNIAPI_API_KEY）' }] };
          }
          try {
            const r = await generateImage({
              prompt: params.prompt,
              size: params.size || '1024x1024',
              dataDir: hub.dataDir,
            });
            // 返回 markdown 图片，前端 MarkdownMsg 直接渲染
            return {
              content: [{ type: 'text', text: `已生成图片（${Math.round(r.bytes / 1024)} KB）：\n\n![${params.prompt.slice(0, 40)}](${r.url})` }],
            };
          } catch (e) {
            return { content: [{ type: 'text', text: '生成失败：' + (e.message || e) }], isError: true };
          }
        },
      });

      // ---------- 软件设置 ----------
      const settingsCtx = () => ({
        hub,
        lib: lib(),
        ragManager: hub.ragManager,
        emit: (obj) => hub._emit(convId, obj),
        addOrActivateLibrary: hub.addOrActivateLibrary,
        removeLibrary: hub.removeLibrary,
      });

      pi.registerTool({
        name: 'settings_get',
        label: '读取设置',
        description: `读取 Workbench 的当前设置。可选类别：${Object.keys(SETTABLE).join(' / ')}；留空返回全部。`,
        parameters: Type.Object({
          category: Type.Optional(Type.String({ description: `类别：${Object.keys(SETTABLE).join(' / ')}` })),
        }),
        execute: async (_id, params) => {
          try {
            const all = readSettings(settingsCtx());
            const cat = params.category ? String(params.category) : '';
            if (!cat) return { content: [{ type: 'text', text: JSON.stringify(all, null, 2) }] };
            if (!(cat in all)) throw new Error('未知类别: ' + cat);
            return { content: [{ type: 'text', text: JSON.stringify({ [cat]: all[cat] }, null, 2) }] };
          } catch (e) {
            return { content: [{ type: 'text', text: '读取失败：' + (e.message || e) }], isError: true };
          }
        },
      });

      pi.registerTool({
        name: 'settings_set',
        label: '修改设置',
        description: [
          '修改 Workbench 设置。**所有参数类修改都用这个工具**（改检索参数不要用 rag_manage，那个只管构建索引）。先用 settings_get 查看当前值，再只填要改的字段。',
          'category 与可用字段：',
          '- theme：theme（\'A\'=宣纸 / \'B\'=极简 / \'C\'=夜读）',
          '- reading：font、fontSize、lineHeight、paraSpacing、width、codeFontSize',
          '- rag：chunkMaxChars、jsonValueLimit、headingContext、maxLength、topN、rrfK、rrfMin、cosFloor、cosSigma、semanticWeight',
          '- agent：model、thinkingLevel、mode',
          '- collections：action(add/update/remove)、name、dirs',
          '- library：action(add/activate/remove)、baseDir、dsId',
        ].join('\n'),
        parameters: Type.Object({
          category: Type.Union([
            Type.Literal('theme'), Type.Literal('reading'), Type.Literal('rag'),
            Type.Literal('agent'), Type.Literal('collections'), Type.Literal('library'),
          ], { description: '设置类别' }),
          // 外观
          theme: Type.Optional(Type.Union([Type.Literal('A'), Type.Literal('B'), Type.Literal('C')], { description: 'theme 类别：主题' })),
          // 阅读偏好
          font: Type.Optional(Type.Union([Type.Literal('serif'), Type.Literal('sans'), Type.Literal('mono')], { description: 'reading 类别：正文字体' })),
          fontSize: Type.Optional(Type.Number({ description: 'reading 类别：字号 14-32' })),
          lineHeight: Type.Optional(Type.Number({ description: 'reading 类别：行距 1.4-2.4' })),
          paraSpacing: Type.Optional(Type.Number({ description: 'reading 类别：段距 0-2（em）' })),
          width: Type.Optional(Type.Number({ description: 'reading 类别：正文宽度 560-1080（px）' })),
          codeFontSize: Type.Optional(Type.Number({ description: 'reading 类别：代码字号 12-20' })),
          // RAG 参数（扁平）
          chunkMaxChars: Type.Optional(Type.Number({ description: 'rag 类别：单块字数上限 80-4000' })),
          jsonValueLimit: Type.Optional(Type.Number({ description: 'rag 类别：JSON 单值截断 200-10000' })),
          headingContext: Type.Optional(Type.Boolean({ description: 'rag 类别：标题路径是否拼入嵌入文本' })),
          maxLength: Type.Optional(Type.Number({ description: 'rag 类别：嵌入截断 token 128-8192' })),
          topN: Type.Optional(Type.Number({ description: 'rag 类别：每路检索 top-N 5-200' })),
          rrfK: Type.Optional(Type.Number({ description: 'rag 类别：RRF 常数 10-200' })),
          rrfMin: Type.Optional(Type.Number({ description: 'rag 类别：最低融合分 0-0.05' })),
          cosFloor: Type.Optional(Type.Number({ description: 'rag 类别：余弦下限 0-1' })),
          cosSigma: Type.Optional(Type.Number({ description: 'rag 类别：余弦 σ 倍数 0.5-6' })),
          semanticWeight: Type.Optional(Type.Number({ description: 'rag 类别：语义路权重 0.5-3' })),
          // Agent
          model: Type.Optional(Type.String({ description: 'agent 类别：模型名' })),
          thinkingLevel: Type.Optional(Type.Union([Type.Literal('off'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')], { description: 'agent 类别：思考强度' })),
          mode: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('confirm'), Type.Literal('readonly')], { description: 'agent 类别：运行模式' })),
          // 集合 / 资料库
          action: Type.Optional(Type.String({ description: 'collections/library 类别：add / update / remove / activate' })),
          name: Type.Optional(Type.String({ description: 'collections 类别：集合名' })),
          dirs: Type.Optional(Type.Array(Type.String(), { description: 'collections 类别：映射目录数组' })),
          baseDir: Type.Optional(Type.String({ description: 'library 类别：库根目录绝对路径' })),
          dsId: Type.Optional(Type.String({ description: 'library 类别：要移除的库 id' })),
        }),
        execute: async (_id, params) => {
          if (!(await hub._confirm(convId, 'settings_set', params))) {
            return { content: [{ type: 'text', text: '用户取消了此操作' }] };
          }
          try {
            const { category, ...rest } = params;
            const cat = normalizeCategory(category);
            const patch = buildPatch(cat, rest);
            const r = applySettings(settingsCtx(), cat, patch);
            return { content: [{ type: 'text', text: '已应用：' + JSON.stringify(r.applied) + (r.note ? `（${r.note}）` : '') }] };
          } catch (e) {
            return { content: [{ type: 'text', text: '修改失败：' + (e.message || e) }] };
          }
        },
      });

      // ---------- 记忆工具（对用户透明） ----------
      const memCtx = () => ({ agentId: hub.agentId, dsId: hub.currentDsId() });

      pi.registerTool({
        name: 'remember',
        label: '记住',
        description: '把一条值得长期保留的信息写入记忆。用于用户的稳定偏好、跨对话有用的结论、明确约定。不要记一次性问题或可随时查到的事实。',
        parameters: Type.Object({
          fact: Type.String({ description: '要记住的内容，一句话，具体明确' }),
          kind: Type.Optional(Type.Union([Type.Literal('preference'), Type.Literal('knowledge'), Type.Literal('convention')], { description: '偏好/知识/约定' })),
          scope: Type.Optional(Type.Union([Type.Literal('global'), Type.Literal('agent'), Type.Literal('library')], { description: 'global=跨库偏好；agent=你的习性；library=本库知识（默认）' })),
          pinned: Type.Optional(Type.Boolean({ description: '是否固定（永不淘汰且总是注入）。只在你确信未来多次对话都需要时使用' })),
        }),
        execute: async (_id, params) => {
          try {
            const ctx = memCtx();
            const scope = params.scope || 'library';
            if (scope === 'library' && !ctx.dsId) throw new Error('当前没有打开资料库，无法写库记忆');
            const item = hub.memory.addFact(scope, ctx, {
              fact: params.fact,
              kind: params.kind,
              pinned: !!params.pinned,
              source: convId,
            });
            // 容量检查：超限时后台 consolidate（不阻塞本次返回）
            if (hub.memory.needsConsolidate(scope, ctx)) {
              hub._consolidate(scope, ctx).catch(() => {});
            }
            return { content: [{ type: 'text', text: item.duplicate ? '（该内容已在记忆中）' : '已记录' }] };
          } catch (e) {
            return { content: [{ type: 'text', text: '记录失败：' + (e.message || e) }], isError: true };
          }
        },
      });

      pi.registerTool({
        name: 'forget',
        label: '忘记',
        description: '删除或纠正记忆。按 id 精确删除，或按 query 模糊匹配删除。用于纠正记错的内容。',
        parameters: Type.Object({
          id: Type.Optional(Type.String({ description: '记忆 id（精确删除）' })),
          query: Type.Optional(Type.String({ description: '按内容模糊匹配删除' })),
          scope: Type.Optional(Type.Union([Type.Literal('global'), Type.Literal('agent'), Type.Literal('library')], { description: '默认 library' })),
        }),
        execute: async (_id, params) => {
          try {
            const removed = hub.memory.removeFact(params.scope || 'library', memCtx(), { id: params.id, query: params.query });
            return { content: [{ type: 'text', text: removed.length ? `已删除 ${removed.length} 条记忆` : '没有匹配到要删除的记忆' }] };
          } catch (e) {
            return { content: [{ type: 'text', text: '删除失败：' + (e.message || e) }], isError: true };
          }
        },
      });

      pi.registerTool({
        name: 'recall',
        label: '回忆',
        description: '检索此前的记忆条目。query 留空则返回最近的记忆（用于回答「你记得什么」）；有关键词则按相关性检索。注意：这是记忆检索，与检索文档语料的 rag_search 不同。',
        parameters: Type.Object({
          query: Type.String({ description: '检索关键词；留空则列出最近记忆' }),
          scope: Type.Optional(Type.Union([Type.Literal('global'), Type.Literal('agent'), Type.Literal('library'), Type.Literal('all')], { description: '默认 all（三层都查）' })),
          limit: Type.Optional(Type.Number({ description: '返回条数上限，默认 8' })),
        }),
        execute: async (_id, params) => {
          try {
            const hits = hub.memory.recall(params.scope || 'all', memCtx(), params.query, params.limit || 8);
            if (!hits.length) return { content: [{ type: 'text', text: '记忆中没有相关条目' }] };
            const lines = hits.map((h) => `- [${h.scope}] ${h.fact}${h.pinned ? '（固定）' : ''}`);
            return { content: [{ type: 'text', text: lines.join('\n') }] };
          } catch (e) {
            return { content: [{ type: 'text', text: '检索失败：' + (e.message || e) }], isError: true };
          }
        },
      });

      pi.registerTool({
        name: 'consolidate',
        label: '整理记忆',
        description: '把某层的记忆条目压缩重写为摘要。当记忆积累较多、或用户要求整理记忆时使用。',
        parameters: Type.Object({
          scope: Type.Optional(Type.Union([Type.Literal('global'), Type.Literal('agent'), Type.Literal('library')], { description: '默认 library' })),
        }),
        execute: async (_id, params) => {
          try {
            const r = await hub._consolidate(params.scope || 'library', memCtx());
            return { content: [{ type: 'text', text: `已整理：摘要 ${r.summaryChars} 字，保留 ${r.kept} 条记忆${r.dropped ? `，压缩归档 ${r.dropped} 条` : ''}` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: '整理失败：' + (e.message || e) }], isError: true };
          }
        },
      });
    };
  }

  _emit(convId, obj) {
    const entry = this.live.get(convId);
    if (!entry) return;
    for (const res of entry.sse) {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 断开 */ }
    }
  }

  async _ensureSession(convId) {
    let entry = this.live.get(convId);
    if (entry) return entry;
    if (!this.endpointReady()) throw new Error('生成端点未配置（去 Agent 设置页配置）');
    const runtime = await this._runtime();
    const model = runtime.getModel('workbench', this.llm().model);
    if (!model) throw new Error(`模型 ${this.llm().model} 未注册（检查端点配置）`);
    const cwd = this.getLib()?.baseDir || this.dataDir;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      systemPromptOverride: () => [
        // Agent 定义（AGENTS.md，用户可编辑）
        ...(() => {
          try {
            const md = this._loadAgentsMd();
            return md ? [md, ''] : [];
          } catch {
            return [];
          }
        })(),
        ...(() => {
          // 三层记忆注入：全局 + Agent + 库(summary+pinned)
          try {
            const section = buildMemorySection(this.memory, { agentId: this.agentId, dsId: this.currentDsId() });
            return section ? [section, ''] : [];
          } catch {
            return [];
          }
        })(),
        '',
        '## 工具使用规则（对用户完全透明——绝不提及工具名称或使用过程）',
        '- 回答语料问题前，自行检索（语义用 rag_search，关键词用 search_corpus），基于命中段落作答。',
        '- 答案中标注出处为 [文件名.ext] 格式（如 [第1章 入门.md]），不要说「根据 rag_search 的结果」。',
        '- 需要看全文时自行读取，不要告诉用户「我用 read_doc 读取了文件」。',
        '- 要用户查看某文档时直接给出文件名引用（自动可点击跳转），不要说「你可以用 open_doc 打开」。',
        '- 管理操作（重建索引等）直接执行后报告结果，不要列出可用的工具或命令。',
        '',
        '## 记忆',
        '- 遇到值得长期记住的信息（用户的稳定偏好、跨对话有用的结论、明确约定）时，静默调用 remember。',
        '- 只有确信「未来多次对话都需要」时才设 pinned=true（每层上限 20 条）。',
        '- 一次性问题、可随时从语料查到的事实不要记（那些用 rag_search）。',
        '- 发现记错时用 forget 纠正，不要追加「更正」条目。',
        '- 记不清以前记过什么时用 recall 检索本库记忆。',
        '- 记忆操作对用户透明：不说「我记住了」「已写入记忆」，除非用户明确问起。',
        '- 记忆作用域判断（重要）：',
        '  · scope=global：用户对「你如何回答」的偏好（语言、风格、格式、结论先行等），在任何资料库都适用',
        '  · scope=agent：你自己的工作习性（比如总是先查索引再回答）',
        '  · scope=library（默认）：只与当前资料库内容有关的知识',
        '- 拿不准时：涉及「用户希望我怎么回答」→ global；涉及「这个库里有什么」→ library。',
        '',
        '## Shell 执行',
        '- 可以执行 shell 命令完成批量操作（跑脚本、处理文件、调用本机工具），工作目录是语料库根目录。',
        '- 执行破坏性命令（删除、覆盖、移动语料外文件）前先说明要做什么。',
        '- 对用户透明：说「已跑完提取」「已生成列表」，不要说「我用 bash 执行了 xxx」。',
        '',
        '## 图像生成',
        '- 用户要配图/插图/封面时，用 generate_image 生成（描述要具体：主体、风格、配色、构图）。',
        '- 生成后直接说「已生成」并给出图片，不要复述 prompt。',
        '',
        '## 软件设置',
        '- 用户要改界面/阅读/检索/Agent 设置时，用 settings_set（改前可先 settings_get 查看当前值）。',
        '- 常用：改主题 → settings_set(category="theme", theme="A|B|C")；改字号 → settings_set(category="reading", fontSize=20)；',
        '  改检索条数/切块大小等**参数** → settings_set(category="rag", topN=50)；注意：rag_manage 只用于重建/暂停索引，不用于改参数；',
        '  改模型 → settings_set(category="agent", model="...")；',
        '  改运行模式 → settings_set(category="agent", mode="auto|confirm|readonly")。',
        '- 改完直接告诉用户「已切换/已调整」，不要复述参数。',
        '',
        '## Skills 使用规则',
        '- 如果用户的任务匹配某个 skill（如分析文档、生成报告等），可以读取该 skill 的 SKILL.md 了解如何执行，然后按 skill 指引操作。',
        '- 用户可以直接在对话中发送 skill 的 zip 包路径，你收到后用 open_doc 打开查看内容。',
        '',
        '## 系统固定规则（优先级高于以上 AGENTS.md 中的同类表述）',
        '- 回答用中文，简洁分层，用 markdown 格式。',
        '- 语料中没有依据时明确说明，不编造。',
        '- 绝不在回答中出现「工具」「rag_search」「search_corpus」「read_doc」等系统术语。',
        '- 绝不向用户展示工具调用的参数、格式或使用方法。',
      ].join('\n'),
      appendSystemPromptOverride: () => [],
      extensionFactories: [this._workbenchToolsFactory(convId), createMcpExtension()],
    });
    await loader.reload();
    const settings = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } });
    // pi 会话文件与对话投影同目录：knowledge/<dsId>/conversations/<agentId>/
    const convMeta = this._meta().conversations.find((c) => c.id === convId);
    if (convMeta && convMeta.dsId !== this.currentDsId()) {
      throw new Error('对话所属资料库与当前资料库不一致');
    }
    const convDsId = convMeta?.dsId || this.currentDsId() || 'default';
    const sessionDir = this._convDir(convDsId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionManager = SessionManager.create(cwd, sessionDir);
    // 会话文件名与 convId 对齐：pi 默认生成自己的文件名；此处接受 pi 命名，投影按 convId 存
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.agentDir,
      // 工具白名单（全局，内置+自定义都受控）：pi 默认的 edit/write 不启用——
      // 那是全机任意写；语料内写入一律走 save_note/rename_entry 等专用工具。
      // read 保留（skills/引用文件），bash 保留（shell 执行，confirm 模式需确认）。
      tools: TOOL_NAMES,
      model,
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager,
      thinkingLevel: this.llm().thinkingLevel || 'off',
    });
    entry = { session, sse: new Set(), busy: false, curText: '', curTools: [], curThinking: '', curUsage: null, curCompactions: [] };
    // 会话级事件订阅：所有轮次（含 steering 追加轮）的事件都经此转发
    entry.unsubscribe = session.subscribe((event) => {
      this._onEvent(convId, entry, event);
    });
    this.live.set(convId, entry);
    return entry;
  }

  /** 会话级事件处理：转发到全部 SSE 连接，agent_settled 时收尾 */
  _onEvent(convId, entry, event) {
    const send = (obj) => {
      for (const res of entry.sse) {
        try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 断开 */ }
      }
    };
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      entry.curText += event.assistantMessageEvent.delta;
      send({ t: 'delta', v: event.assistantMessageEvent.delta });
    } else if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'thinking_delta') {
      entry.curThinking = (entry.curThinking || '') + event.assistantMessageEvent.delta;
      send({ t: 'thinking', v: event.assistantMessageEvent.delta });
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      // 错误常作为消息事件返回，prompt() 不一定抛异常。等自动恢复结束再决定是否报错。
      entry.lastFailure = event.message.stopReason === 'error'
        ? agentFailure(event.message.errorMessage || '模型返回错误')
        : event.message.stopReason === 'aborted' ? agentFailure('', 'cancelled') : null;
      const u = event.message.usage;
      if (u) {
      entry.curUsage = {
        input: (entry.curUsage?.input || 0) + (u.input || 0),
        output: (entry.curUsage?.output || 0) + (u.output || 0),
        cacheRead: (entry.curUsage?.cacheRead || 0) + (u.cacheRead || 0),
        cacheWrite: (entry.curUsage?.cacheWrite || 0) + (u.cacheWrite || 0),
      };
      send({ t: 'usage', usage: entry.curUsage });
      }
    } else if (event.type === 'compaction_start') {
      send({ t: 'compaction', phase: 'start', reason: event.reason });
    } else if (event.type === 'compaction_end') {
      const r = event.result;
      // 压缩信息记入本轮，随 assistant 消息落盘（前端渲染为分隔条）
      entry.curCompactions = entry.curCompactions || [];
      entry.curCompactions.push({
        reason: event.reason || 'threshold',
        tokensBefore: r?.tokensBefore ?? null,
        tokensAfter: r?.estimatedTokensAfter ?? null,
        aborted: !!event.aborted,
        error: event.errorMessage || null,
        at: nowIso(),
      });
      send({
        t: 'compaction',
        phase: 'end',
        reason: event.reason,
        tokensBefore: r?.tokensBefore ?? null,
        tokensAfter: r?.estimatedTokensAfter ?? null,
        aborted: !!event.aborted,
      });
    } else if (event.type === 'tool_execution_start') {
      const item = { id: event.toolCallId, name: event.toolName, args: event.args, summary: '', isError: false, durationMs: 0 };
      entry.curTools.push(item);
      send({ t: 'tool_start', name: event.toolName, args: event.args, callId: event.toolCallId });
    } else if (event.type === 'tool_execution_end') {
      const summary = this._toolSummary(event.toolName, event.result);
      const item = entry.curTools.find((x) => x.id === event.toolCallId);
      if (item) {
        item.summary = summary;
        item.isError = event.isError;
        item.durationMs = event.durationMs;
      }
      send({ t: 'tool_end', name: event.toolName, callId: event.toolCallId, summary, isError: event.isError, durationMs: event.durationMs });
    } else if (event.type === 'agent_settled') {
      // 全部自动恢复/排队工作结束：写投影、关 SSE、清 busy
      entry.busy = false;
      const failure = entry.lastFailure || (!entry.curText.trim() ? agentFailure('', 'empty') : undefined);
      if (failure) send({ t: 'error', message: failure.message, failure });
      this._append(convId, { role: 'assistant', text: entry.curText, failure, tools: entry.curTools, thinking: entry.curThinking || '', usage: entry.curUsage, compactions: entry.curCompactions || [], at: nowIso() });
      this._touch(convId);
      send({ t: 'done' });
      for (const res of entry.sse) {
        try { res.end(); } catch { /* 已断开 */ }
      }
      entry.sse.clear();
      entry.curText = '';
      entry.curTools = [];
      entry.curCompactions = [];
    }
  }

  /** SSE 聊天：注册响应流，prompt 或 steer（生成中插入指令），事件经会话级订阅转发 */
  /** 组装文档上下文文本（注入为 aside，不进用户消息本体） */
  _docContextText(doc) {
    const lib = this.getLib();
    const lines = [`用户当前正在阅读文档「${doc.name || doc.path}」（路径：${doc.path}）。`];
    try {
      if (lib) {
        const t = loadTopics(lib.baseDir).byPath.get(doc.path);
        if (t?.topics?.length) lines.push(`该文档的主题：${t.topics.join('、')}。`);
        if (t?.concepts?.length) lines.push(`该文档的核心概念：${t.concepts.join('、')}。`);
      }
    } catch { /* 无加工数据时只有路径 */ }
    lines.push('若问题与这篇文档相关，结合文档内容回答；需要看原文时自行读取该文档。');
    return lines.join('\n');
  }

  async chat(convId, text, res, images = [], docContext = null) {
    // 库隔离硬校验：对话绑定的资料库必须与当前激活库一致，否则拒绝
    //（否则会复用旧库的 session 上下文，导致回答串库）
    const convMeta = this._meta().conversations.find((c) => c.id === convId);
    if (!convMeta) throw new Error('对话不存在');
    const activeDs = this.currentDsId();
    if (!activeDs) throw new Error('当前没有打开的资料库');
    if (convMeta.dsId !== activeDs) {
      throw new Error('该对话属于另一个资料库，当前资料库不能继续这个对话。请新建对话。');
    }
    const entry = await this._ensureSession(convId);
    // 文档上下文：与上次不同时注入 aside（custom 消息，随下一条 prompt 发给模型，不进我们的历史文件）
    if (docContext?.path && docContext.path !== convMeta.docPath) {
      try {
        await entry.session.sendCustomMessage(
          { customType: 'doc-context', display: false, content: [{ type: 'text', text: this._docContextText(docContext) }] },
          { deliverAs: 'nextTurn' }
        );
      } catch (e) { console.error('[agent] 文档上下文注入失败:', e.message); }
      const m = this._meta();
      const c = m.conversations.find((x) => x.id === convId);
      if (c) { c.docPath = docContext.path; this._saveMeta(m); }
    }
    entry.sse.add(res);
    const send = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 断开 */ }
    };
    send({ t: 'start' });
    const imageMeta = images.map((im) => ({ mimeType: im.mimeType, bytes: Math.round((im.data?.length || 0) * 0.75) }));
    this._append(convId, { role: 'user', text, images: imageMeta, at: nowIso() });
    this._touch(convId, this._autoTitle(convId, text));

    if (entry.busy) {
      // Steering：当前轮结束后插入，响应在同一 SSE 流上继续
      try {
        const result = await entry.session.steer(text);
        send({ t: 'steered', message: '已插入到当前生成' });
        // 不关 SSE——agent_settled 时由会话级订阅统一收尾
      } catch (e) {
        send({ t: 'error', message: '插入失败：' + String(e.message || e) });
        try { res.end(); } catch { /* */ }
        entry.sse.delete(res);
      }
      return;
    }

    entry.busy = true;
    entry.curText = '';
    entry.curTools = [];
    entry.curCompactions = [];
    entry.lastFailure = null;
    entry.curThinking = '';
    entry.curUsage = null;
    try {
      // images: [{ data(base64), mimeType }] —— pi 原生支持图片附件
      const promptOpts = images.length ? { images } : undefined;
      await entry.session.prompt(text, promptOpts);
      // prompt() 在 run 完成时 resolve；SSE 由 agent_settled 关闭（自动恢复可能追加轮次）
      // 若 agent_settled 已触发但 SSE 未关（时序差），兜底关闭
      if (entry.sse.has(res) && !entry.busy) {
        send({ t: 'done' });
        try { res.end(); } catch { /* */ }
        entry.sse.delete(res);
      }
    } catch (e) {
      if (!entry.busy) return; // agent_settled 已持久化并关闭响应，避免重复写入
      const failure = agentFailure(e);
      send({ t: 'error', message: failure.message, failure });
      // 兜底收尾：失败提示和部分正文一并持久化，重新打开对话仍可见
      entry.busy = false;
      this._append(convId, { role: 'assistant', text: entry.curText, failure, tools: entry.curTools, thinking: entry.curThinking || '', usage: entry.curUsage, compactions: entry.curCompactions || [], at: nowIso() });
      send({ t: 'done' });
      try { res.end(); } catch { /* */ }
      entry.sse.delete(res);
    }
  }

  _toolSummary(name, result) {
    try {
      const text = result?.content?.[0]?.text || '';
      const flat = String(text).replace(/\s+/g, ' ');
      return flat.slice(0, 160) + (flat.length > 160 ? '…' : '');
    } catch {
      return '';
    }
  }

  _autoTitle(convId, text) {
    const m = this._meta();
    const c = m.conversations.find((x) => x.id === convId);
    if (c && (c.title === '新对话' || !c.title)) return text.replace(/\s+/g, ' ').slice(0, 18);
    return undefined;
  }

  /** 会话分叉：从 uptoIndex（含）复制投影到新会话 */
  forkConversation(convId, uptoIndex) {
    const hist = this.history(convId);
    const slice = hist.slice(0, uptoIndex + 1);
    if (!slice.length) return null;
    const newConv = this.newConversation(slice[slice.length - 1]?.text?.slice(0, 18) + '（分叉）');
    for (const m of slice) {
      this._append(newConv.id, m);
    }
    // 把用户消息作为新 prompt 的上下文——不自动发，用户自己发下一条
    return newConv;
  }

  /** 导出对话为 Markdown */
  exportConversation(convId) {
    const hist = this.history(convId);
    const meta = this.listConversations().find((c) => c.id === convId);
    const lines = [`# ${meta?.title || '对话'}

> 导出于 ${new Date().toLocaleString('zh-CN')}
`];
    for (const m of hist) {
      if (m.role === 'user') {
        lines.push(`## 👤 用户

${m.text}
`);
      } else {
        if (m.tools?.length) {
          lines.push(`<details>
<summary>工具调用（${m.tools.length} 次）</summary>

${m.tools.map((t) => `- \`${t.name}\`${t.summary ? ': ' + t.summary.slice(0, 80) : ''}`).join('\n')}

</details>
`);
        }
        lines.push(`## 🤖 助手

${m.text}
`);
      }
    }
    return lines.join('\n');
  }

  /** 模型列表（从端点拉取）。pending 用于「输入框里填了但还没保存」的 baseUrl/apiKey：
      设置面板在保存之前就能拿这对值试拉，避免「先填 key 却因为还没保存而永远 401」。 */
  async listModels(pending = {}) {
    const saved = this.llm();
    const baseUrl = String(pending.baseUrl ?? saved.baseUrl ?? '').trim();
    const apiKey = String(pending.apiKey || saved.apiKey || '');
    if (!baseUrl) return { ok: false, models: [], status: 0, url: '', error: '未填写 baseUrl' };
    const url = baseUrl.replace(/\/+$/, '') + '/models';
    try {
      const r = await fetch(url, {
        headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) {
        let detail = '';
        try {
          const j = await r.json();
          detail = String(j?.error?.message || j?.error || j?.detail || '');
        } catch { /* 非 JSON 错误体 */ }
        return { ok: false, models: [], status: r.status, url, error: modelListError(r.status, url, detail) };
      }
      const j = await r.json();
      const models = (j.data || []).map((m) => m.id).filter(Boolean).slice(0, 50);
      return { ok: true, models, status: r.status, url, error: models.length ? '' : '端点返回了 0 个模型' };
    } catch (e) {
      return { ok: false, models: [], status: 0, url, error: '连接失败：' + String(e?.message || e) };
    }
  }

  /** confirm 模式下：发确认请求到前端，等待 approve/deny（30s 超时自动 deny） */
  _confirm(convId, toolName, args) {
    if (this.mode !== 'confirm') return Promise.resolve(true);
    if (!DESTRUCTIVE_TOOLS.includes(toolName)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const id = 'cf_' + Date.now().toString(36);
      const timer = setTimeout(() => { this._confirmCb.delete(id); resolve(false); }, 30000);
      this._confirmCb.set(id, (ok) => { clearTimeout(timer); resolve(ok); });
      // 推确认事件到该会话的全部 SSE
      const entry = this.live.get(convId);
      if (entry) {
        for (const res of entry.sse) {
          try { res.write(`data: ${JSON.stringify({ t: 'confirm', id, tool: toolName, args })}\n\n`); } catch { /* */ }
        }
      }
    });
  }

  /** 通用 LLM 补全（记忆压缩/摘要用，独立于 pi 会话） */
  async _llmComplete(messages, maxTokens = 800) {
    const c = this.llm();
    if (!this.endpointReady()) throw new Error('生成端点未配置');
    const r = await fetch(c.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(c.apiKey ? { Authorization: 'Bearer ' + c.apiKey } : {}),
      },
      body: JSON.stringify({ model: c.model, messages, temperature: 0.3, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(90000),
    });
    if (!r.ok) throw new Error('LLM 调用失败: HTTP ' + r.status);
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content;
    if (!text) throw new Error('LLM 返回为空');
    return String(text).trim();
  }

  /**
   * 整理某层记忆：facts + 旧 summary → 新 summary，然后裁剪（保留 pinned + 最近 150 条）
   * pinned 内容不再并入 summary（避免重复注入）
   */
  async _consolidate(scope, ctx) {
    const all = this.memory.loadFacts(scope, ctx);
    const prevSummary = this.memory.loadSummary(scope, ctx).trim();
    const compressible = all.filter((f) => !f.pinned);
    if (!compressible.length && !prevSummary) return { summaryChars: prevSummary.length, kept: all.length, dropped: 0 };

    const factsText = compressible.map((f, i) => `${i + 1}. [${f.kind}] ${f.fact}`).join('\n');
    const prompt = [
      '把下列记忆条目整理成摘要，供后续对话参考。',
      '要求：用简短要点列表（每条一行，以「- 」开头）；同类信息合并；保留关键事实与原意；去掉重复与琐碎细节；',
      '用中文；不超过 800 字；不要添加原文没有的信息；不要写「摘要：」之类的前缀。',
      prevSummary ? `\n【已有摘要】\n${prevSummary}` : '',
      `\n【新增记忆条目】\n${factsText}`,
    ].filter(Boolean).join('\n');

    const summary = await this._llmComplete([
      { role: 'system', content: '你是记忆整理助手，只做信息压缩，不编造内容。' },
      { role: 'user', content: prompt },
    ], 900);

    this.memory.saveSummary(scope, ctx, summary);
    const plan = this.memory.planPrune(scope, ctx);
    if (plan.dropped.length) this.memory.applyPrune(scope, ctx, plan.kept);
    return { summaryChars: summary.length, kept: plan.kept.length, dropped: plan.dropped.length };
  }

  /**
   * 切库钩子：销毁属于其他资料库的运行时 session。
   * session 的 cwd / system prompt（含库记忆）在创建时固定，跨库复用必然串上下文。
   */
  onLibSwitch() {
    const activeDs = this.currentDsId();
    for (const [convId, entry] of this.live) {
      const meta = this._meta().conversations.find((c) => c.id === convId);
      if (!meta || meta.dsId !== activeDs) {
        try { entry.session.abort?.(); } catch { /* */ }
        try { if (entry.unsubscribe) entry.unsubscribe(); } catch { /* */ }
        try { entry.session.dispose(); } catch { /* */ }
        this.live.delete(convId);
      }
    }
  }

  async abort(convId) {
    const entry = this.live.get(convId);
    if (!entry) return { ok: false, error: '会话不在内存' };
    try {
      await entry.session.abort();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  status() {
    const llm = this.llm();
    return {
      endpoint: {
        baseUrl: llm.baseUrl || '', model: llm.model || '',
        ready: this.endpointReady(), enabled: !!llm.enabled,
        thinkingLevel: llm.thinkingLevel || 'off',
      },
      agentDir: this.agentDir,
      skills: this._listSkills(),
      mcp: this._mcpStatus(),
      tools: TOOL_NAMES,
      mode: this.mode,
      conversations: this.listConversations(),
      folders: this.listFolders(),
    };
  }

  /** 更新设置（model/baseUrl/apiKey/thinkingLevel） */
  updateSettings(patch) {
    const c = this.llm();
    const next = { ...c };
    for (const k of ['baseUrl', 'model', 'apiKey', 'thinkingLevel', 'enabled']) {
      if (k in patch) next[k] = patch[k];
    }
    if (!['off', 'low', 'medium', 'high'].includes(next.thinkingLevel)) next.thinkingLevel = 'off';
    this.ragManager.setLlm(next); // 落盘 + 触发 onLlmChanged → 同步 models.json
    if (patch.baseUrl || patch.model) this._detectContextWindow().catch(() => {});
    // 模式切换：更新活跃会话的工具集
    if (patch.mode && ['auto', 'confirm', 'readonly'].includes(patch.mode)) {
      this.mode = patch.mode;
      this._applyModeToSessions();
    }
    // 思考强度切换：直接改活跃会话
    if (patch.thinkingLevel) {
      for (const [, entry] of this.live) {
        try { entry.session.setThinkingLevel(patch.thinkingLevel); } catch { /* */ }
      }
    }
    this._syncModelsJson();
    return this.status();
  }

  /** 探测端点模型的真实上下文窗口：vLLM(/v1/models 的 max_model_len) → LM Studio(/api/v0/models) → llama.cpp(/props) → Ollama(/api/show)。
      写正 models.json 的 contextWindow 后，pi 会在接近上限时自动压缩历史，避免 400 超窗报错。 */
  async _detectContextWindow() {
    const c = this.llm();
    if (!c.baseUrl || !c.model) return;
    const origin = String(c.baseUrl).replace(/\/v1\/?$/, '');
    const headers = c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {};
    let ctx = 0;
    // vLLM / OpenAI 兼容：GET {baseUrl}/models 里的 max_model_len（vLLM 必报）
    try {
      const r = await fetch(String(c.baseUrl).replace(/\/+$/, '') + '/models', { headers, signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const j = await r.json();
        const m = (j.data || []).find((x) => x.id === c.model);
        ctx = Number(m?.max_model_len) || Number(m?.max_context_length) || 0;
      }
    } catch { /* 端点不支持 */ }
    if (!ctx) try {
      const r = await fetch(origin + '/api/v0/models', { headers, signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const j = await r.json();
        const m = (j.data || []).find((x) => x.id === c.model);
        if (m) ctx = m.loaded_instances?.[0]?.context_length || m.max_context_length || 0;
      }
    } catch { /* 非 LM Studio */ }
    if (!ctx) {
      try {
        const r = await fetch(origin + '/props', { headers, signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          const j = await r.json();
          ctx = j?.default_generation_settings?.n_ctx || 0;
        }
      } catch { /* 非 llama.cpp */ }
    }
    if (!ctx) {
      try {
        const r = await fetch(origin + '/api/show', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: c.model }),
          signal: AbortSignal.timeout(4000),
        });
        if (r.ok) {
          const j = await r.json();
          for (const [k, v] of Object.entries(j.model_info || {})) {
            if (k.endsWith('.context_length') && Number.isFinite(v)) { ctx = v; break; }
          }
        }
      } catch { /* 非 Ollama */ }
    }
    if (ctx && ctx !== this._ctxWindow) {
      this._ctxWindow = ctx;
      this._syncModelsJson(); // contextWindow 变化：重建模型运行时与活跃会话
    }
  }

  _applyModeToSessions() {
    const tools = this.mode === 'readonly' ? READONLY_TOOLS : TOOL_NAMES;
    for (const [, entry] of this.live) {
      try { entry.session.setActiveToolsByName(tools); } catch { /* */ }
    }
  }

  _mcpStatus() {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(this.agentDir, 'mcp.json'), 'utf8'));
      return Object.entries(cfg.mcpServers || {}).map(([name, c]) => ({
        name,
        type: c.url ? 'http' : 'stdio',
        url: c.url || `${c.command || ''} ${(c.args || []).join(' ')}`.trim(),
        enabled: c.enabled !== false,
      }));
    } catch {
      return [];
    }
  }

  _listSkills() {
    const dir = path.join(this.agentDir, 'skills');
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .filter((n) => fs.existsSync(path.join(dir, n, 'SKILL.md')));
    } catch {
      return [];
    }
  }
}

/** 把端点返回的状态码翻成能直接照着改的提示 */
function modelListError(status, url, detail) {
  const tail = detail ? `（${detail}）` : '';
  if (status === 401 || status === 403) return `HTTP ${status}：密钥验证失败，apiKey 缺失或不正确${tail}`;
  if (status === 404) return `HTTP 404：${url} 不存在。baseUrl 必须填到 /v1 为止（如 https://host/v1），不要漏掉或重复 /v1`;
  if (status >= 500) return `HTTP ${status}：端点内部错误${tail}`;
  return `HTTP ${status}${tail}`;
}

function snapText(lib) {
  const files = lib.scanner.snapshot?.files || [];
  return `${files.length} 个文件`;
}
