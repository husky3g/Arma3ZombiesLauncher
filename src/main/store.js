'use strict';
// Tiny JSON-file persistence: each document is saved atomically, debounced.
const fs = require('fs');
const path = require('path');

class JsonDoc {
  constructor(file, defaults) {
    this.file = file;
    this.data = defaults;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = mergeDefaults(defaults, raw);
    } catch (_) { /* first run or corrupt: keep defaults */ }
    this.timer = null;
  }
  save(delay = 800) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('save failed', this.file, e.message); }
  }
}

function mergeDefaults(def, val) {
  if (Array.isArray(def) || typeof def !== 'object' || def === null) return val === undefined ? def : val;
  const out = { ...def };
  if (val && typeof val === 'object') for (const k of Object.keys(val)) out[k] = k in def ? mergeDefaults(def[k], val[k]) : val[k];
  return out;
}

function createStore(dir) {
  const state = new JsonDoc(path.join(dir, 'state.json'), {
    settings: {
      armaPath: '',
      launchMethod: 'steam',     // 'steam' | 'direct'
      extraParams: '-noSplash -skipIntro -world=empty',
      rescanMinutes: 15,
      deepScan: true,            // query mod lists of every Arma server to find zombie mods
      autoUpdate: true,          // check GitHub for a newer launcher on start
    },
    filters: {
      name: '',
      mods: [],                  // must have ALL of these mods
      excludeMods: [],           // hide servers with ANY of these
      maps: [],                  // empty = all
      excludeGametypes: ['Zombie mods (Ops/Zeus)'],  // hidden by default
      show: { full: true, password: true, noinfo: false, locked: true, empty: false, hidden: false },
    },
    sort: {
      favorites: { key: 'players', dir: -1 },
      browse: { key: 'players', dir: -1 },
      history: { key: 'joinedAt', dir: -1 },
    },
    favorites: [],
    hidden: [],                  // server keys the player chose to hide everywhere
    history: [],                 // [{ key, joinedAt }]
    passwords: {},
  });
  const servers = new JsonDoc(path.join(dir, 'servers.json'), { servers: {}, negative: {}, lastDiscovery: 0 });
  const catalog = new JsonDoc(path.join(dir, 'catalog.json'), { mods: {}, maps: {}, gametypes: {}, workshop: {} });
  return { state, servers, catalog, flushAll() { state.flush(); servers.flush(); catalog.flush(); } };
}

module.exports = { createStore };
