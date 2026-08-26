'use strict';
/**
 * Codex CLI hook installer.
 *
 * Three steps, all of which were determined empirically on this machine
 * (see docs/FINDINGS.md):
 *
 *   1. Write the hook into $CODEX_HOME/hooks.json.
 *      Codex discovers hooks ONLY there. A hooks/ subdirectory and a
 *      project-level .codex/hooks.json were both tested and NOT discovered.
 *
 *   2. Ask Codex what it discovered, via the app-server RPC `hooks/list`.
 *      That returns the canonical `key` and `currentHash` for our handler.
 *
 *   3. Grant trust by writing to ~/.codex/config.toml:
 *          [hooks.state.'<key>']
 *          enabled = true
 *          trusted_hash = "<currentHash>"
 *      Until this exists, hooks/list reports trustStatus "untrusted" and the
 *      hook never executes. The hash covers only the handler definition, so
 *      adding the state block does not invalidate it.
 *
 * The TOML key must use a literal (single-quoted) string because the key is a
 * Windows path: a basic double-quoted key makes TOML interpret \U in
 * "C:\Users\..." as a unicode escape and the file fails to parse.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { writeShim, removeShim } = require('../shared/shim');

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function hooksJsonPath() {
  return path.join(codexHome(), 'hooks.json');
}

function configTomlPath() {
  return path.join(codexHome(), 'config.toml');
}

function hookScriptPath() {
  return path.resolve(__dirname, '..', '..', 'adapters', 'hook.js');
}

/**
 * Locate codex.exe. Checked in order of reliability:
 *   1. AGW_CODEX_BIN override
 *   2. CODEX_CLI_PATH recorded inside the user's own config.toml
 *   3. PATH
 *   4. the versioned install directory used by the Codex desktop app
 */
function findCodexBinary() {
  if (process.env.AGW_CODEX_BIN && fs.existsSync(process.env.AGW_CODEX_BIN)) {
    return process.env.AGW_CODEX_BIN;
  }

  try {
    const toml = fs.readFileSync(configTomlPath(), 'utf8');
    const m = /CODEX_CLI_PATH\s*=\s*'([^']+)'|CODEX_CLI_PATH\s*=\s*"([^"]+)"/.exec(toml);
    const p = m && (m[1] || m[2]);
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* no config.toml yet */
  }

  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable PATH entry */
    }
  }

  const base = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'OpenAI', 'Codex', 'bin'
  );
  try {
    for (const d of fs.readdirSync(base)) {
      const candidate = path.join(base, d, exe);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* not installed there */
  }
  return null;
}

/**
 * The hooks.json document we manage.
 *
 * `command` is a launcher shim, not a direct node invocation. Codex passes this
 * string to cmd.exe, which cannot handle a leading quoted executable path — see
 * src/adapters/shared/shim.js for the evidence.
 */
function buildHooksDoc(commandToken) {
  const command = commandToken || writeShim('codex').command;
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command,
              timeout: 300,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Ask Codex, over its app-server stdio RPC, which hooks it has discovered.
 * @returns {Promise<{ok: true, hooks: object[]} | {ok: false, error: string}>}
 */
function listDiscoveredHooks({ cwd = process.cwd(), timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const bin = findCodexBinary();
    if (!bin) return resolve({ ok: false, error: 'codex binary not found' });

    let child;
    try {
      child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, error: `could not start codex app-server: ${err.message}` });
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(value);
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: 'codex app-server timed out' }),
      timeoutMs
    );

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(
            JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: { cwds: [cwd] } }) + '\n'
          );
        } else if (msg.id === 2) {
          const data = msg.result && Array.isArray(msg.result.data) ? msg.result.data : [];
          const hooks = data.flatMap((d) => d.hooks || []);
          finish({ ok: true, hooks });
        }
      }
    });
    child.on('error', (err) => finish({ ok: false, error: err.message }));
    child.stderr.resume(); // drain so the pipe cannot fill and stall the child

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'agent-approval-gateway', version: '1.0.0' } },
      }) + '\n'
    );
  });
}

/** Remove any existing [hooks.state.'<key>'] table for `key`, then append ours. */
function writeTrustState(key, hash) {
  const file = configTomlPath();
  let toml = '';
  if (fs.existsSync(file)) {
    toml = fs.readFileSync(file, 'utf8');
    // Keep one backup of the pre-modification file for the user's peace of mind.
    const backup = file + '.agw-backup';
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }

  // Strip a previous block for this exact key. A TOML table runs until the next
  // line that starts a new table.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(
    String.raw`\n*\[hooks\.state\.'${escaped}'\][^\[]*`,
    'g'
  );
  toml = toml.replace(blockRe, '\n');

  const block =
    `\n[hooks.state.'${key}']\n` +
    `enabled = true\n` +
    `trusted_hash = "${hash}"\n`;

  const next = toml.replace(/\s*$/, '\n') + block;
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, file);
  return { path: file, key, hash };
}

