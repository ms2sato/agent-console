import { describe, it, expect } from 'bun:test';
import { isContextOverflowError, extractProviderStatedLimit } from '../context-overflow';
/*
 * Reach of the extraction pins, measured the same way as the `c*` mutations
 * below (mutation applied to `context-overflow.ts`, this file re-run):
 *
 *   x1  remove `limitCapture` from the measured qwen entry
 *       -> 'reads the provider-stated cap out of the measured body' here, plus
 *          the over-declaration case in `agent-loop-window-drift.test.ts`.
 *   x2  fall back to a loose `/(\d{4,})/` when a signature has no capture
 *       pattern -- the dangerous direction, since it manufactures a number
 *       from prose nobody measured
 *       -> 'reads NOTHING from a matched signature that carries no capture
 *          pattern', plus its end-to-end twin in the drift test.
 *   x3  drop the `Number.isSafeInteger && > 0` validation
 *       -> 'refuses a captured number that cannot be a limit', alone.
 *   x4  match on status alone, so extraction no longer rides the verdict
 *       -> 'reads nothing from an error the VERDICT did not recognise', alone.
 *          This is what makes the shared `matchSignature` load-bearing rather
 *          than merely tidy.
 */
import type { ProviderErrorDetail } from '../providers/types';

/**
 * Measured reach, recorded by WHICH test failed (standing rule). Each mutation
 * was applied to `context-overflow.ts` and this file re-run:
 *
 *   c1  drop the discriminator from the `invalid_parameter_error` entry
 *       -> 1 fail, alone: 'a non-overflow invalid_parameter_error is NOT
 *          classified as overflow'. Nothing else notices, because every other
 *          case either has no discriminator to drop or fails on family/status
 *          first. That test is the whole guard against the generic-code trap.
 *   c2  return `true` when `detail` is undefined (treat absence as unknown-so-
 *       assume-overflow)
 *       -> 1 fail, alone: the Cloudflare 1010 case. This is the dangerous
 *          direction, and the mutation the module's "absence is a verdict"
 *          paragraph exists to prevent.
 *          Recorded as 2 when predicted, and measured as 1: the "no status at
 *          all" case returns false at the status guard before it ever reaches
 *          the detail branch, so it cannot distinguish this mutation. The
 *          Cloudflare case is the ONLY thing standing here -- which is worth
 *          knowing before anyone edits it.
 *   c3  ignore `status` (match on family alone)
 *       -> 1 fail, alone: the deepseek 403 case.
 *
 * Measurement note, inherited from PR #1462's harness mistake: match the
 * failure marker anywhere in the line, not at line start, and confirm the
 * mutation applied before believing a zero.
 */

const detail = (d: Partial<ProviderErrorDetail> & { message: string }): ProviderErrorDetail => d;

describe('isContextOverflowError', () => {
  describe('measured overflow signatures', () => {
    it('classifies the qwen3.8-flash 400 as overflow, from its structure plus the length discriminator', () => {
      // Verbatim from the measurement recorded in #1419: HTTP 400,
      // `invalid_parameter_error`, this exact message.
      expect(
        isContextOverflowError(
          400,
          detail({
            message: 'Range of input length should be [1, 983616]',
            type: 'invalid_parameter_error',
          }),
        ),
      ).toBe(true);
    });

    it('classifies the industry-standard context_length_exceeded code with no discriminator needed', () => {
      expect(
        isContextOverflowError(
          400,
          detail({
            message: "This model's maximum context length is 8192 tokens",
            code: 'context_length_exceeded',
          }),
        ),
      ).toBe(true);
    });

    it('accepts the family on either structured field, since providers disagree about which they populate', () => {
      const asType = isContextOverflowError(400, detail({ message: 'x', type: 'context_length_exceeded' }));
      const asCode = isContextOverflowError(400, detail({ message: 'x', code: 'context_length_exceeded' }));
      expect(asType).toBe(true);
      expect(asCode).toBe(true);
    });
  });

  describe('the dangerous direction: things that must NOT be classified as overflow', () => {
    it('a non-overflow invalid_parameter_error is NOT classified as overflow', () => {
      // The generic-code trap. `invalid_parameter_error` covers every invalid
      // parameter; without the message discriminator this would be a false
      // positive, and a false positive turns a provider fault into a
      // compaction. This is the case that fails when the discriminator is
      // dropped, and nothing else catches it.
      expect(
        isContextOverflowError(
          400,
          detail({
            message: 'Value of temperature must be between 0 and 2',
            type: 'invalid_parameter_error',
          }),
        ),
      ).toBe(false);
    });

    it("Cloudflare's error code 1010 carries no provider envelope, so there is nothing to match", () => {
      // Measured 2026-08-29: any model, ~2MB body, non-browser UA -> HTTP 403
      // with an edge-proxy body, not the provider's JSON error envelope. The
      // adapter's parse therefore yields `undefined`.
      //
      // This is the row a size-correlated heuristic misfires on, and the
      // failure mode would be an edge proxy triggering a compaction. It is
      // refused here WITHOUT an exclusion rule naming it: every signature
      // requires structure, and there is none.
      expect(isContextOverflowError(403, undefined)).toBe(false);
    });

    it('a deepseek RegionError 403 is not overflow', () => {
      // Measured 2026-08-29, `deepseek-v4-flash`: HTTP 403, `RegionError`.
      expect(isContextOverflowError(403, detail({ message: 'RegionError', type: 'RegionError' }))).toBe(false);
    });

    it('the right family at the wrong status is not overflow', () => {
      expect(
        isContextOverflowError(500, detail({ message: 'Range of input length should be [1, 983616]', type: 'invalid_parameter_error' })),
      ).toBe(false);
    });

    it('a failure with no status at all is not overflow', () => {
      // A retry loop exhausting itself, or an internal fault: no
      // `ProviderError`, so no status and no detail reach the classifier.
      expect(isContextOverflowError(undefined, undefined)).toBe(false);
      expect(isContextOverflowError(undefined, detail({ message: 'x', code: 'context_length_exceeded' }))).toBe(false);
    });

    it('an unrecognised provider code is not overflow, however plausible the prose', () => {
      // Prose is never consulted on its own. A message that reads exactly like
      // an overflow, carrying a family we have not measured, stays false --
      // the safe direction.
      expect(
        isContextOverflowError(400, detail({ message: 'Range of input length should be [1, 983616]', type: 'some_unmeasured_error' })),
      ).toBe(false);
    });
  });
});

