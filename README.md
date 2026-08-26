# Agent Approval Gateway

Approve or deny **Claude Code**, **Codex CLI** and **Antigravity** permission
requests from your iPhone, while a long-running task keeps going on your Windows
laptop.

```
Codex wants to run:
  npx prisma migrate deploy
Project: LevelUP
Risk: HIGH
[ Deny ]  [ Approve ]
```

Your approval stays **your** approval. Anything unknown — timeout, crash,
unreachable gateway, malformed payload — is a **denial**. LOW-risk actions are
auto-allowed by design so unattended work does not stall; see below.

**Free to run.** No Apple Developer Program membership, no Google Play account, no
native app. The phone client is a web app you add to your Home Screen.

---

## ⚠️ Read this first

**`v0.1.0-alpha`. A personal tool, verified on exactly one Windows 11 machine.**

**Risk classification is regex matching on the command the agent declares. It is
evadable and is NOT a security boundary.** `git push` is caught; this is not:

```bash
eval "$(echo Z2l0IHB1c2ggLWYK | base64 -d)"     # classifies MEDIUM, not HIGH
```

If you need a real boundary, use a container, VM, or OS sandbox. Read
[SECURITY.md](SECURITY.md) before arming anything — it is short and it lists
exactly what this does and does not protect against.

**Walk-away mode auto-allows LOW-risk actions** — reads inside the project, tests,
builds — with no approval at all. Deliberate, so unattended work does not stall.
Set `gateMinRisk` to `LOW` in `~/.agw/config.json` if you disagree.

**Windows-only so far.** macOS/Linux code paths exist but are untested.

---

## Status: what is actually verified

I do not want to overstate this, so here it is precisely.

| Agent | Integration | Verified? |
|---|---|---|
| **Claude Code** 2.1.229 | `PreToolUse` + `PermissionRequest`, all tools | ✅ **Walk-away verified live in Manual mode.** A multi-tool task (Write ×4, Read ×2, Bash, mkdir, npm) ran to completion with **zero laptop prompts** — every MEDIUM went to the iPhone, every LOW ran automatically. |
| **Codex CLI** 0.148.0-alpha.15 | `PreToolUse` hook | ✅ **Fully verified live from a real iPhone.** Real `codex exec` → push → tapped Deny → `Command blocked by PreToolUse hook: Denied from iPhone`. |
| **iPhone / Tailscale / Web Push** | PWA over `tailscale serve` | ✅ **Fully verified.** Tailnet HTTPS, pairing, Home Screen install, Web Push delivered, Approve and Deny both tapped, agent continued and stopped correctly. |
| **Antigravity** 2.0 + IDE 2.5.5 | project `.agents/hooks.json` | ⚠️ **EXPERIMENTAL — never verified live.** Approve/deny/timeout are correct through the real hook script and `.cmd` shim, but whether Antigravity *reads* `.agents/hooks.json` is unconfirmed: its agent runs inside the IDE and cannot be scripted. Run `agw selftest antigravity` and please report the result. |

110 automated tests pass. Codex live test passes. Full evidence, including the
paths that did *not* work: **[docs/FINDINGS.md](docs/FINDINGS.md)**. Threat model:
**[SECURITY.md](SECURITY.md)**.

## Walk-away operation

Start a session, walk away, and it runs until it finishes or your phone denies
something. Two hooks make that work, both matching **all** tools:

| Hook | Job |
|---|---|
| `PreToolUse` | LOW → allowed automatically. MEDIUM/HIGH → your phone. |
| `PermissionRequest` | Catch-all for anything else Claude would ask a human about. |

`PermissionRequest` is the piece that keeps the laptop out of the loop. Its
contract differs from `PreToolUse` — it uses `decision.behavior`, and **exit code
2 is ignored** — so the wrong output shape would silently fail to deny.

**Verified run** (Manual mode, nothing touched on the laptop):