function removeTrustState(keyPrefix = hooksJsonPath()) {
  const file = configTomlPath();
  if (!fs.existsSync(file)) return { path: file, removed: 0 };
  let toml = fs.readFileSync(file, 'utf8');
  const escaped = keyPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(String.raw`\n*\[hooks\.state\.'${escaped}[^']*'\][^\[]*`, 'g');
  const before = toml;
  toml = toml.replace(re, '\n');
  if (toml === before) return { path: file, removed: 0 };
  fs.writeFileSync(file, toml.replace(/\s*$/, '\n'));
  return { path: file, removed: 1 };
}

/**
 * Full install: write hooks.json, discover the key/hash, grant trust, verify.
 * @returns {Promise<object>}
 */
async function install({ cwd = process.cwd(), grantTrust = true } = {}) {
  const file = hooksJsonPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Preserve a pre-existing hooks.json the user wrote themselves.
  if (fs.existsSync(file)) {
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { existing = null; }
    const isOurs =
      existing &&
      JSON.stringify(existing).includes('adapters' ) &&
      JSON.stringify(existing).includes('codex');
    if (existing && !isOurs) {
      const backup = file + '.agw-backup';
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    }
  }

  const shim = writeShim('codex');
  const doc = buildHooksDoc(shim.command);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, file);

  const result = {
    hooksJson: file,
    shim: shim.shim,
    command: shim.command,
    trusted: false,
    key: null,
    hash: null,
    notes: [],
  };
  if (shim.usedShortPath) {
    result.notes.push(`Using the 8.3 short path for the shim because ${shim.shim} contains spaces.`);
  }
  if (process.platform === 'win32' && shim.command.includes(' ')) {
    result.notes.push(
      `The shim path contains spaces and no 8.3 short name is available. Codex runs hook ` +
        `commands through cmd.exe, which cannot handle that. Set AGW_HOME to a path without ` +
        `spaces and re-run install-hooks.`
    );
  }

  if (!grantTrust) {
    result.notes.push('Trust not granted (grantTrust=false).');
    return result;
  }

  const listed = await listDiscoveredHooks({ cwd });
  if (!listed.ok) {
    result.notes.push(
      `Could not query Codex for the hook trust hash (${listed.error}). ` +
        'The hook is installed but will not run until it is trusted. ' +
        'Re-run `npm run install-hooks` once Codex is available.'
    );
    return result;
  }

  const ours = listed.hooks.find(
    (h) => h && h.sourcePath && path.resolve(h.sourcePath) === path.resolve(file)
  );
  if (!ours) {
    result.notes.push(
      'Codex did not report our hook. Confirm CODEX_HOME and that hooks.json is at ' + file
    );
    return result;
  }

  result.key = ours.key;
  result.hash = ours.currentHash;
  if (ours.trustStatus === 'trusted') {
    result.trusted = true;
    result.notes.push('Hook already trusted.');
    return result;
  }

  writeTrustState(ours.key, ours.currentHash);

  // Verify rather than assume: re-query and confirm the status actually flipped.
  // Retried, because a query issued immediately after the config write has been
  // observed to still report the pre-write state.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await new Promise((r) => setTimeout(r, attempt * 400));
    const recheck = await listDiscoveredHooks({ cwd });
    if (!recheck.ok) {
      if (attempt === 3) result.notes.push(`Trust state written but could not be verified (${recheck.error}).`);
      continue;
    }
    const again = recheck.hooks.find(
      (h) => h && h.sourcePath && path.resolve(h.sourcePath) === path.resolve(file)
    );
    if (again && again.trustStatus === 'trusted') {
      result.trusted = true;
      return result;
    }
    if (attempt === 3) {
      result.notes.push(
        `Trust state written but Codex still reports "${again ? again.trustStatus : 'missing'}". ` +
          'Open Codex and approve the hook there, or re-run install-hooks.'
      );
    }
  }
  return result;
}

function uninstall() {
  const file = hooksJsonPath();
  const out = { hooksJson: file, removed: false };
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    out.removed = true;
  }
  out.shimRemoved = removeShim('codex');
  out.trust = removeTrustState(file);
  return out;
}

async function status({ cwd = process.cwd() } = {}) {
  const file = hooksJsonPath();
  const out = { path: file, installed: fs.existsSync(file), trusted: false, trustStatus: null };
  if (!out.installed) return out;
  const listed = await listDiscoveredHooks({ cwd, timeoutMs: 45000 });
  if (!listed.ok) {
    out.error = listed.error;
    return out;
  }
  const ours = listed.hooks.find(
    (h) => h && h.sourcePath && path.resolve(h.sourcePath) === path.resolve(file)
  );
  out.discovered = Boolean(ours);
  out.trustStatus = ours ? ours.trustStatus : null;
  out.trusted = Boolean(ours && ours.trustStatus === 'trusted');
  return out;
}

module.exports = {
  install,
  uninstall,
  status,
  hooksJsonPath,
  configTomlPath,
  findCodexBinary,
  listDiscoveredHooks,
  buildHooksDoc,
  writeTrustState,
  hookScriptPath,
};
