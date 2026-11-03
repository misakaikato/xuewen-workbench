# 规格：反馈第 1 批——反馈基础件 + 应用更新全程可见（mac / Windows）

## 背景与目标
总览见 `specs/2026-11-03-feedback-overview.md`，其中的反馈分级是本批的验收口径。

本批做两件事：
1. **反馈基础件**：全局 toast、按钮忙碌态、延迟指示 hook，第 2–4 批都复用它们。
2. **应用更新全程可见**：从点「立即更新」到新版本启动完成，每一刻都能看到正在发生什么。
   - Windows：安装时显示安装器的进度窗口，装完自动打开新版本。
   - mac（未签名）：由手动拖拽改为在应用内准备安装（带进度），退出后自动替换并重新打开；任何一步失败都回退到手动拖拽，并清楚告诉用户。
   - 两端：重启后提示「已更新到 vX」，或说明失败原因。

成功标准：见「验收标准」，每条可执行。

## 非目标
- 第 2–4 批的内容（RAG、助手、文件操作等），本批只提供基础件，不改那些页面。
- 代码签名、公证、更换 mac 的更新通道（仍用 GitHub Release 的 DMG）。
- 不改 Windows 首次安装的体验（向导页、可选安装目录保持不变）。
- 不新增 npm 依赖。

## 假设
- A1：NSIS 自定义脚本放在 `build/installer.nsh`。electron-builder 在 `buildResources`（默认 `build/`）下发现它会自动引入；`build/` 不进安装包。
- A2：mac 安装源用已下载的 DMG（现在的下载逻辑已经按 `latest-mac.yml` 取 DMG），不改用 zip。这样同一个文件既能自动安装，也能在回退时手动拖拽。
- A3：mac 替换动作在应用退出后由一个独立的 `/bin/sh` 脚本完成。不在应用运行中替换自身 bundle：Electron 会按路径懒加载 `app.asar`，运行中替换会读到新旧混杂的内容。
- A4：macOS「App 管理」权限可能拦截替换（EPERM）。真机行为要到真实升级时才能确认，所以回退路径是一等公民，必须可测。
- A5：Windows 走 assisted 安装器（`oneClick:false`）的非静默升级模式，依据是 `node_modules/app-builder-lib/templates/nsis/`：
  - 目录页由 `skipPageIfUpdated` 跳过。
  - 「为谁安装」页不会自动跳过，需要用 `customInstallMode` 钩子按已有安装方式强制设定。
  - 安装完会自动进入完成页（没有定义 `MUI_FINISHPAGE_NOAUTOCLOSE`），所以用 `customFinishPage` 在升级时直接启动应用并跳过完成页。
  - 非静默 + `--force-run` 时安装器本身不会启动应用（`installSection.nsh` 只在 Silent 时启动），不会重复启动。

## 现状
- `electron/updater.js`：更新桥。
  - Windows 用 electron-updater，`quitAndInstall(true, true)` 静默安装。
  - mac 自己下载 DMG（`downloadDmg`）；安装 = `shell.openPath(DMG)` + `app.quit()`。
  - 状态机字段：`status` / `progress` / `info` / `error`。
  - `readPublishConfig()` 只认 github provider。
- 状态如何到达界面：
  - 链路：`electron/main.js` 的 RPC（`update.*`）→ `server/host.js` → `server/update.js` 路由 → `/api/status` 带上 `update`。
  - `src/store/app.tsx` 每 5 秒轮询一次（`usePolling`），用 `sameUpdate` 比较是否变化。
  - **RPC 有 30 秒超时**，而 mac 下载现在要等下载完才返回。
