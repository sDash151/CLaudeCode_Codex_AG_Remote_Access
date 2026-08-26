#!/usr/bin/env node
'use strict';
/**
 * agw — control surface for the Agent Approval Gateway.
 *
 *   agw start [--foreground]      Start the gateway
 *   agw stop                      Stop it (denying anything still pending)
 *   agw status                    Show gateway + hook + device state
 *   agw pair                      Mint a one-time pairing code for the phone
 *   agw devices                   List paired devices
 *   agw revoke <deviceId|--all>   Revoke device access
 *   agw install-hooks [...]       Install the PreToolUse hooks
 *   agw uninstall-hooks [...]     Remove them
 *   agw simulate <agent> ...      Drive one fake request end-to-end
 *   agw history [--limit N]       Print the audit log
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  loadConfig,
  saveConfig,
  loadRuntime,
  clearRuntime,
  PATHS,
} = require('../core/config');
const { AuditLog } = require('../core/audit');
const { DeviceRegistry } = require('../core/devices');

const claudeInstall = require('../adapters/claude/install');
const codexInstall = require('../adapters/codex/install');
const antigravityInstall = require('../adapters/antigravity/install');

const argv = process.argv.slice(2);
const cmd = (argv[0] || 'help').toLowerCase();

function flag(name, fallback = undefined) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) return true;
  return next;
}

function ok(msg) { console.log('  ' + msg); }
function head(msg) { console.log('\n' + msg); }
function warn(msg) { console.log('  ! ' + msg); }

/* ------------------------------------------------------------------- start -- */

