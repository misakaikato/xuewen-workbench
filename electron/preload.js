// Electron preload：向渲染进程暴露最小的宿主能力（沙箱模式，contextBridge 白名单）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wbHost', {
  isElectron: true,
  /** 打开系统目录选择器，返回绝对路径；取消返回 null */
  selectDirectory: (defaultPath) => ipcRenderer.invoke('wb:selectDirectory', defaultPath),
  /** 在系统文件管理器中定位（已有 /api/reveal，这里备用） */
  platform: process.platform,
});
