/**
 * Exit-code mapping for `scripts/smoke/probe-sdk-effort-live-apply.ts`.
 *
 * The probe is billable and needs a real, authenticated `claude` CLI, so its
 * measurement is never run here. `exitCodeFor` is pure -- it reads only the
 * arms' own `conclusive` / `premise` verdicts -- and importing the module runs
 * nothing (the `import.meta.main` guard at the foot of that file), so the
 * mapping is testable at zero cost and separately from what it maps.
 *
 * Why the mapping is worth pinning at all: before this, ANY conclusive
 * measurement exited 0, including a conclusive REFUTATION of PS9. That script
 * is the thing readers are told to re-run on every SDK bump, which is exactly
 * the moment "the premise held" and "the premise fell" must not share a code.
 */
import { describe, it, expect } from 'bun:test';
import { PROBE_EXIT, classifyClearFallback, exitCodeFor } from '../probe-sdk-effort-live-apply.js';

const holds = { conclusive: true, premise: 'holds' } as const;
const refuted = { conclusive: true, premise: 'refuted' } as const;
const neutral = { conclusive: true, premise: null } as const;
const inconclusive = { conclusive: false, premise: null } as const;

describe('probe-sdk-effort-live-apply exit codes', () => {
  it('assigns each outcome a distinct code', () => {
    // The whole point: no two of these collapse onto one number.
    expect(
      new Set([
        PROBE_EXIT.PREMISE_HOLDS,
        PROBE_EXIT.INCONCLUSIVE,
        PROBE_EXIT.HARNESS,
        PROBE_EXIT.PREMISE_REFUTED,
      ]).size
    ).toBe(4);
    expect(PROBE_EXIT.PREMISE_HOLDS).toBe(0);
    expect(PROBE_EXIT.INCONCLUSIVE).toBe(1);
    expect(PROBE_EXIT.HARNESS).toBe(2);
    expect(PROBE_EXIT.PREMISE_REFUTED).toBe(3);
  });

  it('exits PREMISE_HOLDS when every arm concluded and one read the premise as holding', () => {
    expect(exitCodeFor([holds, neutral])).toBe(PROBE_EXIT.PREMISE_HOLDS);
    expect(exitCodeFor([holds])).toBe(PROBE_EXIT.PREMISE_HOLDS);
  });

  it('exits PREMISE_REFUTED on a conclusive refutation', () => {
    expect(exitCodeFor([refuted, neutral])).toBe(PROBE_EXIT.PREMISE_REFUTED);
  });

  /**
   * The ordering that matters. A refutation is a measurement in its own
   * right, so it must not be downgraded to INCONCLUSIVE by an unrelated arm
   * that failed to settle -- that would hide the one result this mapping
   * exists to surface. Both mixes are pinned, including a refutation sitting
   * alongside an arm that read the premise as holding.
   */
  it('lets a refutation outrank an inconclusive or holding sibling arm', () => {
    expect(exitCodeFor([refuted, inconclusive])).toBe(PROBE_EXIT.PREMISE_REFUTED);
    expect(exitCodeFor([inconclusive, refuted])).toBe(PROBE_EXIT.PREMISE_REFUTED);
    expect(exitCodeFor([holds, refuted])).toBe(PROBE_EXIT.PREMISE_REFUTED);
  });

  it('exits INCONCLUSIVE when any arm failed to settle', () => {
    expect(exitCodeFor([holds, inconclusive])).toBe(PROBE_EXIT.INCONCLUSIVE);
    expect(exitCodeFor([inconclusive])).toBe(PROBE_EXIT.INCONCLUSIVE);
  });

  /**
   * A `--absent`-only run: conclusive, and silent about PS9. Exiting 0 there
   * would claim a premise nobody measured, so it is INCONCLUSIVE instead.
   * The empty case (vacuously "every arm concluded") lands the same way for
   * the same reason.
   */
  it('exits INCONCLUSIVE when no arm bore on the premise at all', () => {
    expect(exitCodeFor([neutral])).toBe(PROBE_EXIT.INCONCLUSIVE);
    expect(exitCodeFor([])).toBe(PROBE_EXIT.INCONCLUSIVE);
  });
});

/**
 * The same "never exit 0 on something nobody measured" property, one level
 * further in: the `--clear` arm's own reading of turn 3, before the mapping
 * above ever sees it.
 *
 * The hazard the constrained branch removes: a later SDK that renames or
 * adds an effort level makes turn 3 read a string this repository has never
 * heard of, which is neither the set value ('medium') nor the query-time one
 * ('low'). An unconstrained "anything else is the SDK's own default" branch
 * calls that CONCLUSIVE and `premise: 'holds'`, and the run exits 0 --
 * reporting a premise no turn interpreted. `classifyClearFallback` is pure
 * and takes the reading as a plain string, so this costs nothing to pin.
 */
describe('probe-sdk-effort-live-apply --clear turn-3 classification', () => {
  it('reads a KNOWN level that is neither the set nor the query-time value as the SDK default', () => {
    // Every remaining member of EFFORT_LEVELS, not just 'high': which one
    // the SDK defaults to is the SDK's business, and any of them supports
    // the same reading.
    for (const level of ['high', 'xhigh', 'max']) {
      const r = classifyClearFallback(level);
      expect(r).toMatchObject({ conclusive: true, premise: 'holds' });
      expect(r.verdict).toStartWith('DEFAULT FALLBACK');
      expect(exitCodeFor([r])).toBe(PROBE_EXIT.PREMISE_HOLDS);
    }
  });

  it('reads an UNRECOGNIZED level as inconclusive -- exit 1, never 0', () => {
    const r = classifyClearFallback('ultra');
    expect(r).toMatchObject({ conclusive: false, premise: null });
    expect(r.verdict).toStartWith('UNEXPECTED');
    // The assertion the constraint exists for: the whole run's code.
    expect(exitCodeFor([r])).toBe(PROBE_EXIT.INCONCLUSIVE);
    expect(exitCodeFor([r])).not.toBe(PROBE_EXIT.PREMISE_HOLDS);
  });

  it('keeps the two refutations and the unreadable turn unchanged', () => {
    // Guards the extraction itself: these three branches moved out of the
    // arm verbatim and must still map as they did.
    expect(classifyClearFallback('medium')).toMatchObject({ conclusive: true, premise: 'refuted' });
    expect(classifyClearFallback('low')).toMatchObject({ conclusive: true, premise: 'refuted' });
    expect(classifyClearFallback(null)).toMatchObject({ conclusive: false, premise: null });
    expect(exitCodeFor([classifyClearFallback('medium')])).toBe(PROBE_EXIT.PREMISE_REFUTED);
    expect(exitCodeFor([classifyClearFallback('low')])).toBe(PROBE_EXIT.PREMISE_REFUTED);
    expect(exitCodeFor([classifyClearFallback(null)])).toBe(PROBE_EXIT.INCONCLUSIVE);
  });
});
