'use strict';
/**
 * Claude Code adapter.
 *
 * Integration point: the documented `PreToolUse` hook.
 *   config: ~/.claude/settings.json  (or .claude/settings.json per project)
 *   input:  JSON on stdin
 *   output: JSON on stdout with hookSpecificOutput.permissionDecision
 *
 * Verified on this machine (Claude Code 2.1.229, desktop app):
 *   - claude.exe honours `--settings` hook config and fires hooks with the
 *     documented payload (confirmed live via SessionStart).
 *   - Claude Code supports permissionDecision "allow", "deny" and "ask".
 *   - Exit 0 with no output means "no decision": the normal permission flow
 *     applies. Silence is NOT approval.
 *
 * Because Claude supports "allow", a remote approval here fully satisfies the
 * permission request without a second local prompt.
 */
const { pathsFromToolInput, projectNameFor, summarise } = require('../shared/hook-client');

const id = 'claude';
const displayName = 'Claude Code';

/**
 * @param {string} raw  hook stdin
 * @returns {{ok: true, action: object} | {ok: false, error: string}}
 */
function parse(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Could not parse Claude Code hook payload as JSON' };
  }
  // Arrays and null are typeof 'object' too, so check the shape explicitly.
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    return { ok: false, error: 'Claude Code hook payload was not a JSON object' };
  }

  const toolInput = j.tool_input && typeof j.tool_input === 'object' ? j.tool_input : {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : null;
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
      sessionId: j.session_id || null,
      toolUseId: j.tool_use_id || null,
      permissionMode: j.permission_mode || null,
      // Which hook fired. PermissionRequest needs a different output shape, and
      // it means Claude was about to show a local prompt — so it must never be
      // answered with silence.
      hookEvent: j.hook_event_name || 'PreToolUse',
      summary: summarise({ tool: j.tool_name, command, paths }),
    },
  };
}

/**
 * Translate a gateway result into Claude Code's hook output.
 *
 * Two output shapes, because the two events disagree:
 *
 *   PreToolUse        -> hookSpecificOutput.permissionDecision: allow | deny
 *   PermissionRequest -> hookSpecificOutput.decision.behavior:  allow | deny
 *                        (exit code 2 is NOT honoured for this event; the
 *                         decision object is the only way to deny)
 *
 * Passthrough is rendered as an explicit `allow` rather than silence. Silence
 * means "no decision", which sends the call into Claude's normal permission flow
 * and pops a prompt on the laptop — fatal for walk-away operation. LOW-risk
 * actions are therefore auto-allowed here, which is the documented intent of
 * the gating threshold.
 *
 * @param {object} result
 * @param {boolean} result.approved
 * @param {string} result.reason
 * @param {string} [result.mode]      'passthrough' when below the gate threshold.
 * @param {string} [result.hookEvent] 'PreToolUse' | 'PermissionRequest'
 * @returns {{stdout: string, exitCode: number}}
 */
function render(result) {
  const isPermissionRequest = result.hookEvent === 'PermissionRequest';
  const allow = result.mode === 'passthrough' || result.approved === true;
  const reason = allow
    ? result.reason || 'Approved remotely from paired device'
    : result.reason || 'Denied by remote approval gateway';

  if (isPermissionRequest) {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: allow
            ? { behavior: 'allow' }
            // interrupt:false so a denial stops this one call without aborting
            // the whole turn — the agent can report and move on.
            : { behavior: 'deny', message: reason, interrupt: false },
        },
      }),
      exitCode: 0,
    };
  }

  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: allow ? 'allow' : 'deny',
        permissionDecisionReason: reason,
      },
    }),
    exitCode: 0,
  };
}

module.exports = { id, displayName, parse, render };
