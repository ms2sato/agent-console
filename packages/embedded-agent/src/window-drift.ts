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
 * # How each condition ages, and which way it fails when it does
 *
 * Conditions 3 and 4 are OBSERVED signatures, not documented contracts. Both
 * were measured on one day against one provider each, and neither vendor
 * promises them. Re-verify when: a new provider is added and truncates rather
 * than rejecting; a provider changes its reported `prompt_tokens`; or
 * `estimateTokensFromChars` changes.
 *
 * **Condition 3 (alignment) is provider-dependent.** 4,096 is the alignment
 * the single measured cap happened to have. A provider clamping to a
 * non-power-of-two limit produces no match, and this stays silent about a
 * truncation that really occurred. That is a false negative, which is the
 * direction chosen everywhere in this file.
 *
 * **Condition 4 does NOT degrade toward silence if the estimator improves --
 * it degrades the other way, and this is worth stating precisely because the
 * intuitive reading is backwards.** The condition asks whether our estimate
 * exceeds the provider's number, and its usefulness comes from the
 * estimator's error having a KNOWN SIGN, not from the error being small:
 *
 * - On an honest reading, an understating estimator lands reliably BELOW the
 *   provider's number, so the condition fails and nothing is claimed. That is
 *   the false-positive protection, and it is bought by the understatement.
 * - On a truncation, the condition needs the real request to exceed the cap
 *   by MORE than the estimator understates. With the measured factor of
 *   roughly two, a mild truncation is therefore MISSED: the measured `hy3`
 *   case cleared it only because it was truncated about 2.5-fold, and a
 *   request 1.1x over a cap is invisible here. The understatement costs
 *   detection, and that is the price paid for the protection above.
 *
 * So an estimator that became accurate would catch milder truncations and, at
 * the same time, lose the margin that keeps an aligned honest reading from
 * firing -- trading a false negative for a false positive. An estimator that
 * OVERSTATED would remove the protection entirely, leaving only the
 * 1-in-4,096 alignment coincidence between an honest reading and an
 * operator-facing claim that their correct configuration is wrong.
 *
 * **Therefore: a change to `estimateTokensFromChars` is a change to this
 * predicate's false-positive rate, and condition 4 must be re-derived rather
 * than assumed to still hold.** It will not simply go quiet.
 *
 * # Adding a condition here changes how every existing test must be built
 *
 * The verdict is a conjunction, so a case written to exercise ONE condition
 * only reaches it when the fixture satisfies every OTHER one. Otherwise an
 * earlier gate refuses the reading and the assertion passes without the named
 * condition ever being evaluated -- green, true, accurately named, and
 * measuring nothing. This is `testing.md`'s "an assertion with more than one
 * way to come true", in the shape a conjunction gives it, and it has already
 * happened here once: the declaration-boundary case used a declaration that
 * was not 4,096-aligned, so alignment refused it first.
 *
 * Adding a sixth condition therefore means revisiting the fixtures of all
 * five existing cases, not only writing a case for the new one.
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
