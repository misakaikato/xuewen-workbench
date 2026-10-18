// 打包后裁剪：onnxruntime-node / better-sqlite3 自带全平台二进制（合计 ~300MB），
// 按当前构建目标只留对应平台目录，产物体积减半以上。
// asarUnpack 的文件在 app.asar.unpacked 下，与 asar 内路径同构。
const fs = require('node:fs');
const path = require('node:path');

/** @param {import('electron-builder').AfterPackContext} context */
module.exports = async function (context) {
  const platform = context.electronPlatformName; // darwin | win32 | linux
  const arch = context.arch === 'x64' ? 'x64' : context.arch === 'ia32' ? 'ia32' : 'arm64';
  const resDir = path.join(context.appOutDir, 'Xuewen Workbench.app', 'Contents', 'Resources');
  const unpacked = path.join(context.appOutDir, 'resources', 'app.asar.unpacked');
  // 布局差异：linux/win 在 <appOutDir>/resources/，macOS 在 <appOutDir>/<AppName>.app/Contents/Resources/
  const realUnpacked = fs.existsSync(unpacked) ? unpacked : path.join(resDir, 'app.asar.unpacked');
  if (!fs.existsSync(realUnpacked)) return;

  const ortBin = path.join(realUnpacked, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  if (fs.existsSync(ortBin)) {
    for (const plat of fs.readdirSync(ortBin)) {
      const keep = plat === platform;
      if (!keep) {
        fs.rmSync(path.join(ortBin, plat), { recursive: true, force: true });
        console.log(`  [prune] 移除 ort/${plat}`);
        continue;
      }
      if (plat === 'win32') continue; // win32 目录不分 x64/arm64 子目录，整体保留
      // darwin/linux 按目录名含架构裁剪
      for (const a of fs.readdirSync(path.join(ortBin, plat))) {
        if (a !== arch) {
          fs.rmSync(path.join(ortBin, plat, a), { recursive: true, force: true });
          console.log(`  [prune] 移除 ort/${plat}/${a}`);
        }
      }
    }
  }

  const sqlitePre = path.join(realUnpacked, 'node_modules', 'better-sqlite3', 'prebuilds');
  if (fs.existsSync(sqlitePre)) {
    // prebuilds/{darwin,win32,linux}-{arch}/ 只留当前平台
    const want = `${platform}-${arch}`;
    for (const d of fs.readdirSync(sqlitePre)) {
      if (d !== want && !d.startsWith(`${platform}-`)) {
        // 其它平台整体删；同平台不同架构也删
        if (d !== want) {
          fs.rmSync(path.join(sqlitePre, d), { recursive: true, force: true });
          console.log(`  [prune] 移除 better-sqlite3/prebuilds/${d}`);
        }
      }
    }
    // better-sqlite3 的 release 编译产物在 build/（单一架构，无需处理）
  }
}
