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
  - "#1795"
summary: |
  Born from diagnosing a read-too-early bug in arm 3.
---

# Why the project-MCP-permission smoke captures worker NDJSON

Moved verbatim (2026-10-12, Issue #1950) from `.claude/rules/smoke-verification-embedded.md`; the original incident date is not recorded in the source. The rule keeps a one-clause pointer here.

 Born from diagnosing the arm-3 read-too-early bug (Issue #1795): the capture let the exact `mcp-servers-discovered` sequence across a restart be inspected after an aborted run, without a billed re-run.
