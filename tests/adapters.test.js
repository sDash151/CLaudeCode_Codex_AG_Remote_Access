'use strict';
/**
 * Adapter tests: parsing each agent's real payload shape, and rendering
 * decisions in each agent's dialect.
 *
 * The rendering assertions encode what was actually observed on this machine:
 *   - Claude Code accepts allow/deny.
 *   - Codex accepts ONLY deny (with a non-empty reason); an approval must be
 *     expressed as silence, because "allow" is rejected as unsupported.
 *   - Antigravity blocks on a non-zero exit and carries a reason.
 */
const test = require('node:test');
const assert = require('node:assert');

const claude = require('../src/adapters/claude/adapter');
const codex = require('../src/adapters/codex/adapter');
const antigravity = require('../src/adapters/antigravity/adapter');
const { getAdapter, listAdapters } = require('../src/adapters/index');

/* ------------------------------------------------------------- registry -- */

test('all three agents are registered and agent-agnostic in shape', () => {
  const ids = listAdapters().map((a) => a.id).sort();
  assert.deepEqual(ids, ['antigravity', 'claude', 'codex']);
  for (const a of listAdapters()) {
    assert.equal(typeof a.parse, 'function');
    assert.equal(typeof a.render, 'function');
    assert.ok(a.displayName, `${a.id} needs a display name for the phone`);
  }
});

test('unknown agent ids are rejected', () => {
  assert.throws(() => getAdapter('cursor'), /Unknown agent adapter/);
  assert.throws(() => getAdapter(''), /Unknown agent adapter/);
});

test('display names identify the originating agent for the notification', () => {
  assert.equal(claude.displayName, 'Claude Code');
  assert.equal(codex.displayName, 'Codex');
  assert.equal(antigravity.displayName, 'Antigravity');
});

/* --------------------------------------------------------------- Claude -- */

// Captured from the official PreToolUse contract.
const CLAUDE_PAYLOAD = JSON.stringify({
  session_id: 'abc123',
  prompt_id: '550e8400-e29b-41d4-a716-446655440000',
  transcript_path: 'C:\\Users\\me\\.claude\\projects\\x\\t.jsonl',
  cwd: 'E:\\ALL PROJECTS\\LevelUP',
  permission_mode: 'default',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'git push origin main', description: 'push' },
  tool_use_id: 'toolu_01ABC123',
});

test('claude: parses the documented PreToolUse payload', () => {
  const out = claude.parse(CLAUDE_PAYLOAD);
  assert.equal(out.ok, true);
  assert.equal(out.action.agent, 'claude');
  assert.equal(out.action.tool, 'Bash');
  assert.equal(out.action.command, 'git push origin main');
  assert.equal(out.action.cwd, 'E:\\ALL PROJECTS\\LevelUP');
  assert.equal(out.action.sessionId, 'abc123');
  assert.equal(out.action.toolUseId, 'toolu_01ABC123');
  assert.equal(out.action.summary, 'git push origin main');
});

test('claude: extracts file paths from write-style tools', () => {
  const out = claude.parse(JSON.stringify({
    cwd: 'E:/p', hook_event_name: 'PreToolUse', tool_name: 'Edit',
    tool_input: { file_path: 'E:/p/src/app.ts', old_string: 'a', new_string: 'b' },
  }));
  assert.deepEqual(out.action.paths, ['E:/p/src/app.ts']);
  assert.equal(out.action.command, null);
});

test('claude: malformed payloads fail closed at parse time', () => {
  for (const bad of ['', 'not json', '[]', 'null']) {
    const out = claude.parse(bad);
    assert.equal(out.ok, false, `${JSON.stringify(bad)} must not parse`);
    assert.ok(out.error);
  }
});

