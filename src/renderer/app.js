'use strict';
/* global zl */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id) => `<svg><use href="#i-${id}"/></svg>`;

const S = {
  tab: 'browse',
  servers: new Map(),
  state: null,
  catalog: { mods: {}, maps: {}, gametypes: {} },
  knownMaps: {},
  knownGametypes: [],
  env: {},
  selected: null,
  modStatus: new Map(),   // key -> { total, missing, list }
  downloads: new Map(),   // key -> { items, toast }
  pendingJoin: null,
  refreshing: new Set(),
  progress: { phase: 'idle' },
};

const SHOW_OPTS = [
  ['full', 'Full servers'],
  ['password', 'Password protected'],
  ['locked', 'Locked servers'],
  ['empty', 'Empty servers'],
  ['noinfo', 'No response / no info'],
  ['hidden', 'Hidden servers'],
];

// ======================================================================
// Art: blood drips under the header + splatter decals (procedural, seeded)
// ======================================================================
function rng(seed) { return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646; }

function drawDrips() {
  const svg = $('#drips'); const w = svg.clientWidth || window.innerWidth; const h = 46;
  const r = rng(1337);
  let d = `M0,0 H${w} V2.5 `;
  // wavy bottom edge of the blood band with drips hanging off it
  const drips = [];
  let x = 6;
  while (x < w - 6) { x += 14 + r() * 70; if (x < w - 6) drips.push(x); }
  let cx = w;
  for (const dx of drips.slice().reverse()) {
    const wid = 1.6 + r() * 3.6;
    const tall = r() < 0.18 ? 22 + r() * 18 : 4 + r() * 13;
    d += `L${(dx + wid * 2.4).toFixed(1)},${(2.5 + r() * 1.5).toFixed(1)} `;
    d += `C${(dx + wid).toFixed(1)},3 ${(dx + wid * .75).toFixed(1)},${(tall * .5).toFixed(1)} ${(dx + wid * .8).toFixed(1)},${(tall - wid).toFixed(1)} `;
    d += `A${wid.toFixed(1)},${(wid * 1.1).toFixed(1)} 0 1 1 ${(dx - wid * .8).toFixed(1)},${(tall - wid).toFixed(1)} `;
    d += `C${(dx - wid * .75).toFixed(1)},${(tall * .5).toFixed(1)} ${(dx - wid).toFixed(1)},3 ${(dx - wid * 2.4).toFixed(1)},${(2.5 + r() * 1.5).toFixed(1)} `;
    cx = dx;
  }
  d += `L0,3 Z`;
  // a few detached droplets
  let drops = '';
  for (let i = 0; i < 10; i++) {
    const px = r() * w, py = 10 + r() * 30, rr = .8 + r() * 1.8;
    drops += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${rr.toFixed(1)}"/>`;
  }
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.innerHTML = `<defs><linearGradient id="bl" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7a0a10"/><stop offset=".55" stop-color="#a50f17"/><stop offset="1" stop-color="#5c060b"/></linearGradient>
      <filter id="gl"><feSpecularLighting surfaceScale="2" specularConstant=".55" specularExponent="22" lighting-color="#ff8a8f" result="s"><fePointLight x="-200" y="-60" z="120"/></feSpecularLighting><feComposite in="s" in2="SourceAlpha" operator="in" result="s2"/><feComposite in="SourceGraphic" in2="s2" operator="arithmetic" k2="1" k3=".35"/></filter></defs>
    <g fill="url(#bl)" filter="url(#gl)"><path d="${d}"/>${drops}</g>`;
}