describe('extractProviderStatedLimit', () => {
  // The measured body, verbatim: opencode zen go/v1, `qwen3.8-flash`, 2026-08-29.
  const QWEN = detail({
    message: 'Range of input length should be [1, 983616]',
    type: 'invalid_parameter_error',
  });

  it('reads the provider-stated cap out of the measured body', () => {
    expect(extractProviderStatedLimit(400, QWEN)).toBe(983_616);
  });

  it('reads NOTHING from a matched signature that carries no capture pattern', () => {
    // The fail-toward-nothing polarity the design turns on, stated as a case
    // rather than as a comment. `context_length_exceeded` matches the verdict
    // at family level and has no measured body here, so a number sitting in
    // its prose is deliberately not taken -- writing a pattern from the shape
    // one EXPECTS is the unmeasured guess the table forbids.
    const openai = detail({
      message: "This model's maximum context length is 8192 tokens.",
      code: 'context_length_exceeded',
    });
    expect(isContextOverflowError(400, openai)).toBe(true);
    expect(extractProviderStatedLimit(400, openai)).toBeUndefined();
  });

  it('reads nothing from an error the VERDICT did not recognise, however clearly it names a number', () => {
    // Extraction is gated on the same match as the verdict, so a number can
    // never be read out of an unrelated fault. Same body, unmeasured family.
    const unmeasured = detail({
      message: 'Range of input length should be [1, 983616]',
      type: 'some_unmeasured_error',
    });
    expect(isContextOverflowError(400, unmeasured)).toBe(false);
    expect(extractProviderStatedLimit(400, unmeasured)).toBeUndefined();
  });

  it('reads nothing when the provider keeps the family but changes the wording', () => {
    // A provider rewording its message stops producing drift claims rather
    // than producing wrong ones -- and the verdict is unaffected, because the
    // two answers are independent by construction. This is the case that
    // shows the degradation is graceful in the direction that matters.
    const reworded = detail({
      message: 'maximum context length is 983616 tokens, your input was longer',
      type: 'invalid_parameter_error',
    });
    expect(isContextOverflowError(400, reworded)).toBe(true);
    expect(extractProviderStatedLimit(400, reworded)).toBeUndefined();
  });

  it('reads nothing at the wrong status, or with no status and no detail', () => {
    expect(extractProviderStatedLimit(500, QWEN)).toBeUndefined();
    expect(extractProviderStatedLimit(undefined, QWEN)).toBeUndefined();
    expect(extractProviderStatedLimit(400, undefined)).toBeUndefined();
  });

  it('refuses a captured number that cannot be a limit', () => {
    // Zero parses fine and would compare as "the provider allows nothing",
    // turning a malformed body into an alarming operator-facing claim.
    expect(
      extractProviderStatedLimit(400, detail({ message: 'Range of input length should be [1, 0]', type: 'invalid_parameter_error' })),
    ).toBeUndefined();
    // Past the safe-integer range the parse silently rounds, so the number
    // reported would not be the number the provider wrote.
    expect(
      extractProviderStatedLimit(
        400,
        detail({ message: 'Range of input length should be [1, 99999999999999999999]', type: 'invalid_parameter_error' }),
      ),
    ).toBeUndefined();
  });
});