- `src/components/UpdateBanner.tsx`：横幅，见总览的缺口。
- `src/pages/Settings.tsx` 的「关于与更新」：检查按钮已有转圈。
- `electron/startup.html`：启动页，`wb:boot` 推送步骤文字。
- `src/components/ui-states.tsx`：`PageLoading` / `InlineLoading` / `EmptyState` / `PageError`。
- `src/components/ui/button.tsx`：按钮变体，是唯一来源（DESIGN.md §4）。
- `src/lib/presence.ts`：`usePresence`，用于进出场动画。
- `src/pages/Read.tsx` 约 606 行：延迟 150ms 才出现的定位提示，是现有的延迟指示写法。
- `src/pages/Edit.tsx`：`dirty` 状态与 `useBlocker`，用于离开页面时提示未保存。
- 现有的临时写法：`AgentChat.tsx` 自己写的 toast（`src/pages/AgentChat.tsx` 约 141–152、754–765 行），`Read.tsx` 的 `resumeHint`。

## 设计

### 一、反馈基础件
1. **全局 toast**
   - 新增 `src/lib/notify.ts`：
     ```ts
     export type ToastKind = 'info' | 'success' | 'error';
     export interface ToastAction { label: string; run: () => void }
     export function notify(text: string, opts?: { kind?: ToastKind; action?: ToastAction; durationMs?: number; id?: string }): string; // 返回 id
     export function dismissToast(id: string): void;
     ```
     - 用模块内的订阅表实现，不引入依赖。
     - 传入同一个 `id` 时更新那条 toast，不重复堆叠。
     - 默认时长：info / success 5 秒，error 8 秒；`durationMs: 0` 表示常驻，直到手动关闭。
   - 新增 `src/components/Toaster.tsx`，挂在应用根部（`src/App.tsx`，与路由同级）。
     - 位置在右下角，最多同时显示 3 条，有关闭按钮。
     - 用 `usePresence` 做进出场，时长和缓动只用 DESIGN.md 的 token。
     - 外层设 `role="status"` 和 `aria-live="polite"`；error 用 `role="alert"`。
   - `AgentChat.tsx` 的临时 toast 改用 `notify`（单一真相源）。`Read.tsx` 的 `resumeHint` 有它自己的定位语义，不动。
2. **按钮忙碌态**：`src/components/ui/button.tsx` 增加 `loading?: boolean`。
   - 为 true 时：`disabled`、`aria-busy="true"`，前置一个 `Loader2 animate-spin`，替换按钮原来的前置图标（如果有），文字保持不变。
   - 不另造按钮组件。
3. **延迟指示 hook**：新增 `src/hooks/useDelayedFlag.ts`：
   ```ts
   export function useDelayedFlag(active: boolean, delayMs = 150): boolean;
   ```
   - `active` 持续超过 `delayMs` 才返回 true，`active` 变 false 时立即返回 false。
   - `Read.tsx` 的定位提示改用它，行为不变。

### 二、更新状态机（`electron/updater.js`）
`status` 不变：`idle | checking | available | not-available | downloading | ready | installing | error`。

新增字段：
```ts
phase: null | 'preparing' | 'copying' | 'verifying' | 'restarting' | 'launching-installer';
progress: { percent, transferred, total, bytesPerSecond, etaSeconds } | null;
canCancel: boolean;
installMode: 'auto' | 'manual' | null;
lastInstall: null | { result: 'updated' | 'failed'; fromVersion: string; toVersion: string; error?: string; dmgPath?: string };
```
- `phase` 在 `installing` 期间使用。
- `progress` 新增 `etaSeconds`：剩余字节 ÷ 最近速度，速度为 0 时为 null。
- `canCancel`：下载中为 true。
- `installMode`：mac 预检是否能自动安装，见四；Windows 恒为 `'auto'`。
- `lastInstall`：本次启动时消费的上次安装结果，见五。

`src/lib/types.ts` 的 `UpdateState` 和 `src/store/app.tsx` 的 `sameUpdate` 要同步更新，比较时要包含 phase、progress.percent、canCancel、lastInstall。

新增动作 `cancel()`：
- Windows：用 electron-updater 的 `CancellationToken` 取消 `downloadUpdate`。
- mac：用 `AbortController` 中止 fetch，并删除半截文件。
- 取消后回到 `available`。
- 沿用现有链路暴露：RPC 增加 `update.cancel`（`electron/main.js`、`server/host.js`），路由增加 `POST /api/update/cancel`（`server/update.js`）。

