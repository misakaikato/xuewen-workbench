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
