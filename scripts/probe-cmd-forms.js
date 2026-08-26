'use strict';
/**
 * Determines which command-string form survives `%COMSPEC% /c "<string>"`,
 * which is how Codex launches a hook on Windows.
 *
 * Run: node scripts/probe-cmd-forms.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-cmdform-'));
const spaceyDir = path.join(tmp, 'dir with spaces');
fs.mkdirSync(spaceyDir, { recursive: true });

// A trivial script that echoes a marker and reads stdin, like the real hook.
const script = path.join(spaceyDir, 'echo hook.js');
fs.writeFileSync(
  script,
  "let d='';process.stdin.setEncoding('utf8');" +
    "process.stdin.on('data',c=>d+=c);" +
    "process.stdin.on('end',()=>{process.stdout.write('MARKER:'+process.argv[2]+':'+d.length)});" +
    "setTimeout(()=>{process.stdout.write('MARKER:'+process.argv[2]+':nostdin')},2000);"
);

const node = process.execPath;

/** 8.3 short path avoids spaces entirely, so no quoting is needed. */
function shortPath(p) {
  try {
    const out = execSync(
      `for %I in ("${p}") do @echo %~sI`,
      { shell: process.env.COMSPEC || 'cmd.exe', encoding: 'utf8' }
    );
    return out.trim();
  } catch {
    return null;
  }
}

const shortNode = shortPath(node);
const shortScript = shortPath(script);

// Launcher .cmd in a space-free directory.
const shimDir = path.join(tmp, 'shim');
fs.mkdirSync(shimDir, { recursive: true });
const shim = path.join(shimDir, 'hook.cmd');
fs.writeFileSync(shim, `@echo off\r\n"${node}" "${script}" %*\r\n`);

// Launcher .cmd in a directory WITH spaces, referenced quoted.
const shimSpacey = path.join(spaceyDir, 'hook.cmd');
fs.writeFileSync(shimSpacey, `@echo off\r\n"${node}" "${script}" %*\r\n`);

const forms = [
  ['A quoted-exe first (current)', `"${node}" "${script}" codex`],
  ['B bare node + quoted script', `node "${script}" codex`],
  ['C shim.cmd, space-free, bare', `${shim} codex`],
  ['D shim.cmd, spacey, quoted', `"${shimSpacey}" codex`],
  ['E double-wrapped quotes', `""${node}" "${script}" codex"`],
  ['F 8.3 short paths, unquoted', shortNode && shortScript ? `${shortNode} ${shortScript} codex` : null],
  ['G cmd /c inner wrap', `cmd /c ""${node}" "${script}" codex"`],
];

console.log('node       :', node);
console.log('short node :', shortNode);
console.log('script     :', script);
console.log('short scr  :', shortScript);
console.log('');

for (const [label, cmd] of forms) {
  if (!cmd) {
    console.log(label.padEnd(30), '=> SKIPPED (no short path available)');
    continue;
  }
  try {
    const out = execFileSync(process.env.COMSPEC || 'cmd.exe', ['/c', cmd], {
      encoding: 'utf8',
      input: '{"tool_input":{"command":"echo hi"}}',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const ok = out.includes('MARKER:codex:');
    const gotStdin = /MARKER:codex:(\d+)/.exec(out);
    console.log(
      label.padEnd(30),
      ok ? '=> WORKS' : '=> ran but no marker',
      gotStdin ? `(stdin ${gotStdin[1]} bytes)` : out.includes('nostdin') ? '(NO STDIN)' : '',
      ok ? '' : JSON.stringify(out.trim().slice(0, 80))
    );
  } catch (e) {
    const msg = ((e.stderr || '') + (e.stdout || '') + (e.message || '')).toString().trim();
    console.log(label.padEnd(30), '=> FAILED:', msg.slice(0, 90).replace(/\s+/g, ' '));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