test('claude: approval renders permissionDecision allow', () => {
  const out = claude.render({ approved: true, reason: 'Approved from iPhone' });
  const j = JSON.parse(out.stdout);
  assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(j.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(j.hookSpecificOutput.permissionDecisionReason, 'Approved from iPhone');
  assert.equal(out.exitCode, 0);
});

test('claude: denial renders permissionDecision deny with a reason', () => {
  const out = claude.render({ approved: false, reason: 'Denied from iPhone' });
  const j = JSON.parse(out.stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(j.hookSpecificOutput.permissionDecisionReason, 'Denied from iPhone');
});

test('claude: anything that is not an explicit approval renders deny', () => {
  for (const result of [
    {},
    { approved: false },
    { approved: 'true' },       // string, not boolean
    { approved: 1 },            // truthy but not true
    { approved: null },
    { status: 'expired' },
  ]) {
    const j = JSON.parse(claude.render(result).stdout);
    assert.equal(
      j.hookSpecificOutput.permissionDecision, 'deny',
      `${JSON.stringify(result)} must render as deny`
    );
  }
});

test('claude: passthrough auto-ALLOWS so no local prompt can block walk-away', () => {
  // Silence would mean "no decision", which sends the call into Claude's normal
  // permission flow and pops a prompt on the laptop. For Claude, LOW-risk
  // passthrough must be an explicit allow. Codex and Antigravity differ — see
  // their own tests below.
  const out = claude.render({ mode: 'passthrough', approved: false });
  assert.notEqual(out.stdout, '', 'must not be silent');
  const j = JSON.parse(out.stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(out.exitCode, 0);
});

/* ---------------------------------------------------------------- Codex -- */

// Captured live from codex-cli 0.148.0-alpha.15 on this machine.
const CODEX_PAYLOAD = JSON.stringify({
  session_id: '01a0367e-923a-7452-a0e8-0112d7800b4c',
  turn_id: '01a0367e-92d9-7f40-a9d2-732e9f9458c8',
  transcript_path: 'C:\\Users\\USER\\.codex\\sessions\\2026\\08\\25\\rollout-x.jsonl',
  cwd: 'E:\\ALL PROJECTS\\CLaudeCode_Codex_AG_Remote_Access\\_probe',
  hook_event_name: 'PreToolUse',
  model: 'gpt-5.6-sol',
  permission_mode: 'bypassPermissions',
  tool_name: 'Bash',
  tool_input: { command: 'echo HELLO_HOOK_PROBE3' },
  tool_use_id: 'call_B8RzDlhwAaVldBUybibBeauc',
});

test('codex: parses the payload captured from the real CLI', () => {
  const out = codex.parse(CODEX_PAYLOAD);
  assert.equal(out.ok, true);
  assert.equal(out.action.agent, 'codex');
  assert.equal(out.action.tool, 'Bash');
  assert.equal(out.action.command, 'echo HELLO_HOOK_PROBE3');
  assert.equal(out.action.sessionId, '01a0367e-923a-7452-a0e8-0112d7800b4c');
  assert.equal(out.action.turnId, '01a0367e-92d9-7f40-a9d2-732e9f9458c8');
  assert.equal(out.action.toolUseId, 'call_B8RzDlhwAaVldBUybibBeauc');
  assert.equal(out.action.permissionMode, 'bypassPermissions');
});

test('codex: accepts an argv-array command', () => {
  const out = codex.parse(JSON.stringify({
    cwd: 'E:/p', tool_name: 'Bash', tool_input: { command: ['git', 'push', 'origin', 'main'] },
  }));
  assert.equal(out.action.command, 'git push origin main');
});

test('codex: denial renders deny with a NON-EMPTY reason (Codex rejects empty)', () => {
  const out = codex.render({ approved: false, reason: '' });
  const j = JSON.parse(out.stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(
    j.hookSpecificOutput.permissionDecisionReason.length > 0,
    'Codex errors with "deny without a non-empty permissionDecisionReason"'
  );
});

test('codex: approval renders SILENCE, because Codex rejects permissionDecision allow', () => {
  const out = codex.render({ approved: true, reason: 'Approved from iPhone' });
  assert.equal(out.stdout, '', 'must not emit allow — Codex reports it as unsupported');
  assert.equal(out.exitCode, 0);
  // Guard against a regression that starts emitting "allow".
  assert.ok(!out.stdout.includes('allow'));
});

test('codex: passthrough is also silence', () => {
  const out = codex.render({ mode: 'passthrough', approved: false });
  assert.equal(out.stdout, '');
  assert.equal(out.exitCode, 0);
});

test('codex: every non-approval renders an enforceable deny', () => {
  for (const result of [{}, { approved: false }, { approved: 'yes' }, { status: 'expired' }]) {
    const out = codex.render(result);
    const j = JSON.parse(out.stdout);
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(j.hookSpecificOutput.permissionDecisionReason);
  }
});

/* ---------------------------------------------------------- Antigravity -- */

test('antigravity: parses a snake_case payload', () => {
  const out = antigravity.parse(JSON.stringify({
    session_id: 'ag_1', cwd: 'E:/proj/LevelUP',
    tool_name: 'run_command', tool_input: { command: 'npm run deploy' },
  }));
  assert.equal(out.ok, true);
  assert.equal(out.action.agent, 'antigravity');
  assert.equal(out.action.command, 'npm run deploy');
  assert.equal(out.action.sessionId, 'ag_1');
});

test('antigravity: tolerates camelCase and alternative field names', () => {
  const out = antigravity.parse(JSON.stringify({
    conversationId: 'c1', workspaceRoot: 'E:/proj/X',
    toolName: 'terminal', args: { cmd: 'git push' }, toolUseId: 'tc_9',
  }));
  assert.equal(out.action.command, 'git push');
  assert.equal(out.action.cwd, 'E:/proj/X');
  assert.equal(out.action.sessionId, 'c1');
  assert.equal(out.action.toolUseId, 'tc_9');
});

test('antigravity: denial exits non-zero and supplies a reason both ways', () => {
  const out = antigravity.render({ approved: false, reason: 'Denied from iPhone' });
  assert.equal(out.exitCode, 2, 'non-zero exit is the load-bearing block signal');
  assert.equal(out.stderr, 'Denied from iPhone');
  const j = JSON.parse(out.stdout);
  assert.equal(j.blocked, true);
  assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
});

test('antigravity: approval exits 0 with no output', () => {
  const out = antigravity.render({ approved: true, reason: 'ok' });
  assert.equal(out.exitCode, 0);
  assert.equal(out.stdout, '');
});

test('antigravity: every non-approval blocks', () => {
  for (const result of [{}, { approved: false }, { approved: 'true' }, { status: 'denied' }]) {
    assert.equal(antigravity.render(result).exitCode, 2, `${JSON.stringify(result)} must block`);
  }
});

/* ------------------------------------------------- cross-agent uniformity -- */

test('all adapters produce the same normalised action shape', () => {
  const cases = [
    [claude, JSON.stringify({ cwd: 'E:/p', tool_name: 'Bash', tool_input: { command: 'git push' }, session_id: 's' })],
    [codex, JSON.stringify({ cwd: 'E:/p', tool_name: 'Bash', tool_input: { command: 'git push' }, session_id: 's' })],
    [antigravity, JSON.stringify({ cwd: 'E:/p', tool_name: 'Bash', tool_input: { command: 'git push' }, session_id: 's' })],
  ];
  const required = ['agent', 'tool', 'command', 'paths', 'cwd', 'project', 'sessionId', 'summary'];
  for (const [adapter, payload] of cases) {
    const out = adapter.parse(payload);
    assert.equal(out.ok, true, `${adapter.id} should parse`);
    for (const key of required) {
      assert.ok(key in out.action, `${adapter.id} action is missing ${key}`);
    }
    assert.equal(out.action.command, 'git push');
  }
});

test('all adapters fail closed on unparseable input', () => {
  for (const adapter of [claude, codex, antigravity]) {
    const out = adapter.parse('{{{');
    assert.equal(out.ok, false, `${adapter.id} must not accept garbage`);
  }
});
