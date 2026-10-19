// 智能助手路由：SSE 聊天流 + 会话 CRUD + 状态
import { Router } from 'express';

export function mountAgent(hub, resolveLib) {
  const r = Router();

  r.get('/status', (_req, res) => {
    res.json(hub.status());
  });

  r.post('/session', (req, res) => {
    res.json(hub.newConversation(req.body?.title));
  });

  r.get('/session/:id', (req, res) => {
    const meta = hub.listConversations().find((c) => c.id === req.params.id);
    if (!meta) return res.status(404).json({ error: '会话不存在' });
    res.json({ ...meta, messages: hub.history(req.params.id) });
  });

  r.delete('/session/:id', (req, res) => {
    res.json(hub.deleteConversation(req.params.id));
  });

  r.post('/fork', (req, res) => {
    const { sessionId, uptoIndex } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: '缺少 sessionId' });
    const conv = hub.forkConversation(sessionId, Number(uptoIndex) || 0);
    if (!conv) return res.status(400).json({ error: '无法分叉（历史为空）' });
    res.json(conv);
  });

  r.get('/export/:id', (req, res) => {
    const md = hub.exportConversation(req.params.id);
    if (!md) return res.status(404).json({ error: '会话不存在' });
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(md);
  });

  // confirm 模式：客户端确认/拒绝工具执行
  r.post('/confirm', (req, res) => {
    const { id, approved } = req.body || {};
    const cb = hub._confirmCb.get(String(id || ''));
    if (cb) {
      hub._confirmCb.delete(String(id || ''));
      cb(!!approved);
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: '确认请求不存在或已超时' });
    }
  });

  r.put('/settings', (req, res) => {
    res.json(hub.updateSettings(req.body || {}));
  });

  // 编辑/删除投影中的消息（display 层——LLM 上下文不回滚，仅 UI 展示变化）
  r.put('/session/:id/message/:idx', (req, res) => {
    const { text } = req.body || {};
    const id = req.params.id;
    const idx = Number(req.params.idx);
    const hist = hub.history(id);
    if (idx < 0 || idx >= hist.length) return res.status(404).json({ error: '消息不存在' });
    hist[idx].text = String(text || '');
    // 重写整个投影文件
    const fs = require('node:fs');
    const path = require('node:path');
    fs.writeFileSync(hub._convFile(id), hist.map((m) => JSON.stringify(m)).join('\n') + '\n');
    res.json({ ok: true });
  });

  r.delete('/session/:id/message/:idx', (req, res) => {
    const id = req.params.id;
    const idx = Number(req.params.idx);
    const hist = hub.history(id);
    if (idx < 0 || idx >= hist.length) return res.status(404).json({ error: '消息不存在' });
    hist.splice(idx, 1);
    const fs = require('node:fs');
    fs.writeFileSync(hub._convFile(id), hist.map((m) => JSON.stringify(m)).join('\n') + '\n');
    res.json({ ok: true });
  });

  // Skill 管理
  r.post('/skill', async (req, res) => {
    const { name, content } = req.body || {};
    if (!name || !content) return res.status(400).json({ error: '缺少 name 或 content' });
    const fs = require('node:fs');
    const path = require('node:path');
    const safe = name.replace(/[^\w\u4e00-\u9fff-]/g, '_');
    const dir = path.join(hub.agentDir, 'skills', safe);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
      res.json({ ok: true, path: `skills/${safe}/SKILL.md` });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  r.delete('/skill/:name', (req, res) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(hub.agentDir, 'skills', req.params.name);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // MCP 服务器管理（读写 mcp.json）
  r.post('/mcp-server', (req, res) => {
    const { name, config } = req.body || {};
    if (!name || !config) return res.status(400).json({ error: '缺少 name 或 config' });
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.join(hub.agentDir, 'mcp.json');
    try {
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* */ }
      if (!cfg.mcpServers) cfg.mcpServers = {};
      cfg.mcpServers[name] = config;
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  r.delete('/mcp-server/:name', (req, res) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.join(hub.agentDir, 'mcp.json');
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete (cfg.mcpServers || {})[req.params.name];
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  r.get('/models', async (_req, res) => {
    res.json(await hub.listModels());
  });

  r.post('/abort', (req, res) => {
    res.json(hub.abort(String(req.body?.sessionId || '')));
  });

  // SSE 聊天：POST /api/agent/chat {sessionId, text} → text/event-stream
  r.post('/chat', async (req, res) => {
    const { sessionId, text } = req.body || {};
    if (!sessionId || !String(text || '').trim()) {
      return res.status(400).json({ error: '缺少 sessionId 或 text' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ t: 'open' })}\n\n`);
    try {
      await hub.chat(sessionId, String(text).trim(), res);
    } catch (e) {
      try {
        res.write(`data: ${JSON.stringify({ t: 'error', message: String(e.message || e) })}\n\n`);
        res.write(`data: ${JSON.stringify({ t: 'done' })}\n\n`);
        res.end();
      } catch { /* 已断开 */ }
    }
  });

  return r;
}
