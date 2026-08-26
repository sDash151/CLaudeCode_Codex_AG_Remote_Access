'use strict';
/**
 * Risk classification. Agent-agnostic: operates on a normalised action, never
 * on a specific CLI's payload shape.
 *
 * Ordering matters: HIGH patterns are tested first and win. A command that
 * looks LOW but also matches a HIGH pattern is HIGH.
 */
const path = require('node:path');

const RISK = Object.freeze({ LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' });

/** Numeric ordering so callers can compare thresholds. */
const RISK_ORDER = Object.freeze({ LOW: 0, MEDIUM: 1, HIGH: 2 });

/**
 * HIGH: destructive, irreversible, or production-affecting.
 * Each entry documents *why* so the phone can show a reason.
 */
const HIGH_PATTERNS = [
  [/\bprisma\s+migrate\s+(deploy|reset)\b/i, 'Prisma migration against a real database'],
  [/\b(migrate|migration)s?\s+(deploy|run|up|reset|fresh)\b/i, 'Database migration'],
  [/\b(alembic|flyway|liquibase|knex|sequelize|typeorm|drizzle-kit)\b.*\b(migrate|migration|up|deploy|push)\b/i, 'Database migration'],
  [/\bdrizzle-kit\s+push\b/i, 'Database schema push'],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, 'Destructive SQL'],
  [/\bdb\s+(push|reset|drop)\b/i, 'Destructive database operation'],
  [/\bmongo(sh)?\b.*\bdrop\b/i, 'MongoDB drop'],

  [/\bgit\s+push\b/i, 'Publishes commits to a remote'],
  [/\bgit\s+push\b.*\s(-f|--force|--force-with-lease)\b/i, 'Force push rewrites remote history'],
  [/\bgit\s+reset\s+--hard\b/i, 'Discards local work irreversibly'],
  [/\bgit\s+clean\s+-[a-z]*f/i, 'Deletes untracked files'],
  [/\bgit\s+(branch|tag)\s+-D\b/i, 'Deletes a branch or tag'],
  [/\bgit\s+filter-(branch|repo)\b/i, 'Rewrites repository history'],

  [/\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, 'Recursive/forced delete'],
  [/\brmdir\s+\/s\b/i, 'Recursive directory delete'],
  [/\bRemove-Item\b.*-Recurse\b/i, 'Recursive delete (PowerShell)'],
  [/\bdel\s+\/[sq]\b/i, 'Forced delete (cmd)'],
  [/\b(mkfs|fdisk|diskpart|format)\b/i, 'Disk-level operation'],
  [/\bdd\s+if=/i, 'Raw disk write'],
  [/>\s*\/dev\/(sd|nvme|disk)/i, 'Raw device write'],

  [/\b(kubectl|helm)\b.*\b(delete|uninstall)\b/i, 'Deletes cluster resources'],
  [/\bkubectl\s+apply\b.*\b(prod|production)\b/i, 'Applies to production cluster'],
  [/\bterraform\s+(apply|destroy)\b/i, 'Infrastructure change'],
  [/\b(vercel|netlify|fly|railway|heroku)\b.*\b(deploy|release)\b/i, 'Deployment'],
  [/\bnpm\s+publish\b/i, 'Publishes a package'],
  [/\b(docker|podman)\s+(system\s+prune|volume\s+rm)\b/i, 'Removes container volumes/data'],
  [/\baws\s+s3\s+(rb|rm)\b/i, 'Deletes S3 data'],
  [/\bgh\s+release\s+create\b/i, 'Publishes a release'],
  [/\b(shutdown|reboot|Stop-Computer|Restart-Computer)\b/i, 'Machine power state change'],
  [/\bcurl\b[^|]*\|\s*(ba)?sh\b/i, 'Pipes remote script straight into a shell'],
  [/\biwr\b[^|]*\|\s*iex\b/i, 'Pipes remote script into PowerShell'],
  [/\.env\.production\b/i, 'Production configuration'],
  [/\bNODE_ENV\s*=\s*production\b/i, 'Production configuration'],
];

/** MEDIUM: mutates the workspace or dependency tree, but recoverable. */
const MEDIUM_PATTERNS = [
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|up|update|upgrade)\b/i, 'Changes installed dependencies'],
  [/\b(pip|pip3|uv|poetry|pipenv)\s+(install|uninstall|add|remove|sync)\b/i, 'Changes installed dependencies'],
  [/\b(cargo|go|gem|composer|brew|choco|scoop|winget|apt|apt-get|dnf|yum|pacman)\s+(install|add|get|remove|uninstall|update|upgrade)\b/i, 'Changes installed software'],
  [/\bgit\s+(commit|merge|rebase|cherry-pick|revert|stash\s+drop|checkout\s+-b|switch\s+-c)\b/i, 'Changes repository state'],
  [/\bgit\s+(add|restore|checkout)\b/i, 'Changes working tree or index'],
  [/\bnpx\s+/i, 'Executes an arbitrary package'],
  [/\b(chmod|chown|icacls|takeown)\b/i, 'Changes permissions/ownership'],
  [/\b(mv|move|cp|copy|Move-Item|Copy-Item)\b/i, 'Moves or overwrites files'],
  [/\b(systemctl|sc\.exe|net\s+(start|stop)|Start-Service|Stop-Service)\b/i, 'Changes a service'],
  [/\b(docker|podman)\s+(run|compose|build|up)\b/i, 'Runs or builds containers'],
  [/\bprisma\s+(generate|db\s+seed)\b/i, 'Regenerates client / seeds data'],
  [/\bssh\b|\bscp\b|\brsync\b/i, 'Remote machine access'],
  [/\b(tsc|eslint)\b.*--fix\b/i, 'Rewrites source files'],
  [/\b(\.env|config\.(json|ya?ml|toml)|settings\.json|Dockerfile|docker-compose)\b/i, 'Modifies configuration'],
];

