---
proposed_id: I-11
slug: termination-attribution
source_pr: 1349
source_issue: 1334
brewed_at: 2026-08-18
brewed_by: Orchestrator session 55213f05 (Claude Opus 5)
status: proposed
---

# I-11. Termination Attribution

## Why this PR warrants a new invariant

PR #1349 had to add a per-query generation counter (`packages/embedded-agent/src/sdk-engine.ts`, `consumeLoop(activeQuery, generation)`) because session-boundary handoff **replaces** the SDK query while the engine stays alive. The old query's consumer loop then observes a clean stream end — indistinguishable, to the code that existed, from "the child process died with no result", which Phase 1 mapped to `handleFatal`. Without the fix, **every handoff would have killed a healthy engine**.

The interesting part is not that a guard was missing; it is *why the existing guard could not cover it*. Phase 1 already had a deliberate-shutdown discriminator (`this.dead`, set by `dispose()`), and this codebase has two more of the same shape: `worker-manager.ts` passes a literal `'unexpected'` reason to `callbacks.onExit`, and `embedded-agent-worker-service.ts` keeps `Runtime.shutdownRequested`, commented as "set by `deactivate()` so the exit observer can classify a managed shutdown". All three are **process-scoped booleans**, and all three are correct only while the resource is never replaced during the owner's lifetime. The moment replacement enters — as it did in #1349 — a boolean cannot express *which instance* the flag was about.

## Rule (draft)

When code maps an observed termination (stream end, process exit, connection close, stream error) onto a failure, the discriminator between **deliberate** and **unexpected** must be scoped to the **instance** that terminated — captured by the observer when it starts — whenever that resource can be replaced while its owner stays alive. A discriminator scoped to the owner (a boolean field, a "shutting down" flag) is only sound when the resource has exactly one instance per owner lifetime.

## Why it matters

The failure mode is a **spurious fatal**: an in-flight observer of a deliberately-replaced instance attributes that instance's normal end to the *current* one, and tears down a resource that is perfectly healthy. It is nasty for three reasons. It fires on the success path (the replacement worked; the teardown follows *because* it worked), so it does not look like an error case worth testing. It surfaces only after the replacement feature exists, which is typically a later phase than the guard — so the guard is written when a boolean genuinely is sufficient, and quietly becomes wrong later. And the naive fix is to weaken or delete the guard, which trades a spurious fatal for a silent one: the real "the process died" case stops being detected at all.

## Detection heuristics (draft)

1. **Find every site that turns an observed end into a failure** — `handleFatal` on stream end, an exit handler that reports `'unexpected'`, an `onClose` that marks a worker dead. For each, ask: *what tells this code the end was deliberate?*
2. **Classify that discriminator's scope.** A field on the owner (`this.dead`, `runtime.shutdownRequested`, `isShuttingDown`) is owner-scoped. A value captured as a **parameter** by the observer at start (a generation, an instance handle, an epoch) is instance-scoped.
3. **Ask whether the resource can be replaced while the owner lives** — reseed, reconnect, respawn, rotate, restart-in-place. If yes and the discriminator is owner-scoped, the bug is present (or one feature away).
4. **Watch for the read-vs-capture slip.** Even a generation counter is owner-scoped if the observer reads `this.generation` at termination time instead of comparing against the value it captured at start. #1349's comment names this explicitly: "captured PARAMETERS, not read from `this.query`".
5. **Check the ordering around replacement.** The generation must advance with no `await` between closing the old instance and bumping it, or the old observer can run its comparison before the bump and still fire.

## Resolution patterns (draft)

- Pass the instance (or its generation) into the observer as a **parameter**; compare the captured value against the current one at termination and return silently on mismatch.
- Keep the deliberate-shutdown flag as well. The two answer different questions — "the owner is going away" vs "this instance was superseded" — and #1349 keeps both guards side by side rather than merging them.
- Make the fix **additive**: an early return ahead of the existing failure path, so the original guard still fires for a genuinely unexpected end on the current instance.
- Test both directions. A test that only proves "replacement no longer emits a fatal" is satisfied by deleting the guard.

## Example (from source PR)

Handoff terminates the old `query()` so a successor can be seeded. The old `consumeLoop` ends without throwing. Pre-fix, that reached `handleFatal('SDK message stream ended unexpectedly')`, since `this.dead` is false during a handoff — the engine is very much alive. The fix captures `generation` as a parameter of `consumeLoop`; a mismatch at stream end means a newer query superseded this one, and the loop returns silently. The pre-existing "clean stream end" tests still pass unchanged, which is what demonstrates the guard was not weakened.

Note that the Architect predicted this interaction at AC time and named it as a required scope item (`S4`), rather than it being found in review. That is the same reasoning this invariant would give a reviewer who has never seen the file.

## Suggested acceptance criterion template

- [ ] Every site that maps an observed termination (stream end / process exit / connection close) to a failure uses an **instance-scoped** discriminator captured by the observer at start, wherever the resource can be replaced while its owner stays alive → two tests per site: replacement produces no failure event, and a genuinely unexpected end on the current instance still produces exactly one

## Review questions for owner

- Is this truly cross-cutting? Three instances of the discriminator shape exist today (`sdk-engine.ts` `this.dead` + `queryGeneration`, `worker-manager.ts`'s `'unexpected'` exit reason, `embedded-agent-worker-service.ts`'s `shutdownRequested`), but only one of the three currently has a replaceable resource. Is "two of these are one feature away from the bug" strong enough, or should this wait for a second real incident?
- Does it overlap with I-3 (Identity Stability Across Time)? I read them as opposites — I-3 says an identifier must not change for the same resource; this says an observer must notice when the resource *did* change underneath it. Worth confirming that framing.
- Is the epoch machinery in the worker output stream (`worker.epoch`) the same invariant wearing different clothes, or a genuinely different concern (client resync addressing rather than termination attribution)? If the same, this entry should cover both and say so.
- Is the criterion template's "two tests per site" too heavy for sites where the resource demonstrably cannot be replaced?
