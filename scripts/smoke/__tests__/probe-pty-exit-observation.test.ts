import { describe, expect, test } from 'bun:test';

import { classifyTimeout, determineExitCode } from '../probe-pty-exit-observation.js';

/**
 * Pins the pure classifier and exit-code mapper for Issue #1879's
 * measurement instrument. Per the Architect's AC, this file never spawns a
 * PTY -- the real-process behavior is exercised manually, by running
 * `bun scripts/smoke/probe-pty-exit-observation.ts` itself.
 *
 * Issue #1888 added the post-timeout grace window: `exitFiredWithinGrace`
 * wins over the LOST-EXIT/STUCK-CHILD table (regardless of `procState`) but
 * loses to `exitFired` (fired AT timeout, a probe timing artefact unrelated
 * to the grace window).
 */

describe('classifyTimeout', () => {
  test('boundary: procState undefined (gone) + exitFired false + no grace fire -> LOST-EXIT', () => {
    expect(
      classifyTimeout({ procState: undefined, killZeroErrno: 'ESRCH', exitFired: false, exitFiredWithinGrace: false }),
    ).toEqual({
      verdict: 'LOST-EXIT',
    });
  });

  test('boundary: procState Z (zombie) + exitFired false + no grace fire -> LOST-EXIT', () => {
    // A zombie still answers kill(pid, 0) with 0 -- this is the exact
    // misread the AC's observable-ordering rationale exists to prevent, and
    // the classifier must still land on LOST-EXIT despite that signal.
    expect(classifyTimeout({ procState: 'Z', killZeroErrno: 0, exitFired: false, exitFiredWithinGrace: false })).toEqual({
      verdict: 'LOST-EXIT',
    });
  });

  test('boundary: procState S (sleeping) + exitFired false + no grace fire -> STUCK-CHILD', () => {
    expect(classifyTimeout({ procState: 'S', killZeroErrno: 0, exitFired: false, exitFiredWithinGrace: false })).toEqual({
      verdict: 'STUCK-CHILD',
    });
  });

  test('procState R (running) + exitFired false + no grace fire -> STUCK-CHILD', () => {
    expect(classifyTimeout({ procState: 'R', killZeroErrno: 0, exitFired: false, exitFiredWithinGrace: false })).toEqual({
      verdict: 'STUCK-CHILD',
    });
  });

  test('procState D (uninterruptible sleep) + exitFired false + no grace fire -> STUCK-CHILD', () => {
    expect(classifyTimeout({ procState: 'D', killZeroErrno: 0, exitFired: false, exitFiredWithinGrace: false })).toEqual({
      verdict: 'STUCK-CHILD',
    });
  });

  test('boundary: any state + exitFired true -> INCONCLUSIVE (race lost but listener fired)', () => {
    const result = classifyTimeout({ procState: 'S', killZeroErrno: 0, exitFired: true, exitFiredWithinGrace: false });
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.reason).toContain('timing artefact');
  });

  test('procState undefined (gone) + exitFired true -> still INCONCLUSIVE, not LOST-EXIT', () => {
    // exitFired must win over every other observable per the AC.
    const result = classifyTimeout({ procState: undefined, killZeroErrno: 'ESRCH', exitFired: true, exitFiredWithinGrace: false });
    expect(result.verdict).toBe('INCONCLUSIVE');
  });

  test('procState Z (zombie) + exitFired true -> still INCONCLUSIVE, not LOST-EXIT', () => {
    const result = classifyTimeout({ procState: 'Z', killZeroErrno: 0, exitFired: true, exitFiredWithinGrace: false });
    expect(result.verdict).toBe('INCONCLUSIVE');
  });

  test('an unrecognized /proc state letter -> INCONCLUSIVE, naming the state', () => {
    const result = classifyTimeout({ procState: 'T', killZeroErrno: 0, exitFired: false, exitFiredWithinGrace: false });
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.reason).toContain('T');
  });

  test('procState undefined but kill(pid, 0) disagrees (returns 0, not ESRCH) -> INCONCLUSIVE, named as a pid-reuse inconsistency', () => {
    const result = classifyTimeout({ procState: undefined, killZeroErrno: 0, exitFired: false, exitFiredWithinGrace: false });
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.reason).toContain('pid reuse');
  });

  test('procState undefined, kill(pid, 0) EPERM (also disagrees with ESRCH) -> INCONCLUSIVE', () => {
    const result = classifyTimeout({ procState: undefined, killZeroErrno: 'EPERM', exitFired: false, exitFiredWithinGrace: false });
    expect(result.verdict).toBe('INCONCLUSIVE');
  });

  // --- Issue #1888: post-timeout grace window boundaries ---

  test('boundary: grace fired + procState undefined -> DELAYED-EXIT', () => {
    expect(
      classifyTimeout({ procState: undefined, killZeroErrno: 'ESRCH', exitFired: false, exitFiredWithinGrace: true }),
    ).toEqual({
      verdict: 'DELAYED-EXIT',
    });
  });

  test('boundary: grace fired + state S -> DELAYED-EXIT (the child exited during the grace, regardless of procState)', () => {
    expect(classifyTimeout({ procState: 'S', killZeroErrno: 0, exitFired: false, exitFiredWithinGrace: true })).toEqual({
      verdict: 'DELAYED-EXIT',
    });
  });

  test('grace fired + state R -> DELAYED-EXIT (wins over the STUCK-CHILD table too)', () => {
    expect(classifyTimeout({ procState: 'R', killZeroErrno: 0, exitFired: false, exitFiredWithinGrace: true })).toEqual({
      verdict: 'DELAYED-EXIT',
    });
  });

  test('grace fired + zombie state Z -> DELAYED-EXIT (wins over the LOST-EXIT table too)', () => {
    expect(classifyTimeout({ procState: 'Z', killZeroErrno: 0, exitFired: false, exitFiredWithinGrace: true })).toEqual({
      verdict: 'DELAYED-EXIT',
    });
  });

  test('exitFired (at timeout) true wins over exitFiredWithinGrace true -> still INCONCLUSIVE, not DELAYED-EXIT', () => {
    const result = classifyTimeout({ procState: undefined, killZeroErrno: 'ESRCH', exitFired: true, exitFiredWithinGrace: true });
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.reason).toContain('timing artefact');
  });
});

