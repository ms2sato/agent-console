import { useState } from 'react';
import { describe, it, expect, afterEach, beforeEach, spyOn } from 'bun:test';
import { render, screen, cleanup, act } from '@testing-library/react';
import { TerminalView } from '../TerminalView';
import { ErrorBoundary } from '../../ui/ErrorBoundary';
import { getOrCreateTerminal, _resetTerminals, type TerminalInstance } from '../terminal-store';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';

// Level (c) of the #1899 three-level pin: a cross-level MOUNT integration
// check only. This test makes NO claim about the stall (heartbeat gap, RSS
// growth, microtask starvation) originally reported in #1899 -- that symptom
// was investigated separately and found to persist independent of the NaN
// resize bug this file pins (see #1899 for the ongoing investigation). What
// this test DOES claim: happy-dom's garbage geometry must never trip the
// ErrorBoundary wrapping TerminalView, across a sibling re-render. See
// TerminalView.geometry-measurement.test.ts (level a) and
// terminal-store.test.ts's "resize() non-finite/non-positive guard" describe
// block (level b) for the two unit-level pins this integration test sits on
// top of.
//
// happy-dom's getComputedStyle() returns '' (not a resolved "0px") for an
// unset padding, because it applies no real CSS engine — Tailwind's `px-2
// py-1` classes on the scroll container are never resolved. Before the (a)
// and (b) fixes, TerminalView's `applyResize` fed that `''` straight into
// `parseFloat`, producing NaN padding -> NaN cols/rows ->
// `instance.resize(NaN, NaN)` -> `@xterm/headless`'s `Terminal.resize()`
// throwing "This API only accepts integers". The ErrorBoundary wrapping
// TerminalView in SessionPage caught that, unmounting TerminalView.
//
// Real browsers never produce this: `getComputedStyle` always resolves to a
// concrete pixel value once an element is in the DOM, so the NaN path is a
// happy-dom-only harness artifact, not a production defect (confirmed via
// real-Chromium manual verification across 5 layout scenarios). This test
// still deliberately mounts a REAL store instance with NO stubbed geometry
// (no `getBoundingClientRect`/`getComputedStyle` overrides), the same
// "garbage geometry" happy-dom produces by default per this file's sibling
// `TerminalView.test.tsx` comment ("Neutralize the ResizeObserver-driven
// resize: happy-dom yields garbage geometry (NaN cols)"), so the fix is
// pinned against the exact condition that used to trip it.

function Harness({ instance }: { instance: TerminalInstance }) {
  const [generation, setGeneration] = useState(0);
  return (
    <div>
      <button
        type="button"
        onClick={() => setGeneration((g) => g + 1)}
      >
        close-sibling-tab
      </button>
      {/* `generation` in the key stands in for a sibling tab-close triggering
          a parent re-render; it is read nowhere else. */}
      <div data-generation={generation}>
        <ErrorBoundary fallback={() => <div data-testid="boundary-fallback">boundary tripped</div>}>
          <TerminalView instance={instance} />
        </ErrorBoundary>
      </div>
    </div>
  );
}

describe('TerminalView resize NaN guard (#1899 regression)', () => {
  let restoreWebSocket: () => void;
  let originalLocation: PropertyDescriptor | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleErrorSpy: ReturnType<typeof spyOn<any, 'error'>>;

  beforeEach(() => {
    _resetTerminals();
    restoreWebSocket = installMockWebSocket();
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
      configurable: true,
    });
    // Record calls without silencing them from inspection -- the implementation
    // must never be allowed to actually write to the real console during the
    // test, but we still read what was recorded.
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    _resetTerminals();
    restoreWebSocket();
    consoleErrorSpy.mockRestore();
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
  });

  it('never trips the ErrorBoundary across a sibling re-render', async () => {
    const instance = getOrCreateTerminal('s1899', 'w1899');
    const ws = MockWebSocket.getLastInstance();
    if (!ws) throw new Error('no ws');
    ws.simulateOpen();

    render(<Harness instance={instance} />);

    // Standing in for closing a background (non-active) tab: a sibling
    // state update re-renders the tree around the already-mounted
    // TerminalView without remounting it.
    await act(async () => {
      screen.getByRole('button', { name: 'close-sibling-tab' }).click();
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    expect(screen.queryByTestId('boundary-fallback')).toBeNull();

    const trippedCalls = consoleErrorSpy.mock.calls.filter((call) =>
      call.some(
        (arg) =>
          (typeof arg === 'string' && arg.includes('This API only accepts integers')) ||
          (arg instanceof Error && arg.message.includes('This API only accepts integers')),
      ),
    );
    expect(trippedCalls).toEqual([]);
  });
});