`download()` 两端都**立即返回**当前快照，下载放到后台异步进行。原因：mac 现在要等下载完才返回，会撞上 RPC 的 30 秒超时。

`readPublishConfig()` 增加支持 `provider: generic`（`url` 键）：DMG 地址为 `<url>/<dmgFileName>`。目的是让本机能用本地 HTTP 源做端到端验收，不是测试专用开关。

### 三、Windows 安装过程可见
1. 新增 `build/installer.nsh`：
   ```nsh
   ; 升级（--updated）时沿用已有安装方式，跳过「为谁安装」页
   !macro customInstallMode
     ${if} ${isUpdated}
       ${if} $hasPerMachineInstallation == "1"
         StrCpy $isForceMachineInstall "1"
       ${else}
         StrCpy $isForceCurrentInstall "1"
       ${endif}
     ${endif}
   !macroend

   ; 升级时安装完成直接启动新版本并跳过完成页；首次安装仍显示完成页与「运行」勾选
   !macro customFinishPage
     Function StartApp
       ${if} ${isUpdated}
         StrCpy $1 "--updated"
       ${else}
         StrCpy $1 ""
       ${endif}
       ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
     FunctionEnd

     Function finishPagePre
       ${if} ${isUpdated}
         HideWindow
         Call StartApp
         Abort
       ${endif}
     FunctionEnd

     !define MUI_PAGE_CUSTOMFUNCTION_PRE finishPagePre
     !define MUI_FINISHPAGE_RUN
     !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
     !insertmacro MUI_PAGE_FINISH
   !macroend
   ```
   施工时必须对照 `node_modules/app-builder-lib/templates/nsis/`（`assistedInstaller.nsh`、`multiUserUi.nsh`、`common.nsh`、`installer.nsi`）核实以下几点，与上面写法不一致时以模板为准修正，并在报告中说明：
   - 变量名与宏名（`customInstallMode` 在模板里写作 `customInstallmode` / `customInstallMode`，确认大小写不影响）。
   - `$hasPerMachineInstallation` 在 `.onInit` 中已经赋值。
   - `$launchLink` 可用。
2. `install()`：
   - 先写入待完成记录（见五）。
   - 设置 `status:'installing', phase:'launching-installer'`。
   - 等 1200ms，让界面把「正在启动安装程序」显示出来。
   - 然后调用 `autoUpdater.quitAndInstall(false, true)`（非静默，装完运行）。
3. `autoInstallOnAppQuit` 保持 true：用户下载后正常退出，下次启动前静默装好。这条路径同样写入待完成记录，重启后同样提示「已更新」。

### 四、mac 自动安装
新增 `electron/macInstall.js`（主进程，ESM），负责准备阶段和派发替换脚本；新增 `electron/mac-install.sh`，负责退出后的替换。

**1. 预检 `macInstallTarget()`**
- 由 `process.execPath` 向上取 `.app` 目录，得到当前 bundle 路径。
- 以下任一情况返回 `{ mode: 'manual', reason }`：
  - 路径包含 `/AppTranslocation/`；
  - 路径以 `/Volumes/` 开头；
  - bundle 的父目录 `fs.access(W_OK)` 失败；
  - bundle 本身不可写。
- 否则返回 `{ mode: 'auto', target }`。
- 预检在 `ready` 时执行，结果写入状态的 `installMode`，界面据此决定文案。

**2. 准备 `prepareMacUpdate({ dmgPath, expectedVersion, onProgress })`**：全部异步，不得用 `*Sync` 的子进程或文件调用。
1. `phase:'preparing'`：执行 `hdiutil attach -nobrowse -readonly -noautoopen -mountpoint <临时目录> <dmg>`。
2. 在挂载点找唯一的 `*.app`，校验其 `Info.plist`：
   - `CFBundleIdentifier` 必须等于当前应用的；
   - `CFBundleShortVersionString` 必须等于 `expectedVersion`。
   - 读取用 `plutil -extract <key> raw -o - <plist>`。
