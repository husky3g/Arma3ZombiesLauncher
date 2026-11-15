'use strict';
// Discovers Arma 3 servers, queries them and keeps the local zombie-server database up to date.
const { EventEmitter } = require('events');
const dns = require('dns').promises;
const { classify, looksPromising } = require('./classify');
const CLASSIFIER_VERSION = 2; // bump when classify() rules change so stored servers are re-checked

const APPID = 107410;
const NEGATIVE_TTL = 24 * 3600e3;   // re-check non-zombie servers once a day
const RULES_TTL = 30 * 60e3;        // refresh mod lists every 30 minutes at most
const PRUNE_AFTER = 30 * 24 * 3600e3;

async function pool(items, limit, fn, shouldStop) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length && !(shouldStop && shouldStop())) { const it = items[i++]; try { await fn(it); } catch (_) {} }
  });
  await Promise.all(workers);
}

class Scanner extends EventEmitter {
  /** @param discover (onBatch) => Promise  streams server addresses from the Steam client */
  constructor(store, client, discover) {
    super();
    this.store = store; this.client = client; this.discover = discover;
    this.db = store.servers.data;
    this.catalog = store.catalog.data;
    this.changed = new Set();
    this.scanning = false; this.cancel = false;
    this.flushTimer = setInterval(() => this._flushChanges(), 400);
    this._prune();
    this._reclassify();
  }

  get settings() { return this.store.state.data.settings; }

  /** Re-run the classifier over stored servers when its rules changed (no network needed). */
  _reclassify() {
    if (this.db.classifierVersion === CLASSIFIER_VERSION) return;
    for (const [k, s] of Object.entries(this.db.servers)) {
      const c = classify(s);
      if (c.zombie || s.manual) { s.zombie = true; s.gametype = c.gametype || 'Zombies (Other)'; s.reason = c.reason || s.reason; }
      else { delete this.db.servers[k]; this.db.negative[k] = { at: Date.now(), name: s.name }; }
    }
    // servers previously rejected may qualify under the new rules: let the next scan look at them again
    if (this.db.classifierVersion !== undefined) this.db.negative = {};
    this.db.classifierVersion = CLASSIFIER_VERSION;
    const c = this.catalog; c.gametypes = {};
    for (const s of Object.values(this.db.servers)) if (s.gametype) c.gametypes[s.gametype] = { count: 0, lastSeen: Date.now() };
    this._recount();
    this.store.servers.save(); this.store.catalog.save();
  }

  _prune() {
    const now = Date.now();
    for (const [k, s] of Object.entries(this.db.servers)) {
      if (!s.manual && now - (s.lastSeen || s.firstSeen || 0) > PRUNE_AFTER) delete this.db.servers[k];
    }
    for (const [k, t] of Object.entries(this.db.negative)) if (now - t.at > NEGATIVE_TTL * 3) delete this.db.negative[k];
  }

  _flushChanges() {
    if (!this.changed.size) return;
    const list = [...this.changed].map((k) => this.db.servers[k]).filter(Boolean);
    this.changed.clear();
    this.emit('servers', list);
    this.store.servers.save(2000);
  }

  _progress(p) { this.emit('progress', p); }


  _updateCatalog(s) {
    const now = Date.now();
    const bump = (obj, k, extra) => { if (!k) return; const e = obj[k] || (obj[k] = { count: 0, firstSeen: now }); e.lastSeen = now; Object.assign(e, extra); };
    for (const m of s.mods || []) if (!m.isDlc && m.name) bump(this.catalog.mods, m.name, { steamId: m.steamId || null });
    bump(this.catalog.maps, s.map);
    bump(this.catalog.gametypes, s.gametype);
    this.catalog.mods && this._recount();
    this.store.catalog.save(3000);
  }

  _recount() {
    clearTimeout(this._recountTimer);
    this._recountTimer = setTimeout(() => {
      const c = this.catalog; for (const o of [c.mods, c.maps, c.gametypes]) for (const v of Object.values(o)) v.count = 0;
      for (const s of Object.values(this.db.servers)) {
        if (!s.zombie) continue;
        for (const m of s.mods || []) if (!m.isDlc && c.mods[m.name]) c.mods[m.name].count++;
        if (c.maps[s.map]) c.maps[s.map].count++;
        if (c.gametypes[s.gametype]) c.gametypes[s.gametype].count++;
      }
      this.emit('catalog', this.catalog);
    }, 1500);
  }

