/**
 * Pure threshold-crossing predicate for the Context Handoff (Phase A) usage
 * banners -- see docs/design/embedded-agent-worker.md "Context Handoff
 * (Phase A)" § UI "Threshold banners".
 *
 * A crossing is defined as `prevRatio < threshold <= currentRatio`, treating
 * "no prior reading yet" (`prevRatio === null`) as `0` -- so a worker whose
 * very first usage reading already exceeds a threshold still fires once.
 * Two different thresholds (soft/hard) are evaluated independently against
 * the same `(prevRatio, currentRatio)` pair by the caller; both can be `true`
 * for the same update (e.g. a single turn jumping usage from 60% to 95%).
 */
export function crossedThreshold(
  prevRatio: number | null,
  currentRatio: number,
  threshold: number,
): boolean {
  const prev = prevRatio ?? 0;
  return prev < threshold && currentRatio >= threshold;
}