3. `phase:'copying'`：
   - 先遍历源 bundle 统计总字节数（只计普通文件，`lstat`）。
   - 用 `ditto <源> <staging>/<名称>.app` 复制，`staging` 为 `userData/updates/staging/`，开始前清空。
   - 复制期间每 500ms 统计一次 staging 已有字节数并更新 `progress`（percent / transferred / total）。统计方式不要求精确，但必须单调不减，结束时为 100。
4. `phase:'verifying'`：
   - 执行 `codesign --verify --deep <staged.app>`。ad-hoc 签名应能通过；若真实构建产物验证不过，在报告中说明并给出替代校验。
   - 再次核对 staged bundle 的版本号。
5. 无论成功失败都要 `hdiutil detach <挂载点>`；detach 失败时用 `-force` 重试一次。
6. 任一步失败：清理 staging，`status:'error'`，`error` 写人话，并带上「手动安装」入口（`installMode:'manual'`）。此时不退出应用。

**3. 派发替换 `launchMacSwap({ staged, target, dmgPath, fromVersion, toVersion })`**
- 用 fs 读出 asar 内的 `electron/mac-install.sh`，写到 `userData/updates/mac-install.sh`（`0755`）。
- 写入待完成记录（见五）。
- 执行：
  ```
  spawn('/bin/sh', [脚本, String(process.pid), staged, target, resultFile, dmgPath], { detached:true, stdio:['ignore', logFd, logFd] }).unref()
  ```
  日志写到 `logs/` 下的 `mac-install.log`，路径用现有的 `logsDir` 计算，以便诊断包能带上。
- 设置 `phase:'restarting'`，等 1200ms 后 `app.quit()`。

**4. `electron/mac-install.sh`**（POSIX sh，每步都写日志）
1. 等原进程退出：每 0.2 秒执行 `kill -0 $pid`，最多等 60 秒；超时则写失败结果，退出码 1。
2. `backup="$(dirname "$target")/.$(basename "$target").old-$(date +%s)"`，执行 `mv "$target" "$backup"`。
   - 失败（含「App 管理」拦截导致的 Operation not permitted）：写失败结果，`reason` 为 `move-old-failed` 并附 stderr 摘要；然后 `open "$dmgPath"`、`open "$target"`（重开旧版），退出。
3. `mv "$staged" "$target"`；失败时改用 `ditto "$staged" "$target"`。
   - 仍失败：`mv "$backup" "$target"` 还原，写失败结果（`reason:'move-new-failed'`），`open "$dmgPath"`、`open "$target"`，退出。
   - 还原也失败：写失败结果并附 backup 路径，`open "$dmgPath"`，退出。不得删除 backup。
4. `xattr -dr com.apple.quarantine "$target" 2>/dev/null || true`。
5. 写成功结果，`open "$target" --args --updated`。
6. 后台执行 `rm -rf "$backup"`，并清理 staging 目录。
- 结果文件 `userData/updates/install-result.json` 的格式：`{"ok":true|false,"reason":"…","detail":"…","at":"ISO"}`。
- 脚本只接收参数，不拼接任何来自网络的字符串。所有路径参数都要加引号。
- **测试开关**：环境变量 `WB_MAC_INSTALL_NO_OPEN=1` 时，所有 `open` 改为写日志 `would open …`。该变量只在测试中设置；产品代码派发时不传入，也不从用户环境继承（spawn 时显式构造 `env`，删除这个键）。

**5. `install()`（mac）**
- `installMode==='auto'`：执行 `prepareMacUpdate`，再执行 `launchMacSwap`。
- `installMode==='manual'`：沿用现有行为，打开 DMG 后退出。退出前界面要明确说明下一步该做什么。

### 五、跨重启的「已更新」提示（两端共用）
- **待完成记录**：`userData/updates/pending.json`，内容为 `{ fromVersion, toVersion, dmgPath?, at }`。
  - 在 `install()` 中写入。
  - 在 `update-downloaded`（Windows）或 DMG 下载完成（mac）时也写入，用来覆盖「下载后直接退出、退出时自动安装」的路径。
