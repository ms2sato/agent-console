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
  - "#1944"
summary: |
  Recorded polarity runs and the diagnostic evidence for the exited-row pin that reads OK for worker B on the real tree.
---

# Restart-all embedded smoke: measured results and the vacuous-pin diagnostics

Moved verbatim (2026-10-12, Issue #1950) from `.claude/rules/smoke-verification-embedded.md`; the original incident date is not recorded in the source. The rule keeps a one-clause pointer here.

**Measured 2026-10-10, against `main` at ef7fd39b.** Default mode (head `bb2d8ea3`): PASSED, 10/10. `--expect-not-restarted` against the one-hunk scratch revert (never committed; `git diff --stat` empty and `git status` clean once restored): `POLARITY: bug reproduced`, 7/7, exit 0. `--expect-not-restarted` against the unmodified real tree: `POLARITY FAILURE`, **3 passed / 4 failed, exit 1** -- confirming the flag asserts rather than tolerates (A's pid-unchanged, A's `exited`-row-within-5s, and A's same-incarnation-recall assertions all correctly fail; that alone is sufficient for the POLARITY FAILURE verdict).

**Known gap, tracked as Issue [#1944](https://github.com/ms2sato/agent-console/issues/1944) (filed separately from #1552): B's `exited`-row-within-5s pin stays `OK` on the real tree even though B is actually restarted alongside A.** First observed with an immediate (non-polling) read; re-measured after switching to the 5s bounded poll above, and the gap persisted identically -- so this is not a flush-timing artifact a wider window fixes. Diagnostic evidence gathered without any further billed run (re-reading the already-captured pino output from the same runs): no `restore-failure` / fallback / `resetWorkerOutput`-fallback warning fired for either worker, and no `flush`-related warning either (`grep -in "flush"` across both run-3 captures: 0 hits) -- which rules out the two initially-hypothesized mechanisms. B took the quiet "4e: success" restore path, identically to A, so whatever is losing B's `exited` row is a different mechanism; #1944 tracks it as a symptom with four refuted hypotheses and three open candidates. B never receives a turn after reactivation in polarity mode (unlike A, which gets the recall turn); that may be a relevant variable. This assertion is therefore **currently vacuous for B on the real tree** -- it reads `OK` whether or not the underlying defect is present -- and is kept as written anyway, per the Architect's ruling, because once #1944 is fixed it becomes B's regression net: run 3 (real tree, unmodified) must then flip from 3 pass / 4 fail to **2 pass / 5 fail**. Treat a future 2p/5f result on this exact invocation as the fix landing, not as a new failure.
