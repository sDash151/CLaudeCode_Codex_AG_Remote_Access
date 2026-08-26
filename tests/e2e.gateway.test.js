'use strict';
/**
 * End-to-end tests against a live gateway over real HTTP, driving the real hook
 * script as a child process — the same way the agents invoke it.
 *
 * Covers: authentication, pairing, revocation, the agent/phone surface split,
 * the "no remote shell" boundary, connection loss, agent disconnect, and the
 * four required approve/deny flows for all three agents.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { makeHome, cleanHome, request, hookPayload, sleep } = require('./helpers');

const HOME = makeHome('e2e');
const { loadConfig, saveConfig } = require('../src/core/config');
const { AuditLog } = require('../src/core/audit');
const { DeviceRegistry } = require('../src/core/devices');
const { PATHS } = require('../src/core/config');
const { Gateway } = require('../src/server/gateway');

const HOOK = path.resolve(__dirname, '..', 'src', 'adapters', 'hook.js');

let gw;
let port;
let cfg;

test.before(async () => {
  cfg = loadConfig();
  cfg.port = 0;                 // let the OS pick a free port
  cfg.requestTtlMs = 4000;      // keep expiry tests quick
  cfg.agentWaitMs = 3000;
  saveConfig(cfg);
  gw = new Gateway({ config: cfg });
  const addr = await gw.listen();
  port = addr.port;
});

test.after(async () => {
  if (gw) await gw.close();
  cleanHome(HOME);
});

/** Mint a device token the way `agw pair` does. */
function pairDevice(label = 'iPhone') {
  const audit = new AuditLog(PATHS().audit);
  const registry = new DeviceRegistry({ audit, config: cfg });
  const { code } = registry.createPairingCode();
  return { code, registry };
}

async function pairOverHttp(label = 'iPhone') {
  const { code } = pairDevice(label);
  const res = await request({ port, method: 'POST', path: '/api/pair', body: { code, label } });
  assert.equal(res.status, 200, 'pairing should succeed');
  return res.body.token;
}

/**
 * Run the real hook script for `agent` with a payload, returning what the agent
 * would see. Resolves once the child exits.
 */
function runHook(agent, payload, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, agent], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AGW_HOME: HOME, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => {
      let decision = null;
      try {
        decision = JSON.parse(out)?.hookSpecificOutput?.permissionDecision ?? null;
      } catch { /* silence or non-JSON */ }
      resolve({ stdout: out, stderr: err, exitCode: code, decision });
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/** Wait until a pending request appears, then return it. */
async function waitForPending(token, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request({ port, path: '/api/pending', headers: { authorization: 'Bearer ' + token } });
    if (res.status === 200 && res.body.pending.length) return res.body.pending[0];
    await sleep(60);
  }
  throw new Error('no pending request appeared');
}

/* ------------------------------------------------------- authentication -- */

test('phone endpoints reject an absent or bogus token', async () => {
  for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: 'Basic x' }]) {
    const res = await request({ port, path: '/api/pending', headers });
    assert.equal(res.status, 401, 'unauthenticated access must be refused');
  }
  const decide = await request({
    port, method: 'POST', path: '/api/decide',
    body: { requestId: 'req_x', nonce: 'y', decision: 'approve' },
  });
  assert.equal(decide.status, 401, 'cannot decide without authenticating');
});

test('a valid pairing code yields a working token; the code is single-use', async () => {
  const { code } = pairDevice();
  const first = await request({ port, method: 'POST', path: '/api/pair', body: { code, label: 'iPhone' } });
  assert.equal(first.status, 200);
  assert.ok(first.body.token && first.body.token.length >= 40, 'token must be long and random');
  assert.ok(
    String(first.headers['set-cookie'] || '').includes('HttpOnly'),
    'token cookie must be HttpOnly'
  );

  const replay = await request({ port, method: 'POST', path: '/api/pair', body: { code, label: 'iPhone' } });
  assert.equal(replay.status, 401, 'a pairing code cannot be redeemed twice');

  const ok = await request({ port, path: '/api/pending', headers: { authorization: 'Bearer ' + first.body.token } });
  assert.equal(ok.status, 200);
});

