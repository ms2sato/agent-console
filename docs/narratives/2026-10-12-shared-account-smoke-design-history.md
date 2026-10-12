---
date: 2026-10-12
importance: low
nature:
  - incident
tags:
  - smoke
  - embedded-agent
related_rules:
  - .claude/rules/smoke-verification-embedded.md
related_issues:
  - "#1842"
summary: |
  Why the smoke reads a terminal worker, the unelevated-PTY defect found in the smoke itself, the one-time cross-tree measurement, and the assertion-reach mutation.
---

# Shared-account binding smoke: design history and measurements

Moved verbatim (2026-10-12, Issue #1950) from `.claude/rules/smoke-verification-embedded.md`; the original incident date is not recorded in the source. The rule keeps a one-clause pointer here.

This Docker verification container has no `claude` CLI login, so an agent-type worker's PTY predictably exits 127 ("command not found") moments after activating, and `WorkerManager.detachPty` (the ordinary exit-handler path) resets its `pty` back to `null` well within any practical polling interval -- confirmed by direct object-identity-tagged instrumentation before this design was adopted, not assumed.

 This was a real, previously-undetected defect in this smoke: without the override, every PTY it drove was unelevated, and after the terminal-worker rewrite above, the added terminal worker's PTY never activated at all within its 30s deadline (confirmed by removing the override and re-running -- every PTY-identity assertion failed; see the #1842 PR body for the recorded exit).

 The one-time measurement instead runs a disposable, never-committed copy of this smoke's setup against a throwaway `git worktree` checked out at the pre-#1842 commit, with its registry construction swapped for the real (and, on that checkout, still-existing) `SharedAccountRegistry.create()` factory.

**The reach of the "PTY owner is not the server process's own user" assertion was measured on 2026-10-08** via an unelevated-spawn mutation in the tier-2 container (the `MultiUserMode` instance's `spawnPty` delegating to a `SingleUserMode`, with `cwd` and the exec's `SHELL` neutralised as recorded proxies): the PTY still activated, both owners resolved to the server user, and the assertion fires with `got <server user>`; the smoke's header comment carries the full record and nothing from the mutation is committed.
