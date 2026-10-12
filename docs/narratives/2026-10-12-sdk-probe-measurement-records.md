---
date: 2026-10-12
importance: low
nature:
  - insight
tags:
  - smoke
  - sdk-probe
related_rules:
  - .claude/rules/smoke-verification-sdk-probes.md
summary: |
  Measured results, run history and found-and-fixed notes for the P-c and settingSources probes, moved out of the rule.
---

# SDK premise probes: measurement records and run history

Moved verbatim (2026-10-12, Issue #1950) from `.claude/rules/smoke-verification-sdk-probes.md`; the original dates are in the text where recorded. The rule keeps the conclusion as one clause.

## Auto-memory: unrelated activity precedent

(precedent: Task 0's own manual real-tree addendum found nonce matches only in top-level session transcripts, explicitly not under `memory/`, and dismissed them as ordinary conversation — this filter mechanizes exactly that distinction)

## Wall: operational history

Operationally this probe was run across MANY invocations, not one: `--armA` alone first, its result reported before anything else started; the addenda were dispatched by the Orchestrator/Architect live, in response to findings each prior arm surfaced (see Issue [#1781](https://github.com/ms2sato/agent-console/issues/1781)'s PR for the full transcript and per-arm tables).

## Pc: measured 2026-09-21

**Measured 2026-09-21 (non-elevated branch):** SET case -- CLI-native `env` expansion delivered the real value; the loader's `args` substitution delivered the same real value. UNSET case (Control) -- the CLI left `env` as the literal, unexpanded placeholder string (one of the two outcomes the Issue's own AC anticipated, "empty/literal"); the loader left `args` literal per `applyArgSubstitution`'s documented unset-with-no-default behavior; the loader's stderr warning (`"...is unset and has no default; leaving ... literal in args"`) was directly observed in the subprocess's piped stderr, captured via `LOG_LEVEL=debug`. The same run also asserts a same-run positive control: the spawn report (item 1's addition) is byte-equal to the tool-result reading for BOTH fixtures -- a mismatch is a harness failure, not a finding, and this equality is what licenses reading the elevated arm from the spawn report alone.

## Pc: measured 2026-09-22 + item 5b

**Measured 2026-09-22 (elevated arm, item 4's free gate).** Run inside the tier-2 verification container (`scripts/verify-multiuser-docker.sh --keep`), as a real second OS user (`alice`) carrying NO credentials of any kind (`{}` `.claude.json` only, no `.claude/` directory, no `claude` binary on PATH), through the real `spawnAsUser` elevation (`runAsUser`/`spawnAsUser` logs confirm `elevated: true`, not a same-user bypass). OUTCOME (i): both declared MCP servers started WITHOUT a login. Both channels (env and args) left `${PROBE_VAR}` LITERAL under elevation -- neither the CLI's native `env` expansion nor the loader's `args` substitution resolved a real value.

**Item 5b (Architect addition): with `export PROBE_VAR=<nonce>` appended to the target user's own login-shell profile, the SET fixture's spawn report carried the nonce in both `env` (CLI-native expansion) and `args` (the loader's substitution); with the export removed, both were literal again; the UNSET control was literal in all three runs.** This confirms `docs/design/embedded-agent-sdk-engine.md` §4.5's working assumption on both halves: the server process's own export does not cross the elevation boundary, and `${VAR}` does resolve against the TARGET USER's own login-shell profile once exported there. Mechanism: `spawnAsUser`'s elevated branch resets the login shell's environment and re-exports only the six `AGENT_CONSOLE_*` identity keys, so the server's export never crosses; the target user's own profile is read by the login shell it starts, same as that user's own interactive session. Three runs (no export / with export / export removed), clean separation, exit 0 all three times.

## Pc: ready race

**A `ready`-before-MCP-connect race, found and fixed while building this arm.** The worker's `ready` event does not guarantee every declared project MCP server has finished connecting -- one local dry run (target user equal to the invoking user, no real elevation, free) observed `ready` fire, then a fixture's spawn report land roughly 1.5-3.2s LATER, with no prompt sent. `ready` (`sdk-engine.ts`) means the engine constructed the SDK query and started its consumer; it is NOT gated on the CLI's own `system:init`, which does not arrive until the first prompt is sent -- so `ready` fires essentially immediately, before the CLI's own project-server connections have necessarily made any progress. Reading the reports at the instant of `ready` can therefore observe an ABSENT report about to be written a moment later -- a false outcome (ii). The fix is a short GRACE WINDOW (currently 8s, capped by the same 60s overall gate deadline -- the gate's timeout is the bound, the grace window is not a second, unbounded wait) after `ready`/`fatal`/`turn-error` fires, during which the loop keeps polling the reports themselves and exits the instant both appear.

## Pc: stale image trap

**A stale-image trap, found while running item 4.** `scripts/verify-multiuser-docker.sh --keep`, when a prior invocation's outer timeout kills the build mid-flight, leaves the PREVIOUS `agent-console-multiuser-verify:latest` image tag in place -- `docker compose up --build` only re-tags the image on a build that completes successfully, so a killed build silently runs OLD code with no build error of its own. The tell was a `Module not found` for a file the current worktree has but an image built days earlier does not. **Rebuild the image after any change to the probe or its fixture; a stale image runs stale code.**

