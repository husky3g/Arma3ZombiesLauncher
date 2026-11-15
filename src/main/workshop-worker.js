'use strict';
// Runs in its own short-lived process so Steam only sees "Arma 3" as running while mods download.
// Protocol (process messages):
//   in : { cmd: 'download', ids: ['123', ...] } | { cmd: 'status', ids: [...] }
//   out: { type: 'ready' } | { type: 'progress', items: [...] } | { type: 'done', items } | { type: 'error', message }
const APPID = 107410;
const S = { Subscribed: 1, Installed: 4, NeedsUpdate: 8, Downloading: 16, DownloadPending: 32 };

let client;
try {
  client = require('steamworks.js').init(APPID);
} catch (e) {
  process.send({ type: 'error', message: 'Could not connect to Steam. Make sure Steam is running and you own Arma 3. (' + e.message + ')' });
  setTimeout(() => process.exit(1), 200);
}

function snapshot(ids) {
  return ids.map((id) => {
    const big = BigInt(id);
    const state = client.workshop.state(big);
    const dl = client.workshop.downloadInfo(big);
    const inst = client.workshop.installInfo(big);
    const done = (state & S.Installed) && !(state & (S.NeedsUpdate | S.Downloading | S.DownloadPending));
    return {
      id, state, done: !!done, subscribed: !!(state & S.Subscribed),
      current: dl ? Number(dl.current) : 0, total: dl ? Number(dl.total) : 0,
      folder: inst ? inst.folder : null,
    };
  });
}

async function download(ids) {
  for (const id of ids) {
    const big = BigInt(id);
    try {
      if (!(client.workshop.state(big) & S.Subscribed)) await client.workshop.subscribe(big);
    } catch (e) { process.send({ type: 'itemError', id, message: e.message }); }
    try { client.workshop.download(big, true); } catch (_) {}
  }
  const started = Date.now();
  const timer = setInterval(() => {
    const items = snapshot(ids);
    process.send({ type: 'progress', items });
    if (items.every((i) => i.done)) { clearInterval(timer); process.send({ type: 'done', items }); setTimeout(() => process.exit(0), 300); }
    // Nothing moving for a long time and nothing queued -> give up (Steam will still finish in the background).
    if (Date.now() - started > 6 * 3600e3) { clearInterval(timer); process.send({ type: 'done', items, timedOut: true }); process.exit(0); }
  }, 700);
}

if (client) {
  process.on('message', (m) => {
    if (m.cmd === 'download') download(m.ids.map(String));
    else if (m.cmd === 'status') { process.send({ type: 'status', items: snapshot(m.ids.map(String)) }); }
    else if (m.cmd === 'quit') process.exit(0);
  });
  process.send({ type: 'ready' });
}