| Tool | Risk | Outcome |
|---|---|---|
| `Write` ×4 | MEDIUM | approved from iPhone |
| `mkdir -p` | LOW | automatic |
| `Read` ×2 (in project) | LOW | automatic |
| `node --test` | LOW | automatic |
| `npm install --dry-run` | MEDIUM | approved from iPhone |

### Rejected approaches, and why

- **`permissions.defaultMode = "bypassPermissions"`** — the CLI documents it as
  "Bypass all permission checks (requires `allowDangerouslySkipPermissions`)".
  Without that second opt-in the app silently falls back to Manual and keeps
  prompting. It also disables every check instead of routing them.
- **`acceptEdits`** — auto-accepts file edits only. Bash keeps prompting.
- **Pre-approving tool names via `permissions.allow`** — too coarse, and left
  every other tool prompting locally.

### Out-of-project access is routed, not removed

Reading or writing outside the project is **gated, never auto-allowed**:

- outside the project → at least **MEDIUM**
- outside *and* credential-shaped (`.env`, `.ssh/`, `.aws/`, `auth.json`,
  `credentials`, `id_rsa`, `.codex/`, `.claude/`, `*secret*`, `*token*`,
  `*api_key*`) → **HIGH**, which no config can un-gate

This was a real bug, not a hypothetical. An earlier version classified `Read` as
LOW purely because the *tool* was read-only, ignoring the path. The hook answered
`allow`, which suppressed Claude Code's own out-of-project prompt, and a live API
key was read out of `~/.codex/config.toml` into a transcript. The regression test
`the exact file that leaked is now HIGH` pins it.

Your own `deny` and `ask` rules still override a hook `allow`, so project-specific
safety rules keep working.



### The full remote chain, as actually observed

```
codex exec  ->  PreToolUse hook  ->  gateway (127.0.0.1:8787)
            ->  tailscale serve HTTPS  ->  Web Push (Apple)
            ->  iPhone Home Screen PWA  ->  tap Deny
            ->  gateway  ->  hook  ->  Codex stops
```

Audit trail for that run:

```
request.created  codex HIGH   git push origin main
push.sent        sent=1 failed=0
request.denied   iPhone HIGH
```

