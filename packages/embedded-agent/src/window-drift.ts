/**
 * Signal 2 of window-declaration drift: a LENIENT provider does not reject an
 * over-window request. It silently drops what does not fit, answers normally,
 * and reports a `prompt_tokens` clamped to its real cap. Nothing fails, so
 * nothing surfaces -- which is what makes this the worse of the two signals.
 *
 * # The doctrine is the classifier's, applied to a number
 *
 * The consumer of this verdict tells an operator their configuration
 * disagrees with reality. A false one sends someone to edit a value that was
 * correct, and spends the attention a true one will need later. So every
 * condition below is a gate, none of them is a heuristic reaching for a
 * conclusion, and a reading that fails any of them produces silence.
 *
 * # What each condition is measured against
 *
 * **1. The reading is the provider's own.** An estimate agreeing with a cap
 * means nothing -- our estimate did not come from the provider and cannot
 * testify about what the provider did.
 *
 * **2. A declaration exists, and the reading sits below it.** With no
 * declaration there is nothing to contradict. A reading at or above the
 * declaration is the ordinary "the conversation is getting large" case, which
 * the compaction threshold already handles.
 *
 * **3. The reading lands exactly on a 4,096-token boundary.** Measured
 * 2026-08-29 against `hy3`: a request of roughly 500,000 tokens was answered
 * with a `prompt_tokens` of exactly 196,608, which is 48 x 4,096 -- the shape
 * of a machine's cap, not of a conversation's size. A genuine reading hits
 * such a boundary about once in 4,096 turns, which is rare but NOT rare
 * enough on a long-lived worker to stand alone. Hence condition 4.
 *
 * **4. Our own estimate of what we sent exceeds the reading.** This is the
 * condition that makes the coincidence in 3 nearly impossible, and it works
 * because the estimator's error has a MEASURED DIRECTION: chars/4 counts
 * neither the tool schemas nor `tool_calls`, so it reads low. Measured
 * 2026-08-29: it read 5,450 where the provider reported 10,512 for the same
 * conversation. On an honest reading the estimate therefore sits BELOW the
 * provider's number, and the estimate exceeding it is already anomalous. On a
 * truncated reading the gap is enormous and in the same direction.
 *
 * # A predicate this file does NOT use, and why
 *
 * An earlier draft flagged a measured reading identical to the previous
 * measured reading, reasoning that a conversation always grows so exact
 * equality can only be a clamp. It is wrong, and a probe of the mid-turn
 * escape killed it before it was written: an absorbed overflow publishes the
 * distillation call's usage and then the retry's usage, and on a conversation
 * whose size the compaction restored, **those two readings are identical**.
 * The predicate fired on a healthy path, in the dangerous direction. It is
 * recorded here because the reasoning behind it is appealing enough to be
 * proposed again.
 */

/** The granularity every measured cap has landed on. See condition 3 above. */
const CAP_ALIGNMENT_TOKENS = 4_096;

export interface UsageReading {
  readonly promptTokens: number;
  /** False when the number came from the provider's own usage report. */
  readonly estimated: boolean;
}

/**
 * The provider's apparent real input limit when a reading bears every mark of
 * having been clamped, and `undefined` in every other case -- including every
 * case we are merely unsure about.
 *
 * The returned number is what the provider appears to enforce, which is the
 * useful half: the caller already knows the declaration.
 */
export function detectClampedReading(
  reading: UsageReading,
  declaredWindowTokens: number | undefined,
  sentEstimateTokens: number,
): number | undefined {
  if (reading.estimated) return undefined;
  if (declaredWindowTokens === undefined) return undefined;

  const measured = reading.promptTokens;
  if (measured <= 0 || measured >= declaredWindowTokens) return undefined;
  if (measured % CAP_ALIGNMENT_TOKENS !== 0) return undefined;
  // The estimator reads low, so this comparison is already the anomalous
  // direction before the size of the gap is considered.
  if (sentEstimateTokens <= measured) return undefined;

  return measured;
}
