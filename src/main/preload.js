'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  clearIncidents: () => ipcRenderer.invoke('clear-incidents'),
  exportCsv: () => ipcRenderer.invoke('export-csv'),
  onSample: on('sample'),
  onIncidents: on('incidents'),
});