- **启动时消费**：在 `createUpdaterBridge` 中执行，也就是主进程启动早期。
  - `app.getVersion() === toVersion`：`lastInstall = { result:'updated', … }`，删除 pending 和 result。
  - 版本仍等于 `fromVersion`，且 result 文件存在、`ok:false`：`lastInstall = { result:'failed', error: 人话(reason), dmgPath }`，删除 pending 和 result。
  - 版本仍等于 `fromVersion`，且没有 result 文件（Windows 用户取消了安装器，或尚未安装）：保留 pending，不提示。
  - 两个文件都不存在或解析失败：忽略。
- **启动页**：主进程在创建启动窗口之前先读一次 pending。若判定为刚更新成功，首条 boot 步骤文字为「已更新到 v{toVersion}，正在启动…」。
- **界面**：前端在拿到含 `lastInstall` 的状态后，本次会话只提示一次。用 sessionStorage 键 `wb:update-notified:<toVersion>` 防止页面重载后重复提示。
  - 成功：`notify('已更新到 v{toVersion}', { kind:'success', action:{ label:'查看更新内容', run: 打开发布页 } })`。
  - 失败：`notify('自动安装没有完成：{error}', { kind:'error', durationMs:0, action:{ label:'打开安装包', run: 打开 dmgPath } })`。
    - 打开安装包通过新增的 `POST /api/update/open-installer` 实现：只允许打开 `lastInstall.dmgPath`，不接受前端传入的路径。
    - reason 为 `move-old-failed` 时，人话要包含：「系统阻止了替换应用，可在 系统设置 → 隐私与安全性 → App 管理 中允许 Xuewen Workbench，或把安装包里的应用拖到 Applications」。

### 六、前端更新界面
- **轮询节奏**（`src/store/app.tsx`）：
  - `update.status ∈ {checking, downloading, installing}`：1 秒一次；
  - 其他状态：5 秒一次。
  - 改动 `usePolling` 的调用方式，不新增请求循环。
- **横幅**（`UpdateBanner.tsx`）：
  - `available`：「立即更新」按钮在点击后立即进入 `loading`，直到状态离开 `available`。
  - `downloading`：
    - 显示百分比、`已下/总 MB`、速度（MB/s），有 `etaSeconds` 时显示「约剩 N 分 / N 秒」。
    - 提供「取消」按钮。
    - 数字用 `.stat-num`。
  - `ready`：
    - Windows 文案为「v{X} 已下载，安装时会显示安装进度，完成后自动重新打开」，按钮「重启并安装」。
    - mac `installMode==='auto'`：文案同上，但不提安装进度窗口；按钮「重启并安装」。
    - mac `installMode==='manual'`：文案说明原因（来自预检的 reason 人话）和手动步骤；按钮「打开安装包并退出」。
  - `installing`：横幅不够醒目，改为显示全窗口安装遮罩，见下一条。
  - `error`：「重试」按钮用 `loading`。mac 有已下载的 DMG 时，额外提供「手动安装」按钮（打开安装包并退出）。
- **安装遮罩**（新增 `src/components/UpdateInstallOverlay.tsx`，挂在根部）：
  - 在 `status==='installing'` 时显示。全窗口半透明底，阻止交互，不可关闭；进出场用 `usePresence`。
  - 内容：
    - 标题「正在安装 v{X}」。
    - 阶段文字：
      - preparing →「正在打开安装包…」
      - copying →「正在复制新版本… N%」，并显示进度条（复用 `src/components/ui/progress.tsx`）
      - verifying →「正在校验…」
      - restarting →「即将关闭并重新打开…」
      - launching-installer →「正在启动安装程序…」
    - 说明一行：
      - Windows：「应用关闭后会出现安装进度窗口，完成后自动重新打开，请勿手动打开应用」
      - mac：「完成后会自动重新打开，请勿手动打开应用」
- **未保存保护**：
  - 新增 `src/lib/unsaved.ts`，提供一个可注册「当前有未保存改动」检查函数的模块。`Edit.tsx` 在 `dirty` 时注册，卸载时注销；`Read.tsx` 的原位编辑如果有同类 dirty 状态，同样注册。
  - 点击「重启并安装」时如果存在未保存改动，弹确认框：「有未保存的修改，安装会关闭应用。先保存再安装？」，选项为「取消」和「仍然安装」。确认框沿用项目现有的 Dialog 组件，不用 `window.confirm`。