Codex's own output: `The command was blocked by the environment's PreToolUse hook: "Denied from iPhone."`

### Claude Code — the six cases

| Case | Command | Result |
|---|---|---|
| LOW passthrough | `git status` | not gated, ran — `request.passthrough` logged |
| MEDIUM + approve | `npm install --dry-run left-pad` | gated → `request.approved` → **ran** |
| HIGH + approve | `git push --dry-run origin main` | gated HIGH → approved → reached git |
| MEDIUM + deny | `npm install --dry-run right-pad` | **blocked**, `Denied from TestPhone` |
| Timeout | `npm install --dry-run nope-pad` | **blocked**, `No decision arrived before the approval window closed` |
| Gateway down | `npm install --dry-run offline-pad` | **blocked**, `ECONNREFUSED — denying by default` |

### The hooks ship disarmed — on purpose

Nothing is hooked into your agents right now. Arming a gate before a phone is
paired denies **every** MEDIUM/HIGH tool call in all three agents.

Pair your phone first, then `npm run install-hooks`. It refuses to install with
no paired device unless you pass `--force`, and the gateway denies *immediately*
rather than stalling when no device could answer.

**If you ever get wedged:** the gateway must be **running** to un-wedge. LOW-risk
passthrough is decided *by the gateway*, so with it stopped every command denies,
including the one that would remove the hook. Start it, then:

```bash
node -e "require('./src/adapters/claude/install').uninstall({scope:'user'})"
```

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Start the gateway

```bash
npm start
```

It binds `127.0.0.1:8787` only. Nothing is exposed yet.

### 3. Set up remote access (Tailscale)

Your laptop has no public IP and no ports are forwarded. Tailscale gives the
phone a private, encrypted route in, with real HTTPS — which iOS requires both to
install a PWA and to deliver Web Push.

```powershell
.\scripts\setup-tailscale.ps1
```

The script checks what is missing and tells you the next command. In outline:

1. `winget install --id Tailscale.Tailscale` on the laptop, then `tailscale up`
2. Enable HTTPS certificates once at <https://login.tailscale.com/admin/dns>
3. Install the free **Tailscale** app on the iPhone, sign in to the same account
4. Re-run the script — it configures `tailscale serve` to proxy HTTPS 443 to the
   gateway and prints your phone URL

This uses `tailscale serve`, **not** `funnel` — the site stays private to your
tailnet and is never published to the internet.

Then record the origin so push and the PWA work:

```bash
node src/cli/agw.js set-origin https://your-host.your-tailnet.ts.net
node src/cli/agw.js stop && npm start
```

### 4. Pair your iPhone (do this before installing hooks)

```bash
npm run pair
```

You get a single-use code valid for 10 minutes:

```
Pairing code:  K7QD-M2XP
Valid for:     10 minutes, single use
On the iPhone, open:  https://your-host.your-tailnet.ts.net
```

On the phone: connect Tailscale → open that URL → enter the code.

Then **Share → Add to Home Screen**, and open it from the Home Screen icon.
This step is not cosmetic: **iOS only delivers Web Push to a Home Screen
install**, never to a normal Safari tab. Tap *Enable notifications* once inside.

### 5. Install the hooks

```bash
npm run install-hooks
```

For Antigravity, hooks are per project (that is the only location it reads):

```bash
node src/cli/agw.js install-hooks --agent antigravity --project "E:\ALL PROJECTS\LevelUP"
```

Then:

- **Restart Claude Code** if it is open.
- **Restart Antigravity** — it re-reads `.agents/hooks.json` on load.
- Codex picks it up on the next run. The installer also grants Codex's required
  trust hash automatically; `agw status` shows `codex … trust=trusted`.

Check everything landed:

```bash
node src/cli/agw.js status
```

To turn the whole thing off at any time:

```bash
npm run uninstall-hooks
```

---

## Daily use

Once set up, the loop is: gateway runs, hooks installed, phone paired. Then you
only touch it when something asks permission.

```bash
npm start        # start gateway (detached, survives closing the terminal)
npm run status   # gateway, hooks, Codex trust, paired devices
npm stop         # stop it — ANYTHING PENDING IS DENIED
```

| Command | What it does |
|---|---|
| `npm run pair` | New single-use pairing code (10 min) |
| `node src/cli/agw.js devices` | List paired devices |
| `node src/cli/agw.js revoke <id>` / `--all` | Revoke access immediately |
| `node src/cli/agw.js history --limit 30` | Audit log |
| `npm run install-hooks` | Arm the gate |
| `npm run uninstall-hooks` | Disarm it |
| `node src/cli/agw.js simulate codex --command "git push"` | Dry-run one request, no agent needed |

**Order matters on a cold start:** gateway → pair → install-hooks. Installing
hooks before a phone is paired denies everything.

Logs: `%USERPROFILE%\.agw\gateway.log`

Two settings in `%USERPROFILE%\.agw\config.json` worth knowing:

- `gateMinRisk` — default `MEDIUM`. Set `LOW` to gate everything. Cannot exempt HIGH.
- `agentWaitMs` — default 240000 (4 min). How long an agent is held waiting for
  your tap. Lower it if you would rather agents fail fast.

---

## Testing

```bash
npm test                  # 84 automated tests
npm run test:live-codex   # LIVE test against the real Codex CLI
```

The live Codex test backs up and restores your `~/.codex/hooks.json` and
`config.toml`, including on Ctrl-C.

### Verifying Claude Code

```bash
node src/cli/agw.js selftest claude --approve
```

It watches the gateway and tells you what to do. In Claude Code, ask it to run
`echo AGW_SELFTEST_CLAUDE`. The self-test prints the request it saw and approves
it, which exercises the one direction not yet confirmed.

Drop `--approve` to rehearse a denial instead; Claude should refuse the tool call.

`echo` is LOW risk, so to make the self-test gate it, set `gateMinRisk` to `LOW`
in `%USERPROFILE%\.agw\config.json` and restart — or ask for something genuinely
MEDIUM like `npm install left-pad`.

### Verifying Antigravity

```bash
node src/cli/agw.js install-hooks --agent antigravity --project "E:\path\to\project"
node src/cli/agw.js selftest antigravity
```

Restart Antigravity, open that project, and ask the agent to run a terminal
command. If nothing arrives, the self-test prints what to check. Please treat
Antigravity as unconfirmed until this passes for you.

### Dry-run without any agent

```bash
node src/cli/agw.js simulate codex --command "git push origin main"
```

Feeds a synthetic payload through the real hook and prints the verdict.

### Confirming the Windows launcher works

```bash
node scripts/verify-shim.js codex
```

Worth running after any move of the project directory — see *Known limitations*.

---

## Risk levels

| | Examples | Behaviour |
|---|---|---|
| **LOW** | `ls`, `cat`, `git status`, `git diff`, `npm test`, `npm run build`, `tsc`, `pytest` | Not gated by default. The gateway returns *no decision* and the agent applies its own normal rules. This is **not** an approval. |
| **MEDIUM** | `npm install`, `pip install`, `git commit`, `git merge`, `chmod`, editing config, `docker compose up`, any unrecognised command | Requires explicit remote approval |
| **HIGH** | `prisma migrate deploy`, `git push`, `git reset --hard`, `rm -rf`, `terraform apply/destroy`, `kubectl delete`, `npm publish`, deploys, `.env.production` | **Always** requires explicit remote approval, and the phone asks for a second confirming tap |

An unrecognised command is MEDIUM, never LOW — unknown is not treated as safe.
`gateMinRisk` in `config.json` can lower the threshold to `LOW`; it **cannot**
exempt HIGH. That floor is enforced in code and asserted by a test.

---

## Security model

**Authentication.** Pairing is a single-use, time-limited code exchanged for a
long random device token. Only the SHA-256 of the token is stored, so
`devices.json` cannot be used to impersonate your phone. Tokens are compared in
constant time, expire after 30 days, and can be revoked instantly.

**One decision, one request.** Each request carries a fresh 24-byte nonce. A
decision must present the nonce issued for *that* request. A nonce for request A
cannot resolve request B, a spent nonce is refused as a replay, and a terminal
request can never be re-decided. Tested in all four directions.

**Short-lived.** Requests expire (default 5 minutes). Expiry is a denial. A
decision arriving after expiry is refused rather than applied.

**Not a remote shell.** The phone can only resolve a request an agent already
created. No endpoint accepts a command to run; a test asserts the obvious
candidates all 404 and that a device token is rejected on the agent surface.

**Transport.** Loopback-only bind. Remote access is WireGuard inside your tailnet
plus TLS terminated by `tailscale serve` with a real certificate. No port
forwarding, no public hostname, no inbound connections.

**Audit.** Every creation, approval, denial, expiry, refused decision, pairing,
revocation and gateway start/stop is appended to `audit.jsonl` and fsync'd. Each
decision records the request id, agent, exact command, cwd, project, risk, the
device that decided, the reason, and the latency. Viewable on the phone under
*History* or via `agw history`.

**Push contents.** A notification carries only agent, project, risk and a
truncated command — never a token or nonce.

---

## Known limitations

1. **Claude Code is fully verified; Antigravity's IDE round trip is not.** For
   Antigravity, everything up to and including the `.cmd` shim is proven
   (approve/deny/timeout, exit 2 + reason). The single unproven link is whether
   the IDE reads `.agents/hooks.json` at all. Run `agw selftest antigravity`.

2. **Arming the gate with no phone paired blocks everything.** Correct
   fail-closed behaviour, but it will look like your agent is broken. The gateway
   now denies immediately rather than stalling, and `install-hooks` refuses
   without a paired device. **The gateway must be running to un-wedge** — LOW
   passthrough is decided by the gateway, so with it stopped even the command
   that removes the hook is denied. Start the gateway, then run the `uninstall`
   one-liner above.

3. **Antigravity is not verified live at all.** Its approval flow runs inside the
   IDE and cannot be driven from a script. The adapter is written to the contract
   found in its language server and emits both plausible denial conventions at
   once, but until `agw selftest antigravity` passes for you, treat the IDE link
   as unconfirmed.

4. **The iPhone path is verified, but Web Push needs `publicOrigin` set.** Apple
   returns **403** to a placeholder VAPID subject, which silently kills every
   notification while the gateway still reports success. The subject now defaults
   to `publicOrigin`, so run `agw set-origin https://<host>.<tailnet>.ts.net`
   before expecting notifications. Check with `agw history` — a working send logs
   `push.sent sent=1 failed=0`.

