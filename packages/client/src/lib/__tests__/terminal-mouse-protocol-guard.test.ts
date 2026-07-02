/**
 * Tests for the mouse-protocol re-assertion guard
 * (packages/client/src/lib/terminal-mouse-protocol-guard.ts).
 *
 * Two layers:
 *  1. Pure predicate tests of shouldSwallowMouseProtocolSet — a table over
 *     (param x currentMode) pinning which DECSET requests are swallowed
 *     (non-upgrades of the mouse protocol) vs applied (upgrades / non-mouse).
 *  2. Integration with a real headless xterm Terminal (no open() — write
 *     works pre-open, same as our cache-restore path). Confirms that a
 *     steady-state re-assert burst does not churn the protocol while a
 *     genuine fresh activation still reaches the intended final mode.
 */
import { describe, expect, it } from 'bun:test';
import { Terminal } from '@xterm/xterm';
import {
  shouldSwallowMouseProtocolSet,
  installMouseProtocolGuard,
} from '../terminal-mouse-protocol-guard';

type MouseMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    term.write(data, () => resolve());
  });
}

describe('shouldSwallowMouseProtocolSet (pure predicate)', () => {
  // Steady-state re-assert burst: already at 'any', every mouse param is a
  // downgrade or equal → swallow.
  const swallowCases: Array<[number, MouseMode]> = [
    [1003, 'any'], // any -> any (equal)
    [1000, 'any'], // vt200 <= any (downgrade)
    [1002, 'any'], // drag  <= any (downgrade)
    [9, 'x10'],    // x10 -> x10 (equal)
    [1002, 'drag'],// drag -> drag (equal)
    [1000, 'vt200'],// vt200 -> vt200 (equal)
    [1000, 'drag'],// vt200 <= drag (downgrade)
  ];
  for (const [param, mode] of swallowCases) {
    it(`should swallow param ${param} when current mode is ${mode}`, () => {
      expect(shouldSwallowMouseProtocolSet(param, mode)).toBe(true);
    });
  }

  // Genuine upgrades (and fresh activation) → apply.
  const applyCases: Array<[number, MouseMode]> = [
    [1000, 'none'], // none -> vt200 (fresh activation)
    [1002, 'vt200'],// vt200 -> drag (upgrade)
    [1003, 'drag'], // drag -> any (upgrade)
    [1003, 'none'], // none -> any (fresh activation, top mode)
    [9, 'none'],    // none -> x10 (fresh activation)
  ];
  for (const [param, mode] of applyCases) {
    it(`should apply (not swallow) param ${param} when current mode is ${mode}`, () => {
      expect(shouldSwallowMouseProtocolSet(param, mode)).toBe(false);
    });
  }

  // Non-mouse DECSET params are never swallowed, regardless of mode.
  const nonMouseParams = [25, 1004, 1005, 1006, 1015, 1016, 1049, 2004];
  const allModes: MouseMode[] = ['none', 'x10', 'vt200', 'drag', 'any'];
  for (const param of nonMouseParams) {
    for (const mode of allModes) {
      it(`should not swallow non-mouse param ${param} (mode ${mode})`, () => {
        expect(shouldSwallowMouseProtocolSet(param, mode)).toBe(false);
      });
    }
  }
});

describe('installMouseProtocolGuard (real xterm integration)', () => {
  it('should let a fresh activation burst upgrade to "any"', async () => {
    const term = new Terminal();
    installMouseProtocolGuard(term);
    await write(term, '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
    expect(term.modes.mouseTrackingMode).toBe('any');
    term.dispose();
  });

  it('should keep "any" across a steady-state re-assert burst', async () => {
    const term = new Terminal();
    installMouseProtocolGuard(term);
    await write(term, '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
    // Second identical burst (the re-assert on redraw) must not churn.
    await write(term, '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
    expect(term.modes.mouseTrackingMode).toBe('any');
    term.dispose();
  });

  // Polarity-observable test: a lone downgrade DECSET while at 'any' must be
  // swallowed. WITHOUT the guard, xterm would set the mode to 'vt200'.
  it('should swallow a lone downgrade DECSET while at "any" (polarity)', async () => {
    const term = new Terminal();
    installMouseProtocolGuard(term);
    await write(term, '\x1b[?1003h'); // reach 'any'
    expect(term.modes.mouseTrackingMode).toBe('any');
    await write(term, '\x1b[?1000h'); // downgrade request — guard swallows it
    expect(term.modes.mouseTrackingMode).toBe('any');
    term.dispose();
  });

  it('should let DECRST turn tracking off and allow re-activation', async () => {
    const term = new Terminal();
    installMouseProtocolGuard(term);
    await write(term, '\x1b[?1003h');
    expect(term.modes.mouseTrackingMode).toBe('any');
    await write(term, '\x1b[?1003l'); // DECRST — always passes through
    expect(term.modes.mouseTrackingMode).toBe('none');
    await write(term, '\x1b[?1000h'); // re-activation from 'none' — applies
    expect(term.modes.mouseTrackingMode).toBe('vt200');
    term.dispose();
  });

  it('should pass multi-parameter DECSET through to the builtin', async () => {
    const term = new Terminal();
    installMouseProtocolGuard(term);
    await write(term, '\x1b[?1000;1002h');
    // Multi-param is not intercepted; the builtin applies it. Pin the
    // observed builtin outcome (last mouse param wins → 'drag').
    expect(term.modes.mouseTrackingMode).toBe('drag');
    term.dispose();
  });

  it('should not affect non-mouse DECSET (bracketed paste)', async () => {
    const term = new Terminal();
    installMouseProtocolGuard(term);
    await write(term, '\x1b[?2004h');
    expect(term.modes.bracketedPasteMode).toBe(true);
    term.dispose();
  });

  it('should stop guarding after dispose', async () => {
    const term = new Terminal();
    const guard = installMouseProtocolGuard(term);
    await write(term, '\x1b[?1003h');
    expect(term.modes.mouseTrackingMode).toBe('any');
    guard.dispose();
    await write(term, '\x1b[?1000h'); // downgrade now applies (guard gone)
    expect(term.modes.mouseTrackingMode).toBe('vt200');
    term.dispose();
  });
});