- **设置页**：「检查更新」的结果文字保持不变。当前状态为 downloading 或 ready 时，在按钮旁显示一行与横幅一致的状态文字，口径相同。

## 边界情况
| 情况 | 期望 |
|---|---|
| 下载中途断网 | `error`，错误为人话；mac 删除半截文件；「重试」可恢复 |
| 下载中点「取消」 | 回到 `available`，半截文件已删除，再次点击可以重新下载 |
| 重复点「立即更新」或「重启并安装」 | 只触发一次（按钮 loading + 桥内幂等） |
| mac 应用运行在 DMG 卷或 AppTranslocation 中 | 预检返回 manual，文案说明要先拖进 Applications |
| mac 的 /Applications 不可写 | 预检返回 manual |
| mac DMG 校验失败（bundle id 或版本不符） | `error`：「安装包与当前应用不匹配」；不退出 |
| mac ditto 中途失败 | `error`，清理 staging，detach 挂载点，不退出 |
| mac 替换被「App 管理」拦截 | 脚本还原并重开旧版、打开 DMG；旧版启动后 toast 说明原因和手动步骤 |
| mac 原进程 60 秒没退出 | 脚本写失败结果并退出，不动 target；下次启动提示 |
| Windows 用户在安装器里取消 | 版本没变、也没有 result：保留 pending，不提示；下次检查仍会提示更新 |
| pending 的 toVersion 小于等于当前版本，但当前版本又不等于 toVersion（跨版本手动安装过） | 删除 pending，不提示 |
| 编辑页有未保存改动 | 安装前确认 |
| 开发模式（无桥） | 横幅和遮罩都不出现；`/api/update/cancel` 与 `/api/update/open-installer` 返回 409 `update-disabled` |

## 实施步骤
1. 基础件：`notify` + `Toaster` + `Button loading` + `useDelayedFlag`；`AgentChat` 和 `Read` 改用它们。跑 tsc、eslint、相关 e2e。
2. 状态机扩展：`phase`、`eta`、`cancel`、立即返回、generic provider、pending/result 消费；接通 RPC、路由与类型。
3. mac 准备阶段与 `mac-install.sh`，以及它们的脚本级测试（见验收）。
4. Windows 的 `build/installer.nsh` 与 `quitAndInstall(false, true)`；在本机尝试编译 Windows 安装器（见验收 W1）。
5. 前端：横幅、遮罩、轮询节奏、未保存保护、启动页文案、「已更新」提示；UI e2e。
6. 文档：`docs/ARCHITECTURE.md` 的更新章节改为新流程；`DESIGN.md` 的组件规格补上 toast、按钮 loading、延迟指示的用法（各一两句）。

## 验收标准
- **基础件**
  - B1：`npx tsc -b`、`npx eslint .` 0 问题；`npm run build` 成功。
  - B2：新增 `scripts/test-feedback.mjs`（node 可跑，不依赖 DOM）。测 `notify` 的订阅表：
    - 同 `id` 更新而非新增；
    - 超时自动移除（用可注入的计时器或真实短时长）；
    - `durationMs:0` 常驻。
  - B3：UI e2e 覆盖：
    - `notify` 出现在右下角；
    - `Button loading` 有 `aria-busy` 且被禁用；
    - `useDelayedFlag` 在 100ms 内结束的操作不显示指示器，在 400ms 的操作中显示。