test('a wrong pairing code is refused', async () => {
  pairDevice();
  const res = await request({ port, method: 'POST', path: '/api/pair', body: { code: 'WRON-GXXX', label: 'x' } });
  assert.equal(res.status, 401);
});

test('device tokens are not stored in plaintext', async () => {
  const token = await pairOverHttp('PlaintextCheck');
  const raw = require('node:fs').readFileSync(PATHS().devices, 'utf8');
  assert.ok(!raw.includes(token), 'devices.json must not contain the raw token');
  assert.ok(raw.includes('tokenHash'), 'only the hash is persisted');
});

test('revocation immediately invalidates a token', async () => {
  const token = await pairOverHttp('ToRevoke');
  const before = await request({ port, path: '/api/pending', headers: { authorization: 'Bearer ' + token } });
  assert.equal(before.status, 200);

  const audit = new AuditLog(PATHS().audit);
  const registry = new DeviceRegistry({ audit, config: cfg });
  const target = registry.list().find((d) => d.label === 'ToRevoke');
  assert.ok(target, 'device should be listed');
  // The live gateway holds its own registry instance, so revoke through the API.
  const revoked = await request({
    port, method: 'POST', path: '/api/devices/revoke',
    headers: { authorization: 'Bearer ' + token },
    body: { deviceId: target.deviceId },
  });
  assert.equal(revoked.status, 200);

  const after = await request({ port, path: '/api/pending', headers: { authorization: 'Bearer ' + token } });
  assert.equal(after.status, 401, 'a revoked device must be locked out');
});

/* ------------------------------------------------------- surface split -- */

test('the agent surface requires the shared secret', async () => {
  const res = await request({
    port, method: 'POST', path: '/agent/approval',
    body: { agent: 'claude', tool: 'Bash', command: 'git push' },
  });
  assert.equal(res.status, 401, 'no secret means no request creation');

  const wrong = await request({
    port, method: 'POST', path: '/agent/approval',
    headers: { 'x-agw-agent-secret': 'wrong' },
    body: { agent: 'claude', tool: 'Bash', command: 'git push' },
  });
  assert.equal(wrong.status, 401);
});

test('a phone token cannot be used on the agent surface', async () => {
  const token = await pairOverHttp('CrossSurface');
  const res = await request({
    port, method: 'POST', path: '/agent/approval',
    headers: { 'x-agw-agent-secret': token },
    body: { agent: 'claude', tool: 'Bash', command: 'git push' },
  });
  assert.equal(res.status, 401, 'device tokens must not authenticate the agent surface');
});

test('SECURITY: there is no endpoint that lets the phone run a command', async () => {
  const token = await pairOverHttp('NoShell');
  const headers = { authorization: 'Bearer ' + token };

  // Any plausible "run this" endpoint must not exist.
  for (const p of ['/api/exec', '/api/run', '/api/command', '/api/shell', '/api/spawn']) {
    const res = await request({ port, method: 'POST', path: p, headers, body: { command: 'calc.exe' } });
    assert.equal(res.status, 404, `${p} must not exist`);
  }

  // And the phone cannot create a request of its own to then approve.
  const create = await request({
    port, method: 'POST', path: '/agent/approval', headers,
    body: { agent: 'claude', tool: 'Bash', command: 'calc.exe' },
  });
  assert.equal(create.status, 401, 'the phone cannot create approval requests');

  // Deciding a request that does not exist changes nothing.
  const decide = await request({
    port, method: 'POST', path: '/api/decide', headers,
    body: { requestId: 'req_fabricated', nonce: 'whatever', decision: 'approve' },
  });
  assert.equal(decide.status, 409);
  assert.equal(decide.body.error, 'unknown_request');
});