function splatSVG(seed, size, color, opacity) {
  const r = rng(seed); const c = size / 2; let p = '';
  // main blob: noisy radius, smoothed with quadratic curves
  const pts = []; const n = 28;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2; let rad = size * (.16 + r() * .07);
    if (r() < .3) rad *= 1.35 + r() * .5; // spikes
    pts.push([c + Math.cos(a) * rad, c + Math.sin(a) * rad]);
  }
  p += `M${((pts[0][0] + pts[n - 1][0]) / 2).toFixed(1)},${((pts[0][1] + pts[n - 1][1]) / 2).toFixed(1)}`;
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; p += ` Q${a[0].toFixed(1)},${a[1].toFixed(1)} ${((a[0] + b[0]) / 2).toFixed(1)},${((a[1] + b[1]) / 2).toFixed(1)}`; }
  let dots = '';
  for (let i = 0; i < 70; i++) {
    const a = r() * Math.PI * 2, dist = size * (.2 + Math.pow(r(), .7) * .3), rad = Math.max(.6, (1 - dist / (size * .5)) * size * .03 * (0.3 + r()));
    dots += `<circle cx="${(c + Math.cos(a) * dist).toFixed(1)}" cy="${(c + Math.sin(a) * dist).toFixed(1)}" r="${rad.toFixed(1)}"/>`;
  }
  // streaks
  for (let i = 0; i < 7; i++) {
    const a = r() * Math.PI * 2, d1 = size * .2, d2 = size * (.3 + r() * .17), wd = size * (.006 + r() * .01);
    dots += `<line x1="${(c + Math.cos(a) * d1).toFixed(1)}" y1="${(c + Math.sin(a) * d1).toFixed(1)}" x2="${(c + Math.cos(a) * d2).toFixed(1)}" y2="${(c + Math.sin(a) * d2).toFixed(1)}" stroke="${color}" stroke-width="${wd.toFixed(1)}" stroke-linecap="round"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><g fill="${color}" opacity="${opacity}"><path d="${p}"/>${dots}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function paintSplatter() {
  $('.bg-splatter').style.backgroundImage = [splatSVG(7, 620, '#5a070c', .55), splatSVG(21, 300, '#4a060a', .5)].join(',');
  $('.bg-splatter').style.backgroundPosition = 'right -170px bottom -200px, 300px 120%';
  $('#filters').style.backgroundImage = `${splatSVG(99, 360, '#3e0609', .65)}, linear-gradient(180deg, rgba(18,16,17,.97), rgba(12,11,12,.97))`;
  $('#filters').style.backgroundRepeat = 'no-repeat';
  $('#filters').style.backgroundPosition = '-120px calc(100% + 110px), 0 0';
}

// ======================================================================
// Helpers
// ======================================================================
const mapLabel = (m) => {
  if (!m) return '—';
  const known = S.knownMaps[m.toLowerCase()];
  if (known) return known;
  const t = m.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
function gtClass(g) {
  if (!g) return 'g-other';
  if (/breaking/i.test(g)) return 'g-bp';
  if (/ravage/i.test(g)) return 'g-ravage';
  if (/desolation/i.test(g)) return 'g-deso';
  if (/dayz/i.test(g)) return 'g-dayz';
  if (/other/i.test(g)) return 'g-other';
  return '';
}
function fmtAgo(t) {
  if (!t) return '—';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' d ago';
  return new Date(t).toLocaleDateString();
}
function fmtDur(sec) { sec = Math.max(0, sec | 0); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; }
// Alphabetical, case-insensitive, numbers in natural order, ignoring leading "@", "[", "-" etc.
const alphaKey = (s) => String(s || '').replace(/^[^\p{L}\p{N}]+/u, '');
const alpha = (a, b) => alphaKey(a).localeCompare(alphaKey(b), undefined, { sensitivity: 'base', numeric: true });
const modNames = (s) => (s.mods || []).filter((m) => !m.isDlc && m.name).map((m) => m.name);
const isFav = (key) => S.state.favorites.includes(key);

let saveTimer = null;
function persist(part) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => zl.setState(part), 250);
}

function toast(html, cls = '', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast ' + cls; el.innerHTML = html;
  $('#toasts').appendChild(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

// ======================================================================
// Filtering + sorting
// ======================================================================
function passesFilters(s) {
  const f = S.state.filters;
  if (f.name && !(s.name || '').toLowerCase().includes(f.name.toLowerCase())) return false;
  if (f.maps.length && !f.maps.some((m) => m.toLowerCase() === (s.map || '').toLowerCase())) return false;
  if (f.excludeGametypes.includes(s.gametype)) return false;
  const mods = modNames(s).map((n) => n.toLowerCase());
  if (f.mods.length && !f.mods.every((m) => mods.some((n) => n.includes(m.toLowerCase())))) return false;
  if (f.excludeMods.some((m) => mods.some((n) => n.includes(m.toLowerCase())))) return false;
  const sh = f.show;
  if (!sh.noinfo && (!s.online || !s.name)) return false;
  if (!sh.full && s.maxPlayers > 0 && s.players >= s.maxPlayers) return false;
  if (!sh.password && s.password) return false;
  if (!sh.locked && s.locked) return false;
  if (!sh.empty && !s.players) return false;
  return true;
}

// Hidden servers are left out of every tab unless the "Hidden servers" toggle is on.
const isHidden = (key) => (S.state.hidden || []).includes(key);
const hiddenVisible = () => !!S.state.filters.show.hidden;
const notHidden = (s) => hiddenVisible() || !isHidden(s.key);

function rowsFor(tab) {
  if (tab === 'favorites') {
    return S.state.favorites.map((k) => S.servers.get(k) || placeholder(k)).filter(notHidden);
  }
  if (tab === 'history') {
    return S.state.history.map((h) => ({ ...(S.servers.get(h.key) || placeholder(h.key, h)), joinedAt: h.joinedAt })).filter(notHidden);
  }
  return [...S.servers.values()].filter((s) => notHidden(s) && passesFilters(s));
}

function toggleHidden(key) {
  const s = S.servers.get(key) || placeholder(key);
  const was = isHidden(key);
  S.state.hidden = was ? S.state.hidden.filter((k) => k !== key) : [...(S.state.hidden || []), key];
  persist({ hidden: S.state.hidden });
  if (!was && !hiddenVisible() && S.selected === key) S.selected = null;
  toast(was ? `<b>${esc(s.name)}</b> is visible again.` : `Hid <b>${esc(s.name)}</b>. Turn on <b>Hidden servers</b> under Show to see or unhide it.`);
  render(); renderFilters();
}
function placeholder(key, h = {}) {
  const [ip, qp] = key.split(':');
  return { key, ip, queryPort: +qp, gamePort: +qp - 1, name: h.name || key, map: h.map || '', online: false, players: 0, maxPlayers: 0, mods: [], ghost: true };
}

const SORTERS = {
  fav: (s) => (isFav(s.key) ? 0 : 1),
  name: (s) => (s.name || '').toLowerCase(),
  gametype: (s) => (s.gametype || '').toLowerCase(),
  map: (s) => mapLabel(s.map).toLowerCase(),
  players: (s) => (s.online ? s.players || 0 : -1),
  ping: (s) => (s.online && s.ping != null ? s.ping : 99999),
  joinedAt: (s) => s.joinedAt || 0,
};
function sortRows(rows, tab) {
  const { key, dir } = S.state.sort[tab] || { key: 'players', dir: -1 };
  const get = SORTERS[key] || SORTERS.players;
  return rows.sort((a, b) => {
    const x = get(a), y = get(b);
    let c = x < y ? -1 : x > y ? 1 : 0;
    if (!c) c = (b.players || 0) - (a.players || 0) || (a.name || '').localeCompare(b.name || '');
    else c *= dir;
    return c;
  });
}

// ======================================================================
// Table
// ======================================================================
function columns(tab) {
  const cols = [
    { id: 'fav', label: '', w: 44, cls: 'c-act', sort: 'fav' },
    { id: 'name', label: 'Server', sort: 'name' },
    { id: 'gametype', label: 'Game mode', w: 168, sort: 'gametype' },
    { id: 'map', label: 'Map', w: 150, sort: 'map' },
    { id: 'players', label: 'Players', w: 96, cls: 'c-num', sort: 'players' },
    { id: 'ping', label: 'Ping', w: 70, cls: 'c-num', sort: 'ping' },
  ];
  if (tab === 'history') cols.push({ id: 'joined', label: 'Last played', w: 116, sort: 'joinedAt' });
  cols.push({ id: 'refresh', label: '', w: 40, cls: 'c-act' }, { id: 'plist', label: '', w: 40, cls: 'c-act' }, { id: 'dl', label: '', w: 40, cls: 'c-act' }, { id: 'info', label: '', w: 46, cls: 'c-act' });
  return cols;
}

function renderHead() {
  const sort = S.state.sort[S.tab];
  $('#thead-row').innerHTML = columns(S.tab).map((c) => {
    const sorted = c.sort && sort.key === c.sort;
    const arrow = sorted ? `<span class="arrow">${sort.dir > 0 ? '▲' : '▼'}</span>` : '';
    const title = c.id === 'fav' ? 'Sort favorites first' : c.label ? 'Sort by ' + c.label.toLowerCase() : '';
    return `<th class="${c.cls || ''} ${c.sort ? 'sortable' : ''} ${sorted ? 'sorted' : ''}" ${c.w ? `style="width:${c.w}px"` : ''} data-sort="${c.sort || ''}" title="${title}">${c.id === 'fav' ? icon('star') : esc(c.label)}${arrow}</th>`;
  }).join('');
}

function dlCell(s) {
  const d = S.downloads.get(s.key);
  if (d) {
    const tot = d.items.reduce((a, i) => a + (i.total || 0), 0), cur = d.items.reduce((a, i) => a + (i.done ? i.total || 0 : i.current || 0), 0);
    const pct = tot ? cur / tot : 0; const R = 7, C = 2 * Math.PI * R;
    return `<button class="icon-btn need" data-act="dl" title="Downloading mods… ${Math.round(pct * 100)}%"><svg class="dl-ring" viewBox="0 0 18 18"><circle cx="9" cy="9" r="${R}" fill="none" stroke="#3a1518" stroke-width="2.5"/><circle cx="9" cy="9" r="${R}" fill="none" stroke="#ec2a33" stroke-width="2.5" stroke-dasharray="${(C * pct).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 9 9)" stroke-linecap="round"/></svg></button>`;
  }
  const st = S.modStatus.get(s.key);
  if (st && st.total && !st.missing) return `<button class="icon-btn ok" data-act="dl" title="All ${st.total} required mods installed">${icon('check')}</button>`;
  const t = st ? (st.missing ? `Download ${st.missing} missing mod${st.missing > 1 ? 's' : ''}` : 'No mods required') : 'Download required mods';
  return `<button class="icon-btn ${st && st.missing ? 'need' : ''}" data-act="dl" title="${t}">${icon('download')}</button>`;
}

const STATE_NAMES = { 0: 'Starting up', 1: 'Selecting mission', 2: 'Editing mission', 3: 'Waiting for players (lobby)', 4: 'Sending mission', 5: 'Loading mission', 6: 'Briefing', 8: 'Debriefing / restarting', 9: 'Mission aborted' };
/** green = online & playing, yellow = locked or restarting/loading, red = offline / not responding */
function serverStatus(s) {
  if (!s.online) return { cls: 'off', text: 'Offline / not responding' };
  if (s.locked) return { cls: 'wait', text: 'Locked' };
  if (s.serverState != null && s.serverState !== 7 && s.serverState !== 6) return { cls: 'wait', text: STATE_NAMES[s.serverState] || 'Restarting' };
  return { cls: 'on', text: 'Online' };
}
function statusDot(s) { const st = serverStatus(s); return `<span class="sdot ${st.cls}" title="${st.text}"></span>`; }

function rowHTML(s) {
  const full = s.maxPlayers && s.players >= s.maxPlayers;
  const pct = s.maxPlayers ? Math.min(100, (s.players / s.maxPlayers) * 100) : 0;
  const pingCls = s.ping == null ? '' : s.ping < 80 ? 'good' : s.ping < 150 ? 'mid' : 'bad';
  const st = serverStatus(s);
  const sub = `${esc(s.ip)}:${esc(s.gamePort)}${s.version ? ' · v' + esc(s.version) : ''}${st.cls !== 'on' ? ' · ' + esc(st.text.toLowerCase()) : ''}${s.reason === 'added manually' ? ' · added manually' : ''}`;
  const cells = {
    fav: `<td class="c-act"><button class="icon-btn star ${isFav(s.key) ? 'on' : ''}" data-act="fav" title="${isFav(s.key) ? 'Remove from favorites' : 'Add to favorites'}">${icon('star')}</button></td>`,
    name: `<td class="c-name"><div class="name-line">${statusDot(s)}${s.password ? `<span class="lock" title="Password protected">${icon('lock')}</span>` : ''}<span class="nm" title="${esc(s.name)}">${esc(s.name)}</span>${s.battleye ? '<span class="be-tag" title="BattlEye protected">BE</span>' : ''}</div><div class="sub-line">${sub}</div></td>`,
    gametype: `<td>${s.gametype ? `<span class="badge ${gtClass(s.gametype)}">${esc(s.gametype)}</span>` : '<span class="muted">—</span>'}</td>`,
    map: `<td title="${esc(s.map)}">${esc(mapLabel(s.map))}</td>`,
    players: `<td class="c-num">${s.online ? `<div class="players"><span style="${full ? 'color:#f0636a' : ''}">${s.players}/${s.maxPlayers}</span><div class="pbar"><i style="width:${pct}%"></i></div></div>` : '<span class="muted">—</span>'}</td>`,
    ping: `<td class="c-num"><span class="ping ${pingCls}">${s.online && s.ping != null ? s.ping : '—'}</span></td>`,
    joined: `<td title="${s.joinedAt ? new Date(s.joinedAt).toLocaleString() : ''}">${fmtAgo(s.joinedAt)}</td>`,
    refresh: `<td class="c-act"><button class="icon-btn ${S.refreshing.has(s.key) ? 'spin' : ''}" data-act="refresh" title="Refresh this server">${icon('refresh')}</button></td>`,
    plist: `<td class="c-act"><button class="icon-btn" data-act="players" title="Show players">${icon('users')}</button></td>`,
    dl: `<td class="c-act">${dlCell(s)}</td>`,
    info: `<td class="c-act"><button class="icon-btn" data-act="info" title="Server info, required mods and download size">${icon('info')}</button></td>`,
  };
  const hid = isHidden(s.key);
  if (hid) cells.name = cells.name.replace('<span class="nm"', `<span class="hid-tag" title="Hidden server">${icon('eye-off')}</span><span class="nm"`);
  return `<tr data-key="${esc(s.key)}" class="${S.selected === s.key ? 'selected' : ''} ${s.online ? '' : 'offline'} ${hid ? 'is-hidden' : ''}">${columns(S.tab).map((c) => cells[c.id]).join('')}</tr>`;
}

let renderQueued = false;
function render() {
  if (renderQueued) return; renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderNow(); });
}
function renderNow() {
  const rows = sortRows(rowsFor(S.tab), S.tab);
  renderHead();
  const scroll = $('#table-wrap').scrollTop;
  $('#tbody').innerHTML = rows.map(rowHTML).join('');
  $('#table-wrap').scrollTop = scroll;

  const total = S.servers.size;
  $('#c-favorites').textContent = S.state.favorites.length;
  $('#c-browse').textContent = S.tab === 'browse' ? rows.length : [...S.servers.values()].filter((s) => notHidden(s) && passesFilters(s)).length;
  $('#c-history').textContent = S.state.history.length;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === S.tab));
  $('#list-title').textContent = { favorites: 'Favorites', browse: 'Browse', history: 'History' }[S.tab];
  $('#list-sub').textContent = S.tab === 'browse'
    ? `Showing ${rows.length} of ${total} zombie server${total === 1 ? '' : 's'} in your database`
    : S.tab === 'favorites' ? 'Your starred servers. Filters only apply to Browse.' : 'Servers you have joined, most recent first.';

  const empty = $('#empty');
  if (!rows.length) {
    empty.hidden = false;
    if (S.tab === 'favorites') empty.innerHTML = `${icon('star')}<span class="big">No favorites yet</span>Click the star next to any server to keep it here.<br><button class="btn" data-goto="browse">Browse servers</button>`;
    else if (S.tab === 'history') empty.innerHTML = `${icon('skull')}<span class="big">No history yet</span>Servers you join from the launcher appear here.`;
    else if (!total && !S.env.armaPath) empty.innerHTML = `${icon('skull')}<span class="big">Arma 3 not found</span>Point the launcher at your Arma 3 folder and it will start hunting for zombie servers.<br><button class="btn primary" data-open="settings">Set Arma 3 folder</button>`;
    else if (!total && S.progress.phase === 'idle' && S.progress.note) empty.innerHTML = `${icon('skull')}<span class="big">Couldn't reach Steam</span>Make sure Steam is running and you're logged in, then scan again.<br><button class="btn primary" id="empty-scan">Scan again</button>`;
    else if (!total) empty.innerHTML = `${icon('radar')}<span class="big">Hunting for zombie servers…</span>The first scan checks every Arma 3 server Steam knows about. Zombie servers appear here as they're found.`;
    else empty.innerHTML = `${icon('search')}<span class="big">No servers match your filters</span>Try showing empty servers or clearing a filter.<br><button class="btn" id="empty-reset">Reset filters</button>`;
  } else empty.hidden = true;

  $('#filters').style.opacity = S.tab === 'browse' ? '' : '.55';
  queueModStatus(rows.slice(0, 120));
  renderDetails();
}