describe('determineExitCode', () => {
  test('boundary: empty cycle list -> 0 (vacuously no INCONCLUSIVE present)', () => {
    expect(determineExitCode([])).toBe(0);
  });

  test('boundary: single element, exited -> 0', () => {
    expect(determineExitCode([{ outcome: 'exited' }])).toBe(0);
  });

  test('single element, LOST-EXIT -> 0 (a definite verdict still counts as "measured")', () => {
    expect(determineExitCode([{ outcome: 'timeout', verdict: 'LOST-EXIT' }])).toBe(0);
  });

  test('single element, DELAYED-EXIT -> 0 (a definite verdict still counts as "measured")', () => {
    expect(determineExitCode([{ outcome: 'timeout', verdict: 'DELAYED-EXIT' }])).toBe(0);
  });

  test('single element, STUCK-CHILD -> 0', () => {
    expect(determineExitCode([{ outcome: 'timeout', verdict: 'STUCK-CHILD' }])).toBe(0);
  });

  test('single element, INCONCLUSIVE -> 1', () => {
    expect(determineExitCode([{ outcome: 'timeout', verdict: 'INCONCLUSIVE' }])).toBe(1);
  });

  test('all-success: every cycle exited -> 0', () => {
    expect(determineExitCode([{ outcome: 'exited' }, { outcome: 'exited' }, { outcome: 'exited' }])).toBe(0);
  });

  test('all-failure (in the gate sense): every cycle INCONCLUSIVE -> 1', () => {
    expect(
      determineExitCode([
        { outcome: 'timeout', verdict: 'INCONCLUSIVE' },
        { outcome: 'timeout', verdict: 'INCONCLUSIVE' },
      ]),
    ).toBe(1);
  });

  test('mixed terminal verdicts, no INCONCLUSIVE -> 0', () => {
    expect(
      determineExitCode([
        { outcome: 'exited' },
        { outcome: 'timeout', verdict: 'LOST-EXIT' },
        { outcome: 'timeout', verdict: 'DELAYED-EXIT' },
        { outcome: 'timeout', verdict: 'STUCK-CHILD' },
      ]),
    ).toBe(0);
  });

  test('mixed, exactly one INCONCLUSIVE among many definite verdicts -> 1', () => {
    expect(
      determineExitCode([
        { outcome: 'exited' },
        { outcome: 'timeout', verdict: 'LOST-EXIT' },
        { outcome: 'timeout', verdict: 'DELAYED-EXIT' },
        { outcome: 'timeout', verdict: 'INCONCLUSIVE' },
        { outcome: 'timeout', verdict: 'STUCK-CHILD' },
      ]),
    ).toBe(1);
  });
});
