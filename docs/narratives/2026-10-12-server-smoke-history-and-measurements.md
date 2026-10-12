---
date: 2026-10-12
importance: low
nature:
  - insight
tags:
  - smoke
  - server
related_rules:
  - .claude/rules/smoke-verification-server.md
summary: |
  History, measurements and rationale (trust-dialog workaround, polarity records, provider-split
  history, CI-wrapper reasoning) moved out of the server smoke registry rule.
---

# Server, PTY and elevation smokes: history and measurements moved out of the rule

Moved verbatim (2026-10-12, Issue #1950) from `.claude/rules/smoke-verification-server.md`; the rule keeps the operative statement of each.

## Backfilled note

**The fourteen sections below and the three SDK probe sections in `smoke-verification-sdk-probes.md` register the fifteen scripts that had no `check:` alias and no section before Issue #1637 — the old "alias + section" rule never caught them** (one section, "SDK H2 Transport-Settle Probe Pair", covers two sibling files).

## webhook scenario 6 history

 Scenario 6 deliberately does NOT use a literal syntactically-valid-but-never-persisted session id for the "dead" parent -- that construction was tried first and found to trip a separate `job-handler.ts` defect (no per-target failure isolation: a `createPendingNotification` insert for a target whose `sessionId` has no corresponding `sessions` row threw an uncaught `FOREIGN KEY constraint failed`, crashing and retrying the WHOLE job until it stalled, so the fallback target -- appended last in the array -- never got processed). **That defect has since been fixed (Issue [#1677](https://github.com/ms2sato/agent-console/issues/1677), per-target failure isolation in `job-handler.ts`) and is now exercised directly by scenario 7 below**; the paused-session construction here continues to exercise the same `resolveTargets` code path for the DIFFERENT "parent's DB row survives, but the parent is absent from the live session manager" shape.

## webhook trust dialog

**A real, environment-specific wrinkle this script had to work around: the interactive `claude` CLI's own trust dialog.** A brand-new working directory (every fresh `git worktree add` path) trips the CLI's "Do you trust the files in this folder?" TUI prompt at PTY startup, which blocks forever with no automatic resolution -- unlike `claude-sdk` embedded-agent workers (which set the SDK's `permissionMode` and never show this prompt), no other smoke in this file exercises a real terminal-agent PTY, so this is the first place it surfaces. The script bypasses it by seeding an ISOLATED `CLAUDE_CONFIG_DIR` (a copy of the real OS user's own `~/.claude.json`, read-only, with `projects` entries added for the worktree paths -- never a mutation of the real file, so this smoke has no persistent side effect on the host) before spawning the disposable server; `CLAUDE_CONFIG_DIR` is not in `packages/server/src/services/env-filter.ts`'s blocked/protected lists, so it passes through to the spawned PTY unchanged. A from-scratch (non-copied) config was tried first and rejected: it lacks `hasCompletedOnboarding` and triggers the CLI's full first-run onboarding wizard instead, an equally-blocking prompt.

## webhook scenario 4c tail

 The remaining scenarios are unchanged: 6 and 7 still assert "T receives neither", and 4c was inserted before scenario 5 so scenario 7 stays the LAST webhook poster (its "most recent job" query depends on that).

## webhook no CI wrapper

**Deliberately NOT given a `#1872`-style `*.run.test.ts` CI wrapper, even though it is free.** This smoke seeds an isolated `CLAUDE_CONFIG_DIR` from a COPY of the operator's real `~/.claude.json` (see this section's own "trust dialog" paragraph above) and spawns real `claude-code-builtin` PTYs. A GitHub-hosted CI runner has neither that file nor the `claude` CLI installed, so the smoke is free but not PORTABLE -- "free and deterministic" (#1872's wrapping criterion) is necessary but not sufficient; the runner also has to be able to run it at all. It stays a manual gate for that reason, distinct from the four smokes #1872 wrapped (`check-exit-127-diagnostic.ts`, `check-pty-als-data.ts`, `check-pty-early-output.ts`, `check-stdin-sink-leak.ts`), none of which depend on the operator's own Claude Code config or binary.

## bash env #1694 sentence

 (the #1694 acceptance sentence; the pre-#1694 shape asserted no `AGENT_CONSOLE_*` key at all, which is exactly what the injection makes false)

## bash env polarity

 Polarity was measured in the tier-2 container when #1694 landed: the flipped assertion fails on the pre-fix tree and passes with the fix.

## elevation polarity

 Polarity measured in the tier-2 container when #1694 landed: fails on the pre-fix tree (`matches=0`), passes with the fix.

## exit-obs provider history

; this was the AC's own original touch-trigger wording's mistake, corrected after #1879's measurement showed a real LOST-EXIT against `bun-pty` while an identical full-suite-concurrent run against `bun-terminal` was clean -- see #1879's findings comments and the resulting [#1886](https://github.com/ms2sato/agent-console/issues/1886) (test/smoke fidelity: `check-exit-127-diagnostic.ts` and `createTestContext` both hardcode the legacy provider instead of resolving the configured one). Issue [#1888](https://github.com/ms2sato/agent-console/issues/1888) flipped the default from `bun-pty` to `bun-terminal` once #1886 removed the "mirrors `selfCheck()` exactly" rationale for the old default -- the probe should measure production unless told otherwise.

## exit-obs grace window verdicts

 At 30000ms (the production default), "still in flight" past the grace window is implausible, so #1879's own recorded verdicts are unaffected; `--grace-ms 0` reproduces them exactly, which is also how a future reader confirms this change did not alter the pre-#1888 measurement.

## exit-obs variance record

 (one LOST-EXIT in 20 full-suite-concurrent `--provider bun-pty` cycles, zero in the identical `--provider bun-terminal` run; see Issue #1879's findings comments)

## exit-127 provider record

; Issue [#1886](https://github.com/ms2sato/agent-console/issues/1886) fixed this smoke from hardcoding the legacy `bunPtyProvider`)

## pre-attach ci cost

 -- its own ~21-second wall-clock cost, the most expensive of the four smokes CI-wrapped in #1872, is why the wrapper's `it` carries an explicit timeout, so the "manual gate, never a CI job" wording no longer applies to it.

## als ci cost

 -- its own wall-clock cost is why the wrapper's `it` carries an explicit timeout, so the "manual gate, never a CI job" wording no longer applies to it.

