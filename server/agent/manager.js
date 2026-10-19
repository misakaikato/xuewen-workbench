// 智能助手：pi agent SDK 桥（AgentHub）。
// 会话生命周期、workbench 工具集（InlineExtension 注册）、SSE 事件流、持久化。
// agentDir = dataDir/agent/（skills/mcp.json/models.json/sessions），与用户全局 ~/.pi 隔离。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createMcpExtension } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';

const CONV_META = 'conversations.json';
const TOOL_NAMES = ['search_corpus', 'rag_search', 'read_doc', 'list_files', 'list_collections', 'corpus_status', 'rag_manage', 'word_to_markdown', 'save_note', 'open_doc'];

function nowIso() {
  return new Date().toISOString();
}

export class AgentHub {
  constructor({ dataDir, getLib, ragManager, getRagConfig }) {
    this.dataDir = dataDir;
    this.agentDir = path.join(dataDir, 'agent');
    this.sessionsDir = path.join(this.agentDir, 'sessions');
    this.convDir = path.join(this.agentDir, 'conversations');
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    fs.mkdirSync(this.convDir, { recursive: true });
    fs.mkdirSync(path.join(this.agentDir, 'skills'), { recursive: true });
    this.getLib = getLib; // (dsId?) => Lib | null（当前库）
    this.ragManager = ragManager;
    this.getRagConfig = getRagConfig; // () => llm 配置 {enabled, baseUrl, model, apiKey}
    this.live = new Map(); // convId → { session, sse:Set, busy, seq }
    this._modelRuntime = null;
    this._syncModelsJson();
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
      return;
    }
    const json = {
      $schema: 'https://pi.dev/schemas/models.schema.json',
      providers: {
        workbench: {
          baseUrl: c.baseUrl.replace(/\/$/, ''),
          api: 'openai-completions',
          apiKey: c.apiKey || 'workbench',
          models: [{ id: c.model, name: c.model, contextWindow: 128000, toolUse: true }],
        },
      },
    };
    fs.writeFileSync(p, JSON.stringify(json, null, 2));
    this._modelRuntime = null; // 端点变了重建 runtime
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

  _meta() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.agentDir, CONV_META), 'utf8'));
    } catch {
      return { conversations: [] };
    }
  }

  _saveMeta(m) {
    fs.writeFileSync(path.join(this.agentDir, CONV_META), JSON.stringify(m, null, 2));
  }

  listConversations() {
    return this._meta().conversations
      .map((c) => ({ ...c, busy: this.live.get(c.id)?.busy || false }))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  newConversation(title) {
    const id = crypto.randomBytes(6).toString('hex');
    const m = this._meta();
    const conv = { id, title: title || '新对话', createdAt: nowIso(), updatedAt: nowIso() };
    m.conversations.push(conv);
    this._saveMeta(m);
    fs.writeFileSync(this._convFile(id), '');
    return conv;
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
    // pi 会话文件（sessions/<id>.jsonl）一并清
    try { fs.unlinkSync(path.join(this.sessionsDir, id + '.jsonl')); } catch { /* 忽略 */ }
    return { ok: true };
  }

  _convFile(id) {
    return path.join(this.convDir, id + '.jsonl');
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
        description: '管理语义索引：build（增量构建/续建）、rebuild（全量重建）、pause（暂停）。构建是后台任务，用 corpus_status 查进度。',
        parameters: Type.Object({ action: Type.Union([Type.Literal('build'), Type.Literal('rebuild'), Type.Literal('pause')]) }),
        execute: async (_id, params) => {
          const l = lib();
          if (!l) return { content: [{ type: 'text', text: '当前没有打开的资料库' }] };
          if (params.action === 'pause') {
            hub.ragManager.pause(l.id);
            return { content: [{ type: 'text', text: '已请求暂停' }] };
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
            const colsData = JSON.parse(fs.readFileSync(path.join(hub.dataDir, 'sources', l.id, 'collections.json'), 'utf8'));
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
    if (!this.endpointReady()) throw new Error('生成端点未配置（去 RAG 管理页配置 OpenAI 兼容端点）');
    const runtime = await this._runtime();
    const model = runtime.getModel('workbench', this.llm().model);
    if (!model) throw new Error(`模型 ${this.llm().model} 未注册（检查端点配置）`);
    const cwd = this.getLib()?.baseDir || this.dataDir;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      systemPromptOverride: () => [
        '你是「学问 Workbench」的内嵌助手，帮助用户在自己的资料库中检索、阅读、问答与管理。',
        '回答语料内容问题时，先用 rag_search（语义问题）或 search_corpus（关键词）检索，再基于命中段落作答，并标注出处文件名（如 [第1章 入门.md]）。',
        '语料中没有依据时明确说明，不编造。需要看全文用 read_doc；要用户看某文档时用 open_doc。',
        '你也可以用 corpus_status / rag_manage 查询和管理资料库状态。回答用中文，简洁分层。',
      ].join('\n'),
      appendSystemPromptOverride: () => [],
      extensionFactories: [this._workbenchToolsFactory(convId), createMcpExtension()],
    });
    await loader.reload();
    const settings = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } });
    const sessionManager = SessionManager.create(cwd, this.sessionsDir);
    // 会话文件名与 convId 对齐：pi 默认生成自己的文件名；此处接受 pi 命名，投影按 convId 存
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.agentDir,
      model,
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager,
      thinkingLevel: 'off',
    });
    entry = { session, sse: new Set(), busy: false, curText: '', curTools: [] };
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
      this._append(convId, { role: 'assistant', text: entry.curText || '（无输出）', tools: entry.curTools, at: nowIso() });
      this._touch(convId);
      send({ t: 'done' });
      for (const res of entry.sse) {
        try { res.end(); } catch { /* 已断开 */ }
      }
      entry.sse.clear();
      entry.curText = '';
      entry.curTools = [];
    }
  }

  /** SSE 聊天：注册响应流，prompt 或 steer（生成中插入指令），事件经会话级订阅转发 */
  async chat(convId, text, res) {
    const entry = await this._ensureSession(convId);
    entry.sse.add(res);
    const send = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 断开 */ }
    };
    send({ t: 'start' });
    this._append(convId, { role: 'user', text, at: nowIso() });
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
    try {
      await entry.session.prompt(text);
      // prompt() 在 run 完成时 resolve；SSE 由 agent_settled 关闭（自动恢复可能追加轮次）
      // 若 agent_settled 已触发但 SSE 未关（时序差），兜底关闭
      if (entry.sse.has(res) && !entry.busy) {
        send({ t: 'done' });
        try { res.end(); } catch { /* */ }
        entry.sse.delete(res);
      }
    } catch (e) {
      send({ t: 'error', message: String(e.message || e) });
      entry.curText += `\n\n（出错：${e.message || e}）`;
      // 兜底收尾
      entry.busy = false;
      this._append(convId, { role: 'assistant', text: entry.curText || '（无输出）', tools: entry.curTools, at: nowIso() });
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
      endpoint: { baseUrl: llm.baseUrl || '', model: llm.model || '', ready: this.endpointReady(), enabled: !!llm.enabled },
      agentDir: this.agentDir,
      skills: this._listSkills(),
      mcp: this._mcpStatus(),
      tools: TOOL_NAMES,
      conversations: this.listConversations(),
    };
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

function snapText(lib) {
  const files = lib.scanner.snapshot?.files || [];
  return `${files.length} 个文件`;
}
