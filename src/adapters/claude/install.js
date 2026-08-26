'use strict';
/**
 * Claude Code hook installer.
 *
 * Writes a PreToolUse hook into ~/.claude/settings.json (or a project's
 * .claude/settings.json). Uses the *exec form* (`command` + `args`) so the
 * absolute path — which contains spaces on this machine — is passed verbatim
 * and never re-parsed by a shell.
 *
 * The matcher covers the tools that can change the machine. Read-only tools are
 * deliberately not matched, so the gateway is not consulted for them at all.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_ENTRY_MARKER = 'agent-approval-gateway';

/**
 * Walk-away operation needs TWO hooks, on every tool.
 *
 *   PreToolUse        fires before every tool call. LOW risk is auto-allowed so
 *                     ordinary work never stops; MEDIUM/HIGH goes to the phone.
 *   PermissionRequest fires whenever Claude Code is about to ask a human for a
 *                     permission decision — including cases PreToolUse does not
 *                     settle, such as reading a file outside the project. This is
 *                     the catch-all that keeps the laptop from becoming a second
 *                     gate.
 *
 * Matcher is `*` on both: any tool that can interrupt autonomous work must be
 * remotely resolvable, not just Bash and the editors.
 *
 * What this deliberately does NOT do:
 *   - It does not set permissions.defaultMode = bypassPermissions. That needs a
 *     second dangerous opt-in (the CLI calls it "requires
 *     allowDangerouslySkipPermissions"), silently falls back to Manual without
 *     it, and would disable every check rather than routing it.
 *   - It does not pre-approve tools via permissions.allow. Routing each decision
 *     is more precise than blanket-approving a tool name.
 *   - Explicit `deny` and `ask` rules still override a hook allow, so
 *     project-specific safety rules keep working.
 */
const HOOK_EVENTS = ['PreToolUse', 'PermissionRequest'];
const MATCHER_ALL = '*';

/** Legacy matcher from the pre-walk-away version; still removed on uninstall. */
const MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit';

function hookScriptPath() {
  return path.resolve(__dirname, '..', '..', 'adapters', 'hook.js');
}

function settingsPath(scope, projectDir) {
  if (scope === 'project') {
    if (!projectDir) throw new Error('projectDir is required for project scope');
    return path.join(projectDir, '.claude', 'settings.json');
  }
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function buildHandler() {
  return {
    type: 'command',
    command: process.execPath, // absolute path to this node binary
    args: [hookScriptPath(), 'claude'],
    timeout: 300,
    statusMessage: 'Waiting for remote approval…',
    // Marker so we can find and remove exactly our entry later.
    _source: HOOK_ENTRY_MARKER,
  };
}

/** Remove every handler we own from one event array, returning what is left. */
function stripOurs(groups) {
  if (!Array.isArray(groups)) return { groups: [], removed: 0 };
  let removed = 0;
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) continue;
    const before = g.hooks.length;
    g.hooks = g.hooks.filter((h) => !(h && h._source === HOOK_ENTRY_MARKER));
    removed += before - g.hooks.length;
  }
  return { groups: groups.filter((g) => g && Array.isArray(g.hooks) && g.hooks.length), removed };
}

/**
 * @param {object} [opts]
 * @param {'user'|'project'} [opts.scope]
 * @param {string|null} [opts.projectDir]
 * @param {boolean} [opts.walkaway] Install the PermissionRequest catch-all too,
 *   so no local prompt can block. Default true.
 * @returns {{path: string, action: string, walkaway: boolean, events: string[]}}
 */
function install({ scope = 'user', projectDir = null, walkaway = true } = {}) {
  const file = settingsPath(scope, projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`${file} is not valid JSON — refusing to overwrite it (${err.message})`);
    }
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

  // PermissionRequest is what makes walk-away work; without it the laptop is
  // still a gate for anything PreToolUse does not settle.
  const events = walkaway ? HOOK_EVENTS : ['PreToolUse'];

  for (const event of events) {
    const cleaned = stripOurs(settings.hooks[event]);
    cleaned.groups.push({ matcher: MATCHER_ALL, hooks: [buildHandler()] });
    settings.hooks[event] = cleaned.groups;
  }

  // If dropping back to PreToolUse-only, clear a previously installed catch-all
  // rather than leaving a stale one behind.
  if (!walkaway && settings.hooks.PermissionRequest) {
    const cleaned = stripOurs(settings.hooks.PermissionRequest);
    if (cleaned.groups.length) settings.hooks.PermissionRequest = cleaned.groups;
    else delete settings.hooks.PermissionRequest;
  }

  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return { path: file, action: 'installed', walkaway: Boolean(walkaway), events };
}

function uninstall({ scope = 'user', projectDir = null } = {}) {
  const file = settingsPath(scope, projectDir);
  if (!fs.existsSync(file)) return { path: file, action: 'absent' };
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { path: file, action: 'unparseable' };
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') return { path: file, action: 'absent' };

  let removed = 0;
  const clearedEvents = [];
  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) continue;
    const cleaned = stripOurs(settings.hooks[event]);
    removed += cleaned.removed;
    if (cleaned.removed) clearedEvents.push(event);
    // Drop the event key only if nothing of the user's is left in it.
    if (cleaned.groups.length) settings.hooks[event] = cleaned.groups;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;

  // Clean up leftovers from the abandoned pre-approval approach, so an upgrade
  // from that version cannot leave tools silently pre-approved with no hook.
  let removedAllow = [];
  if (Array.isArray(settings._agwAddedAllowRules) && settings.permissions) {
    const ours = new Set(settings._agwAddedAllowRules);
    if (Array.isArray(settings.permissions.allow)) {
      settings.permissions.allow = settings.permissions.allow.filter((r) => !ours.has(r));
      removedAllow = [...ours];
      if (!settings.permissions.allow.length) delete settings.permissions.allow;
    }
    delete settings._agwAddedAllowRules;
    if (!Object.keys(settings.permissions).length) delete settings.permissions;
  }

  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { path: file, action: removed ? 'removed' : 'absent', removed, clearedEvents, removedAllow };
}

function status({ scope = 'user', projectDir = null } = {}) {
  const file = settingsPath(scope, projectDir);
  if (!fs.existsSync(file)) return { path: file, installed: false, reason: 'settings file missing' };
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    const has = (event) =>
      (settings?.hooks?.[event] || []).some(
        (g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => h && h._source === HOOK_ENTRY_MARKER)
      );
    const preToolUse = has('PreToolUse');
    const permissionRequest = has('PermissionRequest');
    const allow = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
    return {
      path: file,
      installed: preToolUse,
      events: HOOK_EVENTS.filter(has),
      // Walk-away needs BOTH: PreToolUse to route tool calls, and
      // PermissionRequest so nothing else can pop a local prompt.
      walkaway: preToolUse && permissionRequest,
      permissionRequestHook: permissionRequest,
      defaultMode: settings?.permissions?.defaultMode || '(unset)',
      // Leftover pre-approvals from the abandoned approach, with no hook to gate.
      staleAllowRules: !preToolUse && Array.isArray(settings._agwAddedAllowRules)
        ? settings._agwAddedAllowRules.filter((r) => allow.includes(r))
        : [],
    };
  } catch (err) {
    return { path: file, installed: false, reason: 'settings file is not valid JSON' };
  }
}

module.exports = {
  install,
  uninstall,
  status,
  settingsPath,
  MATCHER,
  MATCHER_ALL,
  HOOK_EVENTS,
  hookScriptPath,
};
