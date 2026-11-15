'use strict';
// Short-lived helper process: asks the locally running Steam client for every Arma 3 server
// through the player's own steam_api64.dll (shipped with Arma 3). No Web API key needed.
//
// Usage: node steam-servers-worker.js "<path to steam_api64.dll>"
// Messages to parent (process.send, or JSON lines on stdout when run standalone):
//   { type:'batch', servers:[...] } as servers arrive, then { type:'done', total } or { type:'error', message }
const path = require('path');
const APPID = 107410;

process.env.SteamAppId = String(APPID);
process.env.SteamGameId = String(APPID);

const out = (m) => (process.send ? process.send(m) : process.stdout.write(JSON.stringify(m) + '\n'));
const fail = (message) => { out({ type: 'error', message }); setTimeout(() => process.exit(1), 100); };

let koffi;
try { koffi = require('koffi'); } catch (e) { fail('FFI library missing: ' + e.message); return; }

const dllPath = process.argv[2];
let lib;
try { lib = koffi.load(dllPath); } catch (e) { fail('Could not load ' + dllPath + ': ' + e.message); return; }

const fn = (sig) => { try { return lib.func(sig); } catch (_) { return null; } };
const InitFlat = fn('int __stdcall SteamAPI_InitFlat(char *errMsg)');
const InitSafe = fn('bool __stdcall SteamAPI_InitSafe()');
const Init = fn('bool __stdcall SteamAPI_Init()');
const RunCallbacks = fn('void __stdcall SteamAPI_RunCallbacks()');
const Shutdown = fn('void __stdcall SteamAPI_Shutdown()');
const GetMMS = fn('void * __stdcall SteamAPI_SteamMatchmakingServers_v002()');

const ServerItem = koffi.struct('gameserveritem_t', {
  connPort: 'uint16', queryPort: 'uint16', ip: 'uint32',
  ping: 'int', hadResponse: 'bool', doNotRefresh: 'bool',
  gameDir: koffi.array('char', 32, 'String'), map: koffi.array('char', 32, 'String'),
  description: koffi.array('char', 64, 'String'),
  appId: 'uint32', players: 'int', maxPlayers: 'int', bots: 'int',
  password: 'bool', secure: 'bool', lastPlayed: 'uint32', serverVersion: 'int',
  name: koffi.array('char', 64, 'String'), tags: koffi.array('char', 128, 'String'),
  steamId: 'uint64',
});

const RequestList = fn('void * SteamAPI_ISteamMatchmakingServers_RequestInternetServerList(void *self, uint32 app, void *filters, uint32 nFilters, void *response)');
const GetDetails = fn('void * SteamAPI_ISteamMatchmakingServers_GetServerDetails(void *self, void *req, int i)');
const GetCount = fn('int SteamAPI_ISteamMatchmakingServers_GetServerCount(void *self, void *req)');
const Release = fn('void SteamAPI_ISteamMatchmakingServers_ReleaseRequest(void *self, void *req)');

if (!RunCallbacks || !GetMMS || !RequestList || !GetDetails || !GetCount) { fail('This steam_api64.dll is too old (missing server browser functions).'); return; }

// ---- init ----
let ok = false;
if (InitFlat) {
  const err = Buffer.alloc(1024);
  const r = InitFlat(err);
  ok = r === 0;
  if (!ok) { fail('Steam is not running or not logged in (' + err.toString('utf8').replace(/\0.*$/s, '') + ')'); return; }
} else ok = (InitSafe || Init)();
if (!ok) { fail('Steam is not running or not logged in.'); return; }

const mms = GetMMS();
if (!mms) { fail('Steam server browser interface unavailable.'); Shutdown && Shutdown(); return; }

// ---- ISteamMatchmakingServerListResponse: a C++ object = pointer to a vtable of 3 callbacks ----
const RespondedProto = koffi.proto('void __stdcall ServerResponded(void *self, void *req, int i)');
const FailedProto = koffi.proto('void __stdcall ServerFailedToRespond(void *self, void *req, int i)');
const CompleteProto = koffi.proto('void __stdcall RefreshComplete(void *self, void *req, int response)');

let req = null, done = false, pending = [], total = 0;
const seen = new Set();
const ipStr = (n) => `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;

function take(i) {
  const p = GetDetails(mms, req, i);
  if (!p) return;
  const it = koffi.decode(p, ServerItem);
  if (!it || !it.ip) return;
  const key = it.ip + ':' + it.queryPort;
  if (seen.has(key)) return;
  seen.add(key); total++;
  pending.push({
    ip: ipStr(it.ip), queryPort: it.queryPort, gamePort: it.connPort, name: it.name, map: it.map,
    game: it.description, players: it.players, maxPlayers: it.maxPlayers, password: it.password,
    keywords: it.tags, ping: it.ping, responded: it.hadResponse,
  });
}

const cbResponded = koffi.register((self, r, i) => { if (req) take(i); }, koffi.pointer(RespondedProto));
const cbFailed = koffi.register(() => {}, koffi.pointer(FailedProto));
const cbComplete = koffi.register(() => { done = true; }, koffi.pointer(CompleteProto));

const vtbl = koffi.alloc('void *', 3);
koffi.encode(vtbl, koffi.array('void *', 3), [cbResponded, cbFailed, cbComplete]);
const obj = koffi.alloc('void *', 1);
koffi.encode(obj, 'void *', vtbl);

req = RequestList(mms, APPID, null, 0, obj);
if (!req) { fail('Steam refused the server list request.'); Shutdown && Shutdown(); return; }

const started = Date.now();
const MAX_MS = +process.env.ZL_STEAM_TIMEOUT || 120000;
const timer = setInterval(() => {
  try { RunCallbacks(); } catch (_) {}
  if (pending.length) { out({ type: 'batch', servers: pending }); pending = []; }
  if (done || Date.now() - started > MAX_MS) {
    clearInterval(timer);
    // sweep anything Steam listed that we haven't sent yet (e.g. responded before a callback was seen)
    try { const n = GetCount(mms, req); for (let i = 0; i < n; i++) take(i); } catch (_) {}
    if (pending.length) out({ type: 'batch', servers: pending });
    out({ type: 'done', total, timedOut: !done });
    try { Release && Release(mms, req); } catch (_) {}
    try { Shutdown && Shutdown(); } catch (_) {}
    setTimeout(() => process.exit(0), 150);
  }
}, 50);