// Mod install status for visible rows (cheap file-system checks in the main process)
let modQueue = [], modBusy = false;
function queueModStatus(rows) {
  for (const s of rows) if (!s.ghost && !S.modStatus.has(s.key) && !modQueue.includes(s.key)) modQueue.push(s.key);
  pumpMods();
}
async function pumpMods() {
  if (modBusy) return; modBusy = true;
  let changed = false;
  while (modQueue.length) {
    const key = modQueue.shift();
    try { setModStatus(key, await zl.mods(key)); changed = true; } catch (_) {}
  }
  modBusy = false;
  if (changed) render();
}
function setModStatus(key, list) {
  const req = list.filter((m) => m.kind !== 'dlc');
  S.modStatus.set(key, { list, total: req.length, missing: req.filter((m) => !m.installed).length });
}

// ======================================================================
// Details drawer
// ======================================================================
function renderDetails() {
  const box = $('#details');
  const s = S.selected && (S.servers.get(S.selected) || rowsFor(S.tab).find((r) => r.key === S.selected));
  if (!s) { box.hidden = true; return; }
  box.hidden = false;
  const st = S.modStatus.get(s.key);
  const list = st ? st.list : (s.mods || []).map((m) => ({ ...m, kind: m.isDlc ? 'dlc' : m.steamId ? 'workshop' : 'local' }));
  const mods = list.filter((m) => m.kind !== 'dlc');
  const dlcs = list.filter((m) => m.kind === 'dlc');
  const modsHTML = mods.length ? mods.map((m) => {
    const ok = st ? m.installed : null;
    const cls = ok === true ? 'ok' : ok === false ? 'missing' : '';
    const ic = ok === true ? icon('check') : ok === false ? icon('download') : icon('puzzle');
    const name = m.steamId ? `<a data-ws="${esc(m.steamId)}" title="Open in Steam Workshop">${esc(m.name || m.steamId)}</a>` : `<span title="Not on Steam Workshop: install manually">${esc(m.name)} (manual)</span>`;
    return `<span class="mod ${cls}">${ic}${name}</span>`;
  }).join('') : `<span class="muted">${s.hasModInfo === false ? 'This server does not publish its mod list.' : 'No mods required (vanilla or server-side only).'}</span>`;
  const dlcNote = dlcs.length ? `<span class="mod" title="Creator DLC used by this server">DLC: ${dlcs.map((d) => esc(d.folder ? d.folder.toUpperCase() : d.steamId)).join(', ')}</span>` : '';
  const missing = st ? st.missing : 0;
  const downloading = S.downloads.has(s.key);
  box.innerHTML = `
    <div class="left">
      <h3 title="${esc(s.name)}">${esc(s.name)}</h3>
      <div class="meta" style="margin-bottom:4px"><span style="display:inline-flex;align-items:center;gap:6px">${statusDot(s)}<b>${esc(serverStatus(s).text)}</b></span></div>
      <div class="meta">
        <span>${s.gametype ? `<span class="badge ${gtClass(s.gametype)}">${esc(s.gametype)}</span>` : ''}</span>
        <span>Map <b>${esc(mapLabel(s.map))}</b></span>
        <span>Players <b>${s.online ? `${s.players}/${s.maxPlayers}` : '—'}</b></span>
        <span>Address <b>${esc(s.ip)}:${esc(s.gamePort)}</b></span>
        ${s.version ? `<span>Version <b>${esc(s.version)}</b></span>` : ''}
        <span>BattlEye <b>${s.battleye ? 'On' : 'Off'}</b></span>
        ${s.password ? '<span><b style="color:var(--warn)">Password protected</b></span>' : ''}
        <span>Seen <b>${fmtAgo(s.lastSeen)}</b></span>
      </div>
      <div class="modlist">${modsHTML}${dlcNote}</div>
    </div>
    <div class="right">
      <button class="btn primary" data-act="join" ${s.ghost ? 'disabled' : ''}>${icon('play')} Join server</button>
      <div class="mods-sum">${st ? (st.total ? (missing ? `<b class="bad">${missing}</b> of ${st.total} mods missing` : `<b class="ok">All ${st.total} mods installed</b>`) : 'No mods to download') : 'Checking mods…'}</div>
      <button class="btn" data-act="dl" ${!st || !st.total || downloading ? 'disabled' : ''}>${icon('download')} ${downloading ? 'Downloading…' : missing ? 'Download missing mods' : 'Verify / update mods'}</button>
      <div style="display:flex;gap:8px">
        <button class="btn" style="flex:1;justify-content:center" data-act="copy">${icon('copy')} Copy IP</button>
        <button class="btn" data-act="info" title="Server info">${icon('info')}</button>
        <button class="btn danger-outline" data-act="hide" title="${isHidden(s.key) ? 'Unhide this server' : 'Hide this server everywhere'}">${icon(isHidden(s.key) ? 'eye' : 'eye-off')}</button>
      </div>
    </div>`;
}

