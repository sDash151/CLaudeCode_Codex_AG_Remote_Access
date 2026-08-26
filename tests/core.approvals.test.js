'use strict';
/**
 * Core approval semantics: creation, approval, denial, expiry, replay,
 * wrong request id, duplicate decisions, and audit logging.
 *
 * These are the safety properties the whole system rests on, so each test
 * asserts the *absence* of an approval as carefully as its presence.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeHome, cleanHome } = require('./helpers');

const HOME = makeHome('core');
const { AuditLog } = require('../src/core/audit');
const { ApprovalStore, STATUS } = require('../src/core/requests');

test.after(() => cleanHome(HOME));

function newStore({ ttlMs = 60000, clock } = {}) {
  const audit = new AuditLog(path.join(HOME, `audit-${Math.random().toString(36).slice(2)}.jsonl`));
  const now = clock || (() => Date.now());
  return { store: new ApprovalStore({ audit, ttlMs, now }), audit };
}

const BASE = {
  agent: 'claude',
  tool: 'Bash',
  command: 'git push origin main',
  cwd: 'E:/proj/LevelUP',
  project: 'LevelUP',
  sessionId: 'sess_1',
};

/* ------------------------------------------------------------- creation -- */

test('creates a pending request with all required fields', () => {
  const { store } = newStore();
  const req = store.create(BASE);

  assert.match(req.id, /^req_[0-9a-f]{32}$/, 'request id is random and prefixed');
  assert.equal(req.status, STATUS.PENDING);
  assert.equal(req.agent, 'claude');
  assert.equal(req.command, 'git push origin main');
  assert.equal(req.cwd, 'E:/proj/LevelUP');
  assert.equal(req.project, 'LevelUP');
  assert.equal(req.sessionId, 'sess_1');
  assert.equal(req.risk, 'HIGH', 'git push must classify HIGH');
  assert.ok(req.createdAt > 0);
  assert.ok(req.expiresAt > req.createdAt, 'request must be short-lived');
  assert.ok(req.nonce && req.nonce.length >= 24, 'a decision nonce is issued');
  assert.equal(req.decidedAt, null);
});

test('request ids are unique across many creations', () => {
  const { store } = newStore();
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(store.create(BASE).id);
  assert.equal(ids.size, 500);
});

test('pending() lists only undecided requests', () => {
  const { store } = newStore();
  const a = store.create(BASE);
  const b = store.create({ ...BASE, command: 'npm install lodash' });
  assert.equal(store.pending().length, 2);
  store.decide({ requestId: a.id, nonce: a.nonce, decision: 'deny', deviceId: 'dev_1' });
  const pending = store.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, b.id);
});

/* ------------------------------------------------------------- approval -- */

test('explicit approval transitions to approved and records the device', () => {
  const { store } = newStore();
  const req = store.create(BASE);
  const out = store.decide({
    requestId: req.id,
    nonce: req.nonce,
    decision: 'approve',
    deviceId: 'dev_abc',
    deviceLabel: 'iPhone',
  });
  assert.deepEqual(out, { ok: true, status: 'approved' });
  assert.equal(store.get(req.id).status, STATUS.APPROVED);
  assert.equal(store.get(req.id).decidedBy.deviceId, 'dev_abc');
  assert.equal(store.get(req.id).decidedBy.deviceLabel, 'iPhone');
  assert.ok(store.get(req.id).decidedAt >= req.createdAt);
});

test('HIGH-risk requests are approvable only through the same explicit path', () => {
  const { store } = newStore();
  const req = store.create({ ...BASE, command: 'npx prisma migrate deploy' });
  assert.equal(req.risk, 'HIGH');
  // No implicit transition: it stays pending until a decision arrives.
  assert.equal(store.get(req.id).status, STATUS.PENDING);
  const out = store.decide({ requestId: req.id, nonce: req.nonce, decision: 'approve', deviceId: 'd' });
  assert.equal(out.ok, true);
  assert.equal(store.get(req.id).status, STATUS.APPROVED);
});

/* --------------------------------------------------------------- denial -- */

test('explicit denial transitions to denied and keeps the reason', () => {
  const { store } = newStore();
  const req = store.create(BASE);
  const out = store.decide({
    requestId: req.id,
    nonce: req.nonce,
    decision: 'deny',
    deviceId: 'dev_abc',
    reason: 'not right now',
  });
  assert.equal(out.status, 'denied');
  assert.equal(store.get(req.id).status, STATUS.DENIED);
  assert.equal(store.get(req.id).decisionReason, 'not right now');
});

