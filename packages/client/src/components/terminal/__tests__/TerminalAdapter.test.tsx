import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import type { TerminalInstance, TerminalSnapshot } from '../terminal-store';

// TerminalAdapter resolves its instance from the module store singleton. Mock
// only the store factory (the seam under test) and the repo-name hook (avoids a
// network query); the real TerminalView / TerminalKeyboardInput children render
// so no child-component module mock can leak into their own sibling tests.
import * as realStore from '../terminal-store';

const EXITED_SNAPSHOT: TerminalSnapshot = Object.freeze({
  version: 1,
  status: 'exited',
  exitInfo: { code: 0, signal: null },
  rows: [],
  cursor: { x: 0, y: 0, visible: true },
  cols: 80,
  terminalRows: 24,
  bufferType: 'normal',
  mouseTracking: false,
  notice: null,
  workerError: null,
  activityState: null,
  loadingHistory: false,
}) as TerminalSnapshot;

const stubInstance: TerminalInstance = {
  subscribe: () => () => {},
  getSnapshot: () => EXITED_SNAPSHOT,
  sendInput: () => {},
  resize: () => {},
  forwardScroll: () => {},
  reportMouseButton: () => {},
  paste: () => {},
  retry: () => {},
  dismissNotice: () => {},
  acquire: () => () => {},
  dispose: () => {},
};

const mockGetOrCreateTerminal = mock(
  (_sessionId: string, _workerId: string, _opts?: unknown): TerminalInstance => stubInstance,
);
// Spread the real module so any incidental cross-file import still sees the full
// surface; only the factory is overridden.
mock.module('../terminal-store', () => ({ ...realStore, getOrCreateTerminal: mockGetOrCreateTerminal }));
mock.module('../useSessionRepoFullName', () => ({ useSessionRepoFullName: () => null }));

import { act, cleanup, screen } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { TerminalAdapter } from '../TerminalAdapter';

// Fully-typed MediaQueryList stub (no double-cast); TerminalKeyboardInput's
// useIsMobile only reads `.matches`.
function createMatchMediaList(matches: boolean): MediaQueryList {
  return {
    matches,
    media: '(max-width: 767px)',
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
}

describe('TerminalAdapter', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    mockGetOrCreateTerminal.mockClear();
    window.matchMedia = mock((_query: string) => createMatchMediaList(false));
  });

  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
  });

  it('resolves the store instance for the session/worker and drives the adapter from its snapshot', async () => {
    await act(async () =>
      renderWithRouter(
        <TerminalAdapter sessionId="session-1" workerId="worker-1" onFilesReceived={() => {}} />,
      ),
    );

    expect(mockGetOrCreateTerminal).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateTerminal.mock.calls[0][0]).toBe('session-1');
    expect(mockGetOrCreateTerminal.mock.calls[0][1]).toBe('worker-1');
    // The stub instance's exited snapshot flows through the adapter's banner,
    // proving the resolved instance is the one the adapter renders from.
    expect(screen.getByText(/Process exited \(code 0/)).toBeTruthy();
  });

  it('omits the store option when stripScrollbackClear is undefined', async () => {
    await act(async () => renderWithRouter(<TerminalAdapter sessionId="s" workerId="w" />));
    // Third arg omitted -> store default governs (adapter/labs parity).
    expect(mockGetOrCreateTerminal.mock.calls[0][2]).toBeUndefined();
  });

  it('passes the store option through when stripScrollbackClear is set', async () => {
    await act(async () =>
      renderWithRouter(<TerminalAdapter sessionId="s" workerId="w" stripScrollbackClear={true} />),
    );
    expect(mockGetOrCreateTerminal.mock.calls[0][2]).toEqual({ stripScrollbackClear: true });
  });

  it('forwards snapshot status to onStatusChange via the status-mapping', async () => {
    const onStatusChange = mock((_status: string, _exitInfo?: unknown) => {});
    await act(async () =>
      renderWithRouter(<TerminalAdapter sessionId="s" workerId="w" onStatusChange={onStatusChange} />),
    );

    // The exited snapshot maps to ('exited', { code, signal }) (exitInfo present,
    // so status-mapping passes it through rather than normalizing to undefined).
    expect(onStatusChange).toHaveBeenCalledWith('exited', { code: 0, signal: null });
  });
});
