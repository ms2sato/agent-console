---
date: 2026-10-12
importance: low
nature:
  - insight
tags:
  - smoke
  - pty
  - signals
related_rules:
  - .claude/rules/test-trigger.md
related_issues:
  - "#1872"
summary: |
  Measured against the real bunTerminalProvider, an interactive shell PTY
  survived SIGTERM for 1509ms but exited on SIGHUP in about 20ms.
---

# PTY shell teardown: SIGTERM vs SIGHUP, measured

Moved verbatim from `.claude/rules/test-trigger.md` ("Registering a smoke script"). The rule itself (tear a PTY shell down with `SIGHUP`, not `SIGTERM`; fix the signal, not the bound) stays in the rule.

Measured against the real `bunTerminalProvider` (Issue #1872): an `sh -c '...; exec sh'` PTY was still alive 1509ms after `SIGTERM`; `SIGHUP` exited it in ~20ms. A kill-then-wait-for-exit race built on `SIGTERM` therefore loses on nearly every cycle even absent contention, which makes its own timeout a fixed per-cycle tax rather than a rare-path safety margin — widening THAT specific timeout (as opposed to a genuine polling ceiling) multiplies total runtime instead of fixing anything.
