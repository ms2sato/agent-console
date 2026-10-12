---
date: 2026-10-12
importance: low
nature:
  - insight
tags:
  - smoke
  - embedded-agent
related_rules:
  - .claude/rules/smoke-verification-embedded.md
related_issues:
  - "#1414"
summary: |
  Replacing deactivation with a direct SIGKILL passed twenty other assertions; only settle latency and the exit code moved.
---

# Mutation measurement behind the idle-eviction graceful-exit assertion

Moved verbatim (2026-10-12, Issue #1950) from `.claude/rules/smoke-verification-embedded.md`; the original incident date is not recorded in the source. The rule keeps a one-clause pointer here.

 Replacing the deactivation call with a direct `SIGKILL` of the harness, which is exactly the hazard-line violation Issue [#1414](https://github.com/ms2sato/agent-console/issues/1414) makes dangerous, **passed all twenty other assertions**: the child dies anyway when it loses its stdio pipes, the exit observer still fires, and the reason is still `evicted`. Only the settle latency (1 ms against 253 ms) and the exit code moved, and the exit code is the one that separates them deterministically.
