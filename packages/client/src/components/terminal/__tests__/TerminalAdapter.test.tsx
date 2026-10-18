import { describe, it, expect, mock, afterEach, beforeEach, spyOn } from 'bun:test';
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
  retentionFloorReached: false,
}) as TerminalSnapshot;

const stubInstance: TerminalInstance = {
  subscribe: () => () => {},
  getSnapshot: () => EXITED_SNAPSHOT,
  sendInput: () => true,
  sendUserInput: () => {},
  resize: () => {},
  forwardScroll: () => {},
  reportMouseButton: () => {},
  paste: () => {},
  getApplicationCursorMode: () => false,
  retry: () => {},
  dismissNotice: () => {},
  requestOlderHistory: () => {},
  evictTopChunk: () => {},
  onClipboardWrite: () => () => {},
  acquire: () => () => {},
  dispose: () => {},
};

const mockGetOrCreateTerminal = mock(
  (_sessionId: string, _workerId: string, _opts?: unknown): TerminalInstance => stubInstance,
);

import { act, cleanup, screen } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { TerminalAdapter } from '../TerminalAdapter';
import { setAuthMode, _reset as resetAuth } from '../../../lib/auth';

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
  let fetchedUrls: string[] = [];

  beforeEach(() => {
    fetchedUrls = [];
    mockGetOrCreateTerminal.mockClear();
    window.matchMedia = mock((_query: string) => createMatchMediaList(false));
    // useSessionRepoFullName queries the session PR-link endpoint. Answer it at
    // the fetch level (no module mock): orgRepo null -> repoFullName null, the
    // same result the removed useSessionRepoFullName module mock produced.
    // Object.assign supplies the `preconnect` static bun-types declares on
    // fetch, so the stub satisfies `typeof fetch` without a cast.
    const fetchStub: typeof fetch = Object.assign(
      mock((input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetchedUrls.push(url);
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
      }),
      { preconnect: () => {} },
    );
    globalThis.fetch = fetchStub;
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

  it('requests the session PR link for a worktree session (repo name for ref linkification)', async () => {
    await act(async () =>
      renderWithRouter(
        <TerminalAdapter
          sessionId="session-wt"
          workerId="worker-1"
          onFilesReceived={() => {}}
          createInstance={mockGetOrCreateTerminal}
          resolveRepoFullName
        />,
      ),
    );

    expect(fetchedUrls.filter((u) => u.includes('/api/sessions/session-wt/pr-link'))).toHaveLength(1);
  });

  it('makes no PR-link request for a quick session (the endpoint only serves worktree sessions)', async () => {
    await act(async () =>
      renderWithRouter(
        <TerminalAdapter
          sessionId="session-quick"
          workerId="worker-1"
          onFilesReceived={() => {}}
          createInstance={mockGetOrCreateTerminal}
          resolveRepoFullName={false}
        />,
      ),
    );

    expect(fetchedUrls.filter((u) => u.includes('/pr-link'))).toHaveLength(0);
  });

  it('multi-user mode: an OSC 52 write with recent input and focus shows the notice and does not write silently', async () => {
    const writeText = mock((_text: string) => Promise.resolve());
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const hasFocusSpy = spyOn(document, 'hasFocus').mockReturnValue(true);
    setAuthMode('multi-user');
    try {
      let emit: (event: { text: string; atMs: number; recentInput: boolean }) => void = () => {};
      const instance: TerminalInstance = {
        ...stubInstance,
        onClipboardWrite: (listener) => {
          emit = listener;
          return () => {};
        },
      };
      await act(async () =>
        renderWithRouter(
          <TerminalAdapter sessionId="s" workerId="w" createInstance={() => instance} />,
        ),
      );
      await act(async () => emit({ text: 'from the TUI', atMs: 1, recentInput: true }));
      expect(writeText).not.toHaveBeenCalled();
      expect(screen.getByText(/Copied from the terminal/)).toBeTruthy();
    } finally {
      resetAuth();
      hasFocusSpy.mockRestore();
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
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

  it('wires the localhost link transform but does not rewrite when the browser is on loopback', async () => {
    // The adapter wires the real localhostRewriteTransform, which reads
    // window.location at call time. Pin the browser to a loopback host so the
    // rewrite is a no-op — this proves the lane is wired without exploding.
    const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', hostname: 'localhost', host: 'localhost' },
      writable: true,
      configurable: true,
    });
    try {
      const LOCALHOST_URL = 'http://localhost:3000/path';
      const snapshot: TerminalSnapshot = {
        ...EXITED_SNAPSHOT,
        status: 'connected',
        exitInfo: null,
        rows: [
          {
            key: 0,
            isWrapped: false,
            links: [{ start: 0, end: LOCALHOST_URL.length, href: LOCALHOST_URL }],
            fillsLastColumn: false,
            segments: [{ text: LOCALHOST_URL, style: null }],
          },
        ],
      };
      const instance: TerminalInstance = { ...stubInstance, getSnapshot: () => snapshot };
      const createInstance = mock((_sessionId: string, _workerId: string, _opts?: unknown) => instance);

      await act(async () =>
        renderWithRouter(<TerminalAdapter sessionId="s" workerId="w" createInstance={createInstance} />),
      );

      const link = screen.getByText(LOCALHOST_URL);
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('href')).toBe(LOCALHOST_URL);
      expect(link.getAttribute('title')).toBeNull();
    } finally {
      if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
    }
  });
});
