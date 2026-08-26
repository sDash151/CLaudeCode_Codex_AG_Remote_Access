'use strict';
/**
 * Device pairing, authentication and revocation.
 *
 * Model: the laptop mints a short-lived pairing code. The phone posts that code
 * once and receives a long random device token. Only the SHA-256 of the token
 * is stored, so the devices file cannot be used to impersonate a phone.
 */
const { randomToken, newDeviceId, sha256, safeEqual, newPairingCode } = require('./crypto');
const { loadDevices, saveDevices } = require('./config');

class DeviceRegistry {
  /**
   * @param {object} opts
   * @param {import('./audit').AuditLog} opts.audit
   * @param {object} opts.config
   * @param {() => number} [opts.now]
   */
  constructor({ audit, config, now = () => Date.now() }) {
    this.audit = audit;
    this.config = config;
    this.now = now;
    this.state = loadDevices();
    if (!Array.isArray(this.state.devices)) this.state.devices = [];
    this._lastSeenPersistedAt = 0;
  }

  /**
   * Re-read from disk before anything that depends on fresh state.
   *
   * The CLI (`agw pair`, `agw revoke`) and the detached gateway process are
   * different processes sharing one devices.json. Without this reload the
   * gateway would never see a pairing code minted by the CLI, and a revocation
   * would not take effect until restart.
   */
  _reload() {
    const disk = loadDevices();
    if (disk && Array.isArray(disk.devices)) this.state = disk;
    else if (disk) this.state = { devices: [], pairing: disk.pairing || null };
    return this.state;
  }

  _persist() {
    saveDevices(this.state);
  }

  /**
   * Create a pairing code. Only one is outstanding at a time — issuing a new
   * code invalidates the previous one.
   * @returns {{code: string, expiresAt: number}}
   */
  createPairingCode() {
    this._reload();
    const code = newPairingCode();
    const expiresAt = this.now() + this.config.pairingTtlMs;
    this.state.pairing = {
      codeHash: sha256(code),
      expiresAt,
      // A code is consumable exactly once.
      used: false,
      createdAt: this.now(),
    };
    this._persist();
    this.audit.append('pairing.code_issued', { expiresAt: new Date(expiresAt).toISOString() });
    return { code, expiresAt };
  }

  /**
   * Exchange a pairing code for a device token.
   * @param {string} code
   * @param {string} label  Human label for the device, e.g. "iPhone".
   * @returns {{ok: true, deviceId: string, token: string, expiresAt: number} | {ok: false, code: string, message: string}}
   */
  redeemPairingCode(code, label) {
    this._reload();
    const p = this.state.pairing;
    if (!p) {
      this.audit.append('pairing.failed', { reason: 'no_active_code' });
      return { ok: false, code: 'no_pairing', message: 'No pairing code is active.' };
    }
    if (p.used) {
      this.audit.append('pairing.failed', { reason: 'code_already_used' });
      return { ok: false, code: 'used', message: 'That pairing code was already used.' };
    }
    if (this.now() >= p.expiresAt) {
      this.audit.append('pairing.failed', { reason: 'code_expired' });
      return { ok: false, code: 'expired', message: 'That pairing code has expired.' };
    }
    // Normalise the typed code (case + stray spaces) before hashing.
    const normalised = String(code || '').trim().toUpperCase();
    if (!safeEqual(sha256(normalised), p.codeHash)) {
      this.audit.append('pairing.failed', { reason: 'code_mismatch' });
      return { ok: false, code: 'bad_code', message: 'Pairing code is incorrect.' };
    }

    p.used = true;
    const token = randomToken(32);
    const deviceId = newDeviceId();
    const expiresAt = this.now() + this.config.deviceTokenTtlMs;
    this.state.devices.push({
      deviceId,
      label: label || 'Phone',
      tokenHash: sha256(token),
      createdAt: this.now(),
      expiresAt,
      lastSeenAt: this.now(),
      revokedAt: null,
      pushSubscription: null,
    });
    this._persist();
    this.audit.append('pairing.succeeded', { deviceId, label: label || 'Phone' });
    return { ok: true, deviceId, token, expiresAt };
  }

  /**
   * Authenticate a bearer token.
   * @param {string} token
   * @returns {object|null} the device record, or null when not authenticated.
   */
  authenticate(token) {
    if (!token) return null;
    // Pick up revocations made by another process (e.g. `agw revoke`).
    this._reload();
    const hash = sha256(token);
    for (const d of this.state.devices) {
      if (!safeEqual(d.tokenHash, hash)) continue;
      if (d.revokedAt) return null;
      if (this.now() >= d.expiresAt) return null;
      d.lastSeenAt = this.now();
      // Persist lastSeenAt at most once a minute: it is useful for the status
      // view but not worth a disk write on every polled request.
      if (this.now() - this._lastSeenPersistedAt > 60_000) {
        this._lastSeenPersistedAt = this.now();
        this._persist();
      }
      return d;
    }
    return null;
  }

  /** Revoke one device. */
  revoke(deviceId, reason = 'manual') {
    this._reload();
    const d = this.state.devices.find((x) => x.deviceId === deviceId);
    if (!d || d.revokedAt) return false;
    d.revokedAt = this.now();
    d.pushSubscription = null;
    this._persist();
    this.audit.append('device.revoked', { deviceId, label: d.label, reason });
    return true;
  }

  /** Revoke every device. Used by `agw revoke --all`. */
  revokeAll(reason = 'manual_all') {
    this._reload();
    let n = 0;
    for (const d of this.state.devices) {
      if (d.revokedAt) continue;
      d.revokedAt = this.now();
      d.pushSubscription = null;
      n++;
    }
    if (n) {
      this._persist();
      this.audit.append('device.revoked_all', { count: n, reason });
    }
    return n;
  }

  list() {
    this._reload();
    return this.state.devices.map((d) => ({
      deviceId: d.deviceId,
      label: d.label,
      createdAt: d.createdAt,
      expiresAt: d.expiresAt,
      lastSeenAt: d.lastSeenAt,
      revokedAt: d.revokedAt,
      hasPush: Boolean(d.pushSubscription),
    }));
  }

  setPushSubscription(deviceId, subscription) {
    this._reload();
    const d = this.state.devices.find((x) => x.deviceId === deviceId);
    if (!d || d.revokedAt) return false;
    d.pushSubscription = subscription;
    this._persist();
    this.audit.append('device.push_registered', { deviceId, label: d.label });
    return true;
  }

  activePushTargets() {
    this._reload();
    return this.state.devices
      .filter((d) => !d.revokedAt && d.pushSubscription && this.now() < d.expiresAt)
      .map((d) => ({ deviceId: d.deviceId, subscription: d.pushSubscription }));
  }
}

module.exports = { DeviceRegistry };
