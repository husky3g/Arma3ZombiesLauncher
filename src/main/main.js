'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const { createStore } = require('./store');
const { A2SClient } = require('./a2s');
const { Scanner } = require('./scanner');
const { KNOWN_MAPS, KNOWN_GAMETYPES, mapLabel } = require('./classify');
const arma = require('./arma');
const { workshopDetails } = require('./workshop-info');
const { discoverViaSteam, stopSteamDiscovery } = require('./steam-discovery');
const { Updater } = require('./updater');
const { LaunchWatch } = require('./launch-watch');

let win, store, client, scanner, env = {}, rescanTimer = null, worker = null, updater = null, launchWatch = null;

// Portable builds tell us where the real .exe lives (the app itself runs from a temp folder).
// ZL_UPDATE_EXE / ZL_FAKE_VERSION exist only to test the update flow.
function startUpdater() {
  updater = new Updater({
    currentVersion: process.env.ZL_FAKE_VERSION || app.getVersion(),
    exePath: process.env.ZL_UPDATE_EXE || process.env.PORTABLE_EXECUTABLE_FILE || null,
    log,
  });
  updater.cleanup();
  updater.on('state', (s) => send('update', s));
  if (!updater.supported || store.state.data.settings.autoUpdate === false) return;
  setTimeout(async () => {
    const s = await updater.check();
    if (s.status === 'available') updater.download();
  }, 4000);
}

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 680,
    backgroundColor: '#0a0a0b', title: 'Zombies Launcher',
    icon: path.join(__dirname, '../../assets/icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a0a0b', symbolColor: '#d9d2cb', height: 34 },
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function scheduleRescan() {
  clearInterval(rescanTimer);
  const mins = Math.max(3, +store.state.data.settings.rescanMinutes || 15);
  rescanTimer = setInterval(async () => {
    // The Steam server-list helper briefly signs in as "Arma 3"; never do that while the game is starting or running.
    if (launchWatch && launchWatch.pending) return;
    if (await arma.isRunning()) return;
    scanner.scan();
  }, mins * 60e3);
}

function publicState() {
  const d = store.state.data;
  return { settings: d.settings, filters: d.filters, sort: d.sort, favorites: d.favorites, history: d.history, hidden: d.hidden };
}

function serverByKey(key) { return store.servers.data.servers[key]; }

// Plain-text event log (userData/launcher.log) for troubleshooting downloads, launches and scans.
let logFile = null;
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try {
    if (!logFile) {
      logFile = path.join(app.getPath('userData'), 'launcher.log');
      const fs = require('fs');
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2e6) fs.renameSync(logFile, logFile + '.old');
    }
    require('fs').appendFileSync(logFile, line);
  } catch (_) {}
}

app.whenReady().then(async () => {
  store = createStore(app.getPath('userData'));
  client = new A2SClient();
  scanner = new Scanner(store, client, (onBatch) => discoverViaSteam(env.armaPath, onBatch));
  scanner.on('servers', (list) => send('servers', list));
  scanner.on('removed', (key) => send('removed', key));
  scanner.on('progress', (p) => {
    send('progress', p);
    if (p.phase === 'idle') log('scan finished:', Object.keys(store.servers.data.servers).length, 'zombie servers', p.note ? 'note=' + JSON.stringify(p.note) : '');
  });
  scanner.on('catalog', (c) => send('catalog', c));
  env = await arma.detect(store.state.data.settings.armaPath);
  log('launcher started; arma:', env);
  if (env.armaPath && !store.state.data.settings.armaPath) { store.state.data.settings.armaPath = env.armaPath; store.state.save(); }
  createWindow();
  scheduleRescan();
  startUpdater();
  devHooks();
});

// A downloaded update the player didn't restart for is installed when the launcher closes.
app.on('will-quit', () => { if (updater && updater.ready) updater.apply(); });

ipcMain.handle('updateState', () => ({ ...(updater ? updater.state : { status: 'idle' }), current: app.getVersion(), supported: !!(updater && updater.supported) }));
ipcMain.handle('updateCheck', async () => {
  if (!updater || !updater.supported) return { status: 'unsupported' };
  const s = await updater.check();
  if (s.status === 'available') updater.download();
  return s;
});
ipcMain.handle('updateRestart', () => (updater ? updater.restart(app) : false));

