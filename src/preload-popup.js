// 渲染进程与主进程之间的安全桥
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onData: (cb) => ipcRenderer.on('popup:data', (_e, payload) => cb(payload)),
  copy: (text) => ipcRenderer.invoke('popup:copy', text),
  retranslate: () => ipcRenderer.invoke('popup:retranslate'),
  close: () => ipcRenderer.invoke('popup:close'),
  resize: (w, h) => ipcRenderer.invoke('popup:resize', { width: w, height: h }),
  getConfig: () => ipcRenderer.invoke('cfg:get'),
  setConfig: (patch) => ipcRenderer.invoke('cfg:set', patch),
  openSettings: () => ipcRenderer.invoke('open:settings'),
});
