'use strict';
/**
 * Gateway configuration and on-disk state.
 *
 * Layout (default %USERPROFILE%\.agw, override with AGW_HOME):
 *   config.json    settings + gateway secrets   (owner-only)
 *   devices.json   paired devices, tokens hashed (owner-only)
 *   audit.jsonl    append-only audit log
 *   gateway.json   runtime info for the CLI (pid, port, origin)
 *
 * No reusable secret is stored in plaintext except the gateway's own
 * agentSecret, which is a localhost-only credential the adapters must read
 * to talk to the gateway on the same machine. Device tokens — the ones that
 * travel to the phone — are stored only as SHA-256 hashes.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomToken } = require('./crypto');

function homeDir() {
  return process.env.AGW_HOME || path.join(os.homedir(), '.agw');
}

const PATHS = () => {
  const home = homeDir();
  return {
    home,
    config: path.join(home, 'config.json'),
    devices: path.join(home, 'devices.json'),
    audit: path.join(home, 'audit.jsonl'),
    runtime: path.join(home, 'gateway.json'),
  };
};

const DEFAULTS = {
  // Bind to loopback only. Remote access arrives via Tailscale Serve, which
  // terminates TLS and proxies to this port. The port is never opened to the
  // internet directly.
  bindHost: '127.0.0.1',
  port: 8787,

  // How long a request may stay pending before it becomes EXPIRED (a denial).
  requestTtlMs: 5 * 60 * 1000,

  // How long an adapter blocks waiting for a decision. Kept below the agent's
  // own hook timeout so the gateway always returns an explicit decision
  // instead of letting the agent cancel the hook (which would yield "no
  // decision" rather than a deny).
  agentWaitMs: 4 * 60 * 1000,

  // Minimum risk that requires remote approval. LOW-risk actions are passed
  // back to the agent as "no decision", i.e. the agent applies its own normal
  // permission rules — the gateway does not approve them.
  // HIGH can never be excluded; see policy.js.
  gateMinRisk: 'MEDIUM',

  // Public HTTPS origin the phone uses (Tailscale MagicDNS name).
  // Required for Web Push and for Add-to-Home-Screen.
  publicOrigin: '',

  // Device session lifetime.
  deviceTokenTtlMs: 30 * 24 * 60 * 60 * 1000,

  // Pairing code lifetime.
  pairingTtlMs: 10 * 60 * 1000,
};

function writeJsonAtomic(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    // Windows ACLs do not map cleanly to POSIX modes; the file still lives in
    // the user profile, which is not world-readable by default.
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Load config, creating it (with fresh secrets) on first run.
 */
function loadConfig() {
  const p = PATHS();
  let cfg = readJson(p.config, null);
  if (!cfg) {
    cfg = {
      ...DEFAULTS,
      // Shared secret the local adapters present on every call. Prevents any
      // other local process from injecting or resolving approval requests.
      agentSecret: randomToken(32),
      createdAt: new Date().toISOString(),
    };
    writeJsonAtomic(p.config, cfg);
  } else {
    // Fill in keys added by later versions without clobbering user edits.
    let changed = false;
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (cfg[k] === undefined) {
        cfg[k] = v;
        changed = true;
      }
    }
    if (!cfg.agentSecret) {
      cfg.agentSecret = randomToken(32);
      changed = true;
    }
    if (changed) writeJsonAtomic(p.config, cfg);
  }
  return cfg;
}

function saveConfig(cfg) {
  writeJsonAtomic(PATHS().config, cfg);
  return cfg;
}

function loadDevices() {
  return readJson(PATHS().devices, { devices: [], pairing: null });
}

function saveDevices(state) {
  writeJsonAtomic(PATHS().devices, state);
  return state;
}

function loadRuntime() {
  return readJson(PATHS().runtime, null);
}

function saveRuntime(info) {
  writeJsonAtomic(PATHS().runtime, info, 0o600);
}

function clearRuntime() {
  try {
    fs.unlinkSync(PATHS().runtime);
  } catch {
    /* already gone */
  }
}

module.exports = {
  PATHS,
  DEFAULTS,
  homeDir,
  loadConfig,
  saveConfig,
  loadDevices,
  saveDevices,
  loadRuntime,
  saveRuntime,
  clearRuntime,
  writeJsonAtomic,
  readJson,
};
