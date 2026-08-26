'use strict';
/**
 * Walk-away operation.
 *
 * Requirement: start a session, walk away, and it continues indefinitely unless
 * the phone denies something. That needs TWO hooks on ALL tools:
 *
 *   PreToolUse        LOW auto-allowed, MEDIUM/HIGH to the phone
 *   PermissionRequest catch-all for anything else that would prompt locally,
 *                     including files outside the project
 *
 * These run against a throwaway settings.json, never the real ~/.claude.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claudeInstall = require('../src/adapters/claude/install');
const claudeAdapter = require('../src/adapters/claude/adapter');
const { HOOK_EVENTS, MATCHER_ALL } = claudeInstall;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-walkaway-'));
const settingsFile = path.join(dir, '.claude', 'settings.json');
const opts = { scope: 'project', projectDir: dir };

test.after(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

const read = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
function writeSettings(obj) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(obj, null, 2));
}

/* ------------------------------------------------------------- installer -- */

test('install registers BOTH hook events on all tools', () => {
  writeSettings({});
  const r = claudeInstall.install(opts);
  assert.deepEqual(r.events, ['PreToolUse', 'PermissionRequest']);
  const s = read();
  for (const event of HOOK_EVENTS) {
    assert.ok(Array.isArray(s.hooks[event]), `${event} must be registered`);
    assert.equal(s.hooks[event][0].matcher, MATCHER_ALL, `${event} must match all tools`);
  }
});

test('install does NOT use bypassPermissions or blanket pre-approval', () => {
  writeSettings({});
  claudeInstall.install(opts);
  const s = read();
  assert.notEqual(s.permissions?.defaultMode, 'bypassPermissions',
    'must not need the dangerous opt-in');
  assert.ok(!s.permissions?.allow, 'must not blanket pre-approve tool names');
});

test('status reports walkaway only when BOTH events are hooked', () => {
  writeSettings({});
  claudeInstall.install(opts);
  let st = claudeInstall.status(opts);
  assert.equal(st.walkaway, true);
  assert.equal(st.permissionRequestHook, true);

  // Drop the catch-all: the laptop can prompt again.
  const s = read();
  delete s.hooks.PermissionRequest;
  writeSettings(s);
  st = claudeInstall.status(opts);
  assert.equal(st.installed, true);
  assert.equal(st.walkaway, false, 'PreToolUse alone is not walk-away');
});

test('--no-walkaway installs PreToolUse only', () => {
  writeSettings({});
  const r = claudeInstall.install({ ...opts, walkaway: false });
  assert.deepEqual(r.events, ['PreToolUse']);
  assert.ok(!read().hooks.PermissionRequest, 'catch-all must be absent');
});

test('switching to --no-walkaway clears a previously installed catch-all', () => {
  writeSettings({});
  claudeInstall.install(opts);
  assert.ok(read().hooks.PermissionRequest);
  claudeInstall.install({ ...opts, walkaway: false });
  assert.ok(!read().hooks.PermissionRequest, 'stale catch-all must be removed');
});

test('uninstall removes our handlers from both events', () => {
  writeSettings({});
  claudeInstall.install(opts);
  const r = claudeInstall.uninstall(opts);
  assert.deepEqual(r.clearedEvents.sort(), ['PermissionRequest', 'PreToolUse']);
  assert.ok(!read().hooks, 'nothing of ours left behind');
  assert.equal(claudeInstall.status(opts).walkaway, false);
});

test('repeated installs stay idempotent — no duplicate handlers', () => {
  writeSettings({});
  claudeInstall.install(opts);
  claudeInstall.install(opts);
  claudeInstall.install(opts);
  const s = read();
  for (const event of HOOK_EVENTS) {
    const mine = s.hooks[event].flatMap((g) => g.hooks)
      .filter((h) => h._source === 'agent-approval-gateway');
    assert.equal(mine.length, 1, `${event} must have exactly one of our handlers`);
  }
});

test("uninstall preserves the user's own hooks on the same events", () => {
  writeSettings({
    hooks: {
      PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'mine.sh' }] }],
      PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'theirs.sh' }] }],
    },
    someOtherKey: 42,
  });
  claudeInstall.install(opts);
  claudeInstall.uninstall(opts);
  const s = read();
  assert.equal(s.someOtherKey, 42);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'mine.sh');
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].command, 'theirs.sh');
});

