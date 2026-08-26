'use strict';
/**
 * Codex CLI adapter.
 *
 * Integration point: Codex's `PreToolUse` hook.
 *   config: %CODEX_HOME%\hooks.json   (default ~/.codex/hooks.json)
 *   trust:  ~/.codex/config.toml -> [hooks.state.'<key>'] { enabled, trusted_hash }
 *   input:  JSON on stdin (same field names as Claude Code)
 *   output: JSON on stdout with hookSpecificOutput.permissionDecision
 *
 * VERIFIED LIVE on this machine (codex-cli 0.148.0-alpha.15):
 *   - Hooks are discovered only from $CODEX_HOME/hooks.json. A hooks/ directory
 *     and project-level .codex/hooks.json were NOT discovered.
 *   - A discovered hook is inert until it is trusted. `hooks/list` reports
 *     trustStatus "untrusted", and untrusted hooks never execute.
 *   - Trust is granted by adding, to config.toml:
 *         [hooks.state.'<sourcePath>:<event_snake_case>:<group>:<handler>']
 *         enabled = true
 *         trusted_hash = "<currentHash reported by hooks/list>"
 *     The hash covers the handler definition only, so writing the state block
 *     does not invalidate it.
 *   - Once trusted, the hook fires and Codex reports:
 *         "Command blocked by the PreToolUse hook: <reason>"
 *
 * IMPORTANT ASYMMETRY, confirmed from Codex's own error strings:
 *     "PreToolUse hook returned unsupported permissionDecision:allow"
 *     "PreToolUse hook returned unsupported permissionDecision:ask"
 *     "PreToolUse hook returned unsupported decision:approve"
 *   Codex accepts ONLY permissionDecision "deny", and requires a non-empty
 *   permissionDecisionReason. There is no way for a hook to grant permission.
 *
 * Therefore an approval is expressed as *silence*: exit 0 with no output, which
 * Codex treats as "no decision" and continues through its normal permission
 * flow. A denial is expressed as an explicit deny, which Codex enforces.
 * This keeps the gate fail-closed: the only thing the hook can do decisively
 * is stop the command.
 */
const { pathsFromToolInput, projectNameFor, summarise } = require('../shared/hook-client');

const id = 'codex';
const displayName = 'Codex';

function parse(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Could not parse Codex hook payload as JSON' };
  }
  // Arrays and null are typeof 'object' too, so check the shape explicitly.
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    return { ok: false, error: 'Codex hook payload was not a JSON object' };
  }

  const toolInput = j.tool_input && typeof j.tool_input === 'object' ? j.tool_input : {};
  // Codex sends a string command for Bash-like tools; it may also send argv.
  let command = null;
  if (typeof toolInput.command === 'string') command = toolInput.command;
  else if (Array.isArray(toolInput.command)) command = toolInput.command.join(' ');

  const paths = pathsFromToolInput(toolInput);
  const cwd = j.cwd || null;

  return {
    ok: true,
    action: {
      agent: id,
      tool: j.tool_name || null,
      command,
      paths,
      cwd,
      project: projectNameFor(cwd),
      // Codex supplies both a session id and a turn id; the session is the
      // stable process identifier.
      sessionId: j.session_id || null,
      turnId: j.turn_id || null,
      toolUseId: j.tool_use_id || null,
      permissionMode: j.permission_mode || null,
      summary: summarise({ tool: j.tool_name, command, paths }),
    },
  };
}

function render(result) {
  // Passthrough and approval are both "no decision" for Codex, because Codex
  // cannot be told to allow. See the header comment.
  if (result.mode === 'passthrough' || result.approved === true) {
    return { stdout: '', exitCode: 0 };
  }

  // Codex rejects a deny with an empty reason, so always supply one.
  const reason = result.reason && String(result.reason).trim()
    ? String(result.reason).trim()
    : 'Denied by remote approval gateway';

  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
    exitCode: 0,
  };
}

module.exports = { id, displayName, parse, render };
