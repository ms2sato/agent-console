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
  Verbatim design-rationale paragraphs (why a smoke is shaped the way it is)
  and the per-section billable boilerplate, moved out of the embedded smoke rule.
---

# Embedded-agent smokes: design rationale moved out of the rule

Moved verbatim (2026-10-12, Issue #1950) from `.claude/rules/smoke-verification-embedded.md`. These paragraphs justify design decisions rather than tell a reader what to run or check; the rule keeps a compressed statement of each.

## openai-api idle eviction: sibling script

**It is a sibling of `check-embedded-agent-idle-eviction.ts`, not an extension of it, because the two scripts verify different halves.** The eviction MECHANISM (countdown, commit-point re-check, `deactivate()` through the exit observer, `evicted` classification) is engine-agnostic and already proven by the `claude-sdk` script; duplicating those assertions here adds nothing. The REVIVAL mechanism is NOT shared: `claude-sdk` resumes the SDK's own session (`sdkResumed: true`, unchanged `sdkSessionId`); `openai-api` has no provider-side session concept at all and reconstructs the conversation from the persisted NDJSON log on every activation. That reconstruction path has a real bug history — see this file's "Restore E2E and smoke: the conversation must use a tool" section — so this script drives a tool-using planting turn through the `openai-api` reconstruction path across a real eviction, per that section's discipline, and asserts the mechanism used (`restoreInfo.sdkResumed === undefined` and `restoredMessageCount > 0`, not merely that the recall succeeded) rather than only the outcome.

## openai-api idle eviction: two-worker shape

The two-worker positive/negative-control shape (subject A evicted, control B activated later and still inside its own countdown) mirrors the `claude-sdk` script for the same reason: without B, "A was evicted" cannot be distinguished from "everything gets killed". B also serves as the recall control (never heard the nonce, must answer `UNKNOWN`), because the threat here is guessability, not confabulation (`openai-api` has no resumed session to confabulate about).

## Restart-all: modeled on idle eviction

**It is modeled closely on `check-embedded-agent-idle-eviction.ts`, but the mechanism under test is different and so is what counts as proof.** Idle eviction is countdown-driven and needs a positive/negative pair staggered in time to prove selectivity; restart-all acts on every active worker in one synchronous sweep, so both workers here are activated together and BOTH are expected to be restarted by the same call. The two-worker shape survives for a different reason: it is the recall control (a second worker that never heard the planted nonce, chosen per this file's "Restore E2E and smoke" threat table because the risk is guessability, not confabulation by a resumed session) rather than a selectivity control. "Fresh incarnation" is proven by a harness-pid comparison (before/after restart, must differ) rather than by liveness-then-death, since restart-all's positive claim is "replaced", not "evicted" -- and the pre-restart incarnation's persisted `exited` row is asserted `reason: 'managed'`, specifically to distinguish restart-all's ordinary deactivate from idle eviction's `'evicted'` classification.

## Shared-account: why a terminal worker

`activateAgentWorkerPty` and `activateTerminalWorkerPty` resolve identity via the IDENTICAL `session.createdBy -> resolveSpawnUsername -> spawnPty` chain (verified directly in `worker-manager.ts` / `worker-lifecycle-manager.ts`), differing only in the downstream command string `spawnPty` builds -- so substituting which worker type the smoke reads identity through never touches the binding/elevation logic under test (pre-pr-completeness.md Q13 recorded proxy).

## Shared-account: no shipped polarity flag

**No shipped polarity flag.** Proving the Release 1 tree would have shown a single global account regardless of binding is a ONE-TIME, cross-tree measurement recorded in the #1842 PR body, not a flag in this file: on the Release 2 tree, `SharedAccountRegistry.create` / `getDefaultUserId` are deleted and the worktree-creation route no longer calls either, so no registry state constructible from the CURRENT tree's code can reproduce the old global-account behavior -- the bug lived in the route's now-replaced resolution logic, not in a toggle. The one-time measurement is recorded in the #1842 PR body and `docs/narratives/2026-10-12-shared-account-smoke-design-history.md`.

## R6: free and deterministic

**FREE AND DETERMINISTIC -- the exception, stated explicitly because every other script in this section is billable.** No real `claude` CLI, no OS subprocess of any kind (`spawnAsUserFn` returns an in-process stub whose stdout/stderr the script pushes scripted NDJSON lines through -- including a real `sdk-session-id` line, so `worker.sdkSessionId` is set via the SAME production event handler a live incarnation would use, not a hand-written field mutation). R6's target property -- "the fallback path's marker gets written, and the next restore classifies it as noise, surviving into a later incarnation" -- is a pure filesystem-and-parsing property that does not depend on what a real LLM turn produces. It is registered here like its billable siblings, but since #1871 it is CI-run too, via `scripts/smoke/__tests__/check-restore-failure-declaration.run.test.ts` (both modes, under `test:scripts`) -- its only cost is roughly two seconds per mode, so the manual-gate wording this section's billable siblings carry does not apply to it.

## Image: negative control is the polarity check

**The negative control IS the polarity check here**, unlike this section's `--expect-*`-flag siblings: the capability gate (`supportsImages: false`) has a naturally-occurring negative case built into the feature itself, so no separate "revert the fix and confirm the bug reproduces" mode is needed. The SUBJECT/CONTROL pair is a capability-gate control (does the flag actually suppress image parts?), not a selectivity-over-time control like the idle-eviction siblings' A/B pair.

## Usage-seed: why a unit test cannot substitute

The reason a unit test cannot substitute: the defect is a disagreement between two numbers, and only one of them is ours. A fake adapter can be told to report anything, which makes the gap an input rather than a measurement — so the unit layer can pin the extraction rule and the max rule, but only the real chain establishes that the gap exists at the size the fix assumes. The measured gap (12,000-token window: estimator 5,450 vs provider 10,512) is in `docs/narratives/2026-10-12-usage-seed-estimator-vs-provider-gap.md`.

## Usage-seed: what it does not reach

**What it does not reach, and why that is arithmetic rather than effort.** The Issue's full wedge ends in a provider 400 no `Compact` can escape. Reaching it needs the declared window to be both honest and small: with `G` the tool-schema gap and `T` the threshold, `W < G / (1 - T)` — about 37,500 tokens at the measured defaults. The smallest context window across the dev instance's provider catalogue is 196,608, and that model silently truncates rather than erroring, so the 400 is unreachable there. The downstream link (a turn ending in error settles no compaction) is pinned in `packages/embedded-agent/src/__tests__/agent-loop-compaction.test.ts` instead, where a turn's ending is directly constructible.

## Parity: why a single first turn

**Why a single first turn, no tool call.** Unlike this file's restore/eviction smokes, this content is loaded EAGERLY into the system prompt at activation -- it is not something a later tool call or a resumed session reveals, so there is no "recall across a process boundary" here and no need for the tool-turn discipline or a recall negative control. The `.claude/rules-not` nonce is the negative control this AC item asks for, and it is a directory-scoping control (does the loader only ever scan `.claude/rules`?), not a recall-attribution control -- a materially different question from the ones the tool-turn rule above governs.

## Memory layer: why recall-after-restart is the wrong instrument

**Why "recall after a restart" is the wrong instrument, and what this measures instead.** A restarted worker remembers a nonce from its own transcript (SDK resume on `claude-sdk`, NDJSON reconstruction on `openai-api`), so a same-worker recall passes identically with the layer removed. The property this layer exists for is continuity across SESSIONS: B is a fresh worker in a fresh session on the same (definition, repository) key.

## Connectors: no runtime setter

**The mechanism has no runtime setter, and the script's two-worker shape exists because of that.** Unlike compaction's `auto` toggle, `disableClaudeAiConnectors` is read once at `SdkEngine` construction and never re-read; a preference change takes effect at a worker's NEXT activation, never live. Worker A (activated BEFORE the PATCH) is the positive-control baseline; a SEPARATE, fresh worker B (activated AFTER the PATCH, same user) is what proves the new preference actually took effect at its next activation -- reactivating A in place would not distinguish "the fix works" from "the SDK never re-reads settings on a restart, for either value". The observable in both cases is the worker's own persisted `mcp-servers-discovered` event(s), read off its NDJSON output file, never inferred from the model's prose.

## Connectors: polarity flag INCONCLUSIVE note

This flag has no INCONCLUSIVE gate of its own -- if the host account has no connectors at all, its assertion also fails on the fixed tree, indistinguishably from the toggle working correctly, which is harmless since failing is the expected outcome either way; a PASS under this flag (i.e. a genuinely reverted tree) is only meaningful once the same host's default run has separately cleared its own INCONCLUSIVE gate.

## No idle-threshold bullet

- **No idle-threshold parameter.** Unlike the idle-eviction siblings, restart-all is not time-driven, so there is nothing analogous to `--idle-ms` to substitute.

## No idle-threshold bullet

- **No idle-threshold or elevation parameter.** Unlike this file's eviction/elevation siblings, this mechanism is neither time-driven nor elevation-coupled, so there is nothing analogous to `--idle-ms` or `--elevated` to substitute.

## Billable bullets (the shared prerequisites now live in the file's header)

- **It is billable and needs a real, authenticated `claude` CLI** for the invoking OS user, like the SDK probes under `scripts/smoke/`.
- **It is billable and needs a real, authenticated `claude` CLI** for the invoking OS user. Roughly five real turns per run.
- **`--idle-ms N` sets the threshold** (default 45 s) so a run takes minutes rather than the production half-hour. That substitution is upstream of and outside the chain under test: it changes how long the script waits to arrive at the eviction, never what eviction does.
- **It is billable and needs a provider key store** resolvable per the header. A handful of small real HTTP turns per run.
- **`--idle-ms N` sets the threshold** (default 45 s), same substitution rationale as the `claude-sdk` sibling: it changes how long the script waits to arrive at the eviction, never what eviction does.
- **It is billable and needs a real, authenticated `claude` CLI** for the invoking OS user, same resolution as its idle-eviction sibling. Three real turns per run in default mode (plant, recall, recall-control); polarity mode (below) skips the recall-control turn, since its B-side check is a pid comparison, not a second billed turn.
- **It is billable and needs both a provider key store** (`PROVIDER_KEY_REF` / `PROVIDER_KEY_FILE`; see the header) **and a real, authenticated `claude` CLI** for the invoking OS user (the `claude-sdk` case). A handful of small real turns across three workers per run.
- **It is billable and needs a provider key** resolvable per the header. A run is a handful of small turns — cents, not dollars.
- **It is billable and needs BOTH:** a real, authenticated `claude` CLI for the invoking OS user (the `claude-sdk` arm), and a provider key resolvable per the header for the `openai-api` arm. Two small real turns total.
- **It is billable and needs BOTH** a real, authenticated `claude` CLI for the invoking OS user (the `claude-sdk` arm) and a provider key resolvable per the header for the `openai-api` arm. Roughly four small turns per engine (plant, recall, two controls) plus two per engine for the polarity run.
- **It is billable and needs a real, authenticated `claude` CLI** for the invoking OS user -- the `claude-sdk` builtin runs as the executing user and uses that user's own authentication, so there is no API key to configure. About 10-11 real turns per full run (5-6 for arms 1-3 + control (a), plus 5 for arm 4 and its two controls).
- **It is billable and needs a real, authenticated `claude` CLI** for the invoking OS user -- the `claude-sdk` builtin runs as the executing user and uses that user's own authentication, so there is no API key to configure. Two real turns per default run (one per worker), one real turn for the `--expect-connectors-present` polarity run.
