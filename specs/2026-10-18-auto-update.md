# 规格：应用自动更新（GitHub Releases + 顶部更新横幅）

## 背景与目标

应用即将发布到 GitHub。需要：客户端检测到新版本后，在界面**顶部显示更新横幅**；用户点击后自动下载、安装并重启（Windows 全自动；macOS 受签名限制为"下载并打开 DMG"半自动，见「假设 A2」）。成功标准：发布 v0.1.1 后，运行 v0.1.0 的客户端在数分钟内出现横幅，点击后无需打开浏览器即可完成升级。

## 非目标

- 不做代码级热更（只替换渲染层/服务层而不换整包）——整包差量更新（blockmap）已够用。
- 不做多渠道（beta/nightly）；v1 只走 stable 渠道（latest.yml / latest-mac.yml）。
- 不做 Linux。
- 不做灰度发布（staged rollout）；electron-updater 原生支持，将来改 latest.yml 即可启用，不在本期实现 UI。
- 不改动自动检查以外的任何设置同步逻辑。

## 假设（需用户确认）

- **A1 仓库**：GitHub 公开仓库，名称暂定 `<owner>/xuewen-workbench`，`publish.owner/repo` 以实际建仓为准；spec 中用占位符，施工前必须替换。
- **A2 macOS 签名**：暂不购买 Apple Developer Program（$99/年）。已核实（electron-builder v26/v27 官方文档 + Squirrel.Mac 源码 SQRLInstaller）：**macOS 未签名应用无法使用 electron-updater 的自动安装**——ShipIt 会校验更新包与宿主的 designated requirement，ad-hoc 签名每版都变，必然失败。因此 macOS 走「应用内下载 DMG → 打开 → 用户拖入 Applications」半自动流；Windows NSIS 未签名即可全自动。将来买了证书只需把 macOS 分支切回 `downloadUpdate()+quitAndInstall()`，UI 状态机已预留。
- **A3 发布方式**：优先 GitHub Actions（公开仓库免费）：打 tag `v*` 触发 mac+win 矩阵构建并上传 draft release；同时保留本地 `GH_TOKEN` 手动发布脚本。
- **A4 自动下载**：检测到新版本后**不**自动下载（`autoDownload: false`），用户点横幅上的「立即更新」才开始，尊重流量选择。
- **A5 检查频率**：启动后 10s 首查，之后每 6h 一查；设置页有手动「检查更新」。

## 现状（侦察结论）

- `electron/main.js`：Electron 主进程**进程内 import** `server/index.js` 启动 Express（127.0.0.1 动态端口，默认 7410），窗口加载 `http://127.0.0.1:port/`。`contextIsolation: true, sandbox: true`，**无 preload、无 IPC**——渲染层是纯浏览器，只走 HTTP。
- `server/trash.js`：已有「主进程注入能力到 server」的先例——main.js 调 `setTrashHandler(shell.trashItem)`，server 侧 `getTrashHandler()` 取用；独立跑 `npm run dev:server` 时 handler 为空走降级。更新桥接**必须复用此模式**。
- `src/store/app.tsx`：已有每 5s 轮询 `GET /api/status` 的循环（扫描状态同步）。更新状态**搭这班车**，不新增轮询。
- `src/components/Layout.tsx` L133：`<header className="h-12 ...">` 是顶栏；横幅插在它上方，全宽。
- `package.json`：electron-builder ^26.15.3；`build.mac.target: [dmg, zip]`（zip 是 electron-updater 在 macOS 的必需目标，已就位）；`win.target: [nsis]`（assisted 安装、per-user，更新无需提权）；`identity: null`（不签名）；scripts 均为 `--publish never`；version 0.1.0。
- `release/`：产物含 `*.blockmap`（electron-builder 已生成差量更新所需的 blockmap）。
- `server/store.js`：`getUiSettings()/saveUiSettings()` 持久化 UI 设置（theme、侧栏宽度等），自动检查开关存这里。
- 应用数据在 `app.getPath('userData')/data`（打包模式），**不受更新影响**。
- 无 git remote（发布前需建仓）。

## 设计

### 技术选型

- `electron-updater@^6.8.10`（dist-tag `v26`，与 electron-builder 26 配套）加入 **dependencies**（运行时依赖，打进 asar）。GitHub provider 内置，支持差量下载（zip/nsis 均走 blockmap，首版 143MB 的包，小版本更新实际只传变更块）。
- 不用 Electron 内置 `autoUpdater`（Squirrel 系，同样要求 mac 签名，且不支持 GitHub 元数据/差量）。
- 不引入 preload/IPC——更新状态与动作全部经既有 Express HTTP 通道，与现有架构一致。