test('an invalid decision value is refused, leaving the request pending', () => {
  const { store } = newStore();
  const req = store.create(BASE);
  const out = store.decide({ requestId: req.id, nonce: req.nonce, decision: 'maybe', deviceId: 'd' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'invalid_decision');
  assert.equal(store.get(req.id).status, STATUS.PENDING, 'must not be approved by a bad value');
});

/* ------------------------------------------------------------ expiration -- */

test('a request expires after its TTL and expiry is not an approval', () => {
  let t = 1_000_000;
  const { store } = newStore({ ttlMs: 5000, clock: () => t });
  const req = store.create(BASE);
  t += 5001;
  store.expire(req.id);
  assert.equal(store.get(req.id).status, STATUS.EXPIRED);
  assert.notEqual(store.get(req.id).status, STATUS.APPROVED);
});

test('deciding after expiry is refused', () => {
  let t = 2_000_000;
  const { store } = newStore({ ttlMs: 5000, clock: () => t });
  const req = store.create(BASE);
  t += 6000;
  const out = store.decide({ requestId: req.id, nonce: req.nonce, decision: 'approve', deviceId: 'd' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'expired');
  assert.equal(store.get(req.id).status, STATUS.EXPIRED, 'stays expired, never becomes approved');
});

test('expired requests drop out of the pending list', () => {
  let t = 3_000_000;
  const { store } = newStore({ ttlMs: 1000, clock: () => t });
  store.create(BASE);
  t += 2000;
  assert.equal(store.pending().length, 0);
});

/* --------------------------------------------------- replay / wrong ids -- */

test('a nonce cannot be replayed after it has been spent', () => {
  const { store } = newStore();
  const req = store.create(BASE);
  const first = store.decide({ requestId: req.id, nonce: req.nonce, decision: 'approve', deviceId: 'd' });
  assert.equal(first.ok, true);

  const replay = store.decide({ requestId: req.id, nonce: req.nonce, decision: 'approve', deviceId: 'd' });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'replayed');
});

test("a nonce from request A cannot decide request B", () => {
  const { store } = newStore();
  const a = store.create({ ...BASE, command: 'git push origin main' });
  const b = store.create({ ...BASE, command: 'rm -rf build' });

  const out = store.decide({ requestId: b.id, nonce: a.nonce, decision: 'approve', deviceId: 'd' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'bad_nonce');
  assert.equal(store.get(b.id).status, STATUS.PENDING, 'B must remain undecided');
  assert.equal(store.get(a.id).status, STATUS.PENDING, 'A must be untouched');
});

test('an unknown request id is refused', () => {
  const { store } = newStore();
  const out = store.decide({ requestId: 'req_doesnotexist', nonce: 'x', decision: 'approve', deviceId: 'd' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'unknown_request');
});

test('a missing or empty nonce is refused', () => {
  const { store } = newStore();
  const req = store.create(BASE);
  for (const nonce of [undefined, null, '', 'wrong']) {
    const out = store.decide({ requestId: req.id, nonce, decision: 'approve', deviceId: 'd' });
    assert.equal(out.ok, false, `nonce ${JSON.stringify(nonce)} must be refused`);
    assert.equal(out.code, 'bad_nonce');
  }
  assert.equal(store.get(req.id).status, STATUS.PENDING);
});

/* ------------------------------------------------------ duplicate decide -- */

test('a second decision cannot overwrite the first', () => {
  const { store } = newStore();
  const req = store.create(BASE);
  store.decide({ requestId: req.id, nonce: req.nonce, decision: 'deny', deviceId: 'dev_1' });

  // Even with the correct nonce, the request is terminal. (Replay is detected
  // first; both outcomes are refusals.)
  const out = store.decide({ requestId: req.id, nonce: req.nonce, decision: 'approve', deviceId: 'dev_2' });
  assert.equal(out.ok, false);
  assert.equal(store.get(req.id).status, STATUS.DENIED, 'denial must stand');
});

test('a decision after expiry cannot flip an expired request to approved', () => {
  let t = 4_000_000;
  const { store } = newStore({ ttlMs: 1000, clock: () => t });
  const req = store.create(BASE);
  store.expire(req.id);
  t += 10;
  const out = store.decide({ requestId: req.id, nonce: req.nonce, decision: 'approve', deviceId: 'd' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'already_decided');
  assert.equal(store.get(req.id).status, STATUS.EXPIRED);
});

/* ---------------------------------------------------------- agent waits -- */

test('waitForDecision resolves with the approval', async () => {
  const { store } = newStore();
  const req = store.create(BASE);
  const waiting = store.waitForDecision(req.id, 5000);
  setTimeout(
    () => store.decide({ requestId: req.id, nonce: req.nonce, decision: 'approve', deviceId: 'd' }),
    20
  );
  const view = await waiting;
  assert.equal(view.status, STATUS.APPROVED);
});

test('waitForDecision resolves with the denial', async () => {
  const { store } = newStore();
  const req = store.create(BASE);
  const waiting = store.waitForDecision(req.id, 5000);
  setTimeout(
    () => store.decide({ requestId: req.id, nonce: req.nonce, decision: 'deny', deviceId: 'd' }),
    20
  );
  const view = await waiting;
  assert.equal(view.status, STATUS.DENIED);
});

test("an agent's wait timeout expires the request rather than approving it", async () => {
  const { store } = newStore({ ttlMs: 60000 });
  const req = store.create(BASE);
  const view = await store.waitForDecision(req.id, 60);
  assert.equal(view.status, STATUS.EXPIRED);
  assert.equal(view.decisionReason, 'agent_wait_timeout');

  // And a late approval cannot resurrect it.
  const late = store.decide({ requestId: req.id, nonce: req.nonce, decision: 'approve', deviceId: 'd' });
  assert.equal(late.ok, false);
  assert.equal(store.get(req.id).status, STATUS.EXPIRED);
});

/* ------------------------------------------------------ gateway shutdown -- */

test('shutdown denies every pending request', () => {
  const { store } = newStore();
  const a = store.create(BASE);
  const b = store.create({ ...BASE, command: 'npm install' });
  const n = store.denyAllPending('gateway_shutdown');
  assert.equal(n, 2);
  assert.equal(store.get(a.id).status, STATUS.DENIED);
  assert.equal(store.get(b.id).status, STATUS.DENIED);
  assert.equal(store.get(a.id).decisionReason, 'gateway_shutdown');
});

/* --------------------------------------------------------------- audit -- */

test('audit log records creation, approval, denial and expiry', () => {
  const { store, audit } = newStore();

  const approved = store.create(BASE);
  store.decide({
    requestId: approved.id, nonce: approved.nonce, decision: 'approve',
    deviceId: 'dev_1', deviceLabel: 'iPhone',
  });

  const denied = store.create({ ...BASE, command: 'rm -rf /' });
  store.decide({
    requestId: denied.id, nonce: denied.nonce, decision: 'deny',
    deviceId: 'dev_1', deviceLabel: 'iPhone', reason: 'nope',
  });

  const expired = store.create({ ...BASE, command: 'terraform destroy' });
  store.expire(expired.id);

  const entries = audit.tail(100);
  const events = entries.map((e) => e.event);
  assert.ok(events.includes('request.created'));
  assert.ok(events.includes('request.approved'));
  assert.ok(events.includes('request.denied'));
  assert.ok(events.includes('request.expired'));

  const ap = entries.find((e) => e.event === 'request.approved');
  assert.equal(ap.requestId, approved.id);
  assert.equal(ap.deviceId, 'dev_1');
  assert.equal(ap.deviceLabel, 'iPhone');
  assert.equal(ap.agent, 'claude');
  assert.equal(ap.command, 'git push origin main');
  assert.equal(ap.risk, 'HIGH');
  assert.ok(typeof ap.latencyMs === 'number');
  assert.ok(ap.ts, 'every entry is timestamped');

  const dn = entries.find((e) => e.event === 'request.denied');
  assert.equal(dn.reason, 'nope', 'denial reason is recorded');

  const ex = entries.find((e) => e.event === 'request.expired');
  assert.equal(ex.reason, 'ttl_elapsed');
  assert.ok(typeof ex.ttlMs === 'number', 'expiry/timeout is recorded');
});

test('audit log records refused decisions with a reason', () => {
  const { store, audit } = newStore();
  const a = store.create(BASE);
  const b = store.create({ ...BASE, command: 'ls' });
  store.decide({ requestId: b.id, nonce: a.nonce, decision: 'approve', deviceId: 'dev_9' });
  store.decide({ requestId: 'req_nope', nonce: 'x', decision: 'approve', deviceId: 'dev_9' });

  const rejected = audit.tail(50).filter((e) => e.event === 'decision.rejected');
  const reasons = rejected.map((e) => e.reason);
  assert.ok(reasons.includes('nonce_mismatch'));
  assert.ok(reasons.includes('unknown_request_id'));
});

test('the public view never leaks a nonce for a decided request', () => {
  const { store } = newStore();
  const req = store.create(BASE);
  assert.ok(store.publicView(store.get(req.id)).nonce, 'pending view carries the nonce');
  store.decide({ requestId: req.id, nonce: req.nonce, decision: 'approve', deviceId: 'd' });
  assert.equal(store.publicView(store.get(req.id)).nonce, null);
});
