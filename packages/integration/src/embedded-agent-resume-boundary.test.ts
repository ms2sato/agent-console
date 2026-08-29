/**
 * Client-Server Boundary Test: R1's two new wire fields (Issue #1410,
 * `pre-pr-completeness.md` Q10).
 *
 * Q10 exists because valibot's default `v.object` SILENTLY STRIPS unknown
 * fields: a field added to a TypeScript type but not to the matching runtime
 * schema disappears at the wire boundary with no compile error and no runtime
 * error on either side, and the first thing anyone notices is missing data in
 * the UI. Both of R1's additions are exactly that shape --
 * `restore-info.sdkResumed` (server -> client) and the `init` command's
 * `resume` (server -> subprocess) -- so both are asserted to SURVIVE a real
 * parse here, not merely to typecheck.
 *
 * The `restore-info` ABSENCE case for a real `openai-api` worker is covered
 * over a real subprocess in `e2e-native/embedded-agent-restore-info-boundary.test.ts`.
 * What that test cannot reach is the `claude-sdk` side, which needs a real
 * authenticated `claude` CLI; the shapes are pinned against the real schemas
 * here instead.
 */
import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  RestoreInfoMessageSchema,
  EmbeddedAgentCommandSchema,
  EmbeddedAgentEventSchema,
  EmbeddedAgentStreamEventSchema,
} from '@agent-console/shared';

function restoreInfoWire(extra: Record<string, unknown> = {}): unknown {
  return { type: 'restore-info', epoch: 7, restoredMessageCount: 3, repairedToolCallIds: [], completed: true, ...extra };
}

describe('restore-info.sdkResumed survives the wire schema (R1, Q10)', () => {
  it('keeps `sdkResumed: true` through the parse', () => {
    const parsed = v.parse(RestoreInfoMessageSchema, restoreInfoWire({ sdkResumed: true }));
    // The assertion Q10 is actually about: not "the payload was accepted",
    // but "the field came out the other side". A schema missing the member
    // accepts the payload just as happily and drops the field.
    expect(parsed.sdkResumed).toBe(true);
  });

  it('keeps `sdkResumed: false` through the parse', () => {
    const parsed = v.parse(RestoreInfoMessageSchema, restoreInfoWire({ sdkResumed: false }));
    expect(parsed.sdkResumed).toBe(false);
    // Explicitly distinguished from absence, which is a different wire state.
    expect('sdkResumed' in parsed).toBe(true);
  });

  it('leaves the field absent -- not defaulted -- when the server omits it', () => {
    const parsed = v.parse(RestoreInfoMessageSchema, restoreInfoWire());
    expect('sdkResumed' in parsed).toBe(false);
    expect(parsed.sdkResumed).toBeUndefined();
  });

  it('rejects a non-boolean sdkResumed', () => {
    expect(v.safeParse(RestoreInfoMessageSchema, restoreInfoWire({ sdkResumed: 'yes' })).success).toBe(false);
  });
});

describe('restore-info.restoredMessageCount survives the wire schema, including 0 (Q10)', () => {
  // The field was renamed from `messageCount` when its MEANING changed: it now
  // counts only entries that came from the persisted transcript (replayed
  // messages plus a compaction summary), excluding the synthetic system
  // prompt. A same-named field with a changed meaning is the drift a later
  // reader gets wrong, and `restore-info` is a live message rather than a
  // persisted row, so there is no old-log compatibility to keep.
  it('keeps a 0 count through the parse instead of stripping or rejecting it', () => {
    // 0 is the whole point of the change: a worker activated but never spoken
    // to restores nothing, and the client gates its "may not have carried
    // over" notice on `> 0`. A schema that dropped the field would leave the
    // client reading `undefined`.
    const parsed = v.parse(RestoreInfoMessageSchema, restoreInfoWire({ restoredMessageCount: 0 }));
    expect(parsed.restoredMessageCount).toBe(0);
    expect('restoredMessageCount' in parsed).toBe(true);
  });

  it('PRESENCE CONTROL: a non-zero count also survives the parse', () => {
    // Pairs with the 0 case: on its own, "the parse produced 0" cannot tell a
    // preserved 0 apart from a field that is always 0 on the far side.
    const parsed = v.parse(RestoreInfoMessageSchema, restoreInfoWire({ restoredMessageCount: 4 }));
    expect(parsed.restoredMessageCount).toBe(4);
  });

  it('rejects the pre-rename field name outright rather than silently accepting it', () => {
    // `RestoreInfoMessageSchema` is a strictObject, so the rename fails loudly
    // on both halves: an unknown `messageCount` is rejected, and the now-
    // required `restoredMessageCount` is missing. A permissive object would
    // have made a half-renamed server look fine on the wire.
    const stale = { type: 'restore-info', epoch: 7, messageCount: 3, repairedToolCallIds: [], completed: true };
    expect(v.safeParse(RestoreInfoMessageSchema, stale).success).toBe(false);
  });
});