/* ----------------------------------------------- approve / deny per agent -- */

for (const agent of ['claude', 'codex', 'antigravity']) {
  test(`${agent}: APPROVE flow — hook blocks, phone approves, agent continues`, async () => {
    const token = await pairOverHttp(`iPhone-${agent}-ok`);
    const hookDone = runHook(agent, hookPayload({ agent, command: 'git push origin main' }));

    const pending = await waitForPending(token);
    assert.equal(pending.agent, agent, 'the request identifies the originating agent');
    assert.equal(pending.command, 'git push origin main', 'the exact command is shown');
    assert.equal(pending.risk, 'HIGH');
    assert.ok(pending.project, 'a project name is derived');
    assert.ok(pending.nonce, 'a nonce is supplied to the phone');

    const decided = await request({
      port, method: 'POST', path: '/api/decide',
      headers: { authorization: 'Bearer ' + token },
      body: { requestId: pending.id, nonce: pending.nonce, decision: 'approve' },
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.status, 'approved');

    const res = await hookDone;
    if (agent === 'claude') {
      assert.equal(res.decision, 'allow', 'Claude is told to allow');
      assert.equal(res.exitCode, 0);
    } else {
      // Codex rejects "allow"; Antigravity treats exit 0 as no objection.
      assert.equal(res.stdout, '', `${agent} approval must be silence`);
      assert.equal(res.exitCode, 0);
    }
  });

  test(`${agent}: DENY flow — hook blocks, phone denies, agent is stopped`, async () => {
    const token = await pairOverHttp(`iPhone-${agent}-no`);
    const hookDone = runHook(agent, hookPayload({ agent, command: 'npx prisma migrate deploy' }));

    const pending = await waitForPending(token);
    assert.equal(pending.risk, 'HIGH');

    const decided = await request({
      port, method: 'POST', path: '/api/decide',
      headers: { authorization: 'Bearer ' + token },
      body: { requestId: pending.id, nonce: pending.nonce, decision: 'deny', reason: 'not now' },
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.status, 'denied');

    const res = await hookDone;
    if (agent === 'antigravity') {
      assert.equal(res.exitCode, 2, 'Antigravity blocks on a non-zero exit');
      assert.ok(res.stderr.length > 0, 'a reason reaches the agent');
    }
    assert.equal(res.decision, 'deny', `${agent} must receive an explicit deny`);
    assert.ok(/not now|Denied/i.test(res.stdout), 'the denial carries a reason');
  });
}

/* --------------------------------------------- no device: fail fast+closed -- */

test('with no reachable device, a gated request is denied IMMEDIATELY', async () => {
  // Revoke every device so nothing can answer, then time the hook.
  const token = await pairOverHttp('WillRevokeAll');
  const list = await request({ port, path: '/api/devices', headers: { authorization: 'Bearer ' + token } });
  for (const d of list.body.devices) {
    if (d.revokedAt) continue;
    await request({
      port, method: 'POST', path: '/api/devices/revoke',
      headers: { authorization: 'Bearer ' + token },
      body: { deviceId: d.deviceId },
    });
  }

  const started = Date.now();
  const res = await runHook('claude', hookPayload({ agent: 'claude', command: 'git push origin main' }));
  const elapsed = Date.now() - started;

  assert.equal(res.decision, 'deny', 'must still deny');
  assert.match(res.stdout, /No paired device/i, 'reason should explain why');
  // The wait window is 3s in this suite; an immediate refusal must beat it clearly.
  assert.ok(elapsed < 2500, `expected an immediate denial, took ${elapsed}ms`);

  const entries = new AuditLog(PATHS().audit).tail(30);
  assert.ok(
    entries.some((e) => e.event === 'request.refused_no_device'),
    'the refusal is recorded in the audit log'
  );
});

/* ------------------------------------------------------------- lifecycle -- */

test('LOW-risk actions run automatically without reaching the phone', async () => {
  const res = await runHook('claude', hookPayload({ agent: 'claude', command: 'git status' }));
  // Auto-allowed rather than silent: silence would pop a prompt on the laptop.
  assert.equal(res.decision, 'allow', 'LOW must be auto-allowed for walk-away');
  assert.equal(res.exitCode, 0);

  // Codex cannot be told "allow", so for it LOW stays silence.
  const codexRes = await runHook('codex', hookPayload({ agent: 'codex', command: 'git status' }));
  assert.equal(codexRes.stdout, '', 'codex passthrough must remain silent');

  const entries = new AuditLog(PATHS().audit).tail(50);
  const pt = entries.find((e) => e.event === 'request.passthrough' && e.command === 'git status');
  assert.ok(pt, 'passthrough is still recorded in the audit log');
  assert.equal(pt.risk, 'LOW');
});

test('no decision before the wait window closes results in a DENY', async () => {
  // A device must exist, otherwise the gateway refuses immediately for a
  // different reason and this would not exercise the timeout path.
  await pairOverHttp('SilentPhone');
  // agentWaitMs is 3s in this suite; nobody answers.
  const res = await runHook('claude', hookPayload({ agent: 'claude', command: 'git push --force' }));
  assert.equal(res.decision, 'deny', 'silence must never become an approval');
  assert.match(res.stdout, /denied by default|expired|window closed/i);
});

test('CONNECTION LOSS: an unreachable gateway denies rather than proceeding', async () => {
  // Point the hook at a port nothing is listening on.
  const bogus = { ...cfg, port: 1 };
  const fs = require('node:fs');
  const os = require('node:os');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-offline-'));
  fs.writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify(bogus));

  const res = await runHook('claude', hookPayload({ agent: 'claude', command: 'git push' }), {
    env: { AGW_HOME: tmpHome },
  });
  assert.equal(res.decision, 'deny');
  assert.match(res.stdout, /unreachable|denying by default/i);
  cleanHome(tmpHome);
});

test('AGENT DISCONNECT: the request is resolved and cannot be approved later', async () => {
  const token = await pairOverHttp('Disconnect');
  // Start a hook, then kill it mid-wait, simulating the agent going away.
  const child = spawn(process.execPath, [HOOK, 'codex'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGW_HOME: HOME },
  });
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.write(JSON.stringify(hookPayload({ agent: 'codex', command: 'terraform destroy' })));
  child.stdin.end();

  const pending = await waitForPending(token);
  child.kill();
  await sleep(150);

  // The gateway still holds the request; the wait window will expire it. Once it
  // does, a late approval must be refused.
  await sleep(cfg.agentWaitMs + 400);
  const late = await request({
    port, method: 'POST', path: '/api/decide',
    headers: { authorization: 'Bearer ' + token },
    body: { requestId: pending.id, nonce: pending.nonce, decision: 'approve' },
  });
  assert.equal(late.status, 409, 'a stale approval must not be applied');
  assert.ok(['already_decided', 'expired'].includes(late.body.error), `got ${late.body.error}`);
});