/** LOW: read-only or clearly non-destructive. Used only as a positive signal. */
const LOW_PATTERNS = [
  /\b(ls|dir|pwd|cat|type|head|tail|less|more|wc|find|grep|rg|fd|tree|stat|file|which|where)\b/i,
  /\bgit\s+(status|diff|log|show|branch|remote\s+-v|describe|blame|fetch)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(test|run\s+(test|lint|build|typecheck)|ls|list|outdated|why)\b/i,
  /\b(pytest|jest|vitest|mocha|go\s+test|cargo\s+(test|check|build)|mvn\s+test|gradle\s+test)\b/i,
  /\b(tsc|eslint|prettier|ruff|flake8|mypy|black\s+--check)\b/i,
  /\b(node|python|python3)\s+--version\b/i,
  /\becho\b/i,
];

/**
 * Tool names that never touch the machine destructively regardless of input.
 * Keyed on the normalised tool name each adapter reports.
 */
const READ_ONLY_TOOLS = new Set([
  'read', 'glob', 'grep', 'notebookread', 'todowrite', 'taskcreate', 'tasklist',
  'taskget', 'webfetch', 'websearch', 'ls', 'view', 'search', 'list_files',
]);

/** Tools that write files: at least MEDIUM. */
const WRITE_TOOLS = new Set(['write', 'edit', 'notebookedit', 'multiedit', 'apply_patch', 'applypatch', 'create_file', 'replace']);

/**
 * Paths that look like credential material. Reading one of these from outside
 * the project is treated as HIGH, because that is how a secret leaves the
 * machine: an agent reads it, and it lands in a transcript.
 */
const SECRET_PATH_PATTERNS = [
  /\.env(\.|$)/i,
  /credentials?(\.|$)/i,
  /\bauth\.json\b/i,
  /\bid_rsa\b|\bid_ed25519\b|\.pem$|\.pfx$|\.p12$/i,
  /\.ssh[/\\]/i,
  /\.aws[/\\]/i,
  /\.kube[/\\]/i,
  /\.npmrc$|\.pypirc$|\.netrc$/i,
  /\.codex[/\\]|\.claude[/\\]|\.gemini[/\\]/i,
  /secret|token|apikey|api_key|password/i,
];

