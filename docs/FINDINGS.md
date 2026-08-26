# Machine inspection findings

Everything in this file was determined on **this machine** by running the tools,
not from documentation guesses. Where something is documented rather than
observed, it says so. Where something is unverified, it says so.

Inspected: 2026-08-25 · Windows 11 Home Single Language 10.0.26200 · Node 22.15.1

---

## 1. What is actually installed

| Agent | Version | Location |
|---|---|---|
| Claude Code | 2.1.229 | `%LOCALAPPDATA%\Claude-3p\claude-code\2.1.229\claude.exe` (desktop app; `claude` is **not** on PATH) |
| Codex CLI | 0.148.0-alpha.15 | `%LOCALAPPDATA%\OpenAI\Codex\bin\f71e347eb70b3d24\codex.exe` (found via `CODEX_CLI_PATH` in `~/.codex/config.toml`) |
| Antigravity 2.0 | Electron + Go language server | `%LOCALAPPDATA%\Programs\antigravity\` · data in `~/.gemini/antigravity/` |
| Antigravity IDE | 2.5.5 (VS Code fork) | `%LOCALAPPDATA%\Programs\Antigravity IDE\` · data in `~/.gemini/antigravity-ide/` |

Neither Claude Code nor Codex was installed via npm — both are desktop apps that
ship their own CLI binary.

---

## 2. Claude Code

**Mechanism: the documented `PreToolUse` hook.**

- Config: `~/.claude/settings.json` (or `.claude/settings.json` per project).
- Input: JSON on stdin. Output: JSON on stdout.
- Decision field: `hookSpecificOutput.permissionDecision` — accepts
  `"allow"`, `"deny"`, `"ask"`.
- Exit 0 with no output = **no decision**; the normal permission flow applies.
  Per the official docs: *"The hook can deny the call, but staying silent doesn't
  approve it."*
- Hook handler types include `command`, `http`, `mcp_tool`, `prompt`, `agent`.
- Timeout → hook cancelled, **no decision** rendered. So a hook that times out
  does not deny. This is why the gateway's internal wait window is set *shorter*
  than the hook timeout: the gateway always returns an explicit `deny` rather
  than letting Claude cancel the hook.

**Verified live:** `claude.exe --settings '<inline hook config>'` fired a
`SessionStart` hook and delivered the documented payload:

```json
{"session_id":"192ba4e4-…","transcript_path":"C:\\Users\\USER\\.claude\\projects\\…jsonl",
 "cwd":"E:\\ALL PROJECTS\\…","hook_event_name":"SessionStart","source":"startup"}
```

So the hook engine, the `--settings` path, and the payload contract are confirmed
working with this exact binary.

**The deny path was then verified live, unintentionally but conclusively.** After
running `agw install-hooks`, the very next `Write` tool call in the Claude Code
session doing this build was gated by the newly installed hook. With no phone
paired, it blocked, waited out the approval window, and returned:

```
No decision arrived before the approval window closed — denied by default
```

Claude Code refused the tool call. The following `Bash` call was refused the same
way. That is the complete `PreToolUse` → gateway → deny → enforcement path,
observed on Claude Code 2.1.229 with the real hook.

Two useful facts fell out of it:

1. Claude Code **does** pick up `~/.claude/settings.json` between turns of a
   running session — hook config is not frozen for the whole session, unlike the
   project-level `.claude/settings.local.json` case below.
2. The LOW-risk **passthrough** path also works: a command containing `echo`
   classified LOW, the gateway returned "no decision", and the tool ran normally.
   That is what made it possible to un-wedge the session without Bash or Write:

   ```
   echo unblocking; node -e "…uninstall({scope:'user'})…"; echo done
   ```

**Still NOT verified:** the **approve** direction for Claude
(`permissionDecision: "allow"`). Two environmental blockers prevented an
automated round trip:

1. A child `claude.exe` cannot authenticate. The desktop host injects the token
   into the CLI subprocess it spawns; `ANTHROPIC_AUTH_TOKEN` is not present in
   this session's environment, so a spawned `claude.exe` reports
   `Not logged in · Please run /login` before it ever reaches a tool call.
2. Adding a hook via project-level `.claude/settings.local.json` **mid-session**
   did not take effect — confirmed by adding a marker-scoped hook and observing it
   never fire. (The user-level file did take effect, per above.)

Use `agw selftest claude --approve` to confirm the allow direction.

### 2.1 Operational hazard found the hard way

Installing the hook with **no paired device** denies every gated tool call, in
every agent, after a full wait window. It is correct fail-closed behaviour and it
is also unusable — the agent appears to hang for minutes and then refuse.

Two mitigations were added as a result:

- The gateway now checks for a reachable device *before* creating a request and
  denies **immediately** with `request.refused_no_device` when there is none.
  Fail closed *and* fail fast.
- `agw install-hooks` refuses to install when no device is paired unless
  `--force` is passed, and prints the escape hatch (`agw uninstall-hooks`).

---

## 3. Codex CLI — fully verified end to end

**Mechanism: Codex's `PreToolUse` hook.** Codex has implemented a
Claude-Code-compatible hook system (`hooks` feature flag is `stable`/enabled;
the binary contains `hook_event_name`, `hookSpecificOutput`,
`permissionDecision`, `permissionDecisionReason`).

Hook events supported: `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`,
`SubagentStart`, `SubagentStop`, `Stop`. Handler types: `command`, `http`,
`prompt`.

### 3.1 Discovery path

Hooks are discovered **only** from `$CODEX_HOME/hooks.json`. Tested and *not*
discovered:

- `~/.codex/hooks/hooks.json`
- `<project>/.codex/hooks.json`
- `<project>/.codex/hooks/hooks.json`
- `<cwd>/hooks.json`

Verified by querying Codex itself over its app-server RPC:

```
codex app-server            # JSON-RPC over stdio, newline-delimited
-> initialize
-> hooks/list  { "cwds": ["<dir>"] }
```

Only the `$CODEX_HOME/hooks.json` entry came back.

### 3.2 Trust is required, and is content-hash bound

A discovered hook is **inert until trusted**. `hooks/list` initially reported:

```json
{ "key": "C:\\Users\\USER\\.codex\\hooks.json:pre_tool_use:0:0",
  "enabled": true,
  "currentHash": "sha256:6fb53cb8…",
  "trustStatus": "untrusted" }
