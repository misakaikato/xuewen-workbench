// 应用更新桥接（可插拔）：Electron 主进程在打包模式下注入实现（electron/updater.js），
// 独立 dev:server 或开发模式无桥接 → 功能整体停用（enabled:false），路由仍可用。
// 桥接接口：{ state(): 快照, check(): Promise<快照>, download(): Promise<快照>, cancel(): Promise<快照>,
//            install(): Promise<{ok:boolean,error?}>, openInstaller(): Promise<void>, openRelease(): Promise<void> }
let bridge = null;

export function setUpdateBridge(b) {
  bridge = b && typeof b === 'object' ? b : null;
}

export function getUpdateBridge() {
  return bridge;
}

export function disabledUpdateState() {
  return {
    enabled: false, status: 'idle', currentVersion: null, info: null, progress: null, error: null,
    phase: null, canCancel: false, installMode: null, installModeReason: null, lastInstall: null,
  };
}

export function mountUpdateRoutes(app) {
  app.get('/api/update/state', async (req, res) => {
    res.json(bridge ? await bridge.state() : disabledUpdateState());
  });

  for (const action of ['check', 'download', 'cancel']) {
    app.post('/api/update/' + action, async (req, res) => {
      if (!bridge) return res.status(409).json({ error: 'update-disabled' });
      try {
        res.json(await bridge[action]());
      } catch (e) {
        // 检查/下载/取消失败是预期内的业务状态，不是 5xx（见规格「接口定义」）
        res.status(409).json({ error: String(e?.message || e) });
      }
    });
  }

  app.post('/api/update/install', async (req, res) => {
    if (!bridge) return res.status(409).json({ error: 'update-disabled' });
    try {
      res.json(await bridge.install());
    } catch (e) {
      // 非 ready 状态安装 → 409；其余按 500
      if (e && e.notReady) return res.status(409).json({ error: e.message || 'update-not-ready' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.post('/api/update/open-installer', async (req, res) => {
    if (!bridge) return res.status(409).json({ error: 'update-disabled' });
    try {
      await bridge.openInstaller(); // 只打开状态机里的安装包，不接受前端传入路径
      res.json({ ok: true });
    } catch (e) {
      if (e && e.noInstaller) return res.status(409).json({ error: e.message || 'no-installer' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.post('/api/update/open-release', (req, res) => {
    if (!bridge) return res.status(409).json({ error: 'update-disabled' });
    bridge.openRelease().catch((e) => console.error('[update] 打开发布页失败:', e?.message || e));
    res.json({ ok: true });
  });
}
