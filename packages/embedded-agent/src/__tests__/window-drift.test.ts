import { describe, it, expect } from 'bun:test';
import { detectClampedReading } from '../window-drift';

/**
 * The measured truncation, verbatim: `hy3`, 2026-08-29. A request of roughly
 * 500,000 tokens answered with a `prompt_tokens` of exactly 196,608.
 */
const HY3_REAL_CAP = 196_608;
const HY3_DECLARED = 1_000_000;
const HY3_SENT_ESTIMATE = 500_000;

const measured = (promptTokens: number) => ({ promptTokens, estimated: false });
const estimated = (promptTokens: number) => ({ promptTokens, estimated: true });

/*
 * Conjunction-isolation audit, done structurally rather than by mutation
 * (cheaper, and it reaches cases a mutation set may not cover). The verdict
 * ANDs six conditions -- provider-reported, declaration present, reading
 * positive, reading below the declaration, 4,096-aligned, estimate exceeding
 * the reading -- so a case exercising one of them only reaches it when the
 * fixture satisfies the other five.
 *
 * Checked per case: every negative below fails exactly ONE condition, with
 * the rest satisfied. The single exception is the second assertion of the
 * escape-path case (`estimated(43)`), which fails two and is not trying to
 * isolate either -- it asserts what that path publishes, not why.
 *
 * Measured reach, recorded by WHICH test failed (standing rule). Mutations
 * applied to `window-drift.ts` and this file re-run:
 *
 *   w1  drop the `reading.estimated` gate
 *       -> 1 fail, alone: 'an ESTIMATED reading is never flagged'. This is the
 *          gate that keeps our own arithmetic from testifying about what the
 *          provider did, and only that case holds it.
 *   w2  drop the alignment check (`% 4096`)
 *       -> 2 fail: 'a reading that is merely small is not a cap' and 'does not
 *          fire on the two identical readings a healthy absorbed overflow
 *          publishes'. Predicted as 1; the escape-path case turns out to rest
 *          on alignment too, which is worth knowing, since that case is the
 *          one guarding the refuted predicate's return.
 *   w3  drop the estimate comparison (condition 4)
 *       -> 1 fail, alone: 'an aligned reading with nothing oversized behind it
 *          is not flagged'. That case is the whole defence against the
 *          1-in-4096 coincidence, and nothing else notices it is gone.
 *   w4  `measured >= declared` -> `measured > declared` (admit a reading
 *       exactly at the declaration)
 *       -> 1 fail, alone: 'a reading exactly at the declared window is the
 *          ordinary large-conversation case'.
 *
 *       Measured as ZERO first, and the zero was real. The case originally
 *       used a declaration of 1,000,000, which is NOT 4,096-aligned -- so the
 *       alignment check refused the reading before the declaration comparison
 *       was ever reached, and the assertion held for a reason unrelated to
 *       the boundary it names. The fixture now uses an aligned declaration.
 *       Second instance of that shape in this PR; the first was a fixture
 *       whose prose carried no number.
 *   w5  return `declaredWindowTokens` instead of `measured`
 *       -> 1 fail, alone: 'reports the cap the PROVIDER appears to enforce'.
 *          Recorded because the two numbers are both in scope at the return
 *          and swapping them is a silent, plausible slip: the caller would
 *          then tell the operator their declaration disagrees with itself.
 *   w6  drop the `measured <= 0` floor
 *       -> 1 fail, alone: 'a zero reading is inert rather than an infinitely
 *          clamped one'.
 */

describe('detectClampedReading', () => {
  it('flags the measured truncation, and reports the cap the PROVIDER appears to enforce', () => {
    expect(detectClampedReading(measured(HY3_REAL_CAP), HY3_DECLARED, HY3_SENT_ESTIMATE)).toBe(
      HY3_REAL_CAP,
    );
  });

  it('an ESTIMATED reading is never flagged, however well it fits the shape', () => {
    // Same numbers, only the provenance differs. Our own estimate agreeing
    // with a cap is not evidence about the provider -- it is evidence about
    // our arithmetic.
    expect(detectClampedReading(estimated(HY3_REAL_CAP), HY3_DECLARED, HY3_SENT_ESTIMATE)).toBeUndefined();
  });

  it('a reading that is merely small is not a cap', () => {
    // Below the declaration and behind an oversized request, but landing
    // nowhere in particular. Ordinary readings look like this.
    expect(detectClampedReading(measured(196_600), HY3_DECLARED, HY3_SENT_ESTIMATE)).toBeUndefined();
  });

  it('an aligned reading with nothing oversized behind it is not flagged', () => {
    // The 1-in-4096 coincidence: a genuine conversation whose size happens to
    // land on the boundary. The estimator reads LOW, so on an honest reading
    // it sits below the provider's number -- which is exactly this case, and
    // exactly why the coincidence does not survive.
    expect(detectClampedReading(measured(196_608), HY3_DECLARED, 190_000)).toBeUndefined();
    // The boundary of that condition: an estimate equal to the reading is not
    // "exceeds", so it stays silent.
    expect(detectClampedReading(measured(196_608), HY3_DECLARED, 196_608)).toBeUndefined();
  });

  it('a reading exactly at the declared window is the ordinary large-conversation case', () => {
    // Nothing here contradicts the declaration; the conversation simply grew
    // into it, which the compaction threshold already handles.
    //
    // The declaration used here is ITSELF 4,096-aligned, and that is the
    // whole fixture. Measured: with a non-aligned declaration this case
    // passes under a mutation that admits a reading equal to the
    // declaration -- the alignment check refuses it first, so the assertion
    // holds for a reason unrelated to the boundary it names.
    const alignedDeclaration = 196_608;
    expect(
      detectClampedReading(measured(alignedDeclaration), alignedDeclaration, alignedDeclaration * 2),
    ).toBeUndefined();
  });

  it('no declaration means nothing to contradict', () => {
    expect(detectClampedReading(measured(HY3_REAL_CAP), undefined, HY3_SENT_ESTIMATE)).toBeUndefined();
  });

  it('a zero reading is inert rather than an infinitely clamped one', () => {
    // Zero is a multiple of 4096 and below every declaration, so without an
    // explicit floor it would satisfy the shape and report a cap of zero.
    expect(detectClampedReading(measured(0), HY3_DECLARED, HY3_SENT_ESTIMATE)).toBeUndefined();
  });

  it('does not fire on the two identical readings a healthy absorbed overflow publishes', () => {
    // The refuted predicate, kept as a case so it cannot come back silently.
    // A mid-turn escape publishes the distillation call's usage and then the
    // retry's, and those two are identical when compaction restored the
    // conversation's size. An earlier draft flagged exactly that.
    //
    // Observed values from a probe of the escape path: 4,321 twice, with 43
    // (estimated) between them.
    expect(detectClampedReading(measured(4_321), HY3_DECLARED, 5_000)).toBeUndefined();
    expect(detectClampedReading(estimated(43), HY3_DECLARED, 5_000)).toBeUndefined();
  });
});
