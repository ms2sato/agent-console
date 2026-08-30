import { describe, it, expect } from 'bun:test';
import { isContextOverflowError } from '../context-overflow';
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
