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
  Why-paragraphs (refuted premises, Issue wording corrections, rulings) moved out of the SDK probe rule.
---

# SDK premise probes: design rationale and history

Moved verbatim (2026-10-12, Issue #1950) from `.claude/rules/smoke-verification-sdk-probes.md`; the original dates are in the text where recorded. The rule keeps the conclusion as one clause.

## Fidelity: measurement not a gate

**Why this is a measurement, not a gate.** Per the Issue's own ruling: "a post rate not better than pre is a finding to report, not to hide." The script never fails on a low retention rate — it exits 0 whenever every requested run reached a real boundary and its summary was read, regardless of what fraction of identifiers survived. A non-zero exit means the *harness* could not produce a measurement (a run never reached a boundary within its round/time budget, a turn errored or timed out), which is a different fact from a low rate.

## Fidelity: why real provider

**Why this is the real-provider chain and not a unit test.** The retention outcome is a property of what a real LLM does when asked to distil a real conversation under a real prompt — no fake adapter's output can stand in for that without begging the question the Issue is about. There is currently no CI-level pin on the prompt's composition, since no preservation clause has shipped; this script is the only measurement that exists for this prompt today.

## Instr: stop condition why

, because it means the SDK loads rules independently of `settingSources` and Phase A's custom loader-driven rules layer would be redundant with (or in conflict with) a native one already running underneath it

## Effort: refuted premise

**The refuted premise, which is the whole reason this script exists.** The design for that phase was written on the assumption that the SDK has NO runtime effort setter: a model change would go through `Query.setModel`, and an effort change would have to be applied by RESTARTING the worker in place (`deactivate` then `activate`, with the persisted row re-read at `init`), the engine reporting an `effort-requires-restart` refusal on the `model-params-applied` event and the UI warning the user that changing effort restarts the agent. **This probe measured the opposite, and that entire branch — the refusal reason, the server-side restart-in-place, and the UI sentence — was removed before it shipped.** Do not read the script as redundant with `sdk-engine.test.ts`: the unit tests pin what our code CALLS, and this is the only thing in the repository that measures what the SDK DOES with it. A future SDK bump that changes this behavior surfaces here or nowhere.

## Effort: why medium

 — and `'medium'` is deliberate rather than incidental: `'high'` is simultaneously a plausible set-value and the SDK's own default, so it conflates "the clear was ignored" with "the clear worked and landed on the default", while `'medium'` separates `low` (stale query-time value), `high` (SDK default) and `medium` (clear ignored) cleanly.

## Auto-memory: intro history

This is the Task 0 gate probe for Issue [#1658](https://github.com/ms2sato/agent-console/issues/1658): epic #1636's gap 2 framed auto-memory as "unreachable" from the `claude-sdk` arm, citing #1348 — a real but accidental, single-session observation with no reproducible methodology. `packages/embedded-agent/src/sdk-engine.ts`'s `buildOptions` set neither field when this probe was first written, so some undeclared SDK default was very likely already active on every `claude-sdk` worker, unconfigured and unobserved; this script replaced the accident with a controlled measurement. Production has since moved: `buildOptions` now explicitly sets `settings.autoMemoryEnabled: false` (Issue #1681, see this section's `--auto-memory-off` bullet below), so the probe's job is no longer discovering an undeclared default — it is confirming the SDK actually honors the declared one, which is a distinct question the explicit setting does not answer by itself.

## Auto-memory: corrections

**Two corrections to the Issue's own wording, discovered while implementing this script and confirmed by the Architect against the vendored `sdk.d.ts`.** The Issue asked Arm B to capture a `memory_type` field on `SDKMemoryRecallMessage` (`'User'|'Project'|'Local'|'Managed'`); that field does not exist there — it belongs to a different, unrelated type (`InstructionsLoadedHookInput`, the CLAUDE.md/rules loader hook). What `SDKMemoryRecallMessage.memories[]` actually carries is `scope: 'personal'|'team'|'organization'` (plus a top-level `mode: 'select'|'synthesize'`), which is in fact the more direct answer to Arm B's actual privacy-scope question. Separately, `autoMemoryEnabled` / `autoMemoryDirectory` are not direct `Options` fields — they live on the `Settings` interface, reached via `Options.settings?: string | Settings`, the same nesting the sibling probes already use for `autoCompactEnabled`.

## Auto-memory: sanitized cwd

**A third adaptation: the sanitized-cwd algorithm cannot be read from source.** The auto-memory logic is not present anywhere in the vendored `@anthropic-ai/claude-agent-sdk` npm bundle (confirmed by grepping `sdk.mjs` for `memory_recall` and for a sanitizer — zero hits); it lives inside the `claude` CLI binary the SDK spawns. Rather than guess a sanitizer, every arm that needs the SDK's own default `autoMemoryDirectory` for a given scratch `cwd` discovers it empirically at runtime: run one turn with `autoMemoryEnabled: true` and diff the isolated `CLAUDE_CONFIG_DIR/projects/` listing to learn the directory the SDK itself created.

## Auto-memory: arm a provenance

 (per the documented contract at [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory), fetched directly rather than inferred by analogy — Architect ruling, PR #1662; the cited page documents the MEMORY.md-index-plus-topic-file architecture in prose only, with no literal syntax example — the index-line and frontmatter shape specifically are taken from Claude Code's own built-in auto-memory system-prompt instructions instead)

## Auto-memory: Task 0b why

**Task 0b (Issue [#1667](https://github.com/ms2sato/agent-console/issues/1667)) extends this same script with three more arms — `--e` / `--f` / `--g` — after Task 0's own retroactive caveat found a confound arms A-D never accounted for: none of them ever set `Options.systemPrompt`, and what an omitted `systemPrompt` resolves to is undocumented in the vendored `sdk.d.ts`. If it means "no preset", the model in every arm A-D run may never have been told the feature exists — which alone would explain every REFUTED verdict, independent of any timescale or switch. Arms E/F/G separate awareness, switches, and timescale, cheapest first:**

## Auto-memory: memory/ scoping why

**The `memory/` scoping is load-bearing (Architect ruling round 2, PR #1676 review):** this probe prints every nonce to stdout, and the delegate session running it ingests that stdout as its own tool output, writing it into ITS OWN transcript `.jsonl` under the same real config dir — an unscoped nonce-content match would make the operator's own conversation transcript "attributable" and false-escalate on every single run. A transcript is never under `memory/`; only genuine auto-memory content is.

## F/G dirty control

**A dirty or unsettled (iii) control does NOT halt**: per the vendored `sdk.d.ts`, `excludeDynamicSections` is documented to re-inject stripped sections as the first user message, so (iii) surfacing an observable is the EXPECTED result on a doc-conformant build — treating it as a halt condition would make F/G unreachable without `--force-f` on any build that behaves as documented. A dirty (iii) is instead a caveat on ATTRIBUTING (i)/(ii)'s awareness to the dynamic section specifically (already stated in arm E's own note), not a precondition for F to run.

## G poll loop

 The shared write-poll loop (`pollForContent`) makes no repeated LLM turns — confirmed by reading it before this arm was dispatched, per the Issue's own instruction — so a longer window costs wall-clock only, never additional billed turns.

## C1c fallback detail

 (capped, per the Architect's own fallback)

## C1c path check

, confirmed NOT a path-representation mismatch via a free, non-billed `claude mcp get` check showing the CLI's recorded command/args byte-identical to what was passed.

