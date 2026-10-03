'use strict';
/**
 * Shared helpers for all three adapters: project naming, path extraction, and
 * the localhost HTTP call from a hook process to the gateway.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/**
 * Derive a human project name from a working directory.
 * Walks up looking for a repo/package marker so that a hook fired deep inside
 * a monorepo still reports the project the user recognises.
 */
function projectNameFor(cwd) {
  if (!cwd) return null;
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  let fallback = path.basename(dir) || null;
  for (let i = 0; i < 40; i++) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return path.basename(dir);
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg)) {
        try {
          const name = JSON.parse(fs.readFileSync(pkg, 'utf8')).name;
          if (name) return String(name);
        } catch {
          /* unparseable package.json — fall back to the directory name */
        }
        return path.basename(dir);
      }
    } catch {
      /* unreadable directory — stop walking */
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }
  return fallback;
}

/** Pull likely file paths out of a tool input object. */
function pathsFromToolInput(input = {}) {
  const keys = ['file_path', 'filePath', 'path', 'notebook_path', 'target_file', 'file'];
  const out = [];
  for (const k of keys) {
    if (typeof input[k] === 'string' && input[k]) out.push(input[k]);
  }
  if (Array.isArray(input.paths)) out.push(...input.paths.filter((p) => typeof p === 'string'));
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (e && typeof e.file_path === 'string') out.push(e.file_path);
    }
  }
  return [...new Set(out)];
}

/**
 * Build a one-line human summary of an action.
 */
function summarise({ tool, command, paths }) {
  if (command) return command.length > 400 ? command.slice(0, 400) + ' …' : command;
  if (paths && paths.length) return `${tool || 'Tool'}: ${paths.join(', ')}`;
  return tool || 'Unknown action';
}

/**
 * Generate a human-readable description of what the tool is doing.
 */
function describeAction({ tool, command, paths }) {
  const t = String(tool || '').toLowerCase();
  
  // File operations
  if (t === 'edit' || t === 'write' || t === 'multiedit' || t === 'replace') {
    return 'Edit a file';
  }
  if (t === 'read' || t === 'view' || t === 'glob') {
    return 'Read a file';
  }
  if (t === 'create_file') {
    return 'Create a new file';
  }
  if (t === 'list_files' || t === 'ls') {
    return 'List files';
  }
  if (t === 'search' || t === 'grep') {
    return 'Search in files';
  }
  
  // Shell commands
  if (t === 'bash' || t === 'shell' || t === 'run_command' || t === 'execute') {
    if (!command) return 'Run a shell command';
    const cmd = command.toLowerCase();
    
    // Git operations
    if (/\bgit\s+push\b/.test(cmd)) return 'Push to Git remote';
    if (/\bgit\s+pull\b/.test(cmd)) return 'Pull from Git remote';
    if (/\bgit\s+commit\b/.test(cmd)) return 'Create a Git commit';
    if (/\bgit\s+merge\b/.test(cmd)) return 'Merge Git branches';
    if (/\bgit\s+checkout\b/.test(cmd)) return 'Switch Git branch';
    if (/\bgit\s+reset\b/.test(cmd)) return 'Reset Git state';
    if (/\bgit\s+rebase\b/.test(cmd)) return 'Rebase Git history';
    if (/\bgit\s+status\b/.test(cmd)) return 'Check Git status';
    if (/\bgit\s+(diff|log|show)\b/.test(cmd)) return 'View Git history';
    if (/\bgit\b/.test(cmd)) return 'Run Git command';
    
    // Package managers
    if (/\b(npm|yarn|pnpm|bun)\s+(install|i|add)\b/.test(cmd)) return 'Install dependencies';
    if (/\b(npm|yarn|pnpm|bun)\s+(test|run\s+test)\b/.test(cmd)) return 'Run tests';
    if (/\b(npm|yarn|pnpm|bun)\s+run\s+build\b/.test(cmd)) return 'Build the project';
    if (/\b(npm|yarn|pnpm|bun)\s+run\s+dev\b/.test(cmd)) return 'Start dev server';
    
    // Database
    if (/\bprisma\s+migrate\b/.test(cmd)) return 'Run database migration';
    if (/\bprisma\s+db\s+push\b/.test(cmd)) return 'Push database schema';
    if (/\b(migrate|migration)\b/.test(cmd)) return 'Run database migration';
    
    // Docker
    if (/\bdocker\s+(build|compose|run)\b/.test(cmd)) return 'Run Docker command';
    
    // File operations
    if (/\b(rm|del|remove)\b/.test(cmd)) return 'Delete files';
    if (/\b(cp|copy)\b/.test(cmd)) return 'Copy files';
    if (/\b(mv|move)\b/.test(cmd)) return 'Move files';
    if (/\b(mkdir|md)\b/.test(cmd)) return 'Create directory';
    
    // Read operations
    if (/\b(ls|dir|cat|type|head|tail|less|grep|find)\b/.test(cmd)) return 'View files or directories';
    
    return 'Run a shell command';
  }
  
  // Web operations
  if (t === 'webfetch' || t === 'web_fetch') return 'Fetch from web';
  if (t === 'websearch' || t === 'web_search') return 'Search the web';
  
  // Default fallback
  return tool ? `Use ${tool} tool` : 'Perform an action';
}

/**
 * POST an approval request to the gateway and block until it resolves.
 *
 * Fail-closed by construction: every failure mode (no gateway, refused
 * connection, non-2xx, malformed body, socket timeout) returns
 * `{approved: false, ...}` — never `approved: true`.
 *
 * @returns {Promise<{approved: boolean, status: string, reason: string, requestId: string|null, mode?: string}>}
 */
function requestApproval({ host, port, secret, payload, timeoutMs }) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request(
      {
        host: host || '127.0.0.1',
        port,
        path: '/agent/approval',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          'x-agw-agent-secret': secret,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return resolve({
              approved: false,
              status: 'denied',
              reason: `Gateway returned HTTP ${res.statusCode}`,
              requestId: null,
            });
          }
          try {
            const parsed = JSON.parse(text);
            // Approval must be explicitly true. Anything else is a denial.
            resolve({
              approved: parsed.approved === true,
              status: parsed.status || 'denied',
              reason: parsed.reason || 'No reason supplied',
              requestId: parsed.requestId || null,
              mode: parsed.mode,
            });
          } catch {
            resolve({
              approved: false,
              status: 'denied',
              reason: 'Malformed response from approval gateway',
              requestId: null,
            });
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({
        approved: false,
        status: 'denied',
        reason: 'Timed out waiting for a decision from the approval gateway',
        requestId: null,
      });
    });
    req.on('error', (err) => {
      resolve({
        approved: false,
        status: 'denied',
        reason: `Approval gateway unreachable (${err.code || err.message}) — denying by default`,
        requestId: null,
      });
    });
    req.write(body);
    req.end();
  });
}

/** Read all of stdin as UTF-8. Resolves to '' when stdin is closed/empty. */
function readStdin(limitBytes = 4 * 1024 * 1024) {
  return new Promise((resolve) => {
    let data = '';
    let size = 0;
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve(data);
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      size += Buffer.byteLength(c, 'utf8');
      if (size > limitBytes) {
        // Oversized payload: stop reading and let the caller fail closed.
        return done();
      }
      data += c;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    // If nothing ever arrives, do not hang the agent forever.
    const t = setTimeout(done, 10_000);
    if (typeof t.unref === 'function') t.unref();
  });
}

module.exports = { projectNameFor, pathsFromToolInput, summarise, describeAction, requestApproval, readStdin };
