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
summary: |
  On a 12,000-token window the character estimator read 5,450 where the provider reported 10,512.
---

# Restore-boundary usage seed: estimator vs provider token gap

Moved verbatim (2026-10-12, Issue #1950) from `.claude/rules/smoke-verification-embedded.md`; the original incident date is not recorded in the source. The rule keeps a one-clause pointer here.

 Measured 2026-08-29 on a 12,000-token declared window: the estimator read **5,450** where the provider reported **10,512** for the same conversation.
