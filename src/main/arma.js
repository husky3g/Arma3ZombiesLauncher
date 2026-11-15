'use strict';
// Arma 3 install detection, installed-mod checks and game launching.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const APPID = '107410';

// Creator DLC appear in the server mod list as DLC entries keyed by Steam app id.
const CDLC = {
  '1042220': 'gm', '1227700': 'vn', '1294440': 'csla', '1175380': 'spe',
  '1681170': 'ws', '2647760': 'rf', '2647830': 'ef',
};

function regQuery(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const m = out.match(new RegExp(value + '\\s+REG_\\w+\\s+(.+)', 'i'));
      resolve(m ? m[1].trim() : null);
    });
  });
}

const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };

async function steamRoot() {
  const cands = [
    await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    await regQuery('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'),
    'C:\\Program Files (x86)\\Steam',
  ].filter(Boolean).map((p) => path.normalize(p));
  return cands.find((p) => exists(path.join(p, 'steam.exe'))) || cands.find(exists) || null;
}

function libraryFolders(root) {
  const libs = new Set(root ? [root] : []);
  try {
    const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(path.normalize(m[1].replace(/\\\\/g, '\\')));
  } catch (_) {}
  return [...libs];
}

/** Returns { armaPath, steamRoot, library, workshopDir, exe } or null fields when not found. */
async function detect(preferredPath) {
  const root = await steamRoot();
  const out = { steamRoot: root, armaPath: null, library: null, workshopDir: null };
  const tryPath = (p) => p && exists(path.join(p, 'arma3_x64.exe')) ? p : null;
  out.armaPath = tryPath(preferredPath) || tryPath(await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Bohemia Interactive\\arma 3', 'main'));
  if (!out.armaPath && root) {
    for (const lib of libraryFolders(root)) {
      const p = tryPath(path.join(lib, 'steamapps', 'common', 'Arma 3'));
      if (p) { out.armaPath = p; break; }
    }
  }
  if (out.armaPath) {
    // <library>\steamapps\common\Arma 3  ->  <library>
    const lib = path.resolve(out.armaPath, '..', '..', '..');
    out.library = lib;
    const ws = path.join(lib, 'steamapps', 'workshop', 'content', APPID);
    out.workshopDir = ws;
  }
  return out;
}

function workshopModPath(env, id) {
  const cands = [];
  if (env.workshopDir) cands.push(path.join(env.workshopDir, id));
  if (env.steamRoot) for (const lib of libraryFolders(env.steamRoot)) cands.push(path.join(lib, 'steamapps', 'workshop', 'content', APPID, id));
  return cands.find((p) => exists(path.join(p, 'addons')) || exists(path.join(p, 'meta.cpp'))) || null;
}

function localModPath(env, name) {
  if (!env.armaPath || !name) return null;
  const clean = name.replace(/[^\w\- ]/g, '').trim();
  const cands = ['@' + clean, '@' + clean.replace(/\s+/g, '_'), '@' + clean.replace(/\s+/g, ''), clean];
  return cands.map((c) => path.join(env.armaPath, c)).find((p) => exists(path.join(p, 'addons'))) || null;
}

/** For each server mod: is it installed and where. */
function resolveMods(env, mods) {
  return (mods || []).map((m) => {
    if (m.isDlc) {
      const folder = CDLC[m.steamId];
      const p = folder && env.armaPath ? path.join(env.armaPath, folder) : null;
      return { ...m, kind: 'dlc', folder: folder || null, path: p && exists(p) ? p : null, installed: !!(p && exists(p)) };
    }
    const p = (m.steamId && workshopModPath(env, m.steamId)) || localModPath(env, m.name);
    return { ...m, kind: m.steamId ? 'workshop' : 'local', path: p, installed: !!p };
  });
}

/** true when an Arma 3 game process is already running (so we don't start a second copy). */
function isRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq arma3_x64.exe', '/NH'], { windowsHide: true }, (err, out) => {
      if (err) return resolve(false);
      resolve(/arma3_x64\.exe/i.test(out || ''));
    });
  });
}

function launch(env, settings, server, { password, modPaths }) {
  if (!env.armaPath) throw new Error('Arma 3 installation not found. Set it in Settings.');
  const args = [];
  for (const tok of (settings.extraParams || '').match(/"[^"]*"|\S+/g) || []) args.push(tok.replace(/^"|"$/g, ''));
  args.push('-connect=' + server.ip, '-port=' + server.gamePort);
  if (password) args.push('-password=' + password);
  if (modPaths.length) args.push('-mod=' + modPaths.join(';'));

  if (settings.launchMethod === 'direct') {
    // BattlEye-protected servers need the BE launcher stub in front of the game.
    const be = path.join(env.armaPath, 'arma3battleye.exe');
    const exe = path.join(env.armaPath, 'arma3_x64.exe');
    const child = server.battleye && exists(be)
      ? spawn(be, ['2', '1', '1', '-exe', 'arma3_x64.exe', ...args], { cwd: env.armaPath, detached: true, stdio: 'ignore' })
      : spawn(exe, args, { cwd: env.armaPath, detached: true, stdio: 'ignore' });
    child.unref();
    return { method: 'direct', args };
  }
  // Through Steam: the official launcher starts the game straight away (-noLauncher) and handles BattlEye (-useBE).
  const steamExe = env.steamRoot && path.join(env.steamRoot, 'steam.exe');
  if (!steamExe || !exists(steamExe)) throw new Error('Steam not found');
  const steamArgs = ['-applaunch', APPID, '-noLauncher', ...(server.battleye ? ['-useBE'] : []), ...args];
  const child = spawn(steamExe, steamArgs, { detached: true, stdio: 'ignore' });
  child.unref();
  return { method: 'steam', args: steamArgs };
}

module.exports = { detect, resolveMods, launch, isRunning, workshopModPath, CDLC };
