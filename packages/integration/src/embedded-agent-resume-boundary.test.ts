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
  return { type: 'restore-info', epoch: 7, messageCount: 3, repairedToolCallIds: [], completed: true, ...extra };
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

  it('parses sdk-resume-failed with reason `lookup-failed` intact', () => {
    // The reason the server reads to decide whether the persisted
    // `sdkSessionId` survives. Q10's actual hazard is the silent strip: a
    // picklist missing this member does not drop the field, it REJECTS the
    // whole event -- the subprocess would emit it, the server would log a
    // parse failure, and the id-keeping branch would never run. Either way
    // the observable is the same as the bug this fixes.
    //
    // Polarity measured by mutation: removing `'lookup-failed'` from
    // SDK_RESUME_FAILURE_REASONS makes `v.parse` throw here. The assertion
    // reads the reason back rather than stopping at "it parsed", so a
    // picklist that accepted the value and a schema that carried it are
    // distinguished.
    const parsed = v.parse(EmbeddedAgentEventSchema, {
      v: 1,
      type: 'sdk-resume-failed',
      requestedSdkSessionId: 'sess-unreadable',
      reason: 'lookup-failed',
    });
    if (parsed.type !== 'sdk-resume-failed') throw new Error('unexpected parse output');
    expect(parsed.reason).toBe('lookup-failed');
    expect(parsed.requestedSdkSessionId).toBe('sess-unreadable');
  });

  it('still parses an OLD persisted log whose rows predate the third reason', () => {
    // Widening a union is only safe forward if it is also safe BACKWARD: the
    // rows already on disk carry the two original reasons, and every
    // activation replays them. A widening that (say) made `reason` a
    // required-plus-renamed field, or moved to a shape the old rows do not
    // match, would fail the replay of every worker that ever hit a resume
    // failure -- an activation-time regression with no relation to the
    // change's own subject.
    //
    // Read through the STREAM union, which is the one replay actually uses;
    // the loop-only union above is not what a persisted line is parsed with.
    for (const reason of ['not-found', 'refused'] as const) {
      const line = JSON.stringify({ v: 1, type: 'sdk-resume-failed', requestedSdkSessionId: 'sess-old', reason });
      // `unknown`, not the `any` JSON.parse hands back: this test's whole
      // subject is what survives validation, and an `any` reaching `v.parse`
      // would let a type error at the boundary pass silently.
      const replayed: unknown = JSON.parse(line);
      const parsed = v.parse(EmbeddedAgentStreamEventSchema, replayed);
      if (parsed.type !== 'sdk-resume-failed') throw new Error('unexpected parse output');
      expect(parsed.reason).toBe(reason);
    }
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