// Development helpers: ZL_SEED="ip:port,..." adds servers, ZL_SNAPSHOT="file.png" captures the window.
async function devHooks() {
  if (process.env.ZL_SEED) {
    for (const hp of process.env.ZL_SEED.split(',')) {
      const [h, p] = hp.split(':');
      try { await scanner.addManual(h, +p); } catch (e) { console.log('seed failed', hp, e.message); }
    }
  }
  if (process.env.ZL_SNAPSHOT) {
    setTimeout(async () => {
      if (process.env.ZL_SELECT) await win.webContents.executeJavaScript(`document.querySelector('#tbody tr')?.click()`);
      if (process.env.ZL_EVAL) console.log('EVAL', await win.webContents.executeJavaScript(process.env.ZL_EVAL));
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        require('fs').writeFileSync(process.env.ZL_SNAPSHOT, img.toPNG());
        if (process.env.ZL_QUIT) app.quit();
      }, 1200);
    }, +process.env.ZL_DELAY || 6000);
  }
}

app.on('window-all-closed', () => { store && store.flushAll(); if (worker) worker.kill(); app.quit(); });

// ---------- IPC ----------
ipcMain.handle('init', () => ({
  state: publicState(),
  servers: Object.values(store.servers.data.servers),
  catalog: store.catalog.data,
  knownMaps: KNOWN_MAPS,
  knownGametypes: KNOWN_GAMETYPES,
  env, scanning: scanner.scanning, lastDiscovery: store.servers.data.lastDiscovery,
}));

ipcMain.handle('scan', () => { scanner.scan(); return true; });
ipcMain.handle('stopScan', () => { scanner.stop(); return true; });

ipcMain.handle('setState', (_e, patch) => {
  const d = store.state.data;
  for (const k of ['filters', 'sort', 'favorites', 'history', 'passwords', 'hidden']) if (patch[k] !== undefined) d[k] = patch[k];
  if (patch.settings) {
    const before = d.settings;
    d.settings = { ...before, ...patch.settings };
    if (patch.settings.rescanMinutes !== undefined) scheduleRescan();
  }
  store.state.save();
  return publicState();
});

ipcMain.handle('detectArma', async (_e, p) => {
  env = await arma.detect(p || store.state.data.settings.armaPath);
  if (env.armaPath) { store.state.data.settings.armaPath = env.armaPath; store.state.save(); }
  return env;
});

ipcMain.handle('browseArma', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Select your Arma 3 folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return env;
  env = await arma.detect(r.filePaths[0]);
  if (env.armaPath) { store.state.data.settings.armaPath = env.armaPath; store.state.save(); }
  else dialog.showMessageBox(win, { type: 'warning', message: 'arma3_x64.exe was not found in that folder.' });
  return env;
});

ipcMain.handle('refreshServer', async (_e, key) => scanner.refreshOne(key));

ipcMain.handle('players', async (_e, key) => {
  const s = serverByKey(key);
  if (!s) throw new Error('Unknown server');
  return client.players(s.ip, s.queryPort);
});

ipcMain.handle('addServer', async (_e, host, port) => scanner.addManual(host, port));

ipcMain.handle('removeServer', (_e, key) => {
  delete store.servers.data.servers[key];
  store.servers.data.negative[key] = { at: Date.now() + 365 * 24 * 3600e3, name: '' }; // never re-add automatically
  store.servers.save();
  send('removed', key);
  return true;
});

ipcMain.handle('mods', (_e, key) => {
  const s = serverByKey(key);
  return s ? arma.resolveMods(env, s.mods) : [];
});

// Everything known about a server for the info dialog, incl. Workshop sizes for the download estimate.
ipcMain.handle('serverInfo', async (_e, key) => {
  const s = serverByKey(key);
  if (!s) throw new Error('Unknown server');
  const mods = arma.resolveMods(env, s.mods);
  const ws = await workshopDetails(store.catalog.data.workshop, mods.filter((m) => m.kind === 'workshop').map((m) => m.steamId));
  store.catalog.save(2000);
  const list = mods.map((m) => {
    const d = m.kind === 'workshop' ? ws[m.steamId] : null;
    return { ...m, hash: undefined, size: d ? d.size : null, workshopTitle: d ? d.title : null, unavailable: !!(d && d.unavailable) };
  });
  const req = list.filter((m) => m.kind !== 'dlc');
  const missing = req.filter((m) => !m.installed);
  return {
    server: s,
    mods: list,
    totalBytes: req.reduce((a, m) => a + (m.size || 0), 0),
    missingBytes: missing.reduce((a, m) => a + (m.size || 0), 0),
    missingCount: missing.length,
    unknownSizes: missing.filter((m) => m.kind === 'workshop' && !m.size).length,
    manualMissing: missing.filter((m) => m.kind !== 'workshop').length,
  };
});

ipcMain.handle('openExternal', (_e, url) => { if (/^(https?|steam):/.test(url)) shell.openExternal(url); });

