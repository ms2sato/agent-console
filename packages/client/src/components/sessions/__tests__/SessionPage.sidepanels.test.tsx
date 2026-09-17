import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { screen, cleanup, waitFor, act } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { SessionPage } from '../SessionPage';
import { SessionStopTasksContext, SessionDataContext, WorktreeDeletionTasksContext } from '../../../contexts/root-contexts';
import type { SessionDataContextValue } from '../../../contexts/root-contexts';
import type { UseSessionStopTasksReturn } from '../../../hooks/useSessionStopTasks';
import type { UseWorktreeDeletionTasksReturn } from '../../../hooks/useWorktreeDeletionTasks';
import { _reset as resetWebSocket } from '../../../lib/app-websocket';
import { installMockWebSocket } from '../../../test/mock-websocket';
import type { Session } from '@agent-console/shared';

/**
 * Gate test for the mobile drawer trigger (Issue #1712): renders the REAL
 * `SessionPage`, not a harness, so this exercises the actual JS-gated
 * rail-vs-drawer swap wired up in SessionPage.tsx itself.
 *
 * Fetch-level mock (testing.md Anti-Pattern #2), routed by URL substring --
 * same pattern as SessionSidePanels.test.tsx / SessionSidePanelsDrawer.test.tsx.
 */
const originalFetch = globalThis.fetch;
const mockFetch = mock((_input: RequestInfo | URL) => Promise.resolve(new Response()));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function urlToString(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const MEMO_CONTENT = 'Hello Memo';

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    type: 'worktree',
    repositoryId: 'repo-1',
    repositoryName: 'my-repo',
    worktreeId: 'feat/x',
    isMainWorktree: false,
    locationPath: '/tmp/x',
    title: 'T',
    status: 'active',
    activationState: 'running',
    createdAt: new Date().toISOString(),
    // No workers -- keeps useTabManagement from ever navigating (its default
    // tab calc is `newTabs[0]?.id ?? null`, which stays null with an empty
    // list), so TerminalAdapter never mounts and no worker-scoped WS/fetch
    // wiring is exercised by this gate test.
    workers: [],
    ...overrides,
  } as Session;
}