test('uninstall cleans up stale pre-approvals from the abandoned approach', () => {
  writeSettings({
    permissions: { allow: ['Bash', 'Write', 'Read'] },
    _agwAddedAllowRules: ['Bash', 'Write'],
  });
  claudeInstall.install(opts);
  claudeInstall.uninstall(opts);
  const s = read();
  assert.deepEqual(s.permissions.allow, ['Read'], 'only the user rule remains');
  assert.ok(!('_agwAddedAllowRules' in s));
});

test('status flags stale pre-approvals left with no hook', () => {
  writeSettings({
    permissions: { allow: ['Bash'] },
    _agwAddedAllowRules: ['Bash'],
  });
  const st = claudeInstall.status(opts);
  assert.equal(st.installed, false);
  assert.deepEqual(st.staleAllowRules, ['Bash']);
});

/* ---------------------------------------------------- PermissionRequest -- */

// Schema taken from the CLI's own validator:
//   decision: [ {behavior:"allow", updatedInput?, updatedPermissions?},
//               {behavior:"deny",  message?, interrupt?} ]
test('PermissionRequest approval renders decision.behavior = allow', () => {
  const out = claudeAdapter.render({
    approved: true, reason: 'Approved from iPhone', hookEvent: 'PermissionRequest',
  });
  const j = JSON.parse(out.stdout);
  assert.equal(j.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(j.hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(out.exitCode, 0);
});

test('PermissionRequest denial renders decision.behavior = deny with a message', () => {
  const out = claudeAdapter.render({
    approved: false, reason: 'Denied from iPhone', hookEvent: 'PermissionRequest',
  });
  const j = JSON.parse(out.stdout);
  assert.equal(j.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(j.hookSpecificOutput.decision.message, 'Denied from iPhone');
  assert.equal(j.hookSpecificOutput.decision.interrupt, false,
    'deny one call, do not abort the whole turn');
  // Exit 2 is NOT honoured for this event, so the object must carry the denial.
  assert.ok(j.hookSpecificOutput.decision, 'decision object is the only way to deny');
});

test('PermissionRequest never emits the PreToolUse field names', () => {
  for (const result of [{ approved: true }, { approved: false }]) {
    const j = JSON.parse(claudeAdapter.render({ ...result, hookEvent: 'PermissionRequest' }).stdout);
    assert.equal(j.hookSpecificOutput.permissionDecision, undefined,
      'wrong field for this event would silently fail');
  }
});

test('PreToolUse still uses permissionDecision, not the decision object', () => {
  const j = JSON.parse(claudeAdapter.render({ approved: true, hookEvent: 'PreToolUse' }).stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(j.hookSpecificOutput.decision, undefined);
});

test('LOW-risk passthrough is auto-ALLOWED, never silence', () => {
  // Silence means "no decision", which pops a local prompt and breaks walk-away.
  for (const hookEvent of HOOK_EVENTS) {
    const out = claudeAdapter.render({ mode: 'passthrough', approved: false, hookEvent });
    assert.notEqual(out.stdout, '', `${hookEvent} passthrough must not be silent`);
    const j = JSON.parse(out.stdout);
    const verdict = hookEvent === 'PermissionRequest'
      ? j.hookSpecificOutput.decision.behavior
      : j.hookSpecificOutput.permissionDecision;
    assert.equal(verdict, 'allow', `${hookEvent} passthrough must auto-allow`);
  }
});

test('every non-approval still denies, in both shapes', () => {
  for (const hookEvent of HOOK_EVENTS) {
    for (const result of [{}, { approved: false }, { approved: 'yes' }, { status: 'expired' }]) {
      const j = JSON.parse(claudeAdapter.render({ ...result, hookEvent }).stdout);
      const verdict = hookEvent === 'PermissionRequest'
        ? j.hookSpecificOutput.decision.behavior
        : j.hookSpecificOutput.permissionDecision;
      assert.equal(verdict, 'deny', `${hookEvent} ${JSON.stringify(result)} must deny`);
    }
  }
});

test('parse carries the hook event through so render picks the right shape', () => {
  const payload = (event) => JSON.stringify({
    session_id: 's', cwd: dir, hook_event_name: event,
    tool_name: 'Read', tool_input: { file_path: 'C:/elsewhere/secrets.txt' },
  });
  assert.equal(claudeAdapter.parse(payload('PermissionRequest')).action.hookEvent, 'PermissionRequest');
  assert.equal(claudeAdapter.parse(payload('PreToolUse')).action.hookEvent, 'PreToolUse');
  // Missing event defaults to PreToolUse rather than throwing.
  const noEvent = JSON.stringify({ cwd: dir, tool_name: 'Read', tool_input: {} });
  assert.equal(claudeAdapter.parse(noEvent).action.hookEvent, 'PreToolUse');
});