// ======================================================================
// Filters panel
// ======================================================================
function renderFilters() {
  const f = S.state.filters;
  $('#f-name').value = f.name;

  // maps: discovered (with counts) + known
  // one alphabetical list: every discovered map (with server counts) plus every known zombie map
  const mapCounts = new Map();
  const shownServers = [...S.servers.values()].filter((s) => !f.excludeGametypes.includes(s.gametype));
  for (const s of shownServers) if (s.map) { const k = s.map.toLowerCase(); mapCounts.set(k, (mapCounts.get(k) || 0) + 1); }
  const maps = new Map(); // lowercase key -> { value, label, count }
  for (const k of Object.keys(S.knownMaps)) maps.set(k, { value: k, label: S.knownMaps[k], count: 0 });
  for (const s of shownServers) if (s.map) { const lk = s.map.toLowerCase(); if (!maps.has(lk)) maps.set(lk, { value: s.map, label: mapLabel(s.map), count: 0 }); }
  for (const [lk, n] of mapCounts) { const e = maps.get(lk); if (e) e.count = n; }
  const mapList = [...maps.values()].filter((m) => !f.maps.some((x) => x.toLowerCase() === m.value.toLowerCase())).sort((a, b) => alpha(a.label, b.label));
  $('#f-map').innerHTML = `<option value="">${f.maps.length ? 'Add another map…' : 'All maps'}</option>` +
    mapList.map((m) => `<option value="${esc(m.value)}">${esc(m.label)}${m.count ? ` (${m.count})` : ''}</option>`).join('');
  $('#f-map-chips').innerHTML = f.maps.map((m) => `<span class="chip"><span>${esc(mapLabel(m))}</span><button data-rm-map="${esc(m)}" title="Remove">${icon('x')}</button></span>`).join('');

  // mods datalist
  // mods used by servers in the game modes currently shown, alphabetical
  const modCounts = new Map();
  for (const s of S.servers.values()) {
    if (f.excludeGametypes.includes(s.gametype)) continue;
    for (const n of new Set(modNames(s))) modCounts.set(n, (modCounts.get(n) || 0) + 1);
  }
  const mods = [...modCounts].sort((a, b) => alpha(a[0], b[0]));
  $('#mod-options').innerHTML = mods.map(([k, n]) => `<option value="${esc(k)}">${n} server${n > 1 ? 's' : ''}</option>`).join('');
  $('#f-mod-chips').innerHTML = [
    ...f.mods.map((m) => `<span class="chip" title="Required"><span>${esc(m)}</span><button data-rm-mod="${esc(m)}" title="Remove">${icon('x')}</button></span>`),
    ...f.excludeMods.map((m) => `<span class="chip exclude" title="Excluded"><span>${esc(m)}</span><button data-rm-exmod="${esc(m)}" title="Remove">${icon('x')}</button></span>`),
  ].join('');

  // gametypes
  const counts = {};
  for (const s of S.servers.values()) counts[s.gametype] = (counts[s.gametype] || 0) + 1;
  const gts = [...new Set([...S.knownGametypes, ...Object.keys(S.catalog.gametypes), ...Object.keys(counts)])].filter((g) => g && g !== 'null' && g !== 'undefined');
  gts.sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b));
  const shown = S.showAllGametypes ? gts : gts.filter((g) => counts[g] || f.excludeGametypes.includes(g));
  const hiddenN = gts.length - shown.length;
  $('#f-gametypes').innerHTML = shown.map((g) => `<label class="check"><input type="checkbox" data-gt="${esc(g)}" ${f.excludeGametypes.includes(g) ? '' : 'checked'}><span class="box">${icon('check')}</span><span>${esc(g)}</span><span class="n">${counts[g] || 0}</span></label>`).join('') +
    (hiddenN || S.showAllGametypes ? `<button class="link more-link" data-more-gt>${S.showAllGametypes ? 'Hide modes with no servers' : `Show ${hiddenN} more mode${hiddenN > 1 ? 's' : ''}`}</button>` : '');

  $('#f-show').innerHTML = SHOW_OPTS.map(([k, label]) => `<label class="toggle"><span>${label}</span><input type="checkbox" data-show="${k}" ${f.show[k] ? 'checked' : ''}><span class="sw"></span></label>`).join('');
}

