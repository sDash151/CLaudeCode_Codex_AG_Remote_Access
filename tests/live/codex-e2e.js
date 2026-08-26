#!/usr/bin/env node
'use strict';
/**
 * LIVE end-to-end test against the real Codex CLI.
 *
 * This is not a mock. It:
 *   1. starts a real gateway on a throwaway AGW_HOME,
 *   2. installs the real hook into $CODEX_HOME/hooks.json and grants trust,
 *   3. runs `codex exec` with a prompt that makes Codex run a shell command,
 *   4. answers the resulting approval request programmatically (standing in for
 *      the phone, using the same authenticated /api/decide endpoint the PWA uses),
 *   5. asserts Codex actually honoured the decision,
 *   6. restores the user's Codex config exactly as it was.
 *
 * Run:  node tests/live/codex-e2e.js
 *
 * It touches the user's real ~/.codex, so it backs up hooks.json and config.toml
 * first and restores them in a finally block — including on Ctrl-C.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-live-'));
process.env.AGW_HOME = TMP_HOME;

const { loadConfig, saveConfig, PATHS } = require('../../src/core/config');
const { AuditLog } = require('../../src/core/audit');
const { DeviceRegistry } = require('../../src/core/devices');
const { Gateway } = require('../../src/server/gateway');
const codexInstall = require('../../src/adapters/codex/install');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const HOOKS_JSON = path.join(CODEX_HOME, 'hooks.json');
const CONFIG_TOML = path.join(CODEX_HOME, 'config.toml');

const backup = { hooks: null, hooksExisted: false, toml: null, tomlExisted: false };
let restored = false;

function snapshot() {
  backup.hooksExisted = fs.existsSync(HOOKS_JSON);
  if (backup.hooksExisted) backup.hooks = fs.readFileSync(HOOKS_JSON);
  backup.tomlExisted = fs.existsSync(CONFIG_TOML);
  if (backup.tomlExisted) backup.toml = fs.readFileSync(CONFIG_TOML);
  console.log(`  snapshot: hooks.json ${backup.hooksExisted ? 'exists' : 'absent'}, config.toml ${backup.tomlExisted ? 'exists' : 'absent'}`);
}

function restore() {
  if (restored) return;
  restored = true;
  try {
    if (backup.hooksExisted) fs.writeFileSync(HOOKS_JSON, backup.hooks);
    else if (fs.existsSync(HOOKS_JSON)) fs.unlinkSync(HOOKS_JSON);
    if (backup.tomlExisted) fs.writeFileSync(CONFIG_TOML, backup.toml);
    // Remove the backup the installer made, so we leave no litter.
    for (const f of [CONFIG_TOML + '.agw-backup', HOOKS_JSON + '.agw-backup']) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    console.log('  restored your ~/.codex to its original state');
  } catch (err) {
    console.error('  !! RESTORE FAILED:', err.message);
    console.error('     hooks.json backup and config.toml backup were held in memory only.');
  }
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* disposable */ }
}

process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

