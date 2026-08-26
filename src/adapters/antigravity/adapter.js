'use strict';
/**
 * Antigravity adapter (covers both Antigravity 2.0 and Antigravity IDE).
 *
 * Integration point: Antigravity's pre-tool hook.
 *   config: <project>/.agents/hooks.json  with a "PreToolUse" array
 *   input:  JSON on stdin
 *   output: exit code decides; a reason is surfaced to the agent
 *
 * WHAT WAS ACTUALLY OBSERVED on this machine (evidence in docs/FINDINGS.md):
 *   - Both installs ship the same Go language server, which contains:
 *       ".agents/hooks.json", "\"PreToolUse\": [", "\"PostToolUse\": ["
 *       PreToolHook, PreToolHookArgs, PreToolHookResult, PreToolHookNames,
 *       PreToolHookDeniedError
 *       json tags: blocked, exit_code, stdout, stderr, timed_out, duration_ms
 *       format string: "Tool call denied by pre-tool hook: %s"
 *     So Antigravity has an enforced pre-tool hook that can deny a tool call
 *     and carry a reason.
 *   - Antigravity does NOT contain the Claude/Codex decision field names
 *     (no permissionDecision, no hookSpecificOutput, no hook_event_name), so
 *     its output convention is different: a non-zero exit blocks, and the
 *     reason comes from the hook's output.
 *   - It also supports MCP servers (mcp_config.json: mcpServers, command/args/
 *     env/serverUrl) and command allowlist/denylist, but neither of those is an
 *     approval interception point.
 *
 * BECAUSE the precise output convention is not publicly documented, `render`
 * deliberately emits BOTH conventions at once on a denial:
 *   - a non-zero exit code (the signal implied by exit_code/blocked), and
 *   - a human reason on stderr AND a Claude-style JSON decision on stdout.
 * Whichever convention Antigravity reads, it sees a denial. An approval is the
 * unambiguous "no objection" signal: exit 0 with no output.
 *
 * LIMITATION: this adapter is written to the observed contract but the live
 * approval flow has NOT been exercised, because Antigravity's agent runs inside
 * the IDE and cannot be driven from a script. `agw selftest antigravity`
 * verifies it in one step; see README "Verifying Antigravity".
 */
const { pathsFromToolInput, projectNameFor, summarise } = require('../shared/hook-client');

const id = 'antigravity';
const displayName = 'Antigravity';

function parse(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Could not parse Antigravity hook payload as JSON' };
  }
  // Arrays and null are typeof 'object' too, so check the shape explicitly.
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    return { ok: false, error: 'Antigravity hook payload was not a JSON object' };
  }

  // Accept several plausible field spellings rather than assuming one shape.
  const toolInput =
    (j.tool_input && typeof j.tool_input === 'object' && j.tool_input) ||
    (j.toolInput && typeof j.toolInput === 'object' && j.toolInput) ||
    (j.args && typeof j.args === 'object' && j.args) ||
    {};

  let command = null;
  for (const key of ['command', 'cmd', 'command_line', 'commandLine', 'shell_command']) {
    const v = toolInput[key] ?? j[key];
    if (typeof v === 'string' && v) {
      command = v;
      break;
    }
    if (Array.isArray(v) && v.length) {
      command = v.join(' ');
      break;
    }
  }

  const paths = pathsFromToolInput(toolInput);
  const cwd = j.cwd || j.workspace_root || j.workspaceRoot || toolInput.cwd || null;
  const tool = j.tool_name || j.toolName || j.tool || null;

  return {
    ok: true,
    action: {
      agent: id,
      tool,
      command,
      paths,
      cwd,
      project: projectNameFor(cwd),
      sessionId:
        j.session_id || j.sessionId || j.conversation_id || j.conversationId || j.trajectory_id || null,
      toolUseId: j.tool_use_id || j.toolUseId || j.tool_call_id || j.call_id || null,
      summary: summarise({ tool, command, paths }),
    },
  };
}

function render(result) {
  if (result.mode === 'passthrough' || result.approved === true) {
    // No objection. Antigravity proceeds under its own rules.
    return { stdout: '', exitCode: 0 };
  }

  const reason = result.reason && String(result.reason).trim()
    ? String(result.reason).trim()
    : 'Denied by remote approval gateway';

  return {
    // Emit the structured form too, in case Antigravity parses stdout JSON.
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
      blocked: true,
      reason,
    }),
    stderr: reason,
    // Non-zero exit is the load-bearing signal for Antigravity.
    exitCode: 2,
  };
}

module.exports = { id, displayName, parse, render };
