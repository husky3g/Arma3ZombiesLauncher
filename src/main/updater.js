'use strict';
// Self-updater for the portable .exe build.
// 1. asks GitHub for the latest release (public API, no key)
// 2. downloads the newer "*-portable.exe" next to the running exe (<name>.exe.update)
// 3. verifies size + the SHA-256 published in the release notes
// 4. swaps it in: running exe -> <name>.exe.old, update -> <name>.exe (Windows allows renaming a running exe),
//    either when the player clicks "Restart now" or automatically when the launcher closes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const REPO = 'husky3g/Arma3ZombiesLauncher';
const UA = 'ZombiesLauncher-updater';

function parseVer(v) { return String(v || '').replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0); }
function newer(a, b) { const x = parseVer(a), y = parseVer(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; }

class Updater extends EventEmitter {
  /** @param {{currentVersion:string, exePath:string|null, log:Function}} o */
  constructor({ currentVersion, exePath, log }) {
    super();
    this.current = currentVersion;
    this.exe = exePath;               // the portable .exe the player double-clicked (null when running from source)
    this.log = log || (() => {});
    this.state = { status: 'idle' };
    this.ready = null;                // { version, file } once a verified update is waiting
  }

  get supported() { return !!this.exe; }

  _set(s) { this.state = s; this.emit('state', s); }

  /** Remove leftovers from a previous update. */
  cleanup() {
    if (!this.exe) return;
    for (const f of [this.exe + '.old', this.exe + '.update.part']) { try { fs.rmSync(f, { force: true }); } catch (_) {} }
  }

  async check() {
    if (!this.supported) return this.state;
    this._set({ status: 'checking' });
    let rel;
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error('GitHub HTTP ' + res.status);
      rel = await res.json();
    } catch (e) {
      this.log('update check failed:', e.message);
      this._set({ status: 'error', message: 'Could not check for updates: ' + e.message });
      return this.state;
    }
    const version = String(rel.tag_name || '').replace(/^v/i, '');
    if (!newer(version, this.current)) { this._set({ status: 'current', version: this.current }); return this.state; }
    const asset = (rel.assets || []).find((a) => /-portable\.exe$/i.test(a.name));
    if (!asset) { this._set({ status: 'error', message: `v${version} has no portable .exe attached.` }); return this.state; }
    const sha = ((rel.body || '').match(/SHA-?256[^0-9a-f]*([0-9a-f]{64})/i) || [])[1] || null;
    this.log('update available', version, asset.name, asset.size, sha ? 'sha256 ok' : 'no sha256 in notes');
    this.release = { version, url: asset.browser_download_url, size: asset.size, sha, page: rel.html_url, notes: rel.body || '' };
    this._set({ status: 'available', version, size: asset.size, page: rel.html_url });
    return this.state;
  }

  async download() {
    const r = this.release;
    if (!r) return;
    const target = this.exe + '.update';
    const part = target + '.part';
    try {
      const res = await fetch(r.url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error('download HTTP ' + res.status);
      const total = +res.headers.get('content-length') || r.size || 0;
      const out = fs.createWriteStream(part);
      const hash = crypto.createHash('sha256');
      let got = 0, lastEmit = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        hash.update(buf); got += buf.length;
        if (!out.write(buf)) await new Promise((ok) => out.once('drain', ok));
        if (Date.now() - lastEmit > 250) { lastEmit = Date.now(); this._set({ status: 'downloading', version: r.version, got, total }); }
      }
      await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
      const digest = hash.digest('hex');
      if (r.size && got !== r.size) throw new Error(`size mismatch (${got} vs ${r.size})`);
      if (r.sha && digest.toLowerCase() !== r.sha.toLowerCase()) throw new Error('SHA-256 mismatch: the download was corrupted or tampered with');
      fs.renameSync(part, target);
      this.ready = { version: r.version, file: target };
      this.log('update downloaded and verified', r.version, digest);
      this._set({ status: 'ready', version: r.version });
    } catch (e) {
      try { fs.rmSync(part, { force: true }); } catch (_) {}
      this.log('update download failed:', e.message);
      // e.g. no write access to the exe's folder: fall back to the release page
      this._set({ status: 'error', version: r.version, page: r.page, message: 'Update download failed: ' + e.message });
    }
  }

  /** Swap the verified update into place. Returns true on success. */
  apply() {
    if (!this.ready || !this.exe) return false;
    const old = this.exe + '.old';
    try {
      try { fs.rmSync(old, { force: true }); } catch (_) {}
      fs.renameSync(this.exe, old);           // allowed while the exe is running
      try { fs.renameSync(this.ready.file, this.exe); }
      catch (e) { fs.renameSync(old, this.exe); throw e; } // roll back
      this.log('update applied', this.ready.version);
      this.ready = null;
      return true;
    } catch (e) {
      this.log('update apply failed:', e.message);
      this._set({ status: 'error', message: 'Could not install the update: ' + e.message, page: this.release && this.release.page });
      return false;
    }
  }

  /** Apply and start the new version. */
  restart(app) {
    if (!this.apply()) return false;
    spawn(this.exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(this.exe) }).unref();
    app.quit();
    return true;
  }
}

module.exports = { Updater, newer };
