// Only the bundled setup page uses this; the main process ignores calls from any other page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stageSetup', {
  current: () => ipcRenderer.invoke('stage:current'),
  save: (link) => ipcRenderer.invoke('stage:save', link),
});
