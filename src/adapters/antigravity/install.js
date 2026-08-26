'use strict';
/**
 * Antigravity hook installer (covers Antigravity 2.0 and Antigravity IDE).
 *
 * Antigravity discovers pre-tool hooks from a project-scoped file:
 *     <project>/.agents/hooks.json
 * (the string ".agents/hooks.json" is present in the language server, together
 * with "\"PreToolUse\": [" and "\"PostToolUse\": [").
 *
 * Unlike Claude and Codex there is no user-global hook location that could be
 * confirmed, so installation is per-project and the CLI requires an explicit
 * --project path.
 *
 * Because the exact handler schema is not documented, the file we write carries
 * the same shape Claude and Codex use (matcher + hooks[] with type/command/
 * args/timeout) plus a flattened `command`/`args` at the entry level, so a
 * reader expecting either layout finds what it needs.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARKER = 'agent-approval-gateway';

const { writeShim, removeShim } = require('../shared/shim');

function hookScriptPath() {
  return path.resolve(__dirname, '..', '..', 'adapters', 'hook.js');
}

function hooksPathFor(projectDir) {
  return path.join(projectDir, '.agents', 'hooks.json');
}

/** Both known Antigravity variants on Windows, with their data directories. */
function knownInstalls() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    {
      id: 'antigravity',
      label: 'Antigravity 2.0',
      exe: path.join(local, 'Programs', 'antigravity', 'Antigravity.exe'),
      dataDir: path.join(os.homedir(), '.gemini', 'antigravity'),
    },
    {
      id: 'antigravity-ide',
      label: 'Antigravity IDE',
      exe: path.join(local, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
      dataDir: path.join(os.homedir(), '.gemini', 'antigravity-ide'),
    },
  ];
  return candidates.map((c) => ({
    ...c,
    installed: fs.existsSync(c.exe),
    dataDirExists: fs.existsSync(c.dataDir),
  }));
}

function buildEntry(shimCommand) {
  const command = shimCommand || writeShim('antigravity').command;
  return {
    matcher: '*',
    _source: MARKER,
    // Nested form (Claude/Codex style). `command` is the launcher shim, so this
    // works whether Antigravity spawns directly or via a shell — a shell-passed
    // string starting with a quoted exe path fails on Windows.
    hooks: [
      {
        type: 'command',
        command,
        timeout: 300,
        _source: MARKER,
      },
    ],
    // Flattened form, for a reader that expects command/args on the entry.
    type: 'command',
    command,
    timeout: 300,
  };
}

function install({ projectDir } = {}) {
  if (!projectDir) throw new Error('Antigravity hooks are per-project: pass --project <dir>');
  const resolved = path.resolve(projectDir);
  if (!fs.existsSync(resolved)) throw new Error(`Project directory does not exist: ${resolved}`);

  const file = hooksPathFor(resolved);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let doc = { hooks: { PreToolUse: [] } };
  if (fs.existsSync(file)) {
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (existing && typeof existing === 'object') {
        doc = existing;
        const backup = file + '.agw-backup';
        if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
      }
    } catch (err) {
      throw new Error(`${file} is not valid JSON — refusing to overwrite it (${err.message})`);
    }
  }

  if (!doc.hooks || typeof doc.hooks !== 'object') doc.hooks = {};
  if (!Array.isArray(doc.hooks.PreToolUse)) doc.hooks.PreToolUse = [];

  doc.hooks.PreToolUse = doc.hooks.PreToolUse.filter((e) => !(e && e._source === MARKER));
  const shim = writeShim('antigravity');
  doc.hooks.PreToolUse.push(buildEntry(shim.command));

  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return { path: file, action: 'installed', shim: shim.shim, command: shim.command };
}

function uninstall({ projectDir } = {}) {
  if (!projectDir) throw new Error('pass --project <dir>');
  const file = hooksPathFor(path.resolve(projectDir));
  if (!fs.existsSync(file)) return { path: file, action: 'absent' };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { path: file, action: 'unparseable' };
  }
  const arr = doc?.hooks?.PreToolUse;
  if (!Array.isArray(arr)) return { path: file, action: 'absent' };
  const before = arr.length;
  doc.hooks.PreToolUse = arr.filter((e) => !(e && e._source === MARKER));
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  removeShim('antigravity');
  return { path: file, action: before === doc.hooks.PreToolUse.length ? 'absent' : 'removed' };
}

function status({ projectDir } = {}) {
  const installs = knownInstalls();
  if (!projectDir) return { installs, installed: false, reason: 'no project specified' };
  const file = hooksPathFor(path.resolve(projectDir));
  if (!fs.existsSync(file)) return { installs, path: file, installed: false };
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = doc?.hooks?.PreToolUse || [];
    return { installs, path: file, installed: arr.some((e) => e && e._source === MARKER) };
  } catch {
    return { installs, path: file, installed: false, reason: 'not valid JSON' };
  }
}

module.exports = { install, uninstall, status, hooksPathFor, knownInstalls, hookScriptPath };
