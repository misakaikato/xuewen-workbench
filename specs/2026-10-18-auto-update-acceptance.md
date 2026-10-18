# 验收报告：应用自动更新（specs/2026-10-18-auto-update.md）

结论：✅ 通过（本机可验项全过；D 组为发布后真机人工验收，见文末操作手册）
验收独立性：⚠️ 受损——本环境无子 agent，规格、施工、验收同上下文；盲写清单先于代码（/tmp/blind-checklist.md），机器关输出为证。

## 检查明细

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| 机器关 | lint 增量 | 通过 | HEAD 基线 18 错全为存量 react-refresh；改后逐条 diff 仅剩同行空白差异（lint delta = 0） |
| 机器关 | 构建 | 通过 | `npm run build` → `✓ built in 2.19s`（tsc strict + vite） |
| 机器关 | e2e 回归 | 通过 | `npm run test:e2e` → 180 通过 0 失败 |
| A1 | 无桥接 state/status 停用 | 通过 | /tmp/accept-update.mjs 13/13 |
| A2 | 4 个 POST → 409 update-disabled | 通过 | 同上 |
| A3 | 假桥接透传/check 转发/install 409/open-release | 通过 | /tmp/accept-bridge.mjs 6/6 |
| A4 | ui-settings autoUpdate 读写校验持久化 + theme 回归 | 通过 | 同 A1 脚本 |
| B1/B2 | 构建/lint | 通过 | 见机器关 |
| B3 | electron-updater ^6.8.10 在 dependencies | 通过 | npm ls：electron-updater@6.8.10 |
| B4 | publish 配置 + release:* always + build:* 仍 never | 通过 | package.json 检查输出 |
| B5 | workflow YAML 可解析、tag 触发、双平台、GH_TOKEN、contents:write | 通过 | js-yaml 解析 + 结构断言 5/5 |
| C1 | 仅 isPackaged 注入、electron-updater 懒加载 | 通过 | grep：main.js:59 + updater.js:136 动态 import |
| C2 | autoDownload=false；mac 不走 downloadUpdate/quitAndInstall；win quitAndInstall(true,true) | 通过 | 代码审读 updater.js |
| C3 | 渲染层零 github 直连、零新增 IPC/preload | 通过 | grep src/ = 0 处 |
| C4 | 横幅隐藏态不渲染 DOM | 通过 | 代码审读（idle/checking/not-available/disabled → return null） |
| C5 | status.update 与 state 端点同源同构 | 通过 | 两处均 `bridge.state() ?? disabledUpdateState()` |
| E2 | dev:server 无新增报错 | 通过 | A0 启动检查 stderr 干净 |

## 对抗关

- 重复提交：downloading 中连发 3 次 download（假桥接 + 路由层）状态一致（V6 证据）✅
- 外部依赖失败：断网 → checkForUpdates error 事件 → error 态不弹窗（代码审读；真机项 D3）✅
- **发现并修复 1 缺陷**：`shell.openPath` 失败返回错误串而非 reject（Electron API 行为），原实现会在打开失败时照常退出应用。已改为校验返回值、失败保持 ready 可重试（electron/updater.js install 分支），修复后语法+构建复检通过。
- 规格外改动：无（git status 逐文件核对；test-data 下 1 个未跟踪文件为会话前已存在，未动）。新依赖仅 electron-updater（规格许可）。

## D 组：发布后人工验收手册（不阻塞合入，阻塞对外宣布"可自动更新"）

1. 替换 package.json `build.publish` 的 `owner`/`repo` 占位符 → 建公开仓库并 push
2. `npm version patch && git push --follow-tags` → CI 出 draft release（资产应含 dmg/zip/exe + 2 blockmap + latest-mac.yml + latest.yml 共 8 件）→ 核对后 Publish
3. **D2（mac）**：装 v0.1.0 → Publish v0.1.1 → 10s~6h 内横幅出现 → 立即更新 → 进度条 → 打开安装包并退出 → 拖入替换 → 关于显示 v0.1.1
4. **D1（win）**：Windows 虚拟机装 v0.1.0 → 同上 → 重启并安装全自动
5. **D3（断网）**：断网重启应用 → 无横幅无弹窗；恢复后设置页重试 → 横幅出现
