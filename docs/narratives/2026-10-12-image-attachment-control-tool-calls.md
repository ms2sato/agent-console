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
  - "#1630"
summary: |
  Before the fix, the attachment path reached the model regardless of supportsImages, and a control worker spent five tool calls trying to open it.
---

# Image-attachment control arm: pre-fix tool-call measurement

Moved verbatim (2026-10-12, Issue #1950) from `.claude/rules/smoke-verification-embedded.md`; the original incident date is not recorded in the source. The rule keeps a one-clause pointer here.

 Before #1630, the attachment's raw path reached the model's delivered text (via `composeEmbeddedAgentDeliveryText`, unconditionally, regardless of `supportsImages`) and `CANNOT_VIEW_IMAGES_NOTE` invited the model to treat it as a reference rather than forbidding investigation -- a CONTROL worker with Read/Glob/Grep access (the default `enabledTools`) could still spend a tool call trying to open a path it had no legitimate use for. Q12 measurement on unmodified main (Issue #1630, one real `openai-api` turn against `qwen3.8-flash` with Bash additionally enabled) reproduced the full symptom: 5 `tool-call` events (`file`/`which`/`stat`/`strings`+`od`/a hand-rolled PNG-chunk decoder) before the model gave up -- the tool-call count is reported honestly either way, not assumed to be the Issue's own 5-call reproduction, since this smoke's CONTROL definition has a narrower tool set than the Issue's exact repro.
