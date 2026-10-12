---
date: 2026-10-12
importance: low
nature:
  - insight
tags:
  - smoke
  - sdk-probe
related_rules:
  - .claude/rules/smoke-verification-sdk-probes.md
related_issues:
  - "#1781"
summary: |
  Per-arm measured findings of the settingSources/managedSettings wall probe and the P-c probe,
  moved out of the rule because the design-doc premise ledger (PS10-PS16, section 4.5) carries them.
---

# SDK probe per-arm measured findings (moved to the design-doc ledger as the home)

Moved verbatim (2026-10-12, Issue #1950) from `.claude/rules/smoke-verification-sdk-probes.md`. The findings are recorded in `docs/design/embedded-agent-sdk-engine.md` section 5 (PS10-PS16) and section 4.5 (P-c row, D-F); the rule now lists, per arm, what it varies and reads plus the premise it feeds.

## Wall probe: per-arm measured findings (bullets)

- `--armA` -- `settingSources: ['user']`, strict OFF, plus `A+` (omitted, positive control), `A-` (`[]`, isolation), `A2` (`['user']` + `strictMcpConfig: true`). 4 sessions. **Measured finding: local-scope MCP (L) does NOT start under `['user']` alone** -- `A+` proves L's config is reachable, so the gap is `settingSources` scope, not the fixture.
- `--armA3` (addendum) -- `settingSources: ['user','local']`. 1 session. **Clean confirmation**: U+L start, X/Y do not, CLAUDE.md/agent shape unchanged from plain A -- the exact knob design II needs to cover User+Local without leaking project scope.
- `--armC` -- `['user','project']`, strict OFF (baseline). C1/C2/C3 (`allowedMcpServers` exact-argv / mutated / empty) and C5 (`deniedMcpServers`), each via BOTH `managedSettings` and `settings` = 9 sessions. **Measured finding, refuting the AC's cited doc premise: `managedSettings.allowedMcpServers` is NOT dropped -- it is fully and universally enforced**, blocking even the reserved `agent-console` HTTP server and all four claude.ai connectors whenever set with ANY content (C1/C2/C3 collapsed to an identical "everything blocked" reading in BOTH carriers). C5's `deniedMcpServers` survives as documented.
- `--armC1b` (addendum, diagnostic) -- a NAME-ONLY allow entry (no `serverCommand`), both carriers. 2 sessions. Resolves C1/C2/C3's collapsed reading: X IS admitted by name, proving the field works and the compound `serverName`+`serverCommand` entry's argv comparison was the broken piece, not the field itself.
- `--armC1d` / `--armC1e` (addendum, Architect's exact shape) -- one `settings.allowedMcpServers` entry naming `agent-console`, `console`, X, and a claude.ai connector (label form, then slug form) by `serverName` alone. 2 sessions. **Load-bearing finding**: naming the reserved pair re-admits `agent-console`; connectors are NEVER re-admittable by any naming form. **Refined by C1c's byproduct** (below): `console`, an in-process SDK server with no command/url, was never actually gated by `allowedMcpServers` at all -- it connects whether named or not, so only `agent-console` needs explicit naming.
- `--armC1c` (addendum, exact-argv re-test) -- C1's shape re-run with `command` as an absolute path (`process.execPath`), plus C2' (one arg mutated), settings carrier only. 2 sessions. **Both still block X** -- exact-argv `serverCommand` matching is unusable on SDK 0.3.238, and not a path-representation mismatch (a free `claude mcp get` shows the CLI's recorded command/args byte-identical to what was passed).
- `--armB` -- `['user','project']`, strict OFF. B1 `disabledMcpjsonServers` (spawn-canary confirms X never exec'd, not merely disconnected), B2 `enabledMcpjsonServers` (record, not a gate -- the un-listed server still starts), B3 `enableAllProjectMcpServers: false` (no observed effect in this shape). 3 sessions.
- `--armF` -- `['user','project']` + `Settings.claudeMdExcludes` (design III's feasibility input) via both carriers, plus a no-excludes control and a narrow, absolute-path-only F2 variant (added live; project file only, not the broad `**/CLAUDE.md` glob). 4 sessions. **Findings**: the broad exclude via `settings` suppresses ALL THREE CLAUDE.md/rules canaries (including user-level -- the glob is absolute-path-matched); the SAME exclude via `managedSettings` suppresses NONE (dropped -- the opposite carrier behavior from `allowedMcpServers`); the narrow F2 exclude (naming only the project's own file) suppresses project only, leaving user + rules intact -- exactly the scoped knob design II needs.
- `--armE` -- `['project']` + a repo-level `PreToolUse` hook (matcher `Read`) that touches a hook-canary file; control fires it via a real `Read` call, `disableAllHooks: true` suppresses it. 2 sessions. Clean, matches doc.
- `--armD` -- `disableClaudeAiConnectors: true`; reuses arm C's baseline connector reading when run in the same invocation, or runs its own control session standalone. 1-2 sessions. Clean: all 4 connectors gone, everything else unaffected.
- `--armG` -- an explicit `Options.mcpServers` entry whose `args` contains the literal string `${PROBE_VAR}`, versus a DEDICATED `.mcp.json`-declared server with the identical shape (not a reused sibling server -- an earlier version's control reused X's plain declaration, which never carried the placeholder argument, and was discarded). 2 sessions. **Finding: `${PROBE_VAR}` is passed through LITERALLY in `args`, never expanded, on both declaration paths** -- contradicts the AC's "docs say expanded" premise for `args` specifically.
- `--armG2` / `--armG3` (addenda, Orchestrator's follow-up) -- the SAME `${VAR}`-expansion question for `env:`, `headers:`, and `url:` fields instead of `args:`, once via explicit `Options.mcpServers` (G2) and once via `.mcp.json` (G3). 1 session each. **Finding, a per-field asymmetry**: all three of `env:`/`headers:`/`url:` DO expand `${VAR}` (on both declaration paths), while `args:` does not.

## P-c: measured results (non-elevated)

**Non-elevated branch, measured:** SET -- CLI-native `env` expansion and the loader's `args` substitution both delivered the real value. UNSET control -- the CLI left `env` as the literal placeholder; the loader left `args` literal with a stderr warning (observed via `LOG_LEVEL=debug`). A same-run positive control asserts the spawn report is byte-equal to the tool-result reading for BOTH fixtures (a mismatch is a harness failure, not a finding); that equality licenses reading the elevated arm from the spawn report alone (full record: `docs/narratives/2026-10-12-sdk-probe-measurement-records.md`).

## P-c: measured results (elevated + item 5b)

**Elevated arm, measured (outcome (i)):** both declared MCP servers start WITHOUT a login, and `${PROBE_VAR}` stays LITERAL in both `env` and `args` under elevation unless the target user exports it in their own login-shell profile (then both resolve; removing the export makes them literal again; the UNSET control is literal throughout). This confirms `docs/design/embedded-agent-sdk-engine.md` §4.5's assumption: the server process's export does not cross the elevation boundary, because `spawnAsUser`'s elevated branch resets the login shell's environment and re-exports only the six `AGENT_CONSOLE_*` identity keys (full record: `docs/narratives/2026-10-12-sdk-probe-measurement-records.md`).
