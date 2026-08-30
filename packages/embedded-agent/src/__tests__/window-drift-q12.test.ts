/**
 * Q12 for window-declaration drift — the reproduction, and what is left of it.
 *
 * This file was committed BEFORE any of the feature existed, to observe the
 * Issue's claim rather than assume it: the system RECEIVES evidence
 * contradicting a declared `contextWindowTokens` and DISCARDS it. Both signals
 * were reproduced against unmodified code, deterministically and free.
 *
 * **Signal 1's cases have been retired here, because they were satisfied.**
 * They asserted that no API exposed the provider-stated number and that the
 * classifier's only output was a boolean — statements about an absence that
 * the same PR then filled. Re-pointing them at the built behaviour would only
 * duplicate the feature's own sibling tests, so the reproduction stays where
 * it belongs: in the commit that recorded it, ahead of the implementation.
 * The behaviour those cases were about is now pinned, with measured reach, in
 * `context-overflow.test.ts` (`extractProviderStatedLimit`) and
 * `agent-loop-window-drift.test.ts` (the turn-error annotation).
 *
 * Signal 2 remains reproduced below, and remains unbuilt. When it is built,
 * this case flips the same way and the file is retired with it.
 */
import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { EmbeddedAgentEventSchema } from '@agent-console/shared';

describe('#1434 Q12 — signal 2: a measured reading contradicts the declaration, and nothing compares them', () => {
  it('the context-usage event has no field to carry a drift flag, and its schema REJECTS one', () => {
    // Replaces an earlier case that inspected the keys of an object literal
    // written two lines above it -- self-referential, and true whatever the
    // production schema said.
    //
    // Measured 2026-08-29, `hy3`: a ~500k-token request answered with
    // `prompt_tokens` of exactly 196,608 (its real window), the rest silently
    // dropped. The reading is measured and contradicts a larger declaration,
    // and the event carrying it has nowhere to say so.
    const ordinary = { v: 1, type: 'context-usage', promptTokens: 196_608, estimated: false };
    expect(v.safeParse(EmbeddedAgentEventSchema, ordinary).success).toBe(true);

    // The schema is strict, so a drift field does not merely go unused -- it is
    // refused. That is what makes this a schema change rather than an additive
    // convention, and it is why the shared commit is ordered the way it is.
    const withDrift = { ...ordinary, declaredWindowTokens: 1_000_000 };
    expect(v.safeParse(EmbeddedAgentEventSchema, withDrift).success).toBe(false);
  });
});