function setFilters(mut) {
  mut(S.state.filters);
  persist({ filters: S.state.filters });
  renderFilters(); render();
}

function wireFilters() {
  $('#f-name').addEventListener('input', (e) => { S.state.filters.name = e.target.value; persist({ filters: S.state.filters }); render(); });
  $('#f-map').addEventListener('change', (e) => {
    const v = e.target.value; if (!v) return;
    setFilters((f) => { if (!f.maps.includes(v)) f.maps.push(v); });
  });
  const addMod = (exclude) => {
    const v = $('#f-mod').value.trim(); if (!v) return;
    setFilters((f) => {
      f.mods = f.mods.filter((m) => m !== v); f.excludeMods = f.excludeMods.filter((m) => m !== v);
      (exclude ? f.excludeMods : f.mods).push(v);
    });
    $('#f-mod').value = '';
  };
  $('#f-mod-req').addEventListener('click', () => addMod(false));
  $('#f-mod-ex').addEventListener('click', () => addMod(true));
  $('#f-mod').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMod(e.shiftKey); });
  $('#filters').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if ('moreGt' in b.dataset) { S.showAllGametypes = !S.showAllGametypes; renderFilters(); }
    if (b.dataset.rmMap) setFilters((f) => { f.maps = f.maps.filter((m) => m !== b.dataset.rmMap); });
    if (b.dataset.rmMod) setFilters((f) => { f.mods = f.mods.filter((m) => m !== b.dataset.rmMod); });
    if (b.dataset.rmExmod) setFilters((f) => { f.excludeMods = f.excludeMods.filter((m) => m !== b.dataset.rmExmod); });
  });
  $('#filters').addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.gt) setFilters((f) => { f.excludeGametypes = f.excludeGametypes.filter((g) => g !== t.dataset.gt); if (!t.checked) f.excludeGametypes.push(t.dataset.gt); });
    if (t.dataset.show) setFilters((f) => { f.show[t.dataset.show] = t.checked; });
  });
  $('#f-reset').addEventListener('click', resetFilters);
}
function resetFilters() {
  setFilters((f) => { f.name = ''; f.maps = []; f.mods = []; f.excludeMods = []; f.excludeGametypes = []; f.show = { full: true, password: true, noinfo: false, locked: true, empty: false, hidden: false }; });
}

// ======================================================================
// Actions
// ======================================================================
function toggleFav(key) {
  const fav = S.state.favorites;
  S.state.favorites = fav.includes(key) ? fav.filter((k) => k !== key) : [...fav, key];
  persist({ favorites: S.state.favorites });
  render();
}

async function refreshServer(key) {
  if (S.refreshing.has(key)) return;
  S.refreshing.add(key); render();
  try {
    const r = await zl.refreshServer(key);
    if (r) S.servers.set(key, r);
    S.modStatus.delete(key);
    if (r && !r.online) toast(`<b>${esc(r.name)}</b> did not respond.`);
  } catch (e) { toast('Refresh failed: ' + esc(e.message)); }
  S.refreshing.delete(key); render();
}

