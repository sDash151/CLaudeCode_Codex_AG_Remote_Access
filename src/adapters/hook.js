'use strict';
/**
 * Unified hook entry point. All three agents invoke this same script:
 *
 *   node src/adapters/hook.js <claude|codex|antigravity>
 *
 * Responsibilities, in order:
 *   1. Read the agent's hook payload from stdin.
 *   2. Ask the adapter to normalise it.
 *   3. Ask the gateway for a decision (blocking).
 *   4. Ask the adapter to render the decision in that agent's dialect.
 *
 * FAIL-CLOSED CONTRACT: every error path in this file ends in a denial. There
 * is no branch that emits an approval without the gateway having returned
 * `approved: true`. If this file throws, the catch-all handler still denies.
 */
const { getAdapter } = require('./index');
const { requestApproval, readStdin } = require('./shared/hook-client');
const { loadConfig, loadRuntime } = require('../core/config');

async function main() {
  const agentId = (process.argv[2] || '').toLowerCase();

  // Which event fired. Declared up front because every failure path below needs
  // it: PermissionRequest ignores exit code 2 and honours only its decision
  // object, so answering it in the PreToolUse shape would silently fail to deny.
  let hookEvent = 'PreToolUse';

  // `--home <dir>` pins which gateway this hook talks to. The generated shims
  // also set AGW_HOME, but accepting it as an argument means the hook works even
  // when an agent strips the environment.
  const homeIdx = process.argv.indexOf('--home');
  if (homeIdx !== -1 && process.argv[homeIdx + 1]) {
    process.env.AGW_HOME = process.argv[homeIdx + 1];
  }

  let adapter;
  try {
    adapter = getAdapter(agentId);
  } catch {
    // We do not know which agent called us, so we cannot speak its dialect.
    // Emit a denial in the Claude/Codex shape and a non-zero exit for
    // Antigravity — the union is understood by all three.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'Approval gateway misconfigured: hook invoked without a valid agent id',
        },
      })
    );
    process.exitCode = 2;
    return;
  }

  const emit = (result) => {
    const out = adapter.render(result);
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr + '\n');
    process.exitCode = out.exitCode || 0;
  };

  let raw = '';
  try {
    raw = await readStdin();
  } catch {
    return emit({ approved: false, reason: 'Could not read hook payload — denying by default', hookEvent });
  }

  // Sniff the event before parsing so even a malformed payload is answered in
  // the correct shape. Stashed in the environment so the top-level catch can see
  // it too, since a throw may happen before `hookEvent` is in scope there.
  if (/"hook_event_name"\s*:\s*"PermissionRequest"/.test(raw)) hookEvent = 'PermissionRequest';
  process.env.AGW_LAST_RAW = raw.slice(0, 2000);

  const parsed = adapter.parse(raw);
  if (!parsed.ok) {
    return emit({ approved: false, reason: `${parsed.error} — denying by default`, hookEvent });
  }

  // Let the adapter's own view of the event win once parsing succeeded.
  if (parsed.action.hookEvent) hookEvent = parsed.action.hookEvent;

  let config;
  let runtime;
  try {
    config = loadConfig();
    runtime = loadRuntime();
  } catch (err) {
    return emit({
      approved: false,
      reason: `Approval gateway config unreadable (${err.code || err.message}) — denying by default`,
      hookEvent,
    });
  }

  // Prefer the port the running gateway actually bound, falling back to config.
  const port = (runtime && runtime.port) || config.port;
  const host = (runtime && runtime.bindHost) || config.bindHost;

  const result = await requestApproval({
    host,
    port,
    secret: config.agentSecret,
    payload: parsed.action,
    // Give up slightly after the gateway's own wait window so the gateway is
    // the component that decides, not our socket timeout.
    timeoutMs: (config.agentWaitMs || 240000) + 15000,
  });

  emit({ ...result, hookEvent });
}

main().catch((err) => {
  // Last line of defence. Any unexpected throw is still a denial.
  //
  // We may not know which event fired, so emit BOTH decision shapes' fields in
  // one object: PreToolUse reads permissionDecision, PermissionRequest reads
  // decision.behavior. Each ignores the other's field.
  const reason = `Approval gateway hook failed (${
    err && err.message ? err.message : 'unknown error'
  }) — denying by default`;
  try {
    const isPermReq = /"hook_event_name"\s*:\s*"PermissionRequest"/.test(process.env.AGW_LAST_RAW || '');
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: isPermReq
          ? { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: reason, interrupt: false } }
          : { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      })
    );
  } catch {
    /* stdout is gone; the non-zero exit below is the remaining signal */
  }
  process.exitCode = 2;
});