function httpJson({ port, method = 'GET', path: p, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1', port, path: p, method,
        headers: Object.assign(
          payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
          headers
        ),
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `codex exec` with a prompt, capturing everything it prints. */
function runCodex(bin, prompt, cwd) {
  return new Promise((resolve) => {
    const child = spawn(
      bin,
      ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', prompt],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const killer = setTimeout(() => child.kill(), 240000);
    child.on('exit', (code) => {
      clearTimeout(killer);
      resolve({ output: out, code });
    });
    child.stdin.end();
  });
}

/**
 * Watch for a pending request and answer it with `decision`.
 * Returns the request that was decided.
 */
async function answerNextRequest({ port, token, decision, timeoutMs = 120000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await httpJson({
      port, path: '/api/pending', headers: { authorization: 'Bearer ' + token },
    });
    const pending = (res.body && res.body.pending) || [];
    if (pending.length) {
      const req = pending[0];
      console.log(`    phone sees: [${req.agent}] ${req.risk}  ${req.command}`);
      const out = await httpJson({
        port, method: 'POST', path: '/api/decide',
        headers: { authorization: 'Bearer ' + token },
        body: { requestId: req.id, nonce: req.nonce, decision },
      });
      console.log(`    phone taps ${decision.toUpperCase()} -> ${out.status} ${out.body && out.body.status}`);
      return req;
    }
    await sleep(200);
  }
  return null;
}

/** Lines from Codex output that mention the hook or a block, for diagnosis. */
function hookLines(output) {
  return output
    .split(/\r?\n/)
    .filter((l) => /hook|block|denied|reject|refus/i.test(l))
    .map((l) => l.trim())
    .filter(Boolean);
}

/** True when Codex actually executed the command (its output echoed the marker). */
function commandRan(output, marker) {
  // Codex prints the command it is about to run, then its output. Look for the
  // marker on a line that is NOT the echoed command itself.
  return output
    .split(/\r?\n/)
    .some((l) => l.includes(marker) && !/echo\s+/.test(l) && !/Run exactly/.test(l));
}

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? '  :: ' + detail : ''}`);
  }
}

(async () => {
  console.log('\n=== LIVE Codex end-to-end approval test ===\n');

  const bin = codexInstall.findCodexBinary();
  if (!bin) {
    console.error('Codex CLI not found. Set AGW_CODEX_BIN to codex.exe and retry.');
    process.exit(2);
  }
  console.log('Codex binary: ' + bin);

  snapshot();

  const cfg = loadConfig();
  cfg.port = 0;
  cfg.gateMinRisk = 'LOW';        // gate even `echo`, so the test is deterministic
  cfg.requestTtlMs = 120000;
  cfg.agentWaitMs = 110000;
  saveConfig(cfg);

  const gw = new Gateway({ config: cfg });
  const addr = await gw.listen();
  const port = addr.port;
  console.log(`Gateway on 127.0.0.1:${port}\n`);

  // Stand in for the phone using the real pairing + token flow.
  const registry = new DeviceRegistry({ audit: new AuditLog(PATHS().audit), config: cfg });
  const { code } = registry.createPairingCode();
  const paired = await httpJson({
    port, method: 'POST', path: '/api/pair', body: { code, label: 'TestPhone' },
  });
  const token = paired.body.token;
  check('paired a virtual phone', paired.status === 200 && Boolean(token));

  try {
    console.log('\n--- installing the real Codex hook ---');
    const inst = await codexInstall.install({ cwd: TMP_HOME });
    console.log(`  hooks.json: ${inst.hooksJson}`);
    console.log(`  key:        ${inst.key}`);
    console.log(`  trusted:    ${inst.trusted}`);
    for (const n of inst.notes) console.log('  note: ' + n);
    check('hook installed and trusted by Codex', inst.trusted === true,
      'Codex will not execute an untrusted hook');
    if (!inst.trusted) throw new Error('cannot proceed without a trusted hook');

    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-codexwork-'));

    /* ---------------------------------------------------- APPROVE ------- */
    console.log('\n--- SCENARIO 1: Codex asks -> phone APPROVES -> Codex continues ---');
    const approveWatcher = answerNextRequest({ port, token, decision: 'approve' });
    const r1 = await runCodex(bin, 'Run exactly this shell command and nothing else: echo AGW_LIVE_APPROVE', workdir);
    const approved = await approveWatcher;

    check('an approval request reached the phone', Boolean(approved));
    check('the request is attributed to Codex', approved && approved.agent === 'codex');
    check('the exact command was shown', approved && /echo AGW_LIVE_APPROVE/.test(approved.command || ''));
    check('Codex RAN the command after approval', commandRan(r1.output, 'AGW_LIVE_APPROVE'));
    check('Codex was NOT blocked', !/blocked/i.test(r1.output),
      'expected no block message after approval');
    console.log('    codex hook lines: ' + JSON.stringify(hookLines(r1.output)));

    /* ------------------------------------------------------- DENY ------- */
    console.log('\n--- SCENARIO 2: Codex asks -> phone DENIES -> Codex is stopped ---');
    const denyWatcher = answerNextRequest({ port, token, decision: 'deny' });
    const r2 = await runCodex(bin, 'Run exactly this shell command and nothing else: echo AGW_LIVE_DENY', workdir);
    const denied = await denyWatcher;

    console.log('    codex hook lines: ' + JSON.stringify(hookLines(r2.output)));
    check('a second approval request reached the phone', Boolean(denied));
    check('Codex did NOT run the denied command', !commandRan(r2.output, 'AGW_LIVE_DENY'),
      'the command must not execute after a denial');
    check('Codex surfaced the block', /blocked/i.test(r2.output),
      'Codex should report that the hook blocked the call');
    check('the denial reason reached Codex',
      /remote approval gateway|Denied from/i.test(r2.output));

    /* ------------------------------------------------ TIMEOUT = DENY ---- */
    console.log('\n--- SCENARIO 3: nobody answers -> DENIED by default ---');
    // Shrink the window so the test does not take two minutes.
    gw.config.agentWaitMs = 6000;
    gw.store.ttlMs = 6000;
    const r3 = await runCodex(bin, 'Run exactly this shell command and nothing else: echo AGW_LIVE_TIMEOUT', workdir);
    console.log('    codex hook lines: ' + JSON.stringify(hookLines(r3.output)));
    check('an unanswered request did NOT run', !commandRan(r3.output, 'AGW_LIVE_TIMEOUT'),
      'silence must never become an approval');
    check('Codex surfaced the timeout block', /blocked/i.test(r3.output));

    /* --------------------------------------------------- audit trail ---- */
    console.log('\n--- audit trail ---');
    const hist = await httpJson({ port, path: '/api/history?limit=100', headers: { authorization: 'Bearer ' + token } });
    const events = (hist.body.entries || []).map((e) => e.event);
    check('audit recorded an approval', events.includes('request.approved'));
    check('audit recorded a denial', events.includes('request.denied'));
    check('audit recorded an expiry', events.includes('request.expired'));
    for (const e of (hist.body.entries || []).slice(0, 12).reverse()) {
      console.log(`    ${e.ts}  ${e.event.padEnd(20)} ${e.agent || ''} ${e.risk || ''} ${(e.command || e.reason || '').slice(0, 60)}`);
    }

    // Windows may still hold a handle on the Codex working directory.
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* temp dir */ }
  } finally {
    await gw.close();
    restore();
  }

  console.log(`\n=== ${failures === 0 ? 'ALL LIVE CHECKS PASSED' : failures + ' LIVE CHECK(S) FAILED'} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nLIVE TEST ERROR:', err && err.stack ? err.stack : err);
  restore();
  process.exit(1);
});