function routeFetch(): void {
  mockFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = urlToString(input);
    if (url.includes('/api/sessions/session-1') && !url.includes('/memo') && !url.includes('/artifacts') && !url.includes('/bookmarks')) {
      return Promise.resolve(jsonResponse({ session: createMockSession() }));
    }
    if (url.includes('/memo')) {
      return Promise.resolve(jsonResponse({ content: MEMO_CONTENT }));
    }
    if (url.includes('/artifacts')) {
      return Promise.resolve(jsonResponse({ artifacts: [] }));
    }
    if (url.includes('/bookmarks')) {
      return Promise.resolve(jsonResponse({ bookmarks: [] }));
    }
    if (url.includes('/api/agents')) {
      return Promise.resolve(jsonResponse({ agents: [] }));
    }
    if (url.includes('/api/embedded-agents')) {
      return Promise.resolve(jsonResponse({ embeddedAgents: [] }));
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

const sessionDataContextValue: SessionDataContextValue = {
  sessions: [],
  wsInitialized: true,
  workerActivityStates: {},
};

const sessionStopTasksValue: UseSessionStopTasksReturn = {
  tasks: [],
  addTask: () => false,
  removeTask: () => {},
  getTask: () => undefined,
  markAsFailed: () => {},
};

// SessionSettings unconditionally mounts DeleteWorktreeDialog (open or not),
// which reads this context regardless of dialog visibility.
const worktreeDeletionTasksValue: UseWorktreeDeletionTasksReturn = {
  tasks: [],
  addTask: () => {},
  removeTask: () => {},
  getTask: () => undefined,
  markAsFailed: () => {},
  handleWorktreeDeletionCompleted: () => {},
  handleWorktreeDeletionFailed: () => {},
};

function renderSessionPage() {
  return renderWithRouter(
    <SessionDataContext.Provider value={sessionDataContextValue}>
      <SessionStopTasksContext.Provider value={sessionStopTasksValue}>
        <WorktreeDeletionTasksContext.Provider value={worktreeDeletionTasksValue}>
          <SessionPage sessionId="session-1" />
        </WorktreeDeletionTasksContext.Provider>
      </SessionStopTasksContext.Provider>
    </SessionDataContext.Provider>
  );
}

/**
 * Mirrors hooks/__tests__/useIsMobile.test.ts's `createMockMatchMedia`
 * helper -- reused here (not imported, since it's file-local there) to
 * drive the real `useIsMobile()` inside the real `SessionPage`.
 */
function createMockMatchMedia(matches: boolean) {
  let changeListener: ((e: { matches: boolean }) => void) | null = null;
  const mql = {
    matches,
    addEventListener: mock((event: string, listener: (e: { matches: boolean }) => void) => {
      if (event === 'change') changeListener = listener;
    }),
    removeEventListener: mock((event: string, _listener: unknown) => {
      if (event === 'change') changeListener = null;
    }),
  };
  const matchMedia = mock((_query: string) => mql as unknown as MediaQueryList);
  return {
    matchMedia,
    mql,
    triggerChange: (newMatches: boolean) => {
      mql.matches = newMatches;
      changeListener?.({ matches: newMatches });
    },
  };
}

describe('SessionPage mobile side-panels drawer gate', () => {
  let restoreWebSocket: () => void;
  let originalLocation: Location;
  let originalMatchMedia: typeof window.matchMedia;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
    routeFetch();

    originalLocation = window.location;
    originalMatchMedia = window.matchMedia;
    restoreWebSocket = installMockWebSocket();
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
    });
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    resetWebSocket();
  });

  afterEach(() => {
    cleanup();
    restoreWebSocket();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
    window.matchMedia = originalMatchMedia;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('mobile: shows the drawer trigger (not the rail toggle), and opening it reveals the panels', async () => {
    // Reach (measured): rendering `<SessionSidePanels />` unconditionally
    // (no `!isMobile` gate) fails the "no rail toggle" assertion -- the rail's
    // "Expand side panel" button is in the DOM (only CSS-hidden via
    // `hidden md:flex`, which happy-dom does not evaluate as absence).
    // Hardcoding the trigger's `aria-expanded={false}` fails after the click;
    // hardcoding the drawer's `open={false}` fails at the aria-modal wait.
    const { matchMedia } = createMockMatchMedia(true);
    window.matchMedia = matchMedia;

    await renderSessionPage();

    const trigger = await waitFor(() => screen.getByLabelText('Open session panels'));
    expect(screen.queryByLabelText('Collapse side panel')).toBeNull();
    expect(screen.queryByLabelText('Expand side panel')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    act(() => {
      trigger.click();
    });

    const dialog = await waitFor(() => screen.getByRole('dialog', { name: 'Session panels' }));
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByLabelText('Open session panels').getAttribute('aria-expanded')).toBe('true');

    await waitFor(() => expect(screen.getByText(MEMO_CONTENT)).toBeTruthy());
  });

  it('desktop: shows the rail toggle, no drawer trigger, and no dialog element', async () => {
    // Reach (measured): mounting the trigger unconditionally fails the
    // "no trigger" assertion; mounting the drawer unconditionally fails the
    // "no dialog" assertion (the drawer is always in the DOM once mounted).
    const { matchMedia } = createMockMatchMedia(false);
    window.matchMedia = matchMedia;

    await renderSessionPage();

    await waitFor(() => expect(screen.getByLabelText('Expand side panel')).toBeTruthy());
    expect(screen.queryByLabelText('Open session panels')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('boundary: resizing across 767px with the drawer open tears it down cleanly, and returning to mobile shows it closed again', async () => {
    // Reach (measured): removing SessionPage's reset effect
    // (`if (!isMobile) setSidePanelsDrawerOpen(false)`) fails the final
    // aria-expanded assertion -- SessionPage itself never unmounts across the
    // resize, so without the reset the flag stays true and the drawer would
    // reopen by itself on returning to mobile. Removing the drawer's
    // scroll-lock cleanup fails the `overflow` assertion after the crossing
    // (the lock would outlive the unmounted drawer). Mounting the drawer
    // unconditionally fails the "dialog gone" wait.
    const { matchMedia, triggerChange } = createMockMatchMedia(true);
    window.matchMedia = matchMedia;

    await renderSessionPage();

    const trigger = await waitFor(() => screen.getByLabelText('Open session panels'));
    act(() => {
      trigger.click();
    });
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Session panels' }).getAttribute('aria-modal')).toBe('true'));
    await waitFor(() => expect(document.body.style.overflow).toBe('hidden'));

    // Cross to desktop.
    act(() => {
      triggerChange(false);
    });

    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(screen.getByLabelText('Expand side panel')).toBeTruthy();
    expect(document.body.style.overflow).not.toBe('hidden');

    // Cross back to mobile.
    act(() => {
      triggerChange(true);
    });

    const triggerAgain = await waitFor(() => screen.getByLabelText('Open session panels'));
    expect(triggerAgain.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
  });
});