ipcMain.handle('downloadMods', (_e, key) => {
  const s = serverByKey(key);
  if (!s) throw new Error('Unknown server');
  const ids = arma.resolveMods(env, s.mods).filter((m) => m.kind === 'workshop').map((m) => m.steamId);
  if (!ids.length) return { started: false, reason: 'This server has no Steam Workshop mods.' };
  if (worker) return { started: false, reason: 'A download is already running.' };
  log('download start', s.name, 'workshop ids:', ids);
  // The list helper also runs as "Arma 3"; stop it so the two don't fight over the Steam app session.
  stopSteamDiscovery();
  const workerPath = path.join(__dirname, 'workshop-worker.js').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  worker = fork(workerPath, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '', lastStates = '';
  worker.stderr.on('data', (d) => { stderr += d; });
  worker.on('message', (m) => {
    if (m.type === 'ready') worker.send({ cmd: 'download', ids });
    if (m.type === 'progress' || m.type === 'done') {
      // log only when an item's state/done flag changes, plus a byte summary
      const states = m.items.map((i) => `${i.id}:${i.state}${i.done ? '✓' : ''}`).join(' ');
      if (states !== lastStates || m.type === 'done') {
        lastStates = states;
        const cur = m.items.reduce((a, i) => a + (i.current || 0), 0), tot = m.items.reduce((a, i) => a + (i.total || 0), 0);
        log('download', m.type, `${m.items.filter((i) => i.done).length}/${m.items.length} done`, `${(cur / 1048576).toFixed(1)}/${(tot / 1048576).toFixed(1)} MB`, states);
      }
    } else log('download msg', m);
    send('download', { key, ...m });
  });
  worker.on('exit', (code) => {
    log('download helper exited code', code, stderr.trim().slice(-500));
    if (code && code !== 0) send('download', { key, type: 'error', message: stderr.trim().split('\n').pop() || 'Steam download helper stopped (code ' + code + ')' });
    send('download', { key, type: 'exit' });
    worker = null;
  });
  return { started: true, count: ids.length };
});

ipcMain.handle('cancelDownload', () => { if (worker) worker.kill(); return true; });

ipcMain.handle('join', async (_e, key, password, { ignoreMissing = false } = {}) => {
  const s = serverByKey(key);
  if (!s) throw new Error('Unknown server');
  if (worker) throw new Error('Mods are still downloading. Wait for the download to finish before joining.');
  if (await arma.isRunning()) {
    log('join blocked: Arma 3 already running');
    throw new Error('Arma 3 is already running. Close it first, or switch to the game window.');
  }
  if (!env.armaPath) env = await arma.detect(store.state.data.settings.armaPath);
  const mods = arma.resolveMods(env, s.mods);
  const missing = mods.filter((m) => !m.installed && m.kind !== 'dlc');
  log('join', s.name, `${s.ip}:${s.gamePort}`, 'mods', mods.length, 'missing', missing.map((m) => m.name), 'ignoreMissing', ignoreMissing);
  if (missing.length && !ignoreMissing) return { ok: false, missing };
  const modPaths = mods.filter((m) => m.installed && m.path).map((m) => m.path);
  // The server-list helper briefly runs as "Arma 3" in Steam; stop it so Steam lets the real game start.
  if (stopSteamDiscovery()) { log('stopped server-list helper before launch'); await new Promise((r) => setTimeout(r, 1500)); }
  if (!launchWatch || launchWatch.steamRoot !== env.steamRoot) {
    if (launchWatch) launchWatch.stop();
    launchWatch = new LaunchWatch({ steamRoot: env.steamRoot, isRunning: arma.isRunning, log });
    launchWatch.steamRoot = env.steamRoot;
    launchWatch.on('launch', (ev) => send('launch', ev));
  }
  const settings = store.state.data.settings;
  launchWatch.begin({ viaSteam: settings.launchMethod !== 'direct' });
  let res;
  try { res = arma.launch(env, settings, s, { password, modPaths }); }
  catch (e) { launchWatch.stop(); log('launch failed', e.message); throw e; }
  log('launched via', res.method, 'args:', res.args.map((a) => (a.startsWith('-password=') ? '-password=***' : a)));
  const d = store.state.data;
  d.history = [{ key, joinedAt: Date.now(), name: s.name, map: s.map }, ...d.history.filter((h) => h.key !== key)].slice(0, 200);
  if (password) d.passwords[key] = password;
  store.state.save();
  return { ok: true, launched: res.method, history: d.history };
});

ipcMain.handle('mapLabel', (_e, m) => mapLabel(m));
