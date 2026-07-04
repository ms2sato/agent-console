import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import type { TerminalInstance, TerminalSnapshot } from '../terminal-store';

// TerminalAdapter resolves its instance via an injected `createInstance` factory
// (defaulting to the real store). The test passes a stub factory PROP instead of
// module-mocking the store — bun's `mock.module` is process-global and poisoned
// sibling test files (testing.md Anti-Pattern #2; caused the CI 'no ws' failure).
// The repo-name hook's network query is answered by a fetch-level stub below,
// also avoiding a module mock.

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
  loadingOlder: false,
  canRequestOlder: false,
  pagedRowCount: 0,
  pagedTopChunkRowCount: 0,
  pagedCapReached: false,
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
  requestOlderHistory: () => {},
  evictTopChunk: () => {},
  acquire: () => () => {},
  dispose: () => {},
};

const mockGetOrCreateTerminal = mock(
  (_sessionId: string, _workerId: string, _opts?: unknown): TerminalInstance => stubInstance,
);

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
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockGetOrCreateTerminal.mockClear();
    window.matchMedia = mock((_query: string) => createMatchMediaList(false));
    // useSessionRepoFullName queries the session PR-link endpoint. Answer it at
    // the fetch level (no module mock): orgRepo null -> repoFullName null, the
    // same result the removed useSessionRepoFullName module mock produced.
    globalThis.fetch = mock((input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/pr-link')) {
        return Promise.resolve(
          new Response(JSON.stringify({ prUrl: null, branchName: '', orgRepo: null }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      // Anything unexpected: a benign 404 (the adapter has no other mount fetch).
      return Promise.resolve(new Response('null', { status: 404 }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
    globalThis.fetch = originalFetch;
  });

  it('resolves the store instance for the session/worker and drives the adapter from its snapshot', async () => {
    await act(async () =>
      renderWithRouter(
        <TerminalAdapter
          sessionId="session-1"
          workerId="worker-1"
          onFilesReceived={() => {}}
          createInstance={mockGetOrCreateTerminal}
        />,
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
    await act(async () =>
      renderWithRouter(<TerminalAdapter sessionId="s" workerId="w" createInstance={mockGetOrCreateTerminal} />),
    );
    // Third arg omitted -> store default governs (adapter/labs parity).
    expect(mockGetOrCreateTerminal.mock.calls[0][2]).toBeUndefined();
  });

  it('passes the store option through when stripScrollbackClear is set', async () => {
    await act(async () =>
      renderWithRouter(
        <TerminalAdapter
          sessionId="s"
          workerId="w"
          stripScrollbackClear={true}
          createInstance={mockGetOrCreateTerminal}
        />,
      ),
    );
    expect(mockGetOrCreateTerminal.mock.calls[0][2]).toEqual({ stripScrollbackClear: true });
  });

  it('forwards snapshot status to onStatusChange via the status-mapping', async () => {
    const onStatusChange = mock((_status: string, _exitInfo?: unknown) => {});
    await act(async () =>
      renderWithRouter(
        <TerminalAdapter
          sessionId="s"
          workerId="w"
          onStatusChange={onStatusChange}
          createInstance={mockGetOrCreateTerminal}
        />,
      ),
    );

    // The exited snapshot maps to ('exited', { code, signal }) (exitInfo present,
    // so status-mapping passes it through rather than normalizing to undefined).
    expect(onStatusChange).toHaveBeenCalledWith('exited', { code: 0, signal: null });
  });
});
