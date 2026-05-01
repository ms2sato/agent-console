# Claude Code hooks

This directory contains hook scripts referenced by `.claude/settings.json`.
Each hook is a single executable invoked by the Claude Code runtime at a
specific lifecycle event; the runtime pipes the event JSON to stdin and acts
on the script's stdout / exit code.

## Prerequisites

`enforce-permissions.sh` (the `PreToolUse` hook) parses its event JSON with
`jq`. If `jq` is not on `PATH`, the hook fail-closes on every
`Bash|Read|Write|Edit` invocation and the agent deadlocks (see Issue #730).
Install `jq` once per environment:

```bash
brew install jq        # macOS (Homebrew)
apt-get install jq     # Debian/Ubuntu
dnf install jq         # Fedora / RHEL 8+
yum install jq         # RHEL 7 / older
pacman -S jq           # Arch Linux
```

`check-prerequisites.sh` runs at `SessionStart` and verifies this — if `jq`
is missing it prints the install one-liners above and exits non-zero, so the
deadlock surfaces as an actionable error before the first tool call rather
than as a silent string of denied operations.

## Hooks in this repository

| Script                     | Event         | Matcher              | Purpose                                                           |
| -------------------------- | ------------- | -------------------- | ----------------------------------------------------------------- |
| `check-prerequisites.sh`   | `SessionStart`| (any)                | Verify external prerequisites (`jq`) are on PATH; fail fast otherwise |
| `gh-setup.sh`              | `SessionStart`| (any)                | Install `gh` CLI on Claude Code on the Web                         |
| `enforce-permissions.sh`   | `PreToolUse`  | `Bash\|Read\|Write\|Edit` | Reject catastrophic / credential-touching operations              |

## `enforce-permissions.sh` policy

The Claude Code runtime guarantees that **a `permissionDecision: "deny"`
returned from a `PreToolUse` hook blocks the tool even in
`--dangerously-skip-permissions` (bypassPermissions) mode**. We use this
to mechanically block the small set of operations whose blast radius is
catastrophic, while leaving everything else to the agent's normal
confirmation flow.

### Policy: deny strong, ask minimal

This system spawns parallel Claude Code agents that routinely
`git push` and `gh pr create`. Treating those as `ask` would defeat the
parallelism the platform exists for. The hook therefore **never** returns
an `ask` verdict — it either denies a known-dangerous pattern or stays
out of the way.

### Categories

#### Article-aligned core (catastrophic verbs)

| Pattern                                         | Why                          |
| ----------------------------------------------- | ---------------------------- |
| `rm -r{,f} / -f / --recursive / --force`        | Mass destruction             |
| `sudo`                                          | Privilege escalation         |
| `ssh <args>`                                    | Outbound shell to other host |
| `dd if=… of=…`                                  | Block-level overwrite        |
| `kill -9 / -KILL`                               | Forceful process kill        |

#### Credential files (read AND write are denied)

`.env`, `.env.<suffix>`, `.aws/`, `.ssh/`, `id_rsa*`, `*.pem`, `.gnupg/`.
Reads are denied because exfiltration via `cat .env` is itself the
attack; the hook treats any reference in a Bash command, or any
Read/Write/Edit `file_path` matching the pattern, as deny.

#### This-system specifics

| Pattern                                         | Why                                                     |
| ----------------------------------------------- | ------------------------------------------------------- |
| `rm` / `find … -delete` inside `~/.agent-console/` | Production data directory of the platform               |
| Direct write to `*.db`                          | SQLite production data file                             |
| Direct edit to `.git/{refs,HEAD,hooks}`         | Bypasses git's own integrity guarantees                 |
| `git push --force / -f / --force-with-lease`    | When the last token resolves to `main` or `master`      |
| `git push origin :main` / `:master`             | Branch-deletion form                                    |

### Bypass detection

The hook normalises the command before pattern-matching:

1. **Quote splitting** — strips single and double quotes so `'r''m' -rf`
   collapses to `rm -rf` for detection. The actual command Claude Code is
   about to run is unchanged.
2. **`bash -c "<body>"` / `sh -c '<body>'`** — extracts the inner body
   and includes it in the haystack so wrapped commands are also matched.
3. **Pipe / xargs** — patterns are word-boundary-aware so
   `echo /tmp/x | xargs rm -rf` is matched.

The hook does **not** attempt to detect language-level bypass (e.g.
`python -c "os.system('rm -rf /')"`). That class of evasion is out of
scope; trying to cover it with regex produces false positives without
meaningfully improving safety.

### Fail-closed behaviour

The script exits with code 2 (which Claude Code treats as a blocking
error) when:

- `jq` is not on `PATH`
- stdin is empty
- the JSON event cannot be parsed
- `tool_name` is missing

This means a misconfigured environment cannot silently allow dangerous
operations. The trade-off is that you must keep `jq` installed; on
macOS it ships with `brew install jq`, and on Claude Code on the Web it
is pre-installed.

### Tests

Sibling tests live at
`.claude/hooks/__tests__/enforce-permissions.test.mjs` and run as part
of `bun run test` (via `test:scripts`). They pipe representative event
JSON to the script and assert the verdict, including bypass-attempt
cases and the fail-closed paths.

### Emergency bypass for false positives

If a legitimate operation is denied because it happens to match a deny
pattern (a false positive), the only supported recovery is to disable
the `PreToolUse` hook in `.claude/settings.json` and restart the
session. There is intentionally no env-var or runtime flag to skip
the hook — see "Out of scope" below.

This is an in-the-moment recovery procedure for the operator running
the session, not a permission-escalation tool. Disabling the hook
removes the deny gate for **every** subsequent tool call until it is
re-enabled, so use the smallest window possible and re-enable
immediately after the blocked operation completes.

#### Disable

1. Open `.claude/settings.json`, copy the entire `PreToolUse` block
   whose command is `./.claude/hooks/enforce-permissions.sh` to a
   scratch buffer (you will paste it back during re-enable), then
   delete it from the file. Standard JSON does not support comments,
   so commenting out is not an option — temporary deletion plus a
   scratch copy is the supported path.
2. Restart the Claude Code session. Hook configuration is read at
   session start; an in-flight session continues to enforce the old
   configuration.
3. Perform the previously-denied operation.

#### Re-enable

1. Paste the `PreToolUse` block from your scratch buffer back into
   `.claude/settings.json` at its original location.
2. Restart the Claude Code session.
3. Verify the hook is active by attempting a known-denied operation
   (e.g., `rm -rf /tmp/non-existent-test-path`) — the runtime should
   block it.

#### Follow-up: report the false positive

After recovery, file a bug report so the deny patterns can be
refined. Use the
[Bug report template](../../.github/ISSUE_TEMPLATE/bug-report.yml)
and include:

- The exact tool call that was denied (full command for `Bash`, full
  `file_path` for `Read|Write|Edit`)
- The category in the
  [policy table](#categories) you believe matched
- Why the operation was legitimate

When the denial covers force-push or branch-deletion patterns
(`git push --force`, `git push origin :main`/`:master`), the policy
rationale lives in
[`../rules/workflow.md` § Force-Push and Rebase Gating](../rules/workflow.md#force-push-and-rebase-gating).
Reference that section in the bug report so the discussion has shared
context on the protected-branch and rebase-approval rules the hook
enforces.

Refining the patterns from real false-positive reports is how the
denylist stays both strict and usable; silent workarounds (operators
keeping the hook disabled) are the failure mode this section exists
to prevent.

#### Out of scope

A runtime bypass that does not require editing `settings.json`
(environment variable, magic comment, allowlist file under version
control) is intentionally not provided. Any such mechanism would
re-introduce the very escape hatch the
[deny strong, ask minimal](#policy-deny-strong-ask-minimal) policy
exists to close, and would be vulnerable to the same prompt-injection
attacks the hook defends against.

## Adding a new hook

1. Create the script under `.claude/hooks/<name>.sh`. Keep it
   `set -u`-clean and `command -v <prereq> >/dev/null 2>&1 || exit 2`
   for any external dependency (fail-closed).
2. Add an executable bit (`chmod +x`).
3. Register it in `.claude/settings.json` under the appropriate event
   (`SessionStart` / `PreToolUse` / `PostToolUse` / `Stop` / `Notification`).
4. Add sibling tests under `.claude/hooks/__tests__/` and verify they
   are picked up by `bun run test:scripts`.
5. Document the script in this README's "Hooks in this repository"
   table.

## Cross-project deployment

This configuration is committed to the `agent-console` repository so
every worktree spawned for development of this project (Orchestrator
session and delegated agents alike) inherits the same denylist. To
extend coverage to another repository, copy `.claude/settings.json`
(its `PreToolUse` block) and `.claude/hooks/enforce-permissions.sh`
into that repository's tree. Each repository's owner is responsible
for tuning the denylist to their codebase.