async function showPlayers(key) {
  const s = S.servers.get(key) || placeholder(key);
  openModal(`<h2>Players</h2><p class="sub">${esc(s.name)}</p><div id="pl-body" class="muted">Asking the server…</div>
    <div class="actions"><button class="btn" data-close>Close</button></div>`);
  try {
    const list = await zl.players(key);
    list.sort((a, b) => b.score - a.score || b.duration - a.duration);
    const named = list.filter((p) => p.name);
    $('#pl-body').outerHTML = named.length
      ? `<table class="plist"><thead><tr><th>#</th><th>Name</th><th class="r">Score</th><th class="r">Time</th></tr></thead><tbody>${named.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td class="r">${p.score}</td><td class="r">${fmtDur(p.duration)}</td></tr>`).join('')}</tbody></table>`
      : `<p class="muted">${list.length ? `${list.length} players online, but the server hides their names.` : 'Nobody is online right now.'}</p>`;
  } catch (e) {
    const b = $('#pl-body'); if (b) b.textContent = 'This server did not return a player list (' + e.message + ').';
  }
}

async function startDownload(key, then) {
  const s = S.servers.get(key);
  try {
    const r = await zl.downloadMods(key);
    if (!r.started) { toast(esc(r.reason)); return false; }
    const t = toast(`<b>Downloading ${r.count} mod${r.count > 1 ? 's' : ''}</b> for ${esc(s ? s.name : key)}<div class="bar"><div class="bar-fill" style="width:0"></div></div><div class="dl-text muted" style="margin-top:6px;font-size:12px">Connecting to Steam…</div>`, '', 0);
    S.downloads.set(key, { items: [], toast: t });
    if (then) S.pendingJoin = { key, ...then };
    render();
    return true;
  } catch (e) { toast('Download failed: ' + esc(e.message)); return false; }
}

function onDownload(m) {
  const d = S.downloads.get(m.key);
  if (!d) return;
  if (m.type === 'progress' || m.type === 'done') {
    d.items = m.items;
    const tot = m.items.reduce((a, i) => a + (i.total || 0), 0), cur = m.items.reduce((a, i) => a + (i.done ? i.total || 0 : i.current || 0), 0);
    const doneN = m.items.filter((i) => i.done).length;
    const pct = tot ? (cur / tot) * 100 : (doneN / m.items.length) * 100;
    $('.bar-fill', d.toast).style.width = pct.toFixed(1) + '%';
    $('.dl-text', d.toast).textContent = `${doneN}/${m.items.length} mods ready${tot ? ` · ${(cur / 1048576).toFixed(0)} / ${(tot / 1048576).toFixed(0)} MB` : ''}`;
    render();
  }
  if (m.type === 'itemError') toast('Steam could not subscribe to mod ' + esc(m.id) + ': ' + esc(m.message));
  if (m.type === 'error') { d.toast.innerHTML = `<b>Mod download stopped</b><br>${esc(m.message)}`; d.failed = true; }
  if (m.type === 'done') { d.toast.classList.add('ok'); d.toast.innerHTML = '<b>Mods ready.</b> All required mods are installed.'; d.ok = true; }
  if (m.type === 'exit') {
    setTimeout(() => d.toast.remove(), d.failed ? 9000 : 3500);
    S.downloads.delete(m.key);
    S.modStatus.delete(m.key);
    render();
    if (d.ok && S.pendingJoin && S.pendingJoin.key === m.key) { const pj = S.pendingJoin; S.pendingJoin = null; join(pj.key, pj.password); }
  }
}

async function join(key, knownPassword) {
  const s = S.servers.get(key);
  if (!s) return;
  if (!S.env.armaPath) { toast('Arma 3 was not found. Set its folder in Settings.'); openSettings(); return; }
  // Arma takes a while to show its window; ignore repeat clicks for a bit so we don't start it twice.
  if (S.launchingUntil && Date.now() < S.launchingUntil) { toast('Arma 3 is starting… give it a moment.'); return; }
  let password = knownPassword;
  if (s.password && password === undefined) {
    password = await askPassword(s);
    if (password === null) return;
  }
  try {
    let r = await zl.join(key, password);
    if (!r.ok && r.missing) {
      const choice = await askMissing(s, r.missing);
      if (choice === 'download') { await startDownload(key, { password }); return; }
      if (choice !== 'anyway') return;
      r = await zl.join(key, password, { ignoreMissing: true });
    }
    if (r.ok) {
      S.state.history = r.history;
      S.launchingUntil = Date.now() + 90e3;
      toast(`<b>Starting Arma 3…</b><br>Connecting to ${esc(s.name)}. The game window can take a minute to appear while mods load.`, 'ok', 12000);
      render();
    }
  } catch (e) { toast('Could not launch: ' + esc(e.message), '', 8000); }
}

// ======================================================================
// Right-click menu
// ======================================================================
function openContextMenu(key, x, y) {
  const s = S.servers.get(key) || placeholder(key);
  const st = S.modStatus.get(key);
  const fav = isFav(key), hid = isHidden(key), dl = S.downloads.has(key);
  const item = (cmd, ic, label, { primary = false, disabled = false, hint = '' } = {}) =>
    `<button data-cmd="${cmd}" role="menuitem" class="${primary ? 'primary' : ''}" ${disabled ? 'disabled' : ''}>${icon(ic)}<span>${label}</span>${hint ? `<span class="kbd">${hint}</span>` : ''}</button>`;
  const sep = '<div class="sep"></div>';
  const dlLabel = dl ? 'Downloading mods…' : st && st.total && !st.missing ? 'Verify / update mods' : st && st.missing ? `Download ${st.missing} missing mod${st.missing > 1 ? 's' : ''}` : 'Download required mods';
  const menu = $('#ctx');
  menu.innerHTML = `<div class="ctx-title">${esc(s.name)}</div>` +
    item('join', 'play', 'Join server', { primary: true, disabled: !!s.ghost, hint: 'Double-click' }) +
    item('download', 'download', dlLabel, { disabled: !!s.ghost || dl || (st && !st.total) }) +
    sep +
    item('info', 'info', 'Server info & required mods', { disabled: !!s.ghost }) +
    item('players', 'users', 'Show players', { disabled: !!s.ghost }) +
    item('refresh', 'refresh', 'Refresh server', { disabled: !!s.ghost }) +
    sep +
    item('fav', 'star', fav ? 'Remove from favorites' : 'Add to favorites') +
    item('copy', 'copy', 'Copy IP address') +
    item('hide', hid ? 'eye' : 'eye-off', hid ? 'Unhide server' : 'Hide server') +
    (S.tab === 'history' ? item('forget', 'trash', 'Remove from history') : '');
  menu.dataset.key = key;
  menu.hidden = false;
  // keep it on screen
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  const first = menu.querySelector('button:not([disabled])'); if (first) first.focus({ preventScroll: true });
}
function closeContextMenu() { const m = $('#ctx'); if (m && !m.hidden) { m.hidden = true; m.innerHTML = ''; } }

function runCommand(cmd, key) {
  const s = S.servers.get(key);
  if (cmd === 'join') join(key);
  else if (cmd === 'download') { if (!S.downloads.has(key)) startDownload(key); }
  else if (cmd === 'info') showInfo(key);
  else if (cmd === 'players') showPlayers(key);
  else if (cmd === 'refresh') refreshServer(key);
  else if (cmd === 'fav') toggleFav(key);
  else if (cmd === 'hide') toggleHidden(key);
  else if (cmd === 'copy') {
    const addr = s ? `${s.ip}:${s.gamePort}` : key;
    navigator.clipboard.writeText(addr); toast('Copied ' + esc(addr));
  } else if (cmd === 'forget') {
    S.state.history = S.state.history.filter((h) => h.key !== key);
    persist({ history: S.state.history }); render();
  }
}

// ======================================================================
// Server info dialog
// ======================================================================
const fmtBytes = (b) => {
  if (!b) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 100 || i < 2 ? 0 : 1)} ${u[i]}`;
};
const DIFFICULTY = ['Recruit', 'Regular', 'Veteran', 'Custom'];

