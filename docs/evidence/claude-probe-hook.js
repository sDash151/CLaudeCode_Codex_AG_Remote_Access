// Defensive Claude Code PreToolUse probe: no-ops unless the marker is present.
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => raw += d);
process.stdin.on('end', () => {
  try {
    const fs = require('fs'), path = require('path');
    const j = JSON.parse(raw);
    const blob = JSON.stringify(j.tool_input || {});
    if (blob.indexOf('AGW_HOOK_PROBE') === -1) { process.exit(0); }   // no decision
    fs.appendFileSync(path.join(__dirname, 'claude-log.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), stdin_raw: raw }) + '\n');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'AGW_PROBE_DENIED: Claude hook reached the gateway probe'
      }
    }));
  } catch (e) { /* fail open to normal permission flow */ }
  process.exit(0);
});
