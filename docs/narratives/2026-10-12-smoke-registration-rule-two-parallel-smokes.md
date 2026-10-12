---
date: 2026-10-12
importance: low
nature:
  - incident
tags:
  - smoke
  - registration
related_rules:
  - .claude/rules/test-trigger.md
related_issues:
  - "#671"
summary: |
  Two smokes were added in parallel and neither was registered, because the
  registration requirement existed only as examples, not as a rule.
---

# Two smokes added in parallel, neither registered

Moved verbatim (2026-10-12, Issue #1950; the original incident date is not recorded in the source) from `.claude/rules/test-trigger.md` ("Registering a smoke script"), where it stood as the lesson paragraph under the first two rule paragraphs.

(Lesson: Issue [#671](https://github.com/ms2sato/agent-console/issues/671)'s sibling problem, surfaced twice in one day. Two smokes were added in parallel and neither was registered; the second author could not have learned it from the first author's correction, because the requirement existed nowhere as a rule — only as four examples that a reader had to generalise from unprompted. This section is what stops the next one; `scripts/smoke/__tests__/registry-reachability.test.ts` — every `scripts/smoke/*` basename must appear here — is what stops it mechanically.)
