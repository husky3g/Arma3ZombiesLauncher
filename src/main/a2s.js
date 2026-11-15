'use strict';
// Minimal, dependency-free Steam A2S query client (INFO / PLAYER / RULES)
// plus the Arma 3 binary rules decoder (mod list, DLC, signatures).
const dgram = require('dgram');

const A2S_INFO = 0x54, A2S_PLAYER = 0x55, A2S_RULES = 0x56;
const R_CHALLENGE = 0x41, R_INFO = 0x49, R_PLAYER = 0x44, R_RULES = 0x45;

class Reader {
  constructor(b, o = 0) { this.b = b; this.o = o; }
  left() { return this.b.length - this.o; }
  u8() { if (this.o >= this.b.length) throw new RangeError('eof'); return this.b[this.o++]; }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  i32() { const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  f32() { const v = this.b.readFloatLE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  bytes(n) { if (this.o + n > this.b.length) throw new RangeError('eof'); const s = this.b.subarray(this.o, this.o + n); this.o += n; return s; }
  cbuf() { let e = this.b.indexOf(0, this.o); if (e < 0) e = this.b.length; const s = this.b.subarray(this.o, e); this.o = e + 1; return s; }
  cstr() { return this.cbuf().toString('utf8'); }
}

const pad = (b) => Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), b]);

/**
 * One UDP socket shared by every query. Replies are routed by remote address;
 * requests to the same address are serialised so replies never get mixed up.
 */
class A2SClient {
  constructor() {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('error', () => {});
    this.sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    this.pending = new Map(); // "ip:port" -> handler
    this.locks = new Map();   // "ip:port" -> promise tail
    this.ready = new Promise((res) => this.sock.bind(0, res));
  }

  close() { try { this.sock.close(); } catch (_) {} }

  _onMessage(msg, rinfo) {
    const h = this.pending.get(rinfo.address + ':' + rinfo.port);
    if (h) h(msg);
  }

  _lock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }

  /** Send `buildPacket(challenge)` and resolve with the (reassembled) reply payload. */
  _exchange(ip, port, buildPacket, expect, timeout) {
    const key = ip + ':' + port;
    return this._lock(key, async () => {
      await this.ready;
      return new Promise((resolve, reject) => {
        let sentAt = 0, challenged = 0;
        const parts = new Map(); let total = 0;
        const done = (err, val) => { clearTimeout(timer); this.pending.delete(key); err ? reject(err) : resolve(val); };
        const timer = setTimeout(() => done(new Error('timeout')), timeout);
        const send = (ch) => { sentAt = Date.now(); this.sock.send(pad(buildPacket(ch)), port, ip, (e) => e && done(e)); };
        const handlePayload = (p) => {
          const type = p[0];
          if (type === R_CHALLENGE && challenged < 2) { challenged++; send(p.subarray(1, 5)); return; }
          if (type !== expect) return done(new Error('unexpected reply 0x' + type.toString(16)));
          done(null, { payload: p.subarray(1), ping: Date.now() - sentAt });
        };
        this.pending.set(key, (msg) => {
          try {
            const head = msg.readInt32LE(0);
            if (head === -1) return handlePayload(msg.subarray(4));
            if (head !== -2) return;
            // Source-style split packet: id(4) total(1) number(1) size(2)
            const id = msg.readInt32LE(4);
            total = msg[8]; const num = msg[9];
            let body = msg.subarray(12);
            if (num === 0 && body.readInt32LE(0) !== -1 && msg.subarray(10).readInt32LE(0) === -1) body = msg.subarray(10);
            if (id & 0x80000000) return done(new Error('compressed replies unsupported'));
            parts.set(num, body);
            if (parts.size === total) {
              const all = Buffer.concat([...Array(total).keys()].map((i) => parts.get(i) || Buffer.alloc(0)));
              handlePayload(all.subarray(4));
            }
          } catch (e) { done(e); }
        });
        send(null);
      });
    });
  }

  async info(ip, port, timeout = 2500) {
    const { payload, ping } = await this._exchange(ip, port, (ch) => {
      const base = Buffer.concat([Buffer.from([A2S_INFO]), Buffer.from('Source Engine Query\0', 'latin1')]);
      return ch ? Buffer.concat([base, ch]) : base;
    }, R_INFO, timeout);
    const r = new Reader(payload);
    const info = { ping };
    info.protocol = r.u8();
    info.name = r.cstr(); info.map = r.cstr(); info.folder = r.cstr(); info.game = r.cstr();
    info.appId = r.u16(); info.players = r.u8(); info.maxPlayers = r.u8(); info.bots = r.u8();
    info.serverType = String.fromCharCode(r.u8()); info.environment = String.fromCharCode(r.u8());
    info.password = r.u8() === 1; info.vac = r.u8() === 1; info.version = r.cstr();
    if (r.left() > 0) {
      const edf = r.u8();
      if (edf & 0x80) info.gamePort = r.u16();
      if (edf & 0x10) info.steamId = r.u64().toString();
      if (edf & 0x40) { info.tvPort = r.u16(); info.tvName = r.cstr(); }
      if (edf & 0x20) info.keywords = r.cstr();
      if (edf & 0x01) info.gameId = r.u64().toString();
    }
    if (info.keywords) Object.assign(info, parseArmaKeywords(info.keywords));
    return info;
  }

  async players(ip, port, timeout = 3000) {
    const { payload } = await this._exchange(ip, port, (ch) =>
      Buffer.concat([Buffer.from([A2S_PLAYER]), ch || Buffer.from([0xff, 0xff, 0xff, 0xff])]), R_PLAYER, timeout);
    const r = new Reader(payload); const n = r.u8(); const list = [];
    try {
      for (let i = 0; i < n; i++) { r.u8(); list.push({ name: r.cstr(), score: r.i32(), duration: Math.round(r.f32()) }); }
    } catch (_) { /* truncated reply */ }
    return list;
  }

  async rules(ip, port, timeout = 3500) {
    const { payload } = await this._exchange(ip, port, (ch) =>
      Buffer.concat([Buffer.from([A2S_RULES]), ch || Buffer.from([0xff, 0xff, 0xff, 0xff])]), R_RULES, timeout);
    const r = new Reader(payload); const n = r.u16(); const raw = [];
    try { for (let i = 0; i < n && r.left() > 0; i++) raw.push([r.cbuf(), r.cbuf()]); } catch (_) {}
    return decodeArmaRules(raw);
  }
}

