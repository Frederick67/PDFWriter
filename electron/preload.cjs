const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('native', {
  open: () => ipcRenderer.invoke('dlg-open'),
  read: (p) => ipcRenderer.invoke('file-read', p),
  write: (p, bytes) => ipcRenderer.invoke('file-write', p, bytes),
  saveAs: (name, bytes) => ipcRenderer.invoke('dlg-saveas', name, bytes),
  saveSession: (tabs, active) => ipcRenderer.invoke('session-save', tabs, active),
  restore: () => ipcRenderer.invoke('session-restore'),
  newWindow: () => ipcRenderer.invoke('new-window'),
  winMinimize: () => ipcRenderer.invoke('win-min'),
  winToggleMax: () => ipcRenderer.invoke('win-max'),
  winClose: () => ipcRenderer.invoke('win-close'),
  onBeforeClose: (cb) => ipcRenderer.on('before-close', () => cb()),
  closeReady: () => ipcRenderer.invoke('close-ready'),
  onMaxState: (cb) => ipcRenderer.on('max-state', (_e, v) => cb(v)),
  pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  onOpen: (cb) => ipcRenderer.on('open-path', (_e, p) => cb(p)),
});