async function showInfo(key) {
  const base = S.servers.get(key);
  if (!base) return;
  openModal(`<h2>Server info</h2><p class="sub">${esc(base.name)}</p><div id="info-body" class="muted">Loading server details and Workshop sizes…</div>`);
  $('#modal').classList.add('wide');
  let d;
  try { d = await zl.serverInfo(key); } catch (e) { const b = $('#info-body'); if (b) b.textContent = 'Could not load info: ' + e.message; return; }
  const body = $('#info-body'); if (!body) return; // dialog was closed
  const s = d.server; const st = serverStatus(s);
  const cell = (k, v) => `<div><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const req = d.mods.filter((m) => m.kind !== 'dlc');
  const dlcs = d.mods.filter((m) => m.kind === 'dlc');
  const allOk = d.missingCount === 0;
  const sumHTML = allOk
    ? `<div class="dl-sum ok"><span class="big">Ready to join</span><span class="t">${req.length ? `All ${req.length} required mods are installed (${fmtBytes(d.totalBytes)}).` : 'No mods required.'}</span></div>`
    : `<div class="dl-sum"><span class="big">${fmtBytes(d.missingBytes)}</span><span class="t">estimated download to join: ${d.missingCount} missing mod${d.missingCount > 1 ? 's' : ''}${d.unknownSizes ? ` (${d.unknownSizes} with unknown size)` : ''}${d.manualMissing ? `. ${d.manualMissing} not on the Workshop: install manually` : ''}.<br>Total mod size for this server: ${fmtBytes(d.totalBytes)}.</span></div>`;
  const rows = req.map((m) => {
    const name = m.steamId ? `<a data-ws="${esc(m.steamId)}" title="Open in Steam Workshop">${esc(m.name || m.workshopTitle || m.steamId)}</a>` : esc(m.name);
    const status = m.installed ? '<span class="st-ok">Installed</span>' : m.kind === 'workshop' ? (m.unavailable ? '<span class="st-man">Removed from Workshop</span>' : '<span class="st-miss">Missing</span>') : '<span class="st-man">Manual install</span>';
    return `<tr><td>${name}</td><td class="r">${m.size ? fmtBytes(m.size) : '—'}</td><td class="r">${status}</td></tr>`;
  }).join('');
  body.outerHTML = `
    <div class="info-grid">
      ${cell('Status', `${statusDot(s)} ${esc(st.text)}`)}
      ${cell('Address', `${esc(s.ip)}:${esc(s.gamePort)}`)}
      ${cell('Players', s.online ? `${s.players} / ${s.maxPlayers}` : '—')}
      ${cell('Game mode', esc(s.gametype || '—'))}
      ${cell('Mission', esc(s.game || '—'))}
      ${cell('Map', esc(mapLabel(s.map)))}
      ${cell('Ping', s.online && s.ping != null ? s.ping + ' ms' : '—')}
      ${cell('Game version', esc(s.version || '—'))}
      ${cell('BattlEye', s.battleye ? 'On' : 'Off')}
      ${cell('Password', s.password ? '<span style="color:#ff2d36">Required</span>' : 'No')}
      ${cell('Signature check', s.verifySignatures ? 'On' : 'Off')}
      ${cell('Difficulty', s.difficulty != null ? DIFFICULTY[s.difficulty] || '—' : '—')}
    </div>
    ${s.description ? `<div class="info-desc">${esc(s.description)}</div>` : ''}
    ${sumHTML}
    <div class="f-label" style="margin-top:12px">Required mods (${req.length})</div>
    ${req.length ? `<div class="mod-scroll"><table class="mod-table"><thead><tr><th>Mod</th><th class="r">Size</th><th class="r">Status</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="muted">${s.hasModInfo === false ? 'This server does not publish its mod list.' : 'No mods required (vanilla or server-side only).'}</p>`}
    ${dlcs.length ? `<p class="help">Creator DLC used: ${dlcs.map((x) => esc(x.folder ? x.folder.toUpperCase() : x.steamId)).join(', ')}${dlcs.some((x) => !x.installed) ? ' (not installed; you can still join, with some content limited)' : ''}.</p>` : ''}
    <div class="actions">
      <button class="btn" data-close>Close</button>
      ${!allOk && req.some((m) => m.kind === 'workshop' && !m.installed) ? `<button class="btn" id="info-dl">${icon('download')} Download missing mods</button>` : ''}
      <button class="btn primary" id="info-join">${icon('play')} Join server</button>
    </div>`;
  $('#modal').querySelectorAll('[data-ws]').forEach((a) => a.addEventListener('click', () => zl.openExternal('steam://url/CommunityFilePage/' + a.dataset.ws)));
  const dlb = $('#info-dl'); if (dlb) dlb.onclick = () => { closeModal(); startDownload(key); };
  $('#info-join').onclick = () => { closeModal(); join(key); };
}

// ======================================================================
// Modals
// ======================================================================
let modalResolve = null;
function openModal(html) {
  $('#modal').classList.remove('wide');
  $('#modal').innerHTML = `<button class="icon-btn close" data-close title="Close">${icon('x')}</button>` + html;
  $('#modal-back').hidden = false;
  const first = $('#modal input:not([readonly]), #modal select'); if (first) setTimeout(() => first.focus(), 30);
}
function closeModal(val = null) {
  $('#modal-back').hidden = true; $('#modal').innerHTML = '';
  if (modalResolve) { const r = modalResolve; modalResolve = null; r(val); }
}
const modalResult = () => new Promise((res) => { modalResolve = res; });

function askPassword(s) {
  const saved = (S.state.passwords || {})[s.key] || '';
  openModal(`<h2>Server password</h2><p class="sub">${esc(s.name)}</p>
    <div class="row"><input id="pw" type="password" value="${esc(saved)}" placeholder="Password"></div>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pw-ok">${icon('play')} Join</button></div>`);
  $('#pw-ok').onclick = () => closeModal($('#pw').value);
  $('#pw').onkeydown = (e) => { if (e.key === 'Enter') closeModal($('#pw').value); };
  return modalResult();
}