/** Arma 3 publishes server flags in the Steam keyword string, e.g. "bt,r212,n0,s7,i1,mf,lt,vt,dt,tsurvive,..." */
function parseArmaKeywords(kw) {
  const out = {};
  for (const tok of kw.split(',')) {
    if (!tok) continue;
    const k = tok[0], v = tok.slice(1);
    if (k === 'b') out.battleye = v === 't';
    else if (k === 'l') out.locked = v === 't';
    // server state: 1 selecting mission, 3 assigning roles, 5 loading, 6 briefing, 7 playing, 8 debriefing ...
    else if (k === 's' && /^\d+$/.test(v)) out.serverState = +v;
    else if (k === 't') out.gameType = v;
    else if (k === 'r') out.reqVersion = v;
    else if (k === 'v') out.verifySignatures = v === 't' || v === '2';
  }
  return out;
}

function unescape(b) {
  const out = Buffer.alloc(b.length); let j = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x01 && i + 1 < b.length) {
      const n = b[++i]; out[j++] = n === 0x01 ? 0x01 : n === 0x02 ? 0x00 : n === 0x03 ? 0xff : n;
    } else out[j++] = b[i];
  }
  return out.subarray(0, j);
}

/** Decode Arma 3 "Server Browser Protocol 3" binary rules into mods/signatures. */
function decodeArmaRules(raw) {
  const chunks = [], plain = {};
  for (const [k, v] of raw) {
    if (k.length === 2 && k[0] < 0x20 && k[1] < 0x20 && k[0] >= 1) chunks.push([k[0], v]);
    else plain[k.toString('utf8')] = v.toString('utf8');
  }
  const res = { mods: [], signatures: [], rules: plain, decoded: false };
  if (!chunks.length) return res;
  chunks.sort((a, b) => a[0] - b[0]);
  const data = unescape(Buffer.concat(chunks.map((c) => c[1])));
  const r = new Reader(data);
  try {
    res.protocolVersion = r.u8();
    res.overflow = r.u8();
    const dlc1 = r.u8(), dlc2 = r.u8();
    const diff = r.u8();
    res.difficulty = diff & 0x07;
    r.u8(); // crosshair / reserved
    let dlcBits = dlc1 | (dlc2 << 8), dlcCount = 0;
    while (dlcBits) { dlcCount += dlcBits & 1; dlcBits >>= 1; }
    r.bytes(dlcCount * 4); // DLC hashes
    const modCount = r.u8();
    for (let i = 0; i < modCount; i++) {
      const hash = r.u32();
      const flags = r.u8();
      const idLen = flags & 0x0f;
      let id = 0n; const idBytes = r.bytes(idLen);
      for (let k = idLen - 1; k >= 0; k--) id = (id << 8n) | BigInt(idBytes[k]);
      const name = r.bytes(r.u8()).toString('utf8');
      res.mods.push({ name, steamId: id ? id.toString() : null, isDlc: !!(flags & 0x10), hash });
    }
    const sigCount = r.u8();
    for (let i = 0; i < sigCount; i++) res.signatures.push(r.bytes(r.u8()).toString('utf8'));
    res.decoded = true;
    if (r.left() > 0) { const d = r.bytes(r.u8()).toString('utf8').trim(); if (d) res.description = d; }
  } catch (_) { res.truncated = true; res.decoded = res.mods.length > 0; }
  return res;
}

module.exports = { A2SClient, decodeArmaRules, parseArmaKeywords, unescape };