```

An untrusted hook never executes — the first live test ran the command with no
hook invocation at all.

Trust is **not** expressible in `hooks.json` (adding a `state` block there, at
either nesting level, was ignored). It lives in `~/.codex/config.toml`:

```toml
[hooks.state.'C:\Users\USER\.codex\hooks.json:pre_tool_use:0:0']
enabled = true
trusted_hash = "sha256:6fb53cb8…"
```

Two details that matter:

- The TOML key **must be a literal (single-quoted) string**. A double-quoted key
  makes TOML read `\U` in `C:\Users\…` as a unicode escape and the whole file
  fails to parse:
  `config.toml:111:19: too few unicode value digits, expected unicode hexadecimal value`
- `currentHash` covers the handler definition only, so writing the state block
  does not invalidate the hash. Editing the hook command *does*, which correctly
  forces re-approval.

After writing that block, `hooks/list` reported `trustStatus: "trusted"`.

### 3.3 Codex accepts ONLY `deny`

From Codex's own error strings:

```
PreToolUse hook returned unsupported permissionDecision:allow
PreToolUse hook returned unsupported permissionDecision:ask
PreToolUse hook returned unsupported decision:approve
PreToolUse hook returned permissionDecision:deny without a non-empty permissionDecisionReason
PreToolUse hook returned updatedInput without permissionDecision:allow
```

Confirmed behaviourally: returning `"allow"` produced `hook: PreToolUse Failed`
and — because a failed hook is non-blocking — the command ran anyway.

**Consequence for the design:** an approval is expressed as *silence* (exit 0,
empty stdout = "no decision"), and a denial as an explicit `deny` with a
non-empty reason. This keeps the gate fail-closed: the only thing the hook can do
decisively is stop the command, which is exactly the property we want.

### 3.4 Exact payload captured live

```json
{"session_id":"01a0367e-923a-7452-a0e8-0112d7800b4c",
 "turn_id":"01a0367e-92d9-7f40-a9d2-732e9f9458c8",
 "transcript_path":"C:\\Users\\USER\\.codex\\sessions\\2026\\08\\25\\rollout-….jsonl",
 "cwd":"E:\\ALL PROJECTS\\…\\_probe",
 "hook_event_name":"PreToolUse",
 "model":"gpt-5.6-sol",
 "permission_mode":"bypassPermissions",
 "tool_name":"Bash",
 "tool_input":{"command":"echo HELLO_HOOK_PROBE3"},
 "tool_use_id":"call_B8RzDlhwAaVldBUybibBeauc"}
```

### 3.5 Live end-to-end result

`node tests/live/codex-e2e.js` — all checks pass. Codex's own output:

| Scenario | Codex reported |
|---|---|
| Phone approves | `hook: PreToolUse Completed` → command ran |
| Phone denies | `hook: PreToolUse Blocked` · `The command was blocked by the environment's PreToolUse hook: `Denied from TestPhone`` |
| Nobody answers | `hook: PreToolUse Blocked` · `The command was blocked because the approval request expired.` |

---

## 4. Antigravity