function askMissing(s, missing) {
  const ws = missing.filter((m) => m.kind === 'workshop'), manual = missing.filter((m) => m.kind !== 'workshop');
  openModal(`<h2>Missing mods</h2><p class="sub">${esc(s.name)} needs ${missing.length} mod${missing.length > 1 ? 's' : ''} you don't have yet.</p>
    <ul class="missing-list">${missing.map((m) => `<li>${esc(m.name || m.steamId)}${m.kind !== 'workshop' ? ' <span class="muted">(not on Workshop, install manually)</span>' : ''}</li>`).join('')}</ul>
    ${ws.length ? `<p class="help">The launcher subscribes to the Workshop mods through Steam and joins automatically when they're done.</p>` : ''}
    ${manual.length ? `<p class="help">Mods marked manual are not on the Steam Workshop. Get them from the server's website or Discord.</p>` : ''}
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn" id="m-any">Join anyway</button>${ws.length ? `<button class="btn primary" id="m-dl">${icon('download')} Download &amp; join</button>` : ''}</div>`);
  $('#m-any').onclick = () => closeModal('anyway');
  if (ws.length) $('#m-dl').onclick = () => closeModal('download');
  return modalResult();
}

function openSettings() {
  const st = S.state.settings;
  openModal(`<h2>Settings</h2><p class="sub">Saved automatically on this PC.</p>
    <div class="row"><label class="f-label">Arma 3 folder</label>
      <div class="inline"><input id="s-arma" type="text" value="${esc(S.env.armaPath || st.armaPath || '')}" readonly placeholder="Not found">
      <button class="btn" id="s-browse">Browse…</button><button class="btn" id="s-detect">Auto-detect</button></div>
      <div class="help">${S.env.armaPath ? 'Workshop mods: ' + esc(S.env.workshopDir || '—') : 'Arma 3 not detected. Pick the folder that contains arma3_x64.exe.'}</div></div>
    <div class="row"><label class="f-label">Launch through</label>
      <select id="s-launch" class="select">
        <option value="steam" ${st.launchMethod === 'steam' ? 'selected' : ''}>Steam (recommended, handles BattlEye)</option>
        <option value="direct" ${st.launchMethod === 'direct' ? 'selected' : ''}>Directly (arma3battleye / arma3_x64.exe)</option>
      </select></div>
    <div class="row"><label class="f-label">Extra launch parameters</label><input id="s-params" type="text" value="${esc(st.extraParams)}"></div>
    <div class="row inline">
      <div style="flex:1"><label class="f-label">Re-scan every (minutes)</label><input id="s-rescan" type="number" min="3" max="240" value="${esc(st.rescanMinutes)}"></div>
      <div style="flex:1.4;padding-top:22px"><label class="toggle"><span>Deep scan (check every server's mods)</span><input id="s-deep" type="checkbox" ${st.deepScan ? 'checked' : ''}><span class="sw"></span></label></div>
    </div>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="s-save">Save</button></div>`);
  const updEnv = (env) => { S.env = env; $('#s-arma').value = env.armaPath || ''; renderArma(); S.modStatus.clear(); render(); };
  $('#s-browse').onclick = async () => updEnv(await zl.browseArma());
  $('#s-detect').onclick = async () => { const env = await zl.detectArma(''); updEnv(env); toast(env.armaPath ? 'Found Arma 3: ' + esc(env.armaPath) : 'Arma 3 was not found automatically.'); };
  $('#s-save').onclick = async () => {
    const settings = {
      launchMethod: $('#s-launch').value, extraParams: $('#s-params').value,
      rescanMinutes: Math.max(3, +$('#s-rescan').value || 15), deepScan: $('#s-deep').checked,
    };
    const st2 = await zl.setState({ settings });
    S.state.settings = st2.settings;
    closeModal();
    render();
  };
}

function openAddServer() {
  openModal(`<h2>Add server</h2><p class="sub">Add a zombie server by IP or hostname. It stays in your list even if it isn't detected automatically.</p>
    <div class="row inline"><input id="a-host" type="text" placeholder="IP or hostname" style="flex:3"><input id="a-port" type="number" placeholder="Game port" value="2302" style="flex:1"></div>
    <div class="help" id="a-msg"></div>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="a-ok">Add</button></div>`);
  $('#a-host').addEventListener('paste', (e) => {
    const t = (e.clipboardData.getData('text') || '').trim(); const m = t.match(/^(.+):(\d+)$/);
    if (m) { e.preventDefault(); $('#a-host').value = m[1]; $('#a-port').value = m[2]; }
  });
  $('#a-ok').onclick = async () => {
    const host = $('#a-host').value.trim(); if (!host) return;
    $('#a-msg').textContent = 'Contacting server…'; $('#a-ok').disabled = true;
    try {
      const r = await zl.addServer(host, +$('#a-port').value || 2302);
      S.servers.set(r.key, r); closeModal(); S.selected = r.key; switchTab('browse');
      toast(`<b>Added</b> ${esc(r.name)}`, 'ok');
    } catch (e) { $('#a-msg').textContent = e.message; $('#a-ok').disabled = false; }
  };
}

// ======================================================================
// Status bar
// ======================================================================
function renderProgress() {
  const p = S.progress; const on = p.phase !== 'idle';
  $('#scan-pulse').classList.toggle('on', on);
  $('#btn-scan').querySelector('span').textContent = on ? 'Stop' : 'Scan';
  let txt = '', pct = 0;
  if (p.phase === 'refresh') { txt = `Refreshing known zombie servers… ${p.done}/${p.total}`; pct = p.total ? p.done / p.total : 0; }
  else if (p.phase === 'discover') {
    txt = p.listing
      ? `Getting the server list from Steam… ${p.masterCount} Arma 3 servers so far · ${p.done} checked · ${S.servers.size} zombie servers found`
      : `Checking ${p.masterCount} Arma 3 servers for zombies… ${p.done}/${p.total} · ${S.servers.size} found`;
    pct = p.total ? p.done / p.total : 0;
  }
  else {
    txt = `${S.servers.size} zombie server${S.servers.size === 1 ? '' : 's'} in database`;
    if (p.at) txt += ` · last scan ${new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    if (p.note && p.note.code === 'NOARMA') txt += ' · set your Arma 3 folder in Settings to find new servers';
    else if (p.note) txt += ' · could not get new servers from Steam: ' + p.note.message;
  }
  $('#scan-text').textContent = txt;
  $('#scan-bar').style.width = (on ? pct * 100 : 0).toFixed(1) + '%';
}
function renderArma() {
  const ok = !!S.env.armaPath;
  $('#arma-state').innerHTML = `<span class="dot ${ok ? 'ok' : 'bad'}"></span>${ok ? 'Arma 3: ' + esc(S.env.armaPath) : '<button class="link" data-open="settings">Arma 3 not found. Set its folder.</button>'}`;
}

// ======================================================================
// Wiring
// ======================================================================
function switchTab(tab) { S.tab = tab; S.selected = S.selected && rowsFor(tab).some((r) => r.key === S.selected) ? S.selected : null; render(); }

function wire() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#btn-settings').onclick = openSettings;
  $('#btn-add').onclick = openAddServer;
  $('#btn-scan').onclick = () => (S.progress.phase !== 'idle' ? zl.stopScan() : zl.scan());

  $('#thead-row').addEventListener('click', (e) => {
    const th = e.target.closest('th'); if (!th || !th.dataset.sort) return;
    const key = th.dataset.sort; const cur = S.state.sort[S.tab];
    const defDir = ['name', 'gametype', 'map', 'ping'].includes(key) ? 1 : -1;
    S.state.sort[S.tab] = cur.key === key ? { key, dir: -cur.dir } : { key, dir: key === 'fav' ? 1 : defDir };
    persist({ sort: S.state.sort }); render();
  });

  $('#tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const key = tr.dataset.key; const b = e.target.closest('button[data-act]');
    if (b) {
      e.stopPropagation();
      const a = b.dataset.act;
      if (a === 'fav') toggleFav(key);
      else if (a === 'refresh') refreshServer(key);
      else if (a === 'players') showPlayers(key);
      else if (a === 'dl') { S.selected = key; render(); if (!S.downloads.has(key)) startDownload(key); }
      else if (a === 'info') showInfo(key);
      return;
    }
    S.selected = S.selected === key ? null : key; render();
  });
  $('#tbody').addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    e.preventDefault();
    S.selected = tr.dataset.key; render();
    openContextMenu(tr.dataset.key, e.clientX, e.clientY);
  });
  $('#ctx').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cmd]'); if (!b || b.disabled) return;
    const key = $('#ctx').dataset.key; closeContextMenu(); runCommand(b.dataset.cmd, key);
  });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctx')) closeContextMenu(); }, true);
  $('#table-wrap').addEventListener('scroll', closeContextMenu);
  window.addEventListener('blur', closeContextMenu);
  $('#tbody').addEventListener('dblclick', (e) => { const tr = e.target.closest('tr'); if (tr && !e.target.closest('button')) join(tr.dataset.key); });

  $('#details').addEventListener('click', (e) => {
    const ws = e.target.closest('[data-ws]'); if (ws) { zl.openExternal('steam://url/CommunityFilePage/' + ws.dataset.ws); return; }
    const b = e.target.closest('button[data-act]'); if (!b || !S.selected) return;
    const key = S.selected; const s = S.servers.get(key);
    if (b.dataset.act === 'join') join(key);
    if (b.dataset.act === 'dl') startDownload(key);
    if (b.dataset.act === 'copy' && s) runCommand('copy', key);
    if (b.dataset.act === 'info') showInfo(key);
    if (b.dataset.act === 'hide') toggleHidden(key);
  });

  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]'); if (g) switchTab(g.dataset.goto);
    const o = e.target.closest('[data-open]'); if (o && o.dataset.open === 'settings') openSettings();
    if (e.target.closest('#empty-reset')) resetFilters();
    if (e.target.closest('#empty-scan')) zl.scan();
    if (e.target.closest('[data-close]') || e.target === $('#modal-back')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#ctx').hidden) { closeContextMenu(); return; }
    if (e.key === 'Escape' && !$('#modal-back').hidden) closeModal();
    if (e.key === 'F5') zl.scan();
  });
  // The window itself must never scroll (only the panels inside it do).
  window.addEventListener('scroll', () => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); });
  window.addEventListener('resize', () => { clearTimeout(wire.rt); wire.rt = setTimeout(drawDrips, 120); });
  wireFilters();

  zl.onServers((list) => {
    for (const s of list) { S.servers.set(s.key, s); S.modStatus.delete(s.key); }
    render(); throttleFilters();
  });
  zl.onRemoved((key) => { S.servers.delete(key); render(); });
  zl.onProgress((p) => { S.progress = p; renderProgress(); if (p.phase === 'idle') { renderFilters(); render(); } });
  zl.onCatalog((c) => { S.catalog = c; throttleFilters(); });
  zl.onDownload(onDownload);
}
let filtTimer = null;
function throttleFilters() { if (filtTimer) return; filtTimer = setTimeout(() => { filtTimer = null; if (!document.activeElement || !document.activeElement.closest('#filters')) renderFilters(); }, 1500); }

(async function boot() {
  const d = await zl.init();
  S.state = d.state; S.catalog = d.catalog; S.knownMaps = d.knownMaps; S.knownGametypes = d.knownGametypes; S.env = d.env;
  for (const s of d.servers) S.servers.set(s.key, s);
  S.tab = S.state.favorites.length ? 'favorites' : 'browse';
  wire(); drawDrips(); paintSplatter();
  renderFilters(); renderArma(); renderProgress(); render();
  if (!d.scanning) zl.scan();
  if (!S.env.armaPath) setTimeout(openSettings, 600);
})();
