'use strict';
// Workshop item titles/sizes via Steam's public (keyless) GetPublishedFileDetails endpoint, cached for a day.
const TTL = 24 * 3600e3;

/**
 * @param {object} cache  persistent object { [id]: { title, size, updated, at } }
 * @param {string[]} ids
 * @returns {Promise<object>} map id -> details (missing ids are simply absent)
 */
async function workshopDetails(cache, ids) {
  const now = Date.now();
  const need = [...new Set(ids.filter(Boolean))].filter((id) => !cache[id] || now - cache[id].at > TTL);
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    const body = new URLSearchParams({ itemcount: String(chunk.length) });
    chunk.forEach((id, k) => body.append(`publishedfileids[${k}]`, id));
    try {
      const res = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
        method: 'POST', body, signal: AbortSignal.timeout(15000),
      });
      const json = await res.json();
      for (const f of (json.response && json.response.publishedfiledetails) || []) {
        cache[f.publishedfileid] = f.result === 1
          ? { title: f.title, size: +f.file_size || 0, updated: f.time_updated || 0, at: now }
          : { title: null, size: 0, unavailable: true, at: now };
      }
    } catch (_) { /* offline: fall back to whatever is cached */ }
  }
  const out = {};
  for (const id of ids) if (cache[id]) out[id] = cache[id];
  return out;
}

module.exports = { workshopDetails };
