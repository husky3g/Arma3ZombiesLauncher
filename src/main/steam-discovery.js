'use strict';
// Runs steam-servers-worker.js in a separate process (so Steam only sees "Arma 3" while the list loads)
// and streams the server addresses back.
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

/**
 * @param {string} armaPath  folder containing the player's steam_api64.dll
 * @param {(servers:Array)=>void} onBatch
 * @returns {Promise<{total:number}>}
 */
function discoverViaSteam(armaPath, onBatch) {
  return new Promise((resolve, reject) => {
    const dll = armaPath && path.join(armaPath, 'steam_api64.dll');
    if (!dll || !fs.existsSync(dll)) {
      return reject(Object.assign(new Error('Arma 3 not found, so the Steam server list is unavailable.'), { code: 'NOARMA' }));
    }
    const worker = path.join(__dirname, 'steam-servers-worker.js').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    const child = fork(worker, [dll], {
      cwd: armaPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], // steam_api prints its own log lines; drop them
    });
    current = child;
    child.on('exit', () => { if (current === child) current = null; });
    let settled = false, total = 0;
    const finish = (err, val) => { if (settled) return; settled = true; err ? reject(err) : resolve(val); };
    child.on('message', (m) => {
      if (m.type === 'batch') { total += m.servers.length; onBatch(m.servers); }
      else if (m.type === 'done') finish(null, { total: m.total || total, timedOut: m.timedOut });
      else if (m.type === 'error') finish(Object.assign(new Error(m.message), { code: 'STEAM' }));
    });
    child.on('error', (e) => finish(Object.assign(e, { code: 'STEAM' })));
    child.on('exit', (code) => finish(code ? Object.assign(new Error('Steam server list helper stopped (code ' + code + ')'), { code: 'STEAM' }) : null, { total }));
  });
}

let current = null;

/** Kill a running server-list helper. Returns true if one was running. */
function stopSteamDiscovery() {
  if (!current) return false;
  try { current.kill(); } catch (_) {}
  current = null;
  return true;
}

module.exports = { discoverViaSteam, stopSteamDiscovery };