### 模块与数据流

```
electron/main.js（改动）
  └─ import electron/updater.js → createUpdaterBridge() → setUpdateBridge(bridge)（trash.js 同款注入模式，在 import server/index.js 之前）
electron/updater.js（新增，仅主进程）
  ├─ 状态机 state: { status, currentVersion, info, progress, error, dmgPath }
  ├─ electron-updater：checkForUpdates / downloadUpdate / quitAndInstall（Windows 全自动路径）
  ├─ macOS 未签名路径：fetch 下载 DMG（进度回调）→ shell.openPath → app.quit()
  └─ 定时检查（10s 首查 + 6h 间隔），app.isPackaged 才启用
server/update.js（新增）
  ├─ setUpdateBridge(bridge) / getUpdateBridge()（照抄 trash.js 形状）
  └─ mountRoutes(app)：GET /api/update/state、POST /api/update/{check,download,install,open-release}
server/index.js（改动）
  ├─ import { mountUpdateRoutes } from './update.js'，在路由区调用
  └─ /api/status 响应里追加 update: bridge?.state() ?? { enabled: false }
src/store/update.ts（新增，zustand）
  └─ 从 /api/status 轮询结果里读 update 字段（不新增请求循环）
src/components/UpdateBanner.tsx（新增）
  └─ Layout.tsx 顶栏上方渲染；按 status 渲染文案与按钮
src/pages/Settings.tsx（改动）
  └─ 「关于/更新」区块：当前版本、检查更新按钮、自动检查开关（存 ui-settings.autoUpdate，默认 true）
```

### 状态机（单一真相在 electron/updater.js，渲染层只读快照）

```
status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading'
      | 'ready' | 'installing' | 'error'
info:   null | { version, releaseDate, notes? }   // 来自 electron-updater UpdateInfo
progress: null | { percent, transferred, total, bytesPerSecond }  // downloading 时非空
error:  null | string（人类可读，含原因码）
```

迁移规则：任何状态下 `check()` 都允许（先取消进行中的下载再查）；`downloading` 中重复 `download()` 幂等忽略；`installing` 后不可逆。

### HTTP 接口（挂在前缀 /api 下，均 JSON）

```
GET  /api/update/state   → { enabled, status, currentVersion, info, progress, error }
                             enabled=false：开发模式 / 独立 dev:server / 未打包
POST /api/update/check   → 触发立即检查，返回最新 state（手动入口用）
POST /api/update/download→ 开始下载（available 状态才有效；downloading 幂等）
POST /api/update/install → Windows：quitAndInstall(true, true)
                            macOS：shell.openPath(已下载 DMG) + app.quit()
                            非 ready 状态返回 409
POST /api/update/open-release → shell.openExternal(releases 页)，任何状态可用（兜底逃生口）
错误：enabled=false 时 check/download/install 返回 { error: 'update-disabled' }；网络失败 status='error'，不抛 5xx
```

### 核心流程

**1. 检查（两平台相同）**
1. 打包模式下主进程 ready + 10s（或定时器到点、或收到 POST check）→ `autoUpdater.checkForUpdates()`。
2. `update-available` → state = available（记录 info）。`update-not-available` → not-available（横幅不显示，Settings 显示「已是最新」）。网络/接口错误 → error（横幅不显示，Settings 可见可重试；不打扰用户）。
3. GitHub 匿名 API 限频 60 次/时/IP——检查只发生在启动+6h 间隔+手动，渲染层 5s 轮询打的**始终是本地 state 缓存**，不触网。

**2. 下载+安装（Windows，全自动）**
1. 用户点「立即更新」→ `downloadUpdate()`；`download-progress` 事件更新 progress（差量下载由 electron-updater 自动走 blockmap，对代码透明）。
2. 完成 → state=ready，横幅变「v0.x.y 已就绪，重启并安装」。
3. 点击 → `quitAndInstall(true, true)`：静默重装（per-user 无需提管员）、装完自动拉起。before-quit 已有 stopChildren 清理，Express/chokidar 随进程退出。
4. 也支持 `autoInstallOnAppQuit`（默认 true）：下载完成后用户不点按钮、正常退出时也会装。