describe('init.resume survives the command schema, on the claude-sdk arm only (R1, Q10)', () => {
  const base = {
    v: 1,
    type: 'init',
    compaction: { auto: false },
    mcp: { baseUrl: 'http://mcp.local', token: 'tok' },
    context: { sessionId: 's', workerId: 'w', cwd: '/tmp/work' },
    maxToolIterations: 25,
  };

  it('keeps the resume id through the parse on a claude-sdk init', () => {
    const parsed = v.parse(EmbeddedAgentCommandSchema, {
      ...base,
      engine: 'claude-sdk',
      provider: { model: 'claude-sonnet-5' },
      resume: { sdkSessionId: 'sess-abc' },
    });
    if (parsed.type !== 'init' || parsed.engine !== 'claude-sdk') throw new Error('unexpected parse output');
    // A schema missing this member would accept the command and silently drop
    // the id, so every re-activation would start fresh with nothing to show
    // for it.
    expect(parsed.resume).toEqual({ sdkSessionId: 'sess-abc' });
  });

  it('leaves `resume` absent on a claude-sdk init that carries none', () => {
    const parsed = v.parse(EmbeddedAgentCommandSchema, {
      ...base,
      engine: 'claude-sdk',
      provider: { model: 'claude-sonnet-5' },
    });
    if (parsed.type !== 'init') throw new Error('unexpected parse output');
    expect('resume' in parsed).toBe(false);
  });

  it('REJECTS `resume` on an openai-api init', () => {
    // Structural containment: the field lives on the claude-sdk arm precisely
    // so an openai-api init carrying one is not representable. R2 owns that
    // engine's restore path and it works by a different mechanism.
    const result = v.safeParse(EmbeddedAgentCommandSchema, {
      ...base,
      engine: 'openai-api',
      provider: { baseUrl: 'http://p/v1', model: 'm' },
      resume: { sdkSessionId: 'sess-abc' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a resume with an empty session id', () => {
    const result = v.safeParse(EmbeddedAgentCommandSchema, {
      ...base,
      engine: 'claude-sdk',
      provider: { model: 'claude-sonnet-5' },
      resume: { sdkSessionId: '' },
    });
    expect(result.success).toBe(false);
  });
});

describe('R1 events survive their schemas (Q10)', () => {
  it('parses sdk-resume-failed with its reason intact', () => {
    const parsed = v.parse(EmbeddedAgentEventSchema, {
      v: 1,
      type: 'sdk-resume-failed',
      requestedSdkSessionId: 'sess-gone',
      reason: 'refused',
    });
    if (parsed.type !== 'sdk-resume-failed') throw new Error('unexpected parse output');
    // The server branches on `reason` -- `refused` replaces the incarnation,
    // `not-found` does not -- so a stripped reason would silently turn every
    // refusal into the do-nothing branch and leave the worker wedged.
    expect(parsed.reason).toBe('refused');
    expect(parsed.requestedSdkSessionId).toBe('sess-gone');
  });

  it('rejects an unknown sdk-resume-failed reason', () => {
    expect(
      v.safeParse(EmbeddedAgentEventSchema, {
        v: 1,
        type: 'sdk-resume-failed',
        requestedSdkSessionId: 'sess-gone',
        reason: 'something-else',
      }).success,
    ).toBe(false);
  });

  it('parses a persisted turn-interrupted row through the stream-event union', () => {
    // The union replay uses -- a server-authored row that is NOT in the
    // loop-only event union, so it has to be reachable from this one or every
    // historical marker fails the parse before rendering is reached.
    const parsed = v.parse(EmbeddedAgentStreamEventSchema, { v: 1, type: 'turn-interrupted', turnId: 'u9' });
    if (parsed.type !== 'turn-interrupted') throw new Error('unexpected parse output');
    expect(parsed.turnId).toBe('u9');
  });

  it('rejects a turn-interrupted row with an empty turnId', () => {
    expect(v.safeParse(EmbeddedAgentStreamEventSchema, { v: 1, type: 'turn-interrupted', turnId: '' }).success).toBe(
      false,
    );
  });
});