/**
 * Which of `paths` fall outside `cwd`.
 *
 * This exists because Claude Code asks before touching a file outside the
 * working directory, and a hook that answers "allow" suppresses that prompt.
 * Auto-allowing a read because the *tool* is read-only removed a real guardrail
 * — an out-of-project read pulled a live API key into a transcript. Reading
 * outside the project is exceptional, so it must be gated, not assumed safe.
 */
function pathsOutside(paths, cwd) {
  if (!cwd || !Array.isArray(paths) || !paths.length) return [];
  let root;
  try {
    root = path.resolve(cwd);
  } catch {
    return [];
  }
  const out = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    let resolved;
    try {
      resolved = path.resolve(root, p);
    } catch {
      // Unresolvable path — treat as outside rather than assuming safe.
      out.push(p);
      continue;
    }
    const inside = resolved === root || resolved.startsWith(root + path.sep);
    if (!inside) out.push(p);
  }
  return out;
}

/**
 * Classify a normalised action.
 *
 * @param {object} action
 * @param {string} [action.tool]     Normalised tool name (e.g. "Bash", "Write").
 * @param {string} [action.command]  Full command line, when the tool runs a shell command.
 * @param {string[]} [action.paths]  File paths the action targets.
 * @param {string} [action.cwd]      Project root, used to detect out-of-project access.
 * @returns {{risk: 'LOW'|'MEDIUM'|'HIGH', reasons: string[]}}
 */
function classify(action = {}) {
  const tool = String(action.tool || '').toLowerCase();
  const command = String(action.command || '');
  const paths = Array.isArray(action.paths) ? action.paths : [];
  // Include paths so that e.g. editing .env.production is caught even when
  // the tool is Write rather than Bash.
  const subject = [command, ...paths].filter(Boolean).join(' ');
  const reasons = [];

  for (const [re, why] of HIGH_PATTERNS) {
    if (re.test(subject)) reasons.push(why);
  }
  if (reasons.length) return { risk: RISK.HIGH, reasons: dedupe(reasons) };

  // Checked before the read-only shortcut: a read is only cheap if it stays
  // inside the project.
  const outside = pathsOutside(paths, action.cwd);
  if (outside.length) {
    const secret = outside.some((p) => SECRET_PATH_PATTERNS.some((re) => re.test(p)));
    const label = `Accesses a path outside the project: ${outside.join(', ')}`;
    if (secret) {
      return { risk: RISK.HIGH, reasons: [label, 'Path looks like credential material'] };
    }
    reasons.push(label);
  }

  if (!outside.length && READ_ONLY_TOOLS.has(tool) && !command) {
    return { risk: RISK.LOW, reasons: ['Read-only tool'] };
  }

  for (const [re, why] of MEDIUM_PATTERNS) {
    if (re.test(subject)) reasons.push(why);
  }
  if (WRITE_TOOLS.has(tool)) reasons.push('Writes to a file');
  if (reasons.length) return { risk: RISK.MEDIUM, reasons: dedupe(reasons) };

  if (subject && LOW_PATTERNS.some((re) => re.test(subject))) {
    return { risk: RISK.LOW, reasons: ['Read-only or non-destructive command'] };
  }

  // Unrecognised commands are NOT assumed safe. An unknown shell command gets
  // MEDIUM so it still requires an explicit decision.
  if (command) return { risk: RISK.MEDIUM, reasons: ['Unrecognised command — treated as not-safe by default'] };
  if (tool) return { risk: RISK.LOW, reasons: ['Non-command tool with no shell action'] };
  return { risk: RISK.MEDIUM, reasons: ['Unclassifiable action — treated as not-safe by default'] };
}

function dedupe(arr) {
  return [...new Set(arr)];
}

/** True when `risk` is at or above `threshold`. */
function atOrAbove(risk, threshold) {
  return (RISK_ORDER[risk] ?? 1) >= (RISK_ORDER[threshold] ?? 1);
}

module.exports = { RISK, RISK_ORDER, classify, atOrAbove };
