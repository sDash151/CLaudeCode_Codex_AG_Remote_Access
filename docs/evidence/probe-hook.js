// Probe hook: records the exact stdin payload each agent sends, then DENIES.
const fs = require('fs');
const path = require('path');
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => raw += d);
process.stdin.on('end', () => {
  const label = process.argv[2] || 'probe';
  const out = path.join(__dirname, label + '-log.jsonl');
  fs.appendFileSync(out, JSON.stringify({
    at: new Date().toISOString(),
    argv: process.argv.slice(2),
    env_hook: Object.keys(process.env).filter(k => /HOOK|CLAUDE|CODEX/i.test(k)).reduce((a,k)=>(a[k]=process.env[k],a),{}),
    stdin_raw: raw
  }) + '\n');
  let decision = 'deny', reason = 'PROBE_HOOK_DENIED: remote-approval probe';
  try {
    const j = JSON.parse(raw);
    const cmd = JSON.stringify(j.tool_input || {});
    if (cmd.includes('ALLOWME')) { decision = 'allow'; reason = 'PROBE_HOOK_ALLOWED: explicit probe approval'; }
  } catch {}
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason
    }
  }));
  process.exit(0);
});