5. **Tailscale HTTPS certificates must be enabled once**, at
   <https://login.tailscale.com/admin/dns> → *HTTPS Certificates*. Without it
   `tailscale serve --https=443` hangs, and `tailscale cert` reports
   `your Tailscale account does not support getting TLS certs`. iOS will not
   install a PWA to the Home Screen or deliver Web Push over plain HTTP.

4. **Antigravity hooks are per project.** No user-global location could be found,
   so you must install per repository and restart the IDE.

5. **Codex cannot be told "allow".** It only accepts `deny`, so an approval is
   expressed as "no decision" and Codex then follows its own policy. Run Codex in
   a mode where it would not prompt again locally (`approval never` / full-auto)
   so the remote gate is the only gate. If you run Codex with local prompting on,
   you will be asked twice.

6. **A hook that cannot launch fails open.** All the fail-closed logic lives
   *inside* the hook; if the shell cannot start it, the agent treats that as
   non-blocking and proceeds. This is why the launcher shim exists (see
   [FINDINGS §5](docs/FINDINGS.md#5-windows-launch-quirk-that-silently-defeats-hooks)).
   **If you move this project directory, re-run `npm run install-hooks`** and
   confirm with `node scripts/verify-shim.js codex`.

7. **iOS Web Push requires a Home Screen install.** In a plain Safari tab,
   subscription fails and you get no alert when the app is closed. The PWA says
   so on screen. With the app open, SSE updates instantly regardless.

8. **The phone needs Tailscale connected.** With the VPN off the gateway is
   unreachable; the PWA shows *"Laptop unreachable — nothing can be approved"* and
   disables the buttons. Requests then expire into denials, which is the intended
   fail-closed behaviour, not a silent stall.

9. **Pending requests are in memory.** A gateway restart denies everything
   pending. Deliberate: a decision must never be applied to a request whose agent
   is no longer waiting.

10. **Risk classification is pattern-based.** It is deliberately conservative
    (unknown → MEDIUM), but it is not a sandbox and cannot understand an arbitrary
    script's intent. A shell script whose *name* looks harmless but which deletes
    things will classify on the name. Read what the phone shows you.

11. **A 4-minute wait is a long time to hold an agent.** `agentWaitMs` defaults to
    240s so you have time to react to a notification. If you would rather your
    agents fail fast, lower it in `config.json`.

12. **Single user, one laptop.** No multi-user or org features, by scope.

---

## Future improvements

- Native iOS app (V2) for reliable push without the Home Screen requirement
- Verify and pin Antigravity's hook output convention once documented
- Use Codex's `PermissionRequest` hook event, which may allow a true approve
- Optional per-project policy files (`.agw.json`) for repo-specific thresholds
- Approve-once-per-session for a specific repeated command, still explicitly granted
- Persist pending requests so a gateway restart can resume rather than deny
- Richer diffs on the phone for `Edit`/`Write` so you can review the change itself
- Cloudflare Tunnel as an alternative for when the VPN is inconvenient

---

## Layout

```
src/core/         agent-agnostic approval engine
src/adapters/     claude · codex · antigravity  (+ shared shim & hook client)
src/server/       HTTP gateway, Web Push, and the iPhone PWA
src/cli/          agw
tests/            83 automated tests + live/codex-e2e.js
docs/             ARCHITECTURE.md · FINDINGS.md · evidence/
scripts/          setup-tailscale.ps1 · verify-shim.js · probe-cmd-forms.js
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the layers fit together.
