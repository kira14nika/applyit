// The only bridge between the window and Node. contextIsolation on, nodeIntegration
// off, sandboxed: the page gets these functions and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('applyit', {
  start: (opts) => ipcRenderer.invoke('run:start', opts),
  control: (action) => ipcRenderer.invoke('run:control', action),
  browser: (show) => ipcRenderer.invoke('browser:visibility', show),
  dashboard: () => ipcRenderer.invoke('data:dashboard'),
  applications: () => ipcRenderer.invoke('data:applications'),
  job: (id) => ipcRenderer.invoke('data:job', id),
  reports: () => ipcRenderer.invoke('data:reports'),
  onEvent: (cb) => ipcRenderer.on('run:event', (_e, m) => cb(m)),
  onLog: (cb) => ipcRenderer.on('run:log', (_e, line) => cb(line)),
  onExit: (cb) => ipcRenderer.on('run:exit', (_e, x) => cb(x)),
});