async function start() {
  const existing = loadRuntime();
  if (existing && isAlive(existing.pid)) {
    console.log(`Gateway already running (pid ${existing.pid}) on port ${existing.port}.`);
    return;
  }
  if (existing) clearRuntime();

  const foreground = Boolean(flag('foreground', false));

  if (!foreground) {
    // Detach so closing the terminal does not kill the gateway.
    const logFile = path.join(PATHS().home, 'gateway.log');
    fs.mkdirSync(PATHS().home, { recursive: true });
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [__filename, 'start', '--foreground'], {
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    });
    child.unref();
    // Wait briefly and confirm it actually bound, rather than claiming success.
    const cfg = loadConfig();
    const started = await waitForPing(cfg, 8000);
    if (started) {
      const rt = loadRuntime();
      console.log(`Gateway started (pid ${rt ? rt.pid : child.pid}) on http://${cfg.bindHost}:${rt ? rt.port : cfg.port}`);
      console.log(`Logs: ${logFile}`);
    } else {
      console.error('Gateway did not come up. Check the log:');
      console.error('  ' + logFile);
      process.exitCode = 1;
    }
    return;
  }

  const { Gateway } = require('../server/gateway');
  const cfg = loadConfig();
  const gw = new Gateway({ config: cfg });
  const addr = await gw.listen();
  console.log(`[agw] listening on http://${cfg.bindHost}:${addr.port}`);

  const shutdown = async (signal) => {
    console.log(`[agw] ${signal} — denying pending requests and shutting down`);
    try { await gw.close(); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function ping(cfg, port) {
  return new Promise((resolve) => {
    const http = require('node:http');
    const req = http.request(
      {
        host: cfg.bindHost,
        port: port || cfg.port,
        path: '/agent/ping',
        method: 'GET',
        headers: { 'x-agw-agent-secret': cfg.agentSecret },
        timeout: 2000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function waitForPing(cfg, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const rt = loadRuntime();
    if (rt && (await ping(cfg, rt.port))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* -------------------------------------------------------------------- stop -- */

async function stop() {
  const rt = loadRuntime();
  if (!rt) {
    console.log('Gateway is not running (no runtime file).');
    return;
  }
  if (!isAlive(rt.pid)) {
    console.log(`Gateway pid ${rt.pid} is not alive; clearing stale runtime file.`);
    clearRuntime();
    return;
  }
  try {
    process.kill(rt.pid, 'SIGTERM');
  } catch (err) {
    console.error(`Could not signal pid ${rt.pid}: ${err.message}`);
  }
  // Windows does not deliver SIGTERM the way POSIX does; fall back to taskkill.
  for (let i = 0; i < 20; i++) {
    if (!isAlive(rt.pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (isAlive(rt.pid) && process.platform === 'win32') {
    await new Promise((resolve) => {
      const p = spawn('taskkill', ['/PID', String(rt.pid), '/T', '/F'], { stdio: 'ignore' });
      p.on('exit', resolve);
      p.on('error', resolve);
    });
  }
  clearRuntime();
  console.log(isAlive(rt.pid) ? `Gateway pid ${rt.pid} still running.` : 'Gateway stopped.');
}

/* ------------------------------------------------------------------ status -- */

async function status() {
  const cfg = loadConfig();
  const rt = loadRuntime();

  head('Gateway');
  if (rt && isAlive(rt.pid)) {
    const alive = await ping(cfg, rt.port);
    ok(`running   pid ${rt.pid}, http://${cfg.bindHost}:${rt.port} ${alive ? '(responding)' : '(NOT responding)'}`);
    ok(`started   ${rt.startedAt}`);
  } else {
    ok('stopped');
  }
  ok(`home      ${PATHS().home}`);
  ok(`gate      requests at or above ${cfg.gateMinRisk} (HIGH always gated)`);
  ok(`ttl       ${Math.round(cfg.requestTtlMs / 1000)}s per request, agent waits ${Math.round(cfg.agentWaitMs / 1000)}s`);
  ok(`origin    ${cfg.publicOrigin || '(not set — run: agw set-origin https://host.ts.net)'}`);

  head('Hooks');
  const cs = claudeInstall.status({ scope: 'user' });
  ok(`claude       ${cs.installed ? 'installed' : 'NOT installed'}  ${cs.path}`);
  if (cs.events && cs.events.length) ok(`             events: ${cs.events.join(', ')}`);
  if (cs.walkaway) ok('             walk-away ACTIVE — every prompt routes to your phone');
  if (cs.installed && !cs.walkaway) {
    warn('             PermissionRequest hook missing — the laptop can still prompt.');
    warn('             fix:  agw install-hooks --agent claude');
  }
  if (cs.staleAllowRules && cs.staleAllowRules.length) {
    warn(`             stale pre-approvals with no hook: ${cs.staleAllowRules.join(', ')}`);
    warn('             fix:  agw uninstall-hooks --agent claude');
  }
  const codexStatus = await codexInstall.status({ cwd: process.cwd() });
  const codexBin = codexInstall.findCodexBinary();
  ok(
    `codex        ${codexStatus.installed ? 'installed' : 'NOT installed'}` +
      `  trust=${codexStatus.trustStatus || 'unknown'}  ${codexStatus.path}`
  );
  if (codexStatus.error) warn(`codex query failed: ${codexStatus.error}`);
  if (!codexBin) warn('codex binary not found');
  const ag = antigravityInstall.status({ projectDir: flag('project') || process.cwd() });
  ok(`antigravity  ${ag.installed ? 'installed' : 'NOT installed'}  ${ag.path || '(per project)'}`);
  for (const i of ag.installs) {
    ok(`  ${i.label.padEnd(16)} ${i.installed ? 'found' : 'not found'}`);
  }

  head('Devices');
  const audit = new AuditLog(PATHS().audit);
  const devices = new DeviceRegistry({ audit, config: cfg });
  const list = devices.list();
  if (!list.length) ok('none paired — run: agw pair');
  for (const d of list) {
    ok(
      `${d.deviceId}  ${String(d.label).padEnd(12)} ` +
        `${d.revokedAt ? 'REVOKED' : 'active'}  push=${d.hasPush ? 'yes' : 'no'}  ` +
        `expires ${new Date(d.expiresAt).toISOString().slice(0, 10)}`
    );
  }
  console.log('');
}

/* -------------------------------------------------------------------- pair -- */

function pair() {
  const cfg = loadConfig();
  const audit = new AuditLog(PATHS().audit);
  const devices = new DeviceRegistry({ audit, config: cfg });
  const { code, expiresAt } = devices.createPairingCode();
  const origin = cfg.publicOrigin || `http://${cfg.bindHost}:${cfg.port}`;
  const mins = Math.round((expiresAt - Date.now()) / 60000);

  console.log('');
  console.log('  Pairing code:  ' + code);
  console.log('  Valid for:     ' + mins + ' minutes, single use');
  console.log('');
  console.log('  On the iPhone, open:  ' + origin);
  console.log('  Enter the code, then Share -> Add to Home Screen for notifications.');
  console.log('');
  if (!cfg.publicOrigin) {
    console.log('  Note: publicOrigin is not set, so the URL above only works on this machine.');
    console.log('        Set it once Tailscale Serve is running:');
    console.log('          agw set-origin https://<your-host>.<tailnet>.ts.net');
    console.log('');
  }
}

function devicesCmd() {
  const cfg = loadConfig();
  const audit = new AuditLog(PATHS().audit);
  const registry = new DeviceRegistry({ audit, config: cfg });
  console.log(JSON.stringify(registry.list(), null, 2));
}

function revoke() {
  const cfg = loadConfig();
  const audit = new AuditLog(PATHS().audit);
  const registry = new DeviceRegistry({ audit, config: cfg });
  if (flag('all', false) === true) {
    const n = registry.revokeAll('cli');
    console.log(`Revoked ${n} device(s).`);
    return;
  }
  const id = argv[1];
  if (!id) {
    console.error('Usage: agw revoke <deviceId> | agw revoke --all');
    process.exitCode = 1;
    return;
  }
  console.log(registry.revoke(id, 'cli') ? `Revoked ${id}.` : `No active device ${id}.`);
}

function setOrigin() {
  const origin = argv[1];
  if (!origin || !/^https?:\/\//.test(origin)) {
    console.error('Usage: agw set-origin https://host.tailnet.ts.net');
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig();
  cfg.publicOrigin = origin.replace(/\/+$/, '');
  saveConfig(cfg);
  console.log('publicOrigin = ' + cfg.publicOrigin);
  console.log('Restart the gateway for the change to take effect: agw stop && agw start');
}

/* ------------------------------------------------------------------- hooks -- */

async function installHooks() {
  const only = flag('agent');
  const project = flag('project');
  const force = flag('force', false) === true;
  const want = (id) => only === undefined || only === true || String(only).toLowerCase() === id;

  // Installing a gate before anything can answer it makes every gated tool call
  // fail. That is safe, but it will look like your agent is broken — so require
  // an explicit --force rather than letting it happen by surprise.
  const cfg = loadConfig();
  const registry = new DeviceRegistry({ audit: new AuditLog(PATHS().audit), config: cfg });
  const active = registry.list().filter((d) => !d.revokedAt && Date.now() < d.expiresAt);
  if (!active.length && !force) {
    console.log('');
    console.log('  No phone is paired yet, so nothing could approve a request.');
    console.log('  Every gated tool call would be denied, in every agent.');
    console.log('');
    console.log('  Do this first:');
    console.log('    node src/cli/agw.js pair');
    console.log('');
    console.log('  Or install anyway (all gated calls will be denied until you pair):');
    console.log('    node src/cli/agw.js install-hooks --force');
    console.log('');
    console.log('  To undo an install at any time:');
    console.log('    node src/cli/agw.js uninstall-hooks');
    console.log('');
    process.exitCode = 1;
    return;
  }

  head('Installing hooks');
  if (!active.length) {
    warn('No paired device. Gated calls will be DENIED until you run `agw pair`.');
  }

  if (want('claude')) {
    try {
      const r = claudeInstall.install({
        scope: project ? 'project' : 'user',
        projectDir: project && project !== true ? project : null,
        walkaway: flag('no-walkaway', false) !== true,
      });
      ok(`claude       ${r.action}  ${r.path}`);
      ok(`             hooks: ${r.events.join(' + ')} (matcher: all tools)`);
      if (r.walkaway) {
        ok('             LOW risk runs automatically; MEDIUM/HIGH go to your phone');
        ok('             PermissionRequest catches every other prompt, including');
        ok('             files outside the project — nothing blocks on the laptop');
      } else {
        warn('             --no-walkaway: laptop prompts are still possible');
      }
      ok('             restart Claude Code — hooks load at session start');
    } catch (err) {
      warn(`claude       FAILED: ${err.message}`);
    }
  }

  if (want('codex')) {
    try {
      const r = await codexInstall.install({ cwd: process.cwd() });
      ok(`codex        installed  ${r.hooksJson}`);
      ok(`             trust: ${r.trusted ? 'GRANTED' : 'NOT granted'}${r.key ? '  key=' + r.key : ''}`);
      for (const n of r.notes) warn('             ' + n);
    } catch (err) {
      warn(`codex        FAILED: ${err.message}`);
    }
  }

  if (want('antigravity')) {
    const dir = project && project !== true ? project : null;
    if (!dir) {
      warn('antigravity  skipped — needs an explicit project:');
      warn('             agw install-hooks --agent antigravity --project "E:\\ALL PROJECTS\\LevelUP"');
    } else {
      try {
        const r = antigravityInstall.install({ projectDir: dir });
        ok(`antigravity  ${r.action}  ${r.path}`);
        ok('             restart Antigravity so it re-reads .agents/hooks.json');
      } catch (err) {
        warn(`antigravity  FAILED: ${err.message}`);
      }
    }
  }
  console.log('');
}

function uninstallHooks() {
  const only = flag('agent');
  const project = flag('project');
  const want = (id) => only === undefined || only === true || String(only).toLowerCase() === id;
  head('Removing hooks');
  if (want('claude')) {
    const r = claudeInstall.uninstall({
      scope: project ? 'project' : 'user',
      projectDir: project && project !== true ? project : null,
    });
    ok(`claude       ${r.action}  ${r.path}`);
    if (r.clearedEvents && r.clearedEvents.length) {
      ok(`             removed from: ${r.clearedEvents.join(', ')}`);
    }
    if (r.removedAllow && r.removedAllow.length) {
      ok(`             cleared stale pre-approvals: ${r.removedAllow.join(', ')}`);
    }
  }
  if (want('codex')) {
    const r = codexInstall.uninstall();
    ok(`codex        ${r.removed ? 'removed' : 'absent'}  ${r.hooksJson}`);
  }
  if (want('antigravity') && project && project !== true) {
    const r = antigravityInstall.uninstall({ projectDir: project });
    ok(`antigravity  ${r.action}  ${r.path}`);
  }
  console.log('');
}

/* ---------------------------------------------------------------- simulate -- */

/**
 * Feed a synthetic hook payload through the real hook script, exactly as the
 * agent would. Used by the test suite and for manual end-to-end checks.
 */
function simulate() {
  const agent = (argv[1] || '').toLowerCase();
  if (!['claude', 'codex', 'antigravity'].includes(agent)) {
    console.error('Usage: agw simulate <claude|codex|antigravity> --command "git push" [--cwd DIR]');
    process.exitCode = 1;
    return;
  }
  const command = flag('command', 'git push origin main');
  const cwd = flag('cwd', process.cwd());
  const tool = flag('tool', 'Bash');

  const payload = {
    session_id: 'sim_' + Date.now(),
    transcript_path: null,
    cwd: cwd === true ? process.cwd() : cwd,
    hook_event_name: 'PreToolUse',
    permission_mode: 'default',
    tool_name: tool === true ? 'Bash' : tool,
    tool_input: { command: command === true ? 'git push origin main' : command },
    tool_use_id: 'sim_call_' + Date.now(),
  };

  const hook = path.resolve(__dirname, '..', 'adapters', 'hook.js');
  const child = spawn(process.execPath, [hook, agent], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('exit', (code) => {
    console.log('\n--- hook stdout ---');
    console.log(out || '(empty)');
    if (err.trim()) {
      console.log('--- hook stderr ---');
      console.log(err.trim());
    }
    console.log('--- exit code: ' + code + ' ---');
    let verdict = 'PROCEED (no decision returned)';
    try {
      const j = JSON.parse(out);
      const d = j?.hookSpecificOutput?.permissionDecision;
      if (d === 'deny') verdict = 'DENIED';
      else if (d === 'allow') verdict = 'APPROVED';
    } catch {
      if (code !== 0) verdict = 'DENIED (non-zero exit)';
    }
    console.log('Result: ' + verdict + '\n');
  });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
}

function history() {
  const limit = Number(flag('limit', 50)) || 50;
  const audit = new AuditLog(PATHS().audit);
  for (const e of audit.tail(limit).reverse()) {
    const bits = [
      e.ts,
      e.event.padEnd(22),
      e.agent || '',
      e.risk || '',
      e.deviceLabel || '',
      e.command || e.reason || '',
    ];
    console.log(bits.filter(Boolean).join('  '));
  }
}

function help() {
  console.log(`
Agent Approval Gateway

  agw start [--foreground]        Start the gateway (detached by default)
  agw stop                        Stop it; anything pending is DENIED
  agw status [--project DIR]      Gateway, hook and device state
  agw pair                        Mint a one-time pairing code
  agw devices                     List paired devices
  agw revoke <id> | --all         Revoke device access
  agw set-origin <https://...>    Set the public HTTPS origin (Tailscale)
  agw install-hooks   [--agent claude|codex|antigravity] [--project DIR]
  agw uninstall-hooks [--agent ...] [--project DIR]
  agw simulate <agent> --command "..."   Drive one request end-to-end
  agw selftest <agent> [--approve]       Verify a live agent integration
  agw history [--limit N]         Print the audit log

Data lives in ${PATHS().home}
`);
}

(async () => {
  switch (cmd) {
    case 'start': return start();
    case 'stop': return stop();
    case 'status': return status();
    case 'pair': return pair();
    case 'devices': return devicesCmd();
    case 'revoke': return revoke();
    case 'set-origin': return setOrigin();
    case 'install-hooks': return installHooks();
    case 'uninstall-hooks': return uninstallHooks();
    case 'simulate': return simulate();
    case 'selftest': {
      const agent = (argv[1] || '').toLowerCase();
      if (!['claude', 'codex', 'antigravity'].includes(agent)) {
        console.error('Usage: agw selftest <claude|codex|antigravity> [--approve]');
        process.exitCode = 1;
        return undefined;
      }
      const { selftest } = require('./selftest');
      process.exitCode = await selftest(agent, { approve: flag('approve', false) === true });
      return undefined;
    }
    case 'history': return history();
    default: return help();
  }
})().catch((err) => {
  console.error('agw: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
