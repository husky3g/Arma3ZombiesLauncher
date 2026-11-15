'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (fn) => { const h = (_e, d) => fn(d); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld('zl', {
  init: invoke('init'), scan: invoke('scan'), stopScan: invoke('stopScan'), setState: invoke('setState'),
  detectArma: invoke('detectArma'), browseArma: invoke('browseArma'), refreshServer: invoke('refreshServer'),
  players: invoke('players'), addServer: invoke('addServer'), removeServer: invoke('removeServer'), mods: invoke('mods'),
  openExternal: invoke('openExternal'), downloadMods: invoke('downloadMods'), cancelDownload: invoke('cancelDownload'),
  join: invoke('join'), serverInfo: invoke('serverInfo'),
  updateState: invoke('updateState'), updateCheck: invoke('updateCheck'), updateRestart: invoke('updateRestart'), onUpdate: on('update'),
  onServers: on('servers'), onRemoved: on('removed'), onProgress: on('progress'), onCatalog: on('catalog'), onDownload: on('download'),
});
