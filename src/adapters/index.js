'use strict';
/**
 * Adapter contract.
 *
 * An adapter's only job is translation. It converts one agent's hook payload
 * into the gateway's normalised action, and converts the gateway's decision
 * back into whatever that agent understands. The core never learns which
 * agent it is serving beyond the `agent` label.
 *
 * Every adapter exports:
 *   id            'claude' | 'codex' | 'antigravity'
 *   displayName   Shown on the phone, e.g. "Claude Code".
 *   parse(raw)    hook stdin (string) -> normalised action
 *   render(res)   decision -> {stdout, exitCode}
 *
 * `render` must be fail-closed: for anything other than an explicit approval
 * it produces the agent's strongest available "do not run this" signal.
 */

const claude = require('./claude/adapter');
const codex = require('./codex/adapter');
const antigravity = require('./antigravity/adapter');

const ADAPTERS = { claude, codex, antigravity };

function getAdapter(id) {
  const a = ADAPTERS[String(id || '').toLowerCase()];
  if (!a) throw new Error(`Unknown agent adapter: ${id}`);
  return a;
}

function listAdapters() {
  return Object.values(ADAPTERS);
}

module.exports = { getAdapter, listAdapters, ADAPTERS };
