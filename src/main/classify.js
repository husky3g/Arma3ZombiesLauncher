'use strict';
// Decides whether an Arma 3 server is a zombie server, and which "gametype" it is.

// Workshop IDs of well-known zombie mods (exact match = strong evidence).
const ZOMBIE_MOD_IDS = new Set([
  '501966277',  // Ryan's Zombies & Demons (verified from live server rules)
  // Other zombie mods are matched by name below; add verified IDs here as they are found.
]);

// Mods that ADD zombies (specific names only: e.g. "WebKnight Flashlights" or "Necrons" must not match).
const ZOMBIE_MOD_RX = /\bzombies?\b|ryan'?s[ _]zombies|webknight'?s?[ _]zombies|necroplague|ghoul'?s?[ _]creatures|\bzeds\b|\bundead\b|\binfected\b|stalker mutants/i;
// Whole game modes that are zombie survival by design (mod name or mission name).
const MODE_MOD_RX = /^@?ravage\b|ravage cup|desolation redux|^@?desolation$|^@?breaking ?point\b|a3 ?survival/i;
// Server / mission name evidence.
const ZOMBIE_NAME_RX = /zombie|zombi|\bzeds?\b|undead|infected|dayz|breaking ?point|\bravage\b|desolation redux|\bz[- ]?survival|\bA3S\b|a3 ?survival/i;

// Gametype rules, first match wins. `where`: which text to look in.
const GAMETYPES = [
  { id: 'Breaking Point', rx: /breaking ?point/i, where: 'all' },
  { id: 'Ravage', rx: /\bravage\b/i, where: 'all' },
  { id: 'Desolation Redux', rx: /desolation redux|^@?desolation$|\| ?desolation ?\|/i, where: 'all' },
  { id: 'A3S', rx: /\bA3S\b|a3 ?survival|arma ?3 ?survival/i, where: 'all' },
  { id: 'Exile + Zombies', rx: /exile/i, where: 'all', needsZombieEvidence: true },
  { id: 'Epoch + Zombies', rx: /\bepoch\b/i, where: 'all', needsZombieEvidence: true },
  { id: 'DayZ-style', rx: /dayz|overpoch/i, where: 'name' },
  { id: 'Antistasi + Zombies', rx: /antistasi/i, where: 'name', needsZombieEvidence: true },
  { id: 'Wasteland + Zombies', rx: /wasteland/i, where: 'name', needsZombieEvidence: true },
  { id: 'Life + Zombies', rx: /altis ?life|\blife\b.*\brpg\b|\brpg\b.*\blife\b/i, where: 'name', needsZombieEvidence: true },
];
// Servers that merely have a zombie mod loaded (typical milsim/Zeus groups). Hidden by default.
const OPS_GAMETYPE = 'Zombie mods (Ops/Zeus)';

const realMods = (mods) => (mods || []).filter((m) => !m.isDlc && m.name);
function modEvidence(mods) {
  return realMods(mods).some((m) => (m.steamId && ZOMBIE_MOD_IDS.has(m.steamId)) || ZOMBIE_MOD_RX.test(m.name) || MODE_MOD_RX.test(m.name));
}

/**
 * @param {{name?:string, game?:string, map?:string, gameType?:string, mods?:Array}} s
 * @returns {{zombie:boolean, gametype:string|null, reason:string|null}}
 */
function classify(s) {
  const name = s.name || '', game = s.game || '';
  const mods = realMods(s.mods);
  const byMods = modEvidence(s.mods);
  const byName = ZOMBIE_NAME_RX.test(name) || ZOMBIE_NAME_RX.test(game);
  const zombieEvidence = byMods || byName;
  const nameText = `${name} | ${game}`;
  const allText = `${nameText} | ${mods.map((m) => m.name).join(' | ')}`;

  for (const g of GAMETYPES) {
    if (!g.rx.test(g.where === 'name' ? nameText : allText)) continue;
    if (g.needsZombieEvidence && !zombieEvidence) return { zombie: false, gametype: null, reason: null };
    return { zombie: true, gametype: g.id, reason: byMods ? 'mods' : 'name' };
  }
  if (byName) return { zombie: true, gametype: 'Zombies (Other)', reason: 'name' };
  if (byMods) return { zombie: true, gametype: mods.some((m) => MODE_MOD_RX.test(m.name)) ? 'Zombies (Other)' : OPS_GAMETYPE, reason: 'mods' };
  return { zombie: false, gametype: null, reason: null };
}

/** Cheap pre-check from the master list only (no mod list yet). */
function looksPromising(s) {
  return ZOMBIE_NAME_RX.test(`${s.name || ''} ${s.game || ''}`) || /exile|epoch|ravage|survive|survival/i.test(`${s.name} ${s.gameType || ''}`);
}

// Maps commonly used by zombie / survival modes, keyed by lowercase world name.
const KNOWN_MAPS = {
  altis: 'Altis', stratis: 'Stratis', tanoa: 'Tanoa', malden: 'Malden 2035', enoch: 'Livonia',
  chernarus: 'Chernarus', chernarus_summer: 'Chernarus (Summer)', chernarus_winter: 'Chernarus (Winter)',
  cup_chernarus_a3: 'Chernarus 2020', chernarusredux: 'Chernarus Redux', namalsk: 'Namalsk', takistan: 'Takistan',
  zargabad: 'Zargabad', esseker: 'Esseker', bornholm: 'Bornholm', tavi: 'Taviana', napf: 'Napf', napfwinter: 'Napf Winter',
  lingor3: 'Lingor', panthera3: 'Panthera', ruha: 'Ruha', lythium: 'Lythium', isladuala3: 'Isla Duala',
  abramia: 'Isla Abramia', kujari: 'Kujari', tembelan: 'Tembelan', vt7: 'Virolahti', cam_lao_nam: 'Cam Lao Nam',
  sefrouramal: 'Sefrou-Ramal', gm_weferlingen_summer: 'Weferlingen', gm_weferlingen_winter: 'Weferlingen (Winter)',
  gabreta: 'Gabreta', pulau: 'Pulau', rosche: 'Rosche', hellanmaa: 'Hellanmaa', anizay: 'Anizay', utes: 'Utes',
  deniland: 'Deniland', dingor: 'Dingor', fallujah: 'Fallujah', kunduz: 'Kunduz', woodland_acr: 'Bystrica',
  bootcamp_acr: 'Bukovina', mcn_aliabad: 'Aliabad', dya: 'Diyala', thirsk: 'Thirsk', thirskw: 'Thirsk Winter',
  dayz_chernarus: 'Chernarus (DayZ)', staszow: 'Staszow', sara: 'Sahrani', sara_dbe1: 'Sahrani (Remastered)',
  porto: 'Porto', intro: 'Rahmadi', spe_normandy: 'Normandy', spe_mortain: 'Mortain', blud_cordelia: 'Cordelia',
};

function mapLabel(map) {
  if (!map) return '';
  return KNOWN_MAPS[map.toLowerCase()] || map;
}

const KNOWN_GAMETYPES = [...GAMETYPES.map((g) => g.id), 'Zombies (Other)', OPS_GAMETYPE];

module.exports = { classify, looksPromising, mapLabel, KNOWN_MAPS, KNOWN_GAMETYPES, OPS_GAMETYPE, modEvidence };
