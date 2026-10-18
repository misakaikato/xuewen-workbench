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
