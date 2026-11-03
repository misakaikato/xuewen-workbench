# 规格：mac 更新包下载走系统代理、可续传重试、可诊断

## 背景与目标
mac 版未签名，更新包由应用自己下载 DMG（`electron/updater.js` 的 `downloadDmg`），用的是 Node 内置的全局 `fetch`。

2026-11-03 在本机实测 0.1.9 升级 0.1.10，下载在 0% 停了约 10 秒，然后报「fetch failed」。主进程日志里没有任何失败原因；同一时段检查更新也偶发超时。

这条下载路径有三个问题：
1. **不走系统代理。** Node 的 `fetch` 不读 macOS 系统代理（也不读 `HTTPS_PROXY`）。检查更新由 electron-updater 走 Chromium 网络栈，会用系统代理，两者行为不一致。对只开了「系统代理」模式的用户，下载 GitHub 资产可能根本连不上。
2. **一次失败即放弃。** 没有重试，没有断点续传；300MB 的包遇到一次网络抖动就要从头再来。
3. **失败不可诊断。** 状态里只有 `e.message`（通常就是「fetch failed」），错误码和底层原因都没有写进日志。

**目标**：
- mac 下载 DMG 走 Electron `net.fetch`，与检查更新使用同一网络栈和代理设置；
- 网络抖动时自动续传重试；
- 下完用更新清单里的 sha512 校验完整性；
- 每次失败的原因都能在日志和界面上看到。

## 非目标
- 不改 Windows 的下载路径（electron-updater 自带下载与差量更新）。
- 不改自动安装（准备、替换）流程，不改界面组件。
- 不新增依赖。

## 现状（行号以实际代码为准）
- `electron/updater.js`：
  - `releaseDmgUrl`（约 91 行）：拼 DMG 地址；文件名缺失时回退到 GitHub API（`fetch`）。
  - `downloadDmg`（约 120 行）：`fetch(url)` 后逐块写入 `app.getPath('downloads')/<文件名>`，每 250ms 更新一次进度；失败时删掉半截文件。
  - `update-available` 事件（约 267 行）：从 `info.files` 里取 DMG 文件名，**此处没有记 sha512**。
  - 取消：`AbortController`。
- `scripts/test-mac-install.mjs`：M5 用 loader hook 把 `electron` 替换成桩模块 `stub-electron.mjs`，用本地 generic 发布源驱动 updater。

## 设计
1. **网络栈**：`downloadDmg` 和 `releaseDmgUrl` 的 API 回退都改用 `net.fetch`（`import { net } from 'electron'`）。

2. **记下 sha512**：`update-available` 时，从 `info.files` 中选中的 DMG 那一项里取出 `sha512`（base64 编码），连同文件名一起记住。

3. **续传与重试**：
   - 下载写入 `<目标>.part`，全部完成并通过校验后再改名为正式文件名。
   - 最多尝试 5 次，失败后依次等待 1、2、4、8 秒再重试。等待期间如果用户点了取消，立即结束。
   - 重试时，如果 `.part` 已有 N 字节，请求头带 `Range: bytes=N-`：
     - 服务器返回 206，就从第 N 字节接着写；
     - 返回 200（不支持续传），就清空 `.part` 从头写；
     - 返回 416，或其他与已写入内容不一致的情况，也清空重来。
   - **空闲超时**：60 秒内没收到任何新数据，就中止本次尝试并进入重试。
   - 以下错误不重试：用户取消；HTTP 4xx（416 除外，见上）。

4. **完整性校验**：
   - 有 sha512 时，下载完计算整个文件的 sha512（流式计算，不把文件整块读进内存），与清单比对。
   - 校验不通过：删除 `.part`，从头重下一次；第二次仍然不通过就报错：「安装包校验失败」。
   - 没有 sha512（异常清单）时，跳过校验，并记一行 WARN。

5. **进度**：继续沿用现有字段 `percent`、`transferred`、`total`、`bytesPerSecond`、`etaSeconds`。续传时 `transferred` 从已下载的字节数算起，速度只按本次尝试计算。

6. **日志与错误文案**：
   - 每次尝试失败，在主进程日志记一行 WARN：第几次、主机名、已下载字节数、错误码、原始错误信息。
   - 错误码的取法：依次取 `e.cause?.code`、`e.code`，再从 message 里匹配 `ERR_[A-Z_]+`；都没有就用 HTTP 状态码。
   - 下载开始和成功各记一行 INFO：地址的主机名与路径、总字节数、耗时。
   - 最终失败时，`status:'error'` 的 `error` 字段要写成人话并带上错误码，例如：「下载安装包失败（net::ERR_CONNECTION_RESET，已重试 5 次）」。
   - 取消时不记错误，状态回到 `available`，并删除 `.part`。这一点与现在的行为一致。

## 边界情况
| 情况 | 期望 |
|---|---|
| 下载到一半连接被重置 | 自动续传，最终完成；日志有一行 WARN |
| 服务器不支持 Range（续传请求返回 200） | 从头重写，最终完成 |
| 60 秒没有数据 | 中止本次尝试并重试 |
| 5 次都失败 | `error` 带错误码；`.part` 删除 |
| sha512 不符 | 自动重下一次；仍不符就报「安装包校验失败」 |
| 等待重试期间用户取消 | 立即回到 available，不再重试，`.part` 删除 |
| `Downloads` 目录不可写 | 立即报错（不重试），文案说明路径不可写 |

## 验收标准
- **G1**：`npx tsc -b` 和 `npx eslint .` 都是 0 问题；`npm run build` 成功。
- **G2**：在 `scripts/test-mac-install.mjs` 里新增用例（或新建 `scripts/test-dmg-download.mjs`）。
  - 测试环境：
    - 桩模块 `electron` 增加 `net.fetch`，指向全局 `fetch`；
    - 用本地 HTTP 服务模拟发布源，`latest-mac.yml` 里带正确的 sha512。
  - 要覆盖的用例：
    1. **断点续传**：服务器在第 1 次请求传到一半时断开连接。断言下载最终完成、文件逐字节一致；第 2 次请求带了 `Range` 头，且服务器返回 206；日志里有 1 行重试 WARN，带错误码。
    2. **不支持续传**：服务器忽略 Range，总是返回 200 和完整内容。断言最终文件正确。
    3. **校验失败**：服务器第 1 次返回被篡改的内容（长度相同）。断言自动重下一次后成功；再测一次两次都被篡改的情况，断言最终报错「安装包校验失败」，且 `.part` 已删除。
    4. **始终失败**：服务器始终返回 500。断言共尝试 5 次，最终 `error` 文案里带错误信息和次数。为了让测试跑得快，退避时间可以经由一个仅供测试的参数缩短，**参数不得通过环境变量暴露给产品**（可以用依赖注入或模块级 setter，并在报告中说明）。
    5. **重试等待期间取消**：断言状态回到 available，`.part` 已删除，之后不再有新的请求发出。
  - 原有的 M1–M5 全部通过。
- **G3**：回归全部通过：
  - 全部 `scripts/test-*.mjs`
  - `npm run test:e2e`
  - `e2e-update-ui`
  - `e2e-security`
  - `e2e-reader-regress`
  - `git diff --check`

## 明确禁止
- 不新增依赖；不改既有测试断言；不改 Windows 下载路径与安装流程。
- 不把测试开关做成产品可读的环境变量。
- 不读写 `~/.xuewen-workbench`、`/Users/mayu/Downloads`（测试用临时目录，`app.getPath('downloads')` 在桩里指向临时目录）。
