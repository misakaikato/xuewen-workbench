// RAG 路由：挂在主 Express app（与现有 /api/* 同构，resolveLib 语义）
import { Router } from 'express';

export function mountRag(manager, resolveLib) {
  const r = Router();

  const needLib = (req, res) => {
    const lib = resolveLib(req);
    if (!lib) {
      res.status(409).json({ error: '尚未打开资料库' });
      return null;
    }
    return lib;
  };

  r.get('/status', (req, res) => {
    const lib = needLib(req, res);
    if (!lib) return;
    res.json({ dsId: lib.id, ...manager.status(lib.id) });
  });

  r.post('/model/download', async (_req, res) => {
    res.json(await manager.embed.download());
  });

  r.post('/model/import', async (req, res) => {
    const dir = req.body && req.body.dir;
    if (!dir) return res.status(400).json({ error: '缺少 dir' });
    res.json(await manager.embed.importDir(dir));
  });

  r.post('/index/build', async (req, res) => {
    const lib = needLib(req, res);
    if (!lib) return;
    const rebuild = !!(req.body && req.body.rebuild);
    // 立即返回，进度走 status 轮询
    manager.build(lib.id, { rebuild }).catch(() => {});
    res.json({ ok: true });
  });

  r.post('/index/pause', (req, res) => {
    const lib = needLib(req, res);
    if (!lib) return;
    res.json(manager.pause(lib.id));
  });

  r.post('/search', async (req, res) => {
    const lib = needLib(req, res);
    if (!lib) return;
    const q = String((req.body && req.body.q) || '').trim();
    if (!q) return res.json({ hits: [], took: 0, backend: manager.embed.backend });
    try {
      const r = await manager.search(lib.id, q, Number(req.body.limit) || 20);
      res.json({ dsId: lib.id, ...r });
    } catch (e) {
      res.status(409).json({ error: String(e.message || e) });
    }
  });

  r.get('/llm', (_req, res) => {
    res.json({ ...manager.llm, apiKey: undefined });
  });

  r.put('/llm', (req, res) => {
    const b = req.body || {};
    for (const k of ['enabled', 'baseUrl', 'model', 'apiKey']) {
      if (k in b) manager.llm[k] = b[k];
    }
    res.json({ ok: true, llm: { ...manager.llm, apiKey: undefined } });
  });

  r.post('/llm/test', async (_req, res) => {
    res.json(await manager.llmTest());
  });

  return r;
}
