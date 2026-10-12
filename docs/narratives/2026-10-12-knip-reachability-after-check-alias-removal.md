---
date: 2026-10-12
importance: low
nature:
  - insight
tags:
  - smoke
  - knip
related_rules:
  - .claude/rules/test-trigger.md
related_issues:
  - "#1637"
summary: |
  Removing the package.json check: alias mechanism left the only two .mjs
  smokes as unused files for knip, which is why the smoke glob entry exists.
---

# knip reachability after the `check:` alias mechanism was dropped

Moved verbatim from `.claude/rules/test-trigger.md` ("Registering a smoke script"); the rule keeps the glob-entry requirement and a one-clause pointer here.

A smoke reached only through a removed `package.json` `check:` alias becomes an "unused file" the moment that alias is removed, exactly as happened when Issue #1637 dropped the alias mechanism for `check-artifact-sandbox-boundary.mjs` / `check-artifact-server-story-e2e.mjs` (the only two `.mjs` smokes, `knip.json`'s root `project` scope being `.mjs`-only; `.ts` smokes were invisible to `lint:unused` before this entry pattern existed).