  /** Query one server fully and store the result if it is a zombie server. */
  async probe(base, { forceRules = false, keepEvenIfNot = false } = {}) {
    const key = `${base.ip}:${base.queryPort}`;
    const prev = this.db.servers[key];
    let info;
    try { info = await this.client.info(base.ip, base.queryPort); }
    catch (e) {
      if (prev) { prev.online = false; prev.ping = null; prev.lastQueried = Date.now(); this.changed.add(key); }
      return prev || null;
    }
    const rec = {
      ...(prev || { firstSeen: Date.now(), mods: [], signatures: [] }),
      key, ip: base.ip, queryPort: base.queryPort,
      gamePort: info.gamePort || base.gamePort || base.queryPort - 1,
      name: info.name, map: info.map, game: info.game, players: info.players, maxPlayers: info.maxPlayers,
      password: info.password, locked: !!info.locked, battleye: !!info.battleye, version: info.version,
      armaGameType: info.gameType || '', serverState: info.serverState ?? null, ping: info.ping, online: true, lastSeen: Date.now(), lastQueried: Date.now(),
      manual: (prev && prev.manual) || !!base.manual,
    };
    const needRules = forceRules || !prev || !prev.rulesAt || Date.now() - prev.rulesAt > RULES_TTL || prev.name !== rec.name;
    if (needRules) {
      try {
        const r = await this.client.rules(base.ip, base.queryPort);
        rec.mods = r.mods; rec.signatures = r.signatures; rec.description = r.description || null; rec.verifySignatures = !!info.verifySignatures; rec.difficulty = r.difficulty ?? null; rec.modsTruncated = !!r.truncated || !!(r.overflow & 0x03);
        rec.rulesAt = Date.now(); rec.hasModInfo = r.decoded;
      } catch (_) { rec.hasModInfo = !!(prev && prev.hasModInfo); }
    }
    const c = classify(rec);
    rec.zombie = c.zombie || rec.manual || keepEvenIfNot;
    rec.gametype = c.gametype || (rec.zombie ? 'Zombies (Other)' : null);
    rec.reason = c.reason || (rec.manual ? 'added manually' : null);
    if (rec.zombie) {
      this.db.servers[key] = rec; delete this.db.negative[key];
      this.changed.add(key); this._updateCatalog(rec);
    } else {
      if (prev) { delete this.db.servers[key]; this.emit('removed', key); }
      this.db.negative[key] = { at: Date.now(), name: rec.name };
    }
    return rec;
  }

  async refreshOne(key, opts) {
    const s = this.db.servers[key];
    if (!s) return null;
    const r = await this.probe(s, { forceRules: true, ...opts });
    this._flushChanges();
    return r;
  }

  async addManual(host, port) {
    const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : (await dns.lookup(host, { family: 4 })).address;
    port = +port || 2302;
    for (const qp of [port + 1, port]) {
      try {
        await this.client.info(ip, qp, 2500);
        const r = await this.probe({ ip, queryPort: qp, gamePort: port, manual: true }, { forceRules: true, keepEvenIfNot: true });
        this._flushChanges();
        return r;
      } catch (_) {}
    }
    throw new Error('Server did not answer on query port ' + (port + 1) + ' or ' + port);
  }

  stop() { this.cancel = true; }

  /** Full cycle: refresh known zombie servers, then discover new ones from the Steam master list. */
  async scan() {
    if (this.scanning) return;
    this.scanning = true; this.cancel = false;
    const stop = () => this.cancel;
    let note = null;
    try {
      // 1) Refresh what we already know so the list is live quickly.
      const known = Object.values(this.db.servers);
      let done = 0;
      this._progress({ phase: 'refresh', done, total: known.length });
      await pool(known, 48, async (s) => { await this.probe(s); this._progress({ phase: 'refresh', done: ++done, total: known.length }); }, stop);

      // 2) Discover: the local Steam client streams every Arma 3 server address; we check them as they arrive.
      if (!this.cancel && this.discover) {
        const queue = []; let listed = 0, checked = 0, queued = 0, listDone = false;
        const seen = new Set();
        const report = () => this._progress({ phase: 'discover', done: checked, total: queued, masterCount: listed, listing: !listDone });
        const onBatch = (batch) => {
          const now = Date.now();
          for (const m of batch) {
            const key = `${m.ip}:${m.queryPort}`;
            if (seen.has(key)) continue;
            seen.add(key); listed++;
            if (this.db.servers[key] || m.responded === false) continue; // just refreshed / not answering
            const neg = this.db.negative[key];
            if (neg && now - neg.at < NEGATIVE_TTL && neg.name === m.name) continue;
            if (!this.settings.deepScan && !looksPromising(m)) continue;
            // promising names jump the queue so obvious zombie servers appear first
            if (looksPromising(m)) queue.unshift(m); else queue.push(m);
            queued++;
          }
          report();
        };
        const listing = this.discover(onBatch)
          .then(() => { this.db.lastDiscovery = Date.now(); })
          .catch((e) => { note = { code: e.code || 'STEAM', message: e.message }; })
          .finally(() => { listDone = true; report(); });
        const worker = async () => {
          while (!this.cancel) {
            const m = queue.shift();
            if (!m) { if (listDone) return; await new Promise((r) => setTimeout(r, 150)); continue; }
            try { await this.probe(m); } catch (_) {}
            checked++; if (checked % 8 === 0) report();
          }
        };
        await Promise.all([listing, ...Array.from({ length: 64 }, worker)]);
      }
    } finally {
      this._flushChanges();
      this.store.servers.save(200);
      this.scanning = false;
      this._progress({ phase: 'idle', note, at: Date.now(), count: Object.keys(this.db.servers).length });
    }
  }
}

module.exports = { Scanner };