**3. 下载+安装（macOS 未签名，半自动，A2）**
1. 检查阶段与 Windows 共用 electron-updater（checkForUpdates 只读 GitHub 元数据，不涉及签名）。
2. 用户点「立即更新」→ 主进程用 Node fetch 直接下载 DMG 到 `app.getPath('downloads')`（无则 userData/updates），URL 由版本号拼出：
   `https://github.com/<owner>/<repo>/releases/download/v{version}/{productName}-{version}-arm64.dmg`（空格 URL 编码；产物名已从 release/ 目录核实）。
3. 进度经同一 progress 字段上报，横幅显示与 Windows 一致。
4. 完成 → ready，按钮文案为「打开安装包并退出」：`shell.openPath(dmgPath)` 挂载安装镜像 + `app.quit()`，用户把 App 拖进 Applications 完成替换（Finder 会提示「替换」）。
5. DMG 下载失败（网络/404）→ error + 横幅给出「前往发布页」按钮（open-release 兜底）。
6. 将来启用签名：删除此分支，macOS 直接走 Windows 同款 downloadUpdate+quitAndInstall 路径（UI 状态机无需改动，只换按钮文案来源）。

**4. 发布流（开发者侧）**
1. `npm version patch|minor`（或手改 package.json version）→ commit → `git tag v0.x.y` → push tag。
2. GitHub Actions（`.github/workflows/release.yml` 新增）：`on: push: tags: ['v*']`，matrix `[macos-latest, windows-latest]`，`npm ci` + 对应 `electron:build:* --publish always`，`GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`。
3. electron-builder 自动创建 **draft release** 并上传 dmg/zip/exe + blockmap + latest.yml/latest-mac.yml。人工核对后点 Publish——latest*.yml 对外可见的瞬间，客户端才开始看到新版本（天然的发布闸门）。
4. 本地兜底：`npm run release:mac` / `release:win`（= 既有 build 脚本改 `--publish always`，读环境变量 GH_TOKEN）。

**5. package.json 变更**
- `dependencies` 增 `electron-updater@^6.8.10`。
- `build.publish = { provider: 'github', owner: '<owner>', repo: '<repo>' }`。
- scripts 增 `release:mac` / `release:win`；既有 `electron:build:*` 保持 `--publish never` 不动（本地试打包用）。
- `build.files` 无需改：electron-updater 作为 node_modules 依赖会被 electron-builder 自动打入 asar。

### 横幅 UI（UpdateBanner，插在 Layout 顶栏 header 之上）

| status | 展示 | 动作 |
|---|---|---|
| available | 「发现新版本 v0.x.y」+ [更新说明]（notes 有内容时展开）+ [立即更新] + [×] 忽略本次 | 忽略只隐藏横幅到下次启动，不持久化 |
| downloading | 细进度条 + 「正在下载 45%（12.3 / 28 MB）」 | 无按钮（不可取消，v1 简化） |
| ready (win) | 「v0.x.y 已就绪」+ [重启并安装] | quitAndInstall |
| ready (mac) | 「安装包已下载」+ [打开安装包并退出] | openPath + quit |
| error | 「更新失败：<原因>」+ [重试] + [前往发布页] | 重试=check+download |
| idle/checking/not-available | 不渲染（高度 0，不顶布局） | — |

- 样式走现有 tailwind token（bg-primary/10、text-primary、border-border），高度 h-9，三个主题（A/B/C）下都可读。
- 轮询断连（后端重启窗口）时横幅隐藏，不用骨架。

## 边界情况

1. **dev 模式 / `npm run dev:server` 独立跑**：bridge 未注入 → state.enabled=false，Settings 区块显示「开发模式不支持更新」，横幅永不出现。
2. **检查时无网络**：status=error，日志记入 userData/logs/app-update.log（electron-updater 自带），10 分钟后由下一次定时器重试，不弹窗。
3. **下载中断（网络断/休眠）**：electron-updater 断点续传（差量缓存 userData/__xuewen-workbench-updater）；mac DMG 下载失败则删半截文件置 error。用户重点「立即更新」重新下载，幂等。
4. **用户忽略横幅后当次会话再来新版本**（6h 后又查到）：横幅重新出现（忽略只针对当次 available 的 version）。
5. **安装时应用忙**（Windows 正在写文件）：quitAndInstall 前已有 before-quit 清理；NSIS 静默安装覆盖文件期间进程已退，无文件锁问题。
6. **GitHub API 限频**：匿名 60/h/IP，见流程 1.3 的设计，不会触顶；若真触顶（共享 IP），error 状态静默等下个周期。
7. **release 是 draft / prerelease**：electron-updater 的 GitHub provider 不读 draft（未 publish 不可见）；prerelease 版本号含 `-rc.1` 时走 latest-beta.yml，stable 渠道客户端看不到——**发正式版不要带 prerelease 后缀**。
8. **版本回退**（GitHub 上最新 release 版本号 < 本地）：update-not-available，不降级。
9. **未签名的 Windows exe**：SmartScreen 只影响浏览器首次下载安装的用户（点「仍要运行」）；应用内更新是直接 HTTPS 下载+校验 sha512（electron-updater 自动），不触发 SmartScreen。
10. **多实例**：main.js 已 requestSingleInstanceLock，不存在并发更新。
11. **设置页自动检查关闭（autoUpdate=false）**：定时器停；手动「检查更新」仍可用。