test('the same nonce cannot be replayed over HTTP', async () => {
  const token = await pairOverHttp('ReplayHttp');
  const hookDone = runHook('claude', hookPayload({ agent: 'claude', command: 'git push origin main' }));
  const pending = await waitForPending(token);
  const headers = { authorization: 'Bearer ' + token };
  const body = { requestId: pending.id, nonce: pending.nonce, decision: 'approve' };

  const first = await request({ port, method: 'POST', path: '/api/decide', headers, body });
  assert.equal(first.status, 200);
  const second = await request({ port, method: 'POST', path: '/api/decide', headers, body });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'replayed');
  await hookDone;
});

test('a nonce from one request cannot approve another, over HTTP', async () => {
  const token = await pairOverHttp('CrossReq');
  const headers = { authorization: 'Bearer ' + token };
  const aDone = runHook('claude', hookPayload({ agent: 'claude', command: 'git push origin main' }));
  const a = await waitForPending(token);
  const bDone = runHook('codex', hookPayload({ agent: 'codex', command: 'rm -rf dist' }));

  // Wait until both are listed.
  let b = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const res = await request({ port, path: '/api/pending', headers });
    b = res.body.pending.find((r) => r.id !== a.id);
    if (b) break;
    await sleep(60);
  }
  assert.ok(b, 'second request should appear');

  const crossed = await request({
    port, method: 'POST', path: '/api/decide', headers,
    body: { requestId: b.id, nonce: a.nonce, decision: 'approve' },
  });
  assert.equal(crossed.status, 409);
  assert.equal(crossed.body.error, 'bad_nonce');

  // Clean up: decide both properly so the hooks exit.
  await request({ port, method: 'POST', path: '/api/decide', headers, body: { requestId: a.id, nonce: a.nonce, decision: 'deny' } });
  await request({ port, method: 'POST', path: '/api/decide', headers, body: { requestId: b.id, nonce: b.nonce, decision: 'deny' } });
  await aDone;
  await bDone;
});