- **mac**
  - M1：新增 `scripts/test-mac-install.mjs`（仅 darwin 运行，其他平台跳过并打印原因）：
    - 用 `hdiutil create -srcfolder` 造一个含假 `.app` 的 DMG。假 `.app` 带 `Info.plist`，有 CFBundleIdentifier 和版本号，还要含几 MB 文件和一个符号链接。
    - 调用 `prepareMacUpdate`，断言：
      - 进度回调单调不减，最后为 100；
      - staged 与源 bundle 逐文件一致，`diff -r` 无输出，符号链接保留；
      - 结束后 `hdiutil info` 里没有该挂载点。
  - M2：同一脚本测 `prepareMacUpdate` 的失败路径：版本不符、bundle id 不符时报错，staging 已清理，挂载点已 detach。
  - M3：同一脚本测 `mac-install.sh`，设置 `WB_MAC_INSTALL_NO_OPEN=1`，在临时目录中进行：
    1. 成功路径：target 被替换为新内容，backup 最终被删除，result `ok:true`，日志里有 `would open … --args --updated`。
    2. 旧 target 所在目录不可写（`chmod 555` 父目录）：result `ok:false, reason:'move-old-failed'`，target 未变，日志有 `would open <dmg>`。
    3. 等待的 pid 是一个 `sleep 2` 进程：脚本在它退出后才开始替换（检查日志时间顺序）。
  - M4：`macInstallTarget()` 对路径 `/private/var/folders/x/AppTranslocation/y/A.app/Contents/MacOS/A` 和 `/Volumes/X/A.app/...` 返回 manual。要么为测试导出纯函数，要么让函数接收 execPath 参数。
- **Windows**
  - W1：在本机执行以下命令编译 Windows 安装器：
    ```
    timeout 590 npx electron-builder --win nsis --x64 --publish never -c.win.signAndEditExecutable=false
    ```
    预期 exit 0，`release/` 下生成 `Xuewen-Workbench-Setup-*.exe`。如果本机缺 wine 等条件无法编译，要贴出原始报错并说明。
  - W2：在 electron-builder 生成的最终 NSIS 脚本中确认两个宏都已引入：可以用环境变量 `DEBUG=electron-builder` 看日志，或者确认 makensis 的命令行带上了 `build/installer.nsh`；同时对照模板，说明升级时会依次经过哪些页面。这一条只验证编译和脚本逻辑，Windows 真机行为本批无法验证，报告里要写明。
- **跨重启提示**
  - R1：新增 `scripts/test-update-pending.mjs`，把 pending/result 的消费逻辑做成纯函数单测，覆盖「边界情况」表里的版本组合：成功、失败、取消、跨版本。
- **前端**
  - U1：UI e2e：在 e2e 的 BrowserWindow 加一个测试用 preload，包装 `window.fetch`，伪造 `/api/status` 与 `/api/update/*` 的响应。产品代码里不得加测试分支。依次推进 available → 点击（断言按钮立刻 loading）→ downloading（断言出现速度、剩余时间和「取消」）→ ready → 点击安装 → installing 的各个 phase（断言遮罩、文案、进度条）。
  - U2：同一 e2e 下，`lastInstall` 为 updated 时出现成功 toast；重载页面后不重复出现。为 failed 时出现常驻错误 toast，带「打开安装包」。
  - U3：编辑页有未保存改动时点击安装，出现确认框；点「取消」后不调用 `/api/update/install`。
- **回归**：`scratchpad gate` 等价的全套命令都通过。具体是 `scripts/test-*.mjs` 全部，以及 `npm run test:e2e`、`e2e-filetree`、`test:retrieval:e2e`、`e2e-security`、`e2e-reader-regress`、`e2e-perf`。另外 `git diff --check` 无输出。
- **文档**：ARCHITECTURE 的更新章节与代码一致。

## 明确禁止
- 不新增 npm 依赖；不改 `package.json` 的 `build` 配置，除非 W1 证明必须（如果要改，在报告中说明理由）。
- 不在应用运行中替换自身 bundle。
- 主进程和后端都不用同步子进程或同步大文件调用（`execFileSync`、`spawnSync`、`copyFileSync` 等）处理安装包。
- 产品代码里不加 e2e 专用分支。`WB_MAC_INSTALL_NO_OPEN` 只在 `mac-install.sh` 内生效，派发时必须从 env 中显式删除。
- 不改第 2–4 批的页面逻辑。
- 不读写 `~/.xuewen-workbench` 与 `/Users/mayu/Downloads`；不改 `/Applications`；不 push、不打 tag。
