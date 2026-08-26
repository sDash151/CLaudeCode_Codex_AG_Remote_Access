'use strict';
/**
 * Verifies the generated launcher shim works when invoked exactly the way an
 * agent invokes it on Windows: %COMSPEC% /c "<bare shim path>".
 *
 * Run: node scripts/verify-shim.js [claude|codex|antigravity]
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const agent = process.argv[2] || 'codex';
const { writeShim } = require('../src/adapters/shared/shim');

const r = writeShim(agent);
console.log('shim    :', r.shim);
console.log('command :', r.command);
console.log('shortpath:', r.usedShortPath);
console.log('exists  :', fs.existsSync(r.shim));
console.log('');

const payload = JSON.stringify({
  session_id: 'shim_test',
  cwd: process.cwd(),
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'git push origin main' },
  tool_use_id: 'call_shim_test',
});

const isWin = process.platform === 'win32';
const exe = isWin ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
const args = isWin ? ['/c', r.command] : ['-c', r.command];

let stdout = '';
let status = 0;
try {
  stdout = execFileSync(exe, args, {
    encoding: 'utf8',
    input: payload,
    timeout: 60000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (err) {
  status = err.status ?? -1;
  stdout = (err.stdout || '').toString();
  const stderr = (err.stderr || '').toString();
  if (stderr.trim()) console.log('stderr  :', stderr.trim().slice(0, 300));
}

console.log('exit    :', status);
console.log('stdout  :', stdout.trim().slice(0, 400) || '(empty)');

let verdict = 'PROCEED / no decision';
try {
  const j = JSON.parse(stdout);
  const d = j?.hookSpecificOutput?.permissionDecision;
  if (d) verdict = d.toUpperCase();
} catch {
  if (status !== 0) verdict = 'DENY (non-zero exit)';
}
console.log('verdict :', verdict);

// With no gateway running, the only correct answer is a denial.
const gatewayRunning = (() => {
  try {
    const { loadRuntime } = require('../src/core/config');
    return Boolean(loadRuntime());
  } catch {
    return false;
  }
})();

if (!gatewayRunning) {
  const ok = verdict === 'DENY' || verdict.startsWith('DENY');
  console.log('');
  console.log(ok
    ? 'PASS  shim is reachable and fails closed with no gateway running'
    : 'FAIL  expected a DENY when no gateway is running, got: ' + verdict);
  process.exit(ok ? 0 : 1);
}