/* ----------------------------------------------------------- audit view -- */

test('history is available to a paired device and records decisions', async () => {
  const token = await pairOverHttp('HistoryView');
  const res = await request({ port, path: '/api/history?limit=200', headers: { authorization: 'Bearer ' + token } });
  assert.equal(res.status, 200);
  const events = res.body.entries.map((e) => e.event);
  assert.ok(events.includes('request.created'));
  assert.ok(events.includes('request.approved'));
  assert.ok(events.includes('request.denied'));
  assert.ok(events.includes('pairing.succeeded'));
  assert.ok(events.includes('gateway.started'));

  const approved = res.body.entries.find((e) => e.event === 'request.approved');
  for (const field of ['requestId', 'agent', 'command', 'risk', 'deviceId', 'ts']) {
    assert.ok(field in approved, `audit entry should record ${field}`);
  }
});

test('history is not available without authentication', async () => {
  const res = await request({ port, path: '/api/history' });
  assert.equal(res.status, 401);
});

/* ------------------------------------------------------------- web push -- */

// Regression: the VAPID `sub` claim used to default to
// mailto:approval-gateway@localhost. Apple answers 403 to that, so every
// notification failed silently while the gateway reported success.
test('push refuses to arm without a real VAPID subject, and prefers publicOrigin', () => {
  const { PushService } = require('../src/server/push');
  const stub = { activePushTargets: () => [] };
  const noop = { append() {} };

  const withOrigin = new PushService({
    config: { ...cfg, publicOrigin: 'https://host.tailnet.ts.net', vapidSubject: undefined },
    devices: stub, audit: noop, saveConfig: () => {},
  });
  assert.equal(withOrigin.available, true, 'a valid https origin must arm push');
  assert.equal(withOrigin.subject, 'https://host.tailnet.ts.net');
  assert.ok(!/localhost/.test(withOrigin.subject), 'must never use a localhost subject');

  const without = new PushService({
    config: { ...cfg, publicOrigin: '', vapidSubject: undefined },
    devices: stub, audit: noop, saveConfig: () => {},
  });
  assert.equal(without.available, false, 'no subject means push must not claim to be available');
  assert.match(without.reason, /publicOrigin|vapidSubject/);
});

/* ---------------------------------------------------------------- static -- */

test('the PWA and its manifest are served', async () => {
  for (const p of ['/', '/app.js', '/styles.css', '/sw.js', '/manifest.webmanifest', '/icon-192.png']) {
    const res = await request({ port, path: p });
    assert.equal(res.status, 200, `${p} should be served`);
  }
});

test('static serving refuses path traversal', async () => {
  const res = await request({ port, path: '/../../../../Windows/win.ini' });
  assert.ok([403, 404, 200].includes(res.status));
  if (res.status === 200) {
    assert.ok(!/\[extensions\]/i.test(res.text), 'must not serve files outside the static dir');
  }
});
