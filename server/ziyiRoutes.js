// 字义库路由：挂在 /api/ziyi，全局（不带资料库作用域）
import express, { Router } from 'express';
import { revealInFolder } from './hostOpen.js';
import { SITE, styleName } from './ziGlyphs.js';

const send = (res, e) => res.status(e.status || 500).json({ error: e.message || String(e), ...(e.code ? { code: e.code } : {}) });

/** glyphs：ZiGlyphs 实例；glyphsEnabled：读 ui-settings.ziyiGlyphs 的函数 */
export function mountZiyi(store, { glyphs, glyphsEnabled } = {}) {
  const r = Router();

  // 字形演变：与字义库是否导入无关，挂在读盘中间件之前。没有缓存时立即返回 202 pending，前端每秒再问一次
  // （不占住连接；不再问的字会被丢掉）；取到 200；失败 502（若有旧缓存一并带上）
  const glyphPayload = (rec) => ({
    char: rec.char,
    fetchedAt: rec.fetchedAt,
    url: SITE + encodeURIComponent(rec.char),
    items: rec.items.map(({ png, ...x }) => ({ ...x, styleName: styleName(x.style), src: 'data:image/png;base64,' + png })),
  });
  r.get('/glyphs', async (req, res) => {
    if (!glyphs || !glyphsEnabled?.()) return res.status(409).json({ error: '已关闭联网获取字形', code: 'glyphs-disabled' });
    try {
      const r0 = await glyphs.peek(String(req.query.han || ''), { refresh: req.query.refresh === '1' });
      if (r0.status === 'pending') return res.status(202).json({ status: 'pending' });
      if (r0.status === 'error') return res.status(502).json({ error: r0.message, ...(r0.rec ? glyphPayload(r0.rec) : {}) });
      res.json({ status: 'ok', ...glyphPayload(r0.rec) });
    } catch (e) {
      send(res, e);
    }
  });
  r.delete('/glyphs', (req, res) => {
    glyphs?.cancel(String(req.query.han || ''));
    res.json({ ok: true });
  });

  // 首次请求时读盘；读不了（权限、占用、损坏且无法保留）返回 503，下次请求重试
  r.use(async (_req, res, next) => {
    try {
      await store.ready();
    } catch (e) {
      return send(res, e);
    }
    next();
  });

  r.get('/status', (_req, res) => res.json(store.status()));

  r.get('/search', (req, res) => {
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const origin = ['lecture', 'ai', 'local', 'none'].includes(req.query.origin) ? req.query.origin : null;
    res.json(store.search(String(req.query.q || ''), { offset, limit, origin }));
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

  // 字义文件原始字节（JSON，或装着它的 zip），不走 base64
  r.post('/import', express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '没有收到字义文件' });
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
