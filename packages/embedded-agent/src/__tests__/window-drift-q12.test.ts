/**
 * Q12 for #1434 — window-declaration drift, reproduced against unmodified code.
 *
 * The Issue's claim is that the system RECEIVES evidence contradicting a
 * declared `contextWindowTokens` and DISCARDS it. These cases assert the
 * discarding, so the feature has something observed absent before it is built.
 *
 * Both signals, deterministic and free:
 *
 *   1. A strict provider's rejection names its real cap numerically. The
 *      classifier already recognises the rejection as an overflow -- that is
 *      #1433's work -- but nothing extracts the NUMBER, so the operator never
 *      learns their declaration is wrong.
 *   2. A lenient provider reports a `prompt_tokens` capped exactly at its real
 *      window, having silently dropped the rest. The reading is measured
 *      (`estimated: false`) and contradicts the declaration, and no layer
 *      compares them.
 *
 * If either of these starts failing, the feature is partly built and the AC's
 * premise needs re-checking before more is added.
 */
import { describe, it, expect } from 'bun:test';
import { isContextOverflowError } from '../context-overflow';
import type { ProviderErrorDetail } from '../providers/types';
import * as v from 'valibot';
import { EmbeddedAgentEventSchema } from '@agent-console/shared';

/** Measured 2026-08-29, opencode zen go/v1, `qwen3.8-flash`. */
const QWEN_REJECTION: ProviderErrorDetail = {
  message: 'Range of input length should be [1, 983616]',
  type: 'invalid_parameter_error',
};

/** The provider's real cap, named inside the measured rejection body above. */
const PROVIDER_REAL_LIMIT = 983_616;

describe('#1434 Q12 — the contradicting evidence is received and discarded', () => {
  describe('signal 1: the rejection carries the real limit, and nothing reads it', () => {
    it('PREMISE: the rejection IS already recognised as an overflow', () => {
      // The half #1433 built. Stated as a control: if this were false, the
      // signal-1 path would not be reached at all and the case below would
      // pass for the wrong reason.
      expect(isContextOverflowError(400, QWEN_REJECTION)).toBe(true);
    });

    it('the provider-stated limit is present in the message but no API exposes it', async () => {
      // The number is right there in the structure that already flows inward.
      expect(QWEN_REJECTION.message).toContain(String(PROVIDER_REAL_LIMIT));

      // And the classifier's only output is a boolean. There is nowhere for a
      // number to come out, which is the gap: the evidence arrives, is
      // correctly classified, and its most useful content is dropped.
      const verdict: boolean = isContextOverflowError(400, QWEN_REJECTION);
      expect(typeof verdict).toBe('boolean');

      // Nothing in the module surfaces the contradiction either.
      const surfaced = Object.keys(
        (await import('../context-overflow')) as Record<string, unknown>,
      ).filter((k) => /limit|drift|declared|window/i.test(k));
      expect(surfaced).toEqual([]);
    });

    it('the classifier reaches the number and discards it: the same verdict for two different limits', () => {
      // Replaces an earlier case that asserted `DECLARED - REAL === 16384` --
      // arithmetic on two constants written in this file, which tested
      // nothing about the code.
      //
      // This reads production instead: two rejections naming DIFFERENT real
      // limits are indistinguishable at the classifier's output. The number
      // reaches it and cannot come back out, which is the gap stated as a
      // property rather than as a subtraction.
      const other: ProviderErrorDetail = {
        message: 'Range of input length should be [1, 131072]',
        type: 'invalid_parameter_error',
      };
      expect(isContextOverflowError(400, QWEN_REJECTION)).toBe(true);
      expect(isContextOverflowError(400, other)).toBe(true);
      expect(isContextOverflowError(400, QWEN_REJECTION)).toBe(isContextOverflowError(400, other));
    });
  });

  describe('signal 2: a measured reading contradicts the declaration, and nothing compares them', () => {
    it('the context-usage event has no field to carry a drift flag, and its schema REJECTS one', () => {
      // Replaces an earlier case that inspected the keys of an object literal
      // written two lines above it -- self-referential, and true whatever the
      // production schema said.
      //
      // Measured 2026-08-29, `hy3`: a ~500k-token request answered with
      // `prompt_tokens` of exactly 196,608 (its real window), the rest
      // silently dropped. The reading is measured and contradicts a larger
      // declaration, and the event carrying it has nowhere to say so.
      const ordinary = { v: 1, type: 'context-usage', promptTokens: 196_608, estimated: false };
      expect(v.safeParse(EmbeddedAgentEventSchema, ordinary).success).toBe(true);

      // The schema is strict, so a drift field does not merely go unused --
      // it is refused. That is what makes this a schema change rather than an
      // additive convention, and it is why R6 orders the shared commit.
      const withDrift = { ...ordinary, declaredWindowTokens: 1_000_000 };
      expect(v.safeParse(EmbeddedAgentEventSchema, withDrift).success).toBe(false);
    });
  });
});
