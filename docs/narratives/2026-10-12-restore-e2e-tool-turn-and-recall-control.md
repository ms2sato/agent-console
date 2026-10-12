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
summary: |
  Every claude-sdk restore E2E was text-only, so a restore defect reached users; and a green recall run was a fact about one sampling of a non-deterministic answer.
---

# Restore E2E: the tool-turn rule and the green recall that proved nothing

Moved verbatim (2026-10-12, Issue #1950) from `.claude/rules/smoke-verification-embedded.md`; the original incident date is not recorded in the source. The rule keeps a one-clause pointer here.

 — on a two-turn conversation of thirteen lines, with no rotation involved

Every shipped `claude-sdk` restore E2E and smoke was text-only. That is the whole reason the defect reached a user-facing surface with the feature otherwise fully covered: within a single process it works, and the failure appears only across a restart, only after a tool was used, and only as an absence.



(Lesson: both smokes had their planting turn routed through a tool in one change, which made "the secret word I told you" false in both. The eviction smoke's control broke loudly and forced an investigation; the fatal smoke's recall **passed, 18 of 18**, and forced nothing. The difference was not the defect, which was identical — it was how the model happened to answer once. **A green run there was a fact about one sampling of a non-deterministic answer, not a fact about the assertion.** It was found by review, after both an implementer and an orchestrator had read the run as clean.)
