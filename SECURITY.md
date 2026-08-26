# Security model

Read this before arming the gateway. It is a convenience gate for a single
developer, not a sandbox and not a security boundary.

## What this actually protects against

You start a long-running agent task, walk away, and it reaches something you
would rather decide yourself — a migration, a force push, a deploy. Without this,
the agent either stalls at a prompt until you come back, or you ran it in a
permissive mode and it just did the thing. This puts that decision on your phone.

That is the whole scope: **giving a human a remote veto on an agent's own
declared intent.**

## What it explicitly does NOT protect against

**A determined or adversarial agent.** Risk classification is regex matching on
the command string the agent chose to declare. It is trivially evadable:

```bash
eval "$(echo Z2l0IHB1c2ggLWYK | base64 -d)"     # classifies MEDIUM, not HIGH
python -c "import subprocess;subprocess.run(['git','push'])"
sh ./innocuous-name.sh                            # contents never inspected
```

If you need a real boundary, use an OS sandbox, a container, or a VM. This is not
that, and no amount of pattern-tuning will make it that.

**Anything downstream of an approval.** Approving `npm install left-pad` approves
that command, not what its install scripts do.

**Compromise of the laptop.** The gateway trusts every local process that can read
`~/.agw/config.json`. Anything running as you can mint approval requests.

**LOW-risk actions.** By design they are auto-allowed so unattended work does not
stall. That includes reading files inside the project, running tests and builds.
Set `gateMinRisk` to `LOW` in `~/.agw/config.json` if you want everything gated.

## Trust boundaries

| Surface | Who may call it | What it can do |
|---|---|---|
| `/agent/*` | loopback source **and** the `agentSecret` | create an approval request and wait |
| `/api/*` | a paired device bearer token | approve or deny an existing request |
| static files | anyone who can reach the origin | serve the PWA |

The phone surface has **no endpoint that runs a command**. It can only resolve a
request an agent already created. `/api/exec`, `/api/run`, `/api/command`,
`/api/shell` and `/api/spawn` all 404, and a test asserts they stay that way. A
device token is rejected on `/agent/*`.

## Cryptography and secrets

- Pairing codes: 8 characters from a 32-symbol alphabet, single use, 10-minute
  expiry, stored only as SHA-256. Issuing a new code invalidates the previous one.
- Device tokens: 32 random bytes from `crypto.randomBytes`, stored only as
  SHA-256, compared in constant time, 30-day expiry, revocable instantly.
- Decision nonces: 24 random bytes, bound to one request, accepted once.
- `~/.agw/config.json` holds the `agentSecret` and the VAPID private key **in
  plaintext**, protected only by filesystem permissions. It is a localhost
  credential; treat the file as sensitive.
- Push payloads carry agent, project, risk and a truncated command. Never a token
  or nonce.

## Fail-closed behaviour

Every one of these denies, and each has a test:

- gateway not running (`ECONNREFUSED`)
- gateway returns non-2xx or unparseable JSON
- hook payload malformed, empty, or a JSON array
- hook invoked without a valid agent id
- request TTL elapses, or the agent's wait window elapses
- gateway shuts down with requests pending
- any unexpected exception in the hook
- `approved` is anything other than boolean `true`
- no paired device exists (denied immediately rather than stalling)

**One case fails open, and it is the most dangerous one.** All of the above lives
*inside* the hook process. If the shell cannot launch that process at all, the
agent treats it as a non-blocking error and proceeds unapproved. This is why the
installer writes a `.cmd` launcher instead of a direct node invocation — see
`docs/FINDINGS.md` §5. **Re-run `npm run install-hooks` if you move the project,
and verify with `node scripts/verify-shim.js codex`.**

## Walk-away mode

Arming the gateway installs two Claude Code hooks: `PreToolUse` and
`PermissionRequest`, both matching all tools. Together they mean no local prompt
blocks unattended work — LOW is auto-allowed, everything else routes to the phone.

Consequences to understand before you use it:

- Your laptop stops being an approval gate for ordinary agent work.
- If the gateway dies while hooks are installed, agents are blocked, not freed.
  Safe, but they will grind to a halt.
- Reading files **outside** the project is classified as needing approval, and as
  HIGH if the path looks like credential material (`.env`, `.ssh/`, `.aws/`,
  `auth.json`, `.codex/`, `.claude/`, anything matching `secret|token|api_key`).
  This exists because an earlier version auto-allowed such a read and pulled a
  live API key into a transcript.

Disarm at any time, which also restores normal prompts:

```bash
npm run uninstall-hooks
```

## Reporting a problem

This is a personal project with no security guarantees and no SLA. Open a GitHub
issue. Do not include real command output, transcripts, or `~/.agw` contents —
those routinely contain secrets.
