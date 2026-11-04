// 字义库路由：挂在 /api/ziyi，全局（不带资料库作用域）
import express, { Router } from 'express';
import { revealInFolder } from './hostOpen.js';

const send = (res, e) => res.status(e.status || 500).json({ error: e.message || String(e), ...(e.code ? { code: e.code } : {}) });

export function mountZiyi(store) {
  const r = Router();
  r.use(async (_req, _res, next) => {
    try {
      await store.ready();
      next();
    } catch (e) {
      next(e);
    }
  });

  r.get('/status', (_req, res) => res.json(store.status()));

  r.get('/search', (req, res) => {
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    res.json(store.search(String(req.query.q || ''), { offset, limit }));
  });

  r.get('/entry', (req, res) => {
    const hit = store.get(String(req.query.han || ''));
    if (!hit) return res.status(404).json({ error: '没有字义' });
    res.json(hit);
  });

  r.get('/lookup', (req, res) => res.json({ items: store.lookup(String(req.query.text || '')) }));

  r.put('/entry', async (req, res) => {
    try {
      res.json({ entry: await store.put(req.body || {}) });
    } catch (e) {
      send(res, e);
    }
  });

  r.delete('/entry', async (req, res) => {
    try {
      await store.remove(String(req.query.han || ''));
      res.json({ ok: true });
    } catch (e) {
      send(res, e);
    }
  });

  // 字义包原始字节（application/zip 或 octet-stream），不走 base64
  r.post('/import', express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '没有收到字义包' });
      const keepEdited = req.query.keepEdited !== '0';
      const name = typeof req.query.name === 'string' ? req.query.name.slice(0, 200) : null;
      res.json(await store.importPack(req.body, { keepEdited, name }));
    } catch (e) {
      send(res, e);
    }
  });

  // body.reveal === false 时不在文件管理器中定位（测试用）
  r.post('/export', async (req, res) => {
    try {
      const file = await store.exportPack();
      if (req.body?.reveal !== false) {
        try { await revealInFolder(file); } catch { /* 定位失败不影响导出 */ }
      }
      res.json({ ok: true, file });
    } catch (e) {
      send(res, e);
    }
  });

  r.delete('/', async (_req, res) => {
    try {
      res.json({ ok: true, backup: await store.uninstall() });
    } catch (e) {
      send(res, e);
    }
  });

  return r;
}
