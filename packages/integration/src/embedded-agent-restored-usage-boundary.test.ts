/**
 * Client-Server Boundary Test: the `init` command's `restoredUsage` field
 * (Issue #1419, `pre-pr-completeness.md` Q10).
 *
 * Q10 exists because valibot's default `v.object` SILENTLY STRIPS unknown
 * fields: a field added to a TypeScript type but not to the matching runtime
 * schema disappears at the wire boundary with no compile error and no runtime
 * error on either side. For this field that failure would be especially quiet
 * -- the subprocess would fall back to the estimator, which is exactly the
 * pre-fix behaviour, so the worker would keep working and keep under-firing.
 * Nothing would look broken. So the seed is asserted to SURVIVE a real parse
 * here, not merely to typecheck.
 *
 * MEASURED REACH (mutation, run -- not predicted):
 *
 *   m9   remove `restoredUsage` from the openai-api arm of
 *        `EmbeddedAgentInitCommandSchema` -- i.e. the exact Q10 defect
 *        -> 2 fail: the two "survives the parse" cases. NOTE the arm
 *           containment test does NOT move: the claude-sdk arm never declares
 *           the field, so its strictObject rejects the payload under m9 just
 *           as it does normally. That test therefore pins where the field is
 *           NOT, and only m9-on-the-other-arm would move it -- which is not a
 *           mutation worth carrying, since adding the field to claude-sdk is
 *           the thing the test names.
 *   m10  declare it with `v.optional(v.any())` instead of the strict shape
 *        -> 2 fail: the two malformed-payload rejections. Without them a
 *           schema that accepts anything would pass every surviving
 *           assertion here.
 */
import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { EmbeddedAgentCommandSchema } from '@agent-console/shared';

const base = {
  v: 1,
  type: 'init',
  compaction: { auto: true, contextWindowTokens: 20_000 },
  mcp: { baseUrl: 'http://mcp.local', token: 'tok' },
  context: { sessionId: 's', workerId: 'w', cwd: '/tmp/work' },
  maxToolIterations: 25,
};
const openai = { ...base, engine: 'openai-api', provider: { baseUrl: 'http://p/v1', model: 'm' } };

describe('init.restoredUsage survives the command schema, on the openai-api arm only (#1419, Q10)', () => {
  it('keeps a real provider reading through the parse', () => {
    const parsed = v.parse(EmbeddedAgentCommandSchema, {
      ...openai,
      restoredUsage: { promptTokens: 6722, estimated: false },
    });
    if (parsed.type !== 'init' || parsed.engine !== 'openai-api') throw new Error('unexpected parse output');
    // The assertion Q10 is actually about: not "the payload was accepted",
    // but "the field came out the other side". A schema missing the member
    // accepts the payload just as happily and drops the seed, leaving the
    // subprocess on the estimator -- the pre-fix behaviour, silently.
    expect(parsed.restoredUsage).toEqual({ promptTokens: 6722, estimated: false });
  });

  it('keeps an estimated reading through the parse, flag intact', () => {
    const parsed = v.parse(EmbeddedAgentCommandSchema, {
      ...openai,
      restoredUsage: { promptTokens: 1102, estimated: true },
    });
    if (parsed.type !== 'init' || parsed.engine !== 'openai-api') throw new Error('unexpected parse output');
    // `estimated` is the reading's own honesty and must not be defaulted or
    // normalised on the way across.
    expect(parsed.restoredUsage).toEqual({ promptTokens: 1102, estimated: true });
  });

  it('leaves the field absent -- not defaulted -- when the server omits it', () => {
    const parsed = v.parse(EmbeddedAgentCommandSchema, openai);
    if (parsed.type !== 'init' || parsed.engine !== 'openai-api') throw new Error('unexpected parse output');
    // Absence is a real wire state: a worker that never completed a turn has
    // no reading, and the subprocess must see that rather than a zero.
    expect('restoredUsage' in parsed).toBe(false);
    expect(parsed.restoredUsage).toBeUndefined();
  });

  it('REJECTS restoredUsage on a claude-sdk init', () => {
    // Structural containment, the same rule `resume` gets from the other
    // direction: claude-sdk carries its own context state through the SDK
    // resume and computes no ratio, so a seed there is a field nothing reads.
    const result = v.safeParse(EmbeddedAgentCommandSchema, {
      ...base,
      engine: 'claude-sdk',
      provider: { model: 'claude-sonnet-5' },
      restoredUsage: { promptTokens: 6722, estimated: false },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative or fractional promptTokens', () => {
    expect(
      v.safeParse(EmbeddedAgentCommandSchema, { ...openai, restoredUsage: { promptTokens: -1, estimated: false } })
        .success,
    ).toBe(false);
    expect(
      v.safeParse(EmbeddedAgentCommandSchema, { ...openai, restoredUsage: { promptTokens: 1.5, estimated: false } })
        .success,
    ).toBe(false);
  });

  it('rejects a reading with no `estimated` flag', () => {
    // The flag is not optional: a seed that arrived without it would have to
    // be defaulted, and either default is a lie about where the number came
    // from.
    expect(
      v.safeParse(EmbeddedAgentCommandSchema, { ...openai, restoredUsage: { promptTokens: 6722 } }).success,
    ).toBe(false);
  });
});
