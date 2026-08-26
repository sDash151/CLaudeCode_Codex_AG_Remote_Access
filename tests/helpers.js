'use strict';
/**
 * Shared test harness.
 *
 * Every suite gets a throwaway AGW_HOME so tests never touch the real
 * ~/.agw, and never touch the user's ~/.claude or ~/.codex.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

let counter = 0;

/**
 * Create an isolated environment and return helpers bound to it.
 * Must be called before requiring any src/core module in a test file, because
 * config paths are read from AGW_HOME at call time.
 */
function makeHome(tag = 't') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agw-${tag}-${process.pid}-${counter++}-`));
  process.env.AGW_HOME = dir;
  return dir;
}

function cleanHome(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold a handle briefly; the temp dir is disposable anyway */
  }
}

/** Fresh module instances so cached config from a previous test cannot leak. */
function freshRequire(...mods) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}`)) delete require.cache[key];
  }
  return mods.map((m) => require(m));
}

/** Minimal JSON HTTP client for hitting a live gateway in tests. */
function request({ port, method = 'GET', path: p = '/', headers = {}, body = null, timeout = 15000 }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: p,
        method,
        timeout,
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
          try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
          resolve({ status: res.statusCode, headers: res.headers, body: json, text });
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('request timed out')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** A hook payload shaped like the one each agent really sends. */
function hookPayload({ agent = 'claude', command = 'echo hi', cwd = process.cwd(), tool = 'Bash' } = {}) {
  const base = {
    session_id: 'sess_' + Math.random().toString(36).slice(2),
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { command },
    tool_use_id: 'call_' + Math.random().toString(36).slice(2),
  };
  if (agent === 'codex') {
    // Matches the payload captured live from codex-cli 0.148.0-alpha.15.
    base.turn_id = 'turn_' + Math.random().toString(36).slice(2);
    base.model = 'gpt-5.6-sol';
    base.permission_mode = 'bypassPermissions';
  } else if (agent === 'claude') {
    base.permission_mode = 'default';
    base.prompt_id = 'p_' + Math.random().toString(36).slice(2);
  }
  return base;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { makeHome, cleanHome, freshRequire, request, hookPayload, sleep };