**Mechanism: a project-scoped pre-tool hook.** Both installs ship the same Go
language server (`resources/bin/language_server.exe`, 152 MB), which contains:

- `.agents/hooks.json` — the config path (project-scoped; no user-global
  location could be found)
- `"PreToolUse": [` and `"PostToolUse": [` — the config keys
- `PreToolHook`, `PreToolHookArgs`, `PreToolHookResult`, `PreToolHookNames`,
  **`PreToolHookDeniedError`**
- JSON tags `blocked`, `exit_code`, `stdout`, `stderr`, `timed_out`, `duration_ms`
- the format string **`Tool call denied by pre-tool hook: %s`**

So Antigravity does have an enforced pre-tool hook that can deny a call and carry
a reason.

It does **not** contain the Claude/Codex decision field names (no
`permissionDecision`, no `hookSpecificOutput`, no `hook_event_name`), so its
output convention differs — `blocked` + `exit_code` imply that a non-zero exit
blocks and the reason comes from the hook's output.

Because the precise convention is undocumented, the adapter emits **both** on a
denial: a non-zero exit code, a reason on stderr, *and* a Claude-style JSON
decision on stdout. Whichever it reads, it sees a denial. An approval is the
unambiguous "no objection": exit 0, no output.

Also present but **not** approval interception points, and therefore unused:

- MCP support — `mcp_config.json` with `mcpServers`, `command`/`args`/`env`/`serverUrl`,
  plus `streamableHttp` and SSE transports. Both files exist and are empty:
  `~/.gemini/antigravity/mcp_config.json`, `~/.gemini/antigravity-ide/mcp_config.json`.
  An MCP tool is something the agent chooses to call; it cannot gate a tool the
  agent did not choose to route through it.
- Command allow/deny lists — `user_allowlist`, `user_denylist`, `system_denylist`,
  `system_denylist_regex`, `mcp_allowlist`. Local static policy, not remote approval.

**NOT verified live.** Antigravity's agent runs inside the IDE and cannot be
driven from a script the way `codex exec` can. `agw selftest antigravity` makes
this a one-step manual check. Until you run it, treat Antigravity support as
*implemented to the observed contract, unconfirmed*.

---

## 5. Windows launch quirk that silently defeats hooks

Codex hands a hook's `command` string to `%COMSPEC%` (cmd.exe — the binary
references `COMSPEC` next to `hooks.json`). Under `cmd /c "<string>"`, a string
that **starts** with a quoted executable path fails outright:

```
"C:\Program Files\nodejs\node.exe" "E:\ALL PROJECTS\…\hook.js" codex
  -> '"C:\Program Files\nodejs\node.exe"' is not recognized as an internal
     or external command
```

Codex surfaces that as `hook: PreToolUse Failed` — and a failed hook is
**non-blocking**, so the command would run unapproved. This is the single most
dangerous failure mode found, because it fails *open* at the shell level, before
any of our fail-closed logic runs.

All quoting variants were tested (`scripts/probe-cmd-forms.js`):

| Form | Result |
|---|---|
| `"<node>" "<script>" codex` | FAILS |
| `node "<script>" codex` | fails when the script path contains spaces |
| **`<shim>.cmd` at a space-free path, bare** | **WORKS** (stdin intact) |
| `"<shim>.cmd"` quoted | FAILS |
| `""<node>" "<script>" codex"` | FAILS |
| 8.3 short paths, unquoted | fails when a path segment has spaces |
| `cmd /c ""<node>" …"` | FAILS |

**Fix:** the installer generates a launcher `.cmd` in `%AGW_HOME%\hooks\`
(`C:\Users\<you>\.agw\hooks\` — no spaces) and registers that bare path as the
command. Quoting is safe *inside* the `.cmd`. The shim also pins `AGW_HOME` so a
hook always reaches the gateway that installed it. If the shim path itself
contains spaces, the installer falls back to the 8.3 short name and warns if
neither is available.

Verify with `node scripts/verify-shim.js codex` — it asserts the shim is
reachable through `cmd /c` and that it denies when no gateway is running.

---

## 6. Reproducing this inspection

Raw probe artifacts are in `docs/evidence/`:

- `probe-hook.js` — the hook used to capture live payloads
- `hooks-list.js` — minimal Codex app-server client for `hooks/list`
- `probe-log.jsonl` — the captured Codex `PreToolUse` payload
- `sessionstart-log.jsonl` — the captured Claude Code `SessionStart` payload

Re-runnable checks:

```bash
node scripts/probe-cmd-forms.js       # which cmd.exe form survives
node scripts/verify-shim.js codex     # shim reachable + fails closed
node tests/live/codex-e2e.js          # full live Codex approve/deny/timeout
```
