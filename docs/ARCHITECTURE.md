# Architecture

## Shape

```
                    Windows laptop
 ┌──────────────────────────────────────────────────────────┐
 │                                                          │
 │  Claude Code ──┐                                         │
 │  Codex CLI ────┼── PreToolUse hook ──> launcher shim     │
 │  Antigravity ──┘                          │              │
 │                                           v              │
 │                                    src/adapters/hook.js  │
 │                                     (one process per     │
 │                                      permission request) │
 │                                           │ HTTP         │
 │                                           │ 127.0.0.1    │
 │                                           v              │
 │                          ┌────────────────────────────┐  │
 │                          │  Approval Gateway          │  │
 │                          │  /agent/*  loopback+secret │  │
 │                          │  /api/*    device token    │  │
 │                          │                            │  │
 │                          │  core/  risk · policy ·    │  │
 │                          │         requests · audit   │  │
 │                          └────────────────────────────┘  │
 │                                     │ bound to           │
 │                                     │ 127.0.0.1 only     │
 └─────────────────────────────────────┼────────────────────┘
                                       │
                            tailscale serve (TLS 443)
                                       │
                          private tailnet (WireGuard)
                                       │
                                   iPhone
                          Safari / Home Screen PWA
                              Approve │ Deny
```

Nothing listens on a public address. The laptop makes one outbound connection to
the tailnet. The phone reaches `https://<host>.<tailnet>.ts.net`, which exists
only inside the tailnet.

## Layers, and why they are separate

```
src/
  core/          agent-agnostic. Knows nothing about any CLI.
    risk.js        LOW / MEDIUM / HIGH classification
    policy.js      gate or pass through; HIGH is always gated
    requests.js    state machine, nonces, replay protection, expiry
    audit.js       append-only JSONL, fsync per record
    devices.js     pairing, token auth, revocation
    crypto.js      random ids, hashing, constant-time compare
    config.js      on-disk config and runtime state

  adapters/      the ONLY code that knows about a specific agent
    hook.js        single entry point: node hook.js <agent>
    index.js       registry
    shared/
      hook-client.js  localhost call to the gateway; fail-closed
      shim.js         Windows .cmd launcher (see FINDINGS §5)
    claude/        adapter.js (parse/render) + install.js
    codex/         adapter.js + install.js (writes hooks.json AND trust hash)
    antigravity/   adapter.js + install.js (per-project .agents/hooks.json)

  server/        transport only
    gateway.js     HTTP, two isolated surfaces, SSE
    push.js        Web Push (VAPID)
    static/        the iPhone PWA

  cli/           agw start/stop/status/pair/install-hooks/selftest/history
```

An adapter does exactly two things: turn one agent's hook payload into the
normalised action, and turn a decision back into that agent's dialect. Adding a
fourth agent means adding one directory — no change to `core/`.

The normalised action, which is all `core/` ever sees:

```js
{ agent, tool, command, paths[], cwd, project, sessionId, toolUseId, summary }
```

## Request lifecycle

```
agent about to run a tool
   │
   ├─ hook fires, blocks the agent
   │
   ├─ POST /agent/approval  (loopback + shared secret)
   │
   ├─ classify risk
   │    LOW  and below threshold ──> reply "passthrough"
   │                                 hook emits NO decision
   │                                 agent applies its own rules
   │                                 (this is not an approval)
   │
   └─ MEDIUM / HIGH ──> create request (PENDING, TTL, single-use nonce)
                          │
                          ├─ SSE push to any open PWA
                          ├─ Web Push to paired devices
                          │
                          └─ block until one of:
                               phone approves ──> APPROVED
                               phone denies   ──> DENIED
                               TTL elapses    ──> EXPIRED  (= denial)
                               wait window    ──> EXPIRED  (= denial)
                               gateway stops  ──> DENIED
                          │
                          v
                   render for the agent
                     Claude:      allow | deny
                     Codex:       silence | deny   (allow is unsupported)
                     Antigravity: exit 0 | exit 2 + reason
```

Exactly one state is terminal per request, and it is never revised.

## Why approval means different things per agent

This is the one place the three agents genuinely diverge, and it is forced by
what each actually accepts:

| | Claude Code | Codex | Antigravity |
|---|---|---|---|
| Deny | `permissionDecision: "deny"` | `permissionDecision: "deny"` + non-empty reason | exit 2 + reason |
| Approve | `permissionDecision: "allow"` | **silence** — `allow` is rejected as unsupported | exit 0 |
| Silence means | no decision → normal rules apply | no decision → normal rules apply | no objection |

For Codex, "approve" cannot be expressed, so the gateway returns no decision and
Codex proceeds under its own policy. That is why Codex should be run in a mode
where it would not prompt again locally (`approval never`, or `--full-auto`) —
the hook is then the sole gate, and it is remote and explicit.

The asymmetry is contained entirely in `codex/adapter.js`. `core/` is unaware of
it, and the tests assert that the Codex adapter never emits `allow`.

## Two HTTP surfaces, deliberately unbridged

| | `/agent/*` | `/api/*` |
|---|---|---|
| Caller | local hook processes | the iPhone |
| Auth | loopback source **and** `agentSecret` | device bearer token |
| Can create a request | yes | **no** |
| Can decide a request | no | yes, with the matching nonce |
| Can run a command | no — it only *describes* one | **no endpoint exists** |

The phone can only resolve a request an agent already created. There is no
endpoint that accepts a command to execute; a test asserts that `/api/exec`,
`/api/run`, `/api/command`, `/api/shell` and `/api/spawn` all 404, and that a
device token is rejected on `/agent/*`. This is what keeps the system an approval
gate rather than a remote shell.

## Fail-closed, concretely

Every one of these ends in a denial, and each has a test:

- gateway not running → `ECONNREFUSED` → deny
- gateway returns non-2xx or unparseable JSON → deny
- hook payload malformed, empty, or a JSON array → deny
- hook invoked without a valid agent id → deny
- request TTL elapses → EXPIRED → deny
- agent's wait window elapses → EXPIRED → deny, and a later approval is refused
- gateway shuts down with requests pending → all denied
- unexpected exception anywhere in the hook → catch-all writes a deny
- `approved` is anything other than boolean `true` → deny

The only path that emits an approval is the gateway explicitly returning
`approved: true` after a paired device sent a matching, unspent nonce.

One caveat worth stating plainly: the shell-level failure in FINDINGS §5 fails
*open* (a hook that cannot launch is non-blocking for the agent), which is
upstream of all of the above. That is why the launcher shim exists and why
`scripts/verify-shim.js` is part of setup rather than an afterthought.

## Storage

`%USERPROFILE%\.agw\` (override with `AGW_HOME`):

| File | Contents |
|---|---|
| `config.json` | settings, `agentSecret`, VAPID keys. Owner-only. |
| `devices.json` | paired devices. Tokens stored **only** as SHA-256 hashes. |
| `audit.jsonl` | append-only log, fsync'd per record, never rewritten |
| `gateway.json` | pid/port of the running gateway |
| `hooks/*.cmd` | generated launcher shims |

Pending requests live in memory only. A gateway restart cannot resurrect a
pending request, which is the point: no decision can be applied to a request
whose agent is no longer waiting.

`devices.json` is re-read before every auth check, so `agw pair` and
`agw revoke` in a terminal take effect immediately in the already-running
detached gateway, and a revocation locks a phone out without a restart.