## 实施步骤（按序，每步可独立验证）

1. **发布基建**（无代码风险）：建 GitHub 公开仓库 + push；package.json 加 publish 配置与 release:* 脚本；写 `.github/workflows/release.yml`；发一个 v0.1.1 测试版（draft）验证产物齐全（dmg/zip/exe/blockmap/latest.yml/latest-mac.yml）。
2. **后端骨架**：`npm i electron-updater`；新增 `server/update.js`（bridge 注入 + 4 个路由 + state 并入 /api/status）；`electron/updater.js`（先只做 Windows 全自动路径 + 定时检查）；main.js 接线。验收：curl /api/update/state 各状态。
3. **UI**：`src/store/update.ts` + `UpdateBanner.tsx` + Layout 挂载 + Settings「关于/更新」区块 + autoUpdate 开关。
4. **macOS 半自动路径**：DMG 拼名下载 + openPath + 兜底发布页按钮。
5. **端到端实测**（见验收标准 V2/V3）+ 补 README 发布说明。

## 验收标准

- **V1 构建产物**：`npm run electron:build:mac` 后 release/ 含 zip 与 blockmap（现状已满足，回归确认）；CI 推 tag 后 draft release 资产 ≥ 8 个文件（mac dmg/zip+2 blockmap+latest-mac.yml，win exe+blockmap+latest.yml）。
- **V2 Windows 全自动**：在 Windows 机器（或虚拟机）装 v0.1.0，publish v0.1.1 后：≤6h 内（或手动检查后 5s 内）横幅出现；点「立即更新」进度条走完；点「重启并安装」后应用自动退出、升级、重新打开，菜单/关于显示 v0.1.1，用户数据（资料库配置）完好。操作序列可复现，期望输出明确。
- **V3 macOS 半自动**：mac 上跑 v0.1.0（当前未签名包），publish v0.1.1 后横幅出现；下载完成点按钮 → Finder 打开 DMG + 应用退出；拖入替换重开后关于显示 v0.1.1。
- **V4 降级路径**：断网状态下启动应用 → 无横幅、无报错弹窗，Settings 显示「检查失败可重试」；恢复网络点重试 → 横幅出现。
- **V5 开发模式**：`npm run dev`（electron:dev）与 `npm run dev:server` 两条路径下 GET /api/update/state 恒为 `{enabled:false}`，UI 无更新元素。
- **V6 幂等**：downloading 状态连点 3 次「立即更新」（按钮实际已隐藏，用 curl 直接 POST 验证）只产生一个下载任务。

## 明确禁止

- 不引入 preload/contextBridge/IPC——一切走既有 HTTP 通道。
- 不引入 electron-builder 以外的新构建工具链；不用 Electron 内置 autoUpdater。
- 不动 `build.files`、asar 打包方式与现有 `electron:build:*` 脚本的 `--publish never` 语义。
- 不在渲染层直接请求 GitHub API（触网只发生在主进程 electron-updater / DMG 下载）。
- 不做「跳过此版本」持久化、不做渠道切换 UI（将来另立 spec）。

## 风险与备注

- **R1**：`<owner>/<repo>` 未定 → 步骤 1 阻塞，代码不阻塞（占位符常量集中在一处）。
- **R2**：macOS 未签名 + 浏览器首次下载会触发 Gatekeeper「无法验证开发者」——需 README 写明右键打开；这不影响应用内更新路径。
- **R3**：electron-updater 与 electron-builder 大版本需保持 26 系（锁定 ^6.8.10 即可）；将来升 v27 时注意其 NSIS perMachine 提权与 latest.yml 元数据格式变更（v27 文档已预警，迁移时再读）。
- **R4**：143MB 首装体积 → 差量更新后日常升级实际传输通常远小于此；若仍在意，后续可评估拆 electron dist 缓存，非本期。
