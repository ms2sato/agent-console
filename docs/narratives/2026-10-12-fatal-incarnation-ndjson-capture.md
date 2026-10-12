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
  - "#1468"
summary: |
  The capture step exists because a run's raw event stream was otherwise destroyed at the end of the run; HOME was chosen over the OS temp dir for durability.
---

# Why the fatal-incarnation smoke captures worker NDJSON under HOME

Moved verbatim (2026-10-12, Issue #1950) from `.claude/rules/smoke-verification-embedded.md`; the original incident date is not recorded in the source. The rule keeps a one-clause pointer here.

 Read this **before** running the smoke, not after losing a run you wanted to keep: without this, every run's raw event stream is destroyed the moment the run ends, which is what happened to the reader shape recorded in Issue [#1468](https://github.com/ms2sato/agent-console/issues/1468) (observed in 1 of 6 runs, never captured, and unrecoverable once gone — see that Issue for the shape itself, deliberately not turned into a hand-built fixture).

  - **Why `$HOME`, not `os.tmpdir()`.** `/tmp` is reboot-cleared on Ubuntu and may be swept by `systemd-tmpfiles` on an age basis; this smoke's billed runs also happen inside a delegate's worktree, itself deleted post-merge. Both are the same loss this Issue exists to stop — the NDJSON that prompted it (`/tmp/fatal3.log`) was already gone through exactly this route by the time anyone asked for it. `$HOME` survives both.
