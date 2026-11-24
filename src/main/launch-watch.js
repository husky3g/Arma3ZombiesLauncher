'use strict';
// Watches a "Join" after it's been handed to Steam, so the player isn't left guessing when nothing happens.
// Steam writes each launch step to <Steam>\logs\console_log.txt, e.g.
//   GameAction [AppID 107410, ActionID 5] : LaunchApp waiting for user response to KickingOtherSession "Arma 3"
// which means a Steam dialog (often hidden behind other windows) is waiting for the player.
// We follow that log from the moment of launch and also poll for the game process.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const APPID = '107410';
const PROMPTS = {
  KickingOtherSession: {
    title: 'Steam is asking before it starts Arma 3',
    text: 'Your Steam account is already "playing" Arma 3 somewhere else: another PC, or a Steam client running your dedicated servers. ' +
      'Steam shows a dialog asking whether to play here instead. Open Steam and confirm it; that ends the other session.',
  },
  ShowLaunchOption: { title: 'Steam is asking how to launch Arma 3', text: 'Pick a launch option in the Steam dialog.' },
  ShowEula: { title: 'Steam wants you to accept the Arma 3 EULA', text: 'Accept it in the Steam dialog to continue.' },
  ShowCloudConflict: { title: 'Steam Cloud conflict', text: 'Steam found a Steam Cloud conflict for Arma 3. Pick which files to keep in the Steam dialog.' },
};

class LaunchWatch extends EventEmitter {
  constructor({ steamRoot, isRunning, log }) {
    super();
    this.logFile = steamRoot ? path.join(steamRoot, 'logs', 'console_log.txt') : null;
    this.isRunning = isRunning;
    this.log = log || (() => {});
    this.active = null;
  }

  get pending() { return !!this.active; }

  /** Call right before handing the launch to Steam. */
  begin({ viaSteam, timeoutMs = 75000 }) {
    this.stop();
    let offset = 0;
    try { if (viaSteam && this.logFile) offset = fs.statSync(this.logFile).size; } catch (_) {}
    const a = this.active = { started: Date.now(), offset, viaSteam, timeoutMs, prompt: null, steamDone: false, buf: '' };
    a.timer = setInterval(() => this._tick(a).catch(() => {}), 1500);
  }

  stop() {
    if (this.active) clearInterval(this.active.timer);
    this.active = null;
  }

  _finish(a, ev) {
    if (this.active !== a) return;
    this.stop();
    this.log('launch watch:', ev.status, ev.prompt || '', Math.round((Date.now() - a.started) / 1000) + 's');
    this.emit('launch', ev);
  }

  _readSteamLog(a) {
    if (!a.viaSteam || !this.logFile) return [];
    let size;
    try { size = fs.statSync(this.logFile).size; } catch (_) { return []; }
    if (size < a.offset) a.offset = 0; // log rotated
    if (size === a.offset) return [];
    const fd = fs.openSync(this.logFile, 'r');
    try {
      const len = Math.min(size - a.offset, 1 << 20);
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, a.offset);
      a.offset += len;
      a.buf += b.toString('utf8');
    } finally { fs.closeSync(fd); }
    const lines = a.buf.split(/\r?\n/);
    a.buf = lines.pop();
    return lines.filter((l) => l.includes(`AppID ${APPID}`) && l.includes('LaunchApp'));
  }

  async _tick(a) {
    if (this.active !== a) return;
    for (const line of this._readSteamLog(a)) {
      let m;
      if ((m = line.match(/waiting for user response to (\w+)/))) {
        const key = m[1];
        if (key === 'ShowInterstitials' || key === 'CreatingProcess') continue; // Steam answers these itself
        if (a.prompt !== key) {
          a.prompt = key;
          const p = PROMPTS[key] || { title: 'Steam is waiting for you', text: `Steam is showing a dialog before it starts Arma 3 (${key}). Answer it in the Steam window.` };
          this.log('launch watch: steam waiting for', key);
          this.emit('launch', { status: 'waiting', prompt: key, ...p });
        }
      } else if ((m = line.match(/continues with user response "(\w+)"/)) && m[1] === a.prompt) {
        a.prompt = null;
        a.started = Date.now(); // give the game its full start-up time from here
        this.emit('launch', { status: 'continuing' });
      } else if (/changed task to Completed/.test(line)) {
        a.steamDone = true;
      } else if ((m = line.match(/changed task to (Failed|Canceled|Cancelled)\b/i))) {
        return this._finish(a, { status: 'failed', message: 'Steam cancelled the launch.' });
      }
    }
    if (this.active !== a) return;
    if (await this.isRunning()) return this._finish(a, { status: 'started' });
    // while a Steam dialog is open, wait for the player (up to 10 minutes) instead of timing out
    const limit = a.prompt ? 10 * 60e3 : a.timeoutMs;
    if (Date.now() - a.started > limit) {
      this._finish(a, a.prompt
        ? { status: 'failed', message: 'Steam is still waiting for an answer to its dialog. Arma 3 was not started.' }
        : { status: 'failed', message: a.steamDone
          ? 'Steam started Arma 3, but the game closed again or never opened a window. Check for a BattlEye or error message.'
          : 'Arma 3 has not started. Steam may be updating the game, or showing a dialog behind other windows.' });
    }
  }
}

module.exports = { LaunchWatch };
