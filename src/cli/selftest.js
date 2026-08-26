'use strict';
/**
 * `agw selftest <agent>` — verify a live agent integration in one step.
 *
 * Exists because Claude Code and Antigravity cannot be driven from a script the
 * way `codex exec` can: Claude Code reads hook config only at session start, and
 * Antigravity's agent runs inside the IDE. So the loop is: this command watches
 * the gateway, you ask the agent to run a marker command, and this reports
 * exactly what the gateway saw and what it told the agent.
 *
 * By default the request is DENIED, because a denial is the safe outcome to
 * rehearse and it proves the enforcement path. Pass --approve to test the other
 * direction.
 */
const { loadConfig, loadRuntime, PATHS } = require('../core/config');
const { AuditLog } = require('../core/audit');
const { DeviceRegistry } = require('../core/devices');

const AGENT_LABELS = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

const MARKER = 'AGW_SELFTEST';

function httpJson({ port, method = 'GET', path: p, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: p,
        method,
        headers: Object.assign(
          payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
          headers
        ),
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {'claude'|'codex'|'antigravity'} agent
 * @param {{approve?: boolean, timeoutMs?: number}} opts
 */
async function selftest(agent, opts = {}) {
  const label = AGENT_LABELS[agent] || agent;
  const decision = opts.approve ? 'approve' : 'deny';
  const timeoutMs = opts.timeoutMs || 300000;

  const rt = loadRuntime();
  if (!rt) {
    console.error('The gateway is not running. Start it first:  agw start');
    return 2;
  }
  const cfg = loadConfig();
  const port = rt.port;

  // Use a real device token so the decision goes through the same authenticated
  // path the phone uses.
  const registry = new DeviceRegistry({ audit: new AuditLog(PATHS().audit), config: cfg });
  const { code } = registry.createPairingCode();
  const paired = await httpJson({
    port, method: 'POST', path: '/api/pair', body: { code, label: 'selftest' },
  });
  if (paired.status !== 200) {
    console.error('Could not create a self-test device session:', paired.status, paired.body);
    return 2;
  }
  const token = paired.body.token;

  // Must be a command the gateway actually gates. `echo` classifies LOW, which
  // passes through at the default MEDIUM threshold, so the self-test would sit
  // there waiting for a request that never arrives. `npm install --dry-run`
  // is MEDIUM and changes nothing on disk.
  const cmd = 'npm install --dry-run left-pad';

  console.log('');
  console.log(`  Self-test: ${label}`);
  console.log(`  Watching the gateway on port ${port} for up to ${Math.round(timeoutMs / 1000)}s.`);
  console.log('');
  console.log('  Now do this in ' + label + ':');
  if (agent === 'claude') {
    console.log('    1. Start a NEW Claude Code session (hook config is read at session start).');
    console.log(`    2. Ask it:  run the bash command: ${cmd}`);
  } else if (agent === 'codex') {
    console.log(`    1. Run:  codex exec "Run exactly this shell command and nothing else: ${cmd}"`);
  } else {
    console.log('    1. Restart Antigravity so it re-reads .agents/hooks.json.');
    console.log('    2. Open the project you installed the hook into.');
    console.log(`    3. Ask the agent:  run the terminal command: ${cmd}`);
  }
  console.log('');
  console.log(`  When the request arrives this self-test will ${decision.toUpperCase()} it.`);
  console.log('  Waiting…');
  console.log('');

  const deadline = Date.now() + timeoutMs;
  let seen = null;
  while (Date.now() < deadline) {
    const res = await httpJson({
      port, path: '/api/pending', headers: { authorization: 'Bearer ' + token },
    });
    const pending = (res.body && res.body.pending) || [];
    const match = pending.find((r) => r.agent === agent);
    if (match) {
      seen = match;
      console.log('  REQUEST RECEIVED');
      console.log('    agent    : ' + match.agent + '  (' + label + ')');
      console.log('    command  : ' + match.command);
      console.log('    tool     : ' + match.tool);
      console.log('    project  : ' + match.project);
      console.log('    folder   : ' + match.cwd);
      console.log('    risk     : ' + match.risk + '  (' + (match.riskReasons || []).join('; ') + ')');
      console.log('    session  : ' + match.sessionId);
      console.log('    requestId: ' + match.id);
      const out = await httpJson({
        port, method: 'POST', path: '/api/decide',
        headers: { authorization: 'Bearer ' + token },
        body: { requestId: match.id, nonce: match.nonce, decision },
      });
      console.log('');
      console.log(`  Decision sent: ${decision.toUpperCase()} -> HTTP ${out.status} (${out.body && out.body.status})`);
      break;
    }
    await sleep(300);
  }

  // Revoke the temporary session so it cannot be reused.
  const mine = registry.list().find((d) => d.label === 'selftest' && !d.revokedAt);
  if (mine) {
    await httpJson({
      port, method: 'POST', path: '/api/devices/revoke',
      headers: { authorization: 'Bearer ' + token },
      body: { deviceId: mine.deviceId },
    });
  }

  console.log('');
  if (!seen) {
    console.log('  RESULT: no request arrived.');
    console.log('');
    console.log('  Things to check:');
    console.log('    - `agw status` shows the hook installed for ' + agent);
    if (agent === 'claude') console.log('    - you started a NEW Claude Code session after installing');
    if (agent === 'codex') console.log('    - `agw status` shows codex trust=trusted');
    if (agent === 'antigravity') {
      console.log('    - you installed into the project you actually opened:');
      console.log('        agw install-hooks --agent antigravity --project "<that folder>"');
      console.log('    - you restarted Antigravity afterwards');
    }
    console.log('    - the command you asked for is gated: risk >= ' + cfg.gateMinRisk);
    console.log('      (`echo` is LOW; set gateMinRisk to LOW in ' + PATHS().config + ' to gate it)');
    return 1;
  }

  console.log(`  RESULT: ${label} integration is working.`);
  console.log(`  The agent should now report that the command was ${decision === 'deny' ? 'blocked' : 'allowed'}.`);
  console.log('  Confirm that in the agent, then check:  agw history --limit 5');
  return 0;
}

module.exports = { selftest, MARKER };
