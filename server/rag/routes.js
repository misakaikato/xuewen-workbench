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

  r.post('/model/download', async (req, res) => {
    const force = !!(req.body && req.body.force);
    res.json(await manager.embed.download({ force }));
  });

  r.post('/model/import', (req, res) => {
    const dir = req.body && req.body.dir;
    if (!dir) return res.status(400).json({ error: '缺少 dir' });
    // 同步校验参数（缺文件/目录不存在立即报错），复制在后台跑（进度走 status 轮询）
    res.json(manager.embed.importDir(dir));
  });

  r.post('/model/cancel', (_req, res) => {
    res.json(manager.embed.cancel());
  });

  r.post('/index/build', (req, res) => {
    const lib = needLib(req, res);
    if (!lib) return;
    const rebuild = !!(req.body && req.body.rebuild);
    // 前置检查同步执行：失败返回 409 且错误进入状态；通过则后台构建，立即返回
    const pre = manager.index(lib.id).begin();
    if (!pre.ok) return res.status(409).json({ error: pre.error });
    if (!pre.already) {
      manager.startBuild(lib.id, rebuild).catch((e) => console.error('[rag] 构建异常退出: ' + (e?.message || e)));
    }
    res.json({ ok: true, already: !!pre.already });
  });

  r.post('/index/pause', (req, res) => {
    const lib = needLib(req, res);
    if (!lib) return;
    res.json(manager.pause(lib.id));
  });

  r.get('/config', (req, res) => {
    const lib = needLib(req, res);
    if (!lib) return;
    res.json({ dsId: lib.id, config: manager.index(lib.id).cfg });
  });

  r.put('/config', (req, res) => {
    const lib = needLib(req, res);
    if (!lib) return;
    const next = manager.saveConfig(lib.id, req.body || {});
    res.json({ ok: true, config: next });
  });

  r.post('/search', async (req, res) => {
    const lib = needLib(req, res);
    if (!lib) return;
    const q = String((req.body && req.body.q) || '').trim();
    if (!q) return res.json({ hits: [], took: 0, backend: manager.embed.backend });
    try {
      const limit = Math.min(500, Math.max(1, Number(req.body.limit) || 50));
      const r = await manager.search(lib.id, q, limit);
      res.json({ dsId: lib.id, ...r });
    } catch (e) {
      res.status(409).json({ error: String(e.message || e) });
    }
  });

  r.get('/llm', (_req, res) => {
    res.json({ ...manager.llm, apiKey: undefined });
  });

  r.put('/llm', (req, res) => {
    res.json({ ok: true, llm: manager.setLlm(req.body || {}) });
  });

  r.post('/llm/test', async (_req, res) => {
    res.json(await manager.llmTest());
  });

  return r;
}
