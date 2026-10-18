import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { screen, cleanup, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { waitForAbsent } from '../../../test/waitForAbsent';
import { SessionPage } from '../SessionPage';
import { SessionStopTasksContext, SessionDataContext, WorktreeDeletionTasksContext } from '../../../contexts/root-contexts';
import type { SessionDataContextValue } from '../../../contexts/root-contexts';
import type { UseSessionStopTasksReturn, SessionStopTask } from '../../../hooks/useSessionStopTasks';
import type { UseWorktreeDeletionTasksReturn } from '../../../hooks/useWorktreeDeletionTasks';
import { _reset as resetWebSocket } from '../../../lib/app-websocket';
import { installMockWebSocket, MockWebSocket } from '../../../test/mock-websocket';
import { _resetTerminals } from '../../terminal/terminal-store';
import type { Session, Worker } from '@agent-console/shared';
import { completeWireBody } from '../../../test/wire-fixtures';
import { setAuthMode, setCurrentUser, _reset as resetAuth } from '../../../lib/auth';

/**
 * Component-render tests for `SessionPage` (the sibling `SessionPage.test.ts`
 * covers its exported pure helpers without JSX; `tabKeyboardNavigation.test.tsx`
 * drives a harness). This file renders the REAL `SessionPage`, not a harness,
 * so it exercises the actual JS-gated rail-vs-drawer swap wired up in
 * SessionPage.tsx itself.
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
  return new Response(JSON.stringify(completeWireBody(data)), {
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

function routeFetch(workers: Worker[] = [], sessionOverrides: Partial<Session> = {}): void {
  mockFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = urlToString(input);
    if (url.includes('/api/sessions/session-1/pause')) {
      return Promise.resolve(jsonResponse({ success: true }));
    }
    if (
      url.includes('/api/sessions/session-1') &&
      !url.includes('/memo') &&
      !url.includes('/artifacts') &&
      !url.includes('/bookmarks') &&
      !url.includes('/pr-link') &&
      !url.includes('/workers')
    ) {
      return Promise.resolve(jsonResponse({ session: createMockSession({ ...sessionOverrides, workers }) }));
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
    if (url.includes('/pr-link')) {
      return Promise.resolve(jsonResponse({ prUrl: null, branchName: '', orgRepo: null }));
    }
    if (url.includes('/workers')) {
      return Promise.resolve(jsonResponse({}));
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
  markAsSucceeded: () => {},
  markAsPending: () => {},
  hookFailure: null,
  reportHookFailure: () => {},
  dismissHookFailure: () => {},
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

function renderSessionPage(stopTasks: UseSessionStopTasksReturn = sessionStopTasksValue, workerId?: string) {
  return renderWithRouter(
    <SessionDataContext.Provider value={sessionDataContextValue}>
      <SessionStopTasksContext.Provider value={stopTasks}>
        <WorktreeDeletionTasksContext.Provider value={worktreeDeletionTasksValue}>
          <SessionPage sessionId="session-1" workerId={workerId} />
        </WorktreeDeletionTasksContext.Provider>
      </SessionStopTasksContext.Provider>
    </SessionDataContext.Provider>
  );
}

/**
 * A complete, directly-typed `MediaQueryList` stub (no cast through
 * `unknown`; same shape as TerminalAdapter.test.tsx's `createMatchMediaList`)
 * plus a `triggerChange` lever, so the test can drive the real `useIsMobile()`
 * inside the real `SessionPage` across the 767px boundary. `useIsMobile`
 * only reads `.matches` and subscribes via `addEventListener('change')`.
 */
function createMockMatchMedia(matches: boolean) {
  let changeListener: ((e: MediaQueryListEvent) => void) | null = null;
  const mql: MediaQueryList = {
    matches,
    media: '(max-width: 767px)',
    onchange: null,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (type === 'change' && typeof listener === 'function') {
        changeListener = listener as (e: MediaQueryListEvent) => void;
      }
    },
    removeEventListener: (type: string) => {
      if (type === 'change') changeListener = null;
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
  const matchMedia = mock((_query: string) => mql);
  return {
    matchMedia,
    mql,
    triggerChange: (newMatches: boolean) => {
      mql.matches = newMatches;
      changeListener?.({ matches: newMatches } as MediaQueryListEvent);
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

    await waitForAbsent(() => document.querySelector('[role="dialog"]'));
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

  describe('file-viewer tab', () => {
    const VIEWER_WORKER = createMockWorker({ id: 'viewer-1', type: 'file-viewer', name: 'File Viewer' });
    const TERMINAL_WORKER = createMockWorker({ id: 'term-1', type: 'terminal', name: 'Shell 1', activated: true } as Partial<Worker> & { type: 'terminal' });

    function workerSocketUrls(): string[] {
      return MockWebSocket.getInstances().map((ws) => ws.url).filter((url) => url.includes('/worker/'));
    }

    it('renders the viewer view and opens no worker WebSocket for it (the app socket does open)', async () => {
      // Reach (measured): dropping SessionPage's file-viewer view branch (so the
      // tab falls through to the terminal view) fails this test: the terminal
      // view opens `/ws/session/session-1/worker/viewer-1`.
      const { matchMedia } = createMockMatchMedia(false);
      window.matchMedia = matchMedia;
      routeFetch([VIEWER_WORKER]);

      await renderSessionPage(sessionStopTasksValue, 'viewer-1');

      await waitFor(() => expect(screen.getByText('Select a file to view it.')).toBeTruthy());
      // Positive control: the harness sees WebSocket opens (the app-wide socket).
      expect(MockWebSocket.getInstances().some((ws) => ws.url.includes('/ws/app'))).toBe(true);
      expect(workerSocketUrls()).toEqual([]);
    });

    it('control: a terminal tab in the same harness does open its worker WebSocket', async () => {
      const { matchMedia } = createMockMatchMedia(false);
      window.matchMedia = matchMedia;
      routeFetch([TERMINAL_WORKER]);

      await renderSessionPage(sessionStopTasksValue, 'term-1');

      await waitFor(() => expect(workerSocketUrls().some((url) => url.includes('/worker/term-1'))).toBe(true));
    });
  });
});

/**
 * Regression coverage for Issue #1608: the tab bar's "Close tab" button was
 * nested inside the tab's own activator `<button>` (invalid DOM nesting,
 * React's validateDOMNesting warning, and a nested-interactive-controls
 * accessibility defect). These tests render the REAL SessionPage with one
 * agent worker (primary, non-closeable) and one terminal worker (closeable),
 * so both the activator and the close control are present in the tab bar.
 */
function createMockWorker(overrides: Partial<Worker> & { type: Worker['type'] }): Worker {
  return {
    id: overrides.id ?? 'worker-1',
    name: overrides.name ?? 'Worker',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Worker;
}

const AGENT_WORKER = createMockWorker({
  id: 'agent-1',
  type: 'agent',
  name: 'Agent',
  agentId: 'claude-code',
  activated: true,
});

const TERMINAL_WORKER = createMockWorker({
  id: 'terminal-1',
  type: 'terminal',
  name: 'Shell 1',
  activated: true,
});

describe('SessionPage tab bar DOM structure (Issue #1608)', () => {
  let restoreWebSocket: () => void;
  let originalLocation: Location;
  let originalMatchMedia: typeof window.matchMedia;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
    routeFetch([AGENT_WORKER, TERMINAL_WORKER]);

    originalLocation = window.location;
    originalMatchMedia = window.matchMedia;
    restoreWebSocket = installMockWebSocket();
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
    });
    const { matchMedia } = createMockMatchMedia(false);
    window.matchMedia = matchMedia;
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    resetWebSocket();
  });

  afterEach(() => {
    cleanup();
    // The active tab mounts the production terminal store (no `createInstance`
    // override is passed to TerminalAdapter), and its instance registry
    // deliberately survives unmount. Reset it so reconnect/idle-timer state
    // from one test can't bleed into the next (Issue #1608 flakiness).
    _resetTerminals();
    restoreWebSocket();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
    window.matchMedia = originalMatchMedia;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('renders the close control as a sibling, never nested inside the tab activator button (regression pin)', async () => {
    await renderSessionPage();

    await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(2));

    // Positive control: the instrument actually sees the tab bar, so a 0
    // below can't be read as "nothing rendered".
    expect(document.querySelectorAll('[role="tab"]').length).toBe(2);

    expect(document.querySelectorAll('button button').length).toBe(0);

    const nestingWarningLogged = consoleErrorSpy.mock.calls.some(call =>
      call.some(arg => typeof arg === 'string' && arg.includes('validateDOMNesting'))
    );
    expect(nestingWarningLogged).toBe(false);
  });

  it('clicking the close control (now a sibling) reaches the close handler and never activates the tab', async () => {
    await renderSessionPage();
    await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(2));

    // The agent tab is the default active tab; the terminal tab (closeable)
    // is the one with a close control.
    expect(screen.getByRole('tab', { name: 'Agent' }).getAttribute('aria-selected')).toBe('true');

    const closeButton = screen.getByRole('button', { name: 'Close tab' });
    act(() => {
      closeButton.click();
    });

    const deleteCall = mockFetch.mock.calls.find(([input, init]) => {
      return urlToString(input).includes(`/api/sessions/session-1/workers/${TERMINAL_WORKER.id}`)
        && init?.method === 'DELETE';
    });
    expect(deleteCall).toBeDefined();

    // The tab is actually removed once the close request's continuation
    // settles.
    await waitForAbsent(() => screen.queryByRole('tab', { name: 'Shell 1' }));

    // The sibling click never bubbles into the activator's onClick (the
    // activator and the close control are DOM siblings, not nested) -- the
    // active tab must still be Agent.
    expect(screen.getByRole('tab', { name: 'Agent' }).getAttribute('aria-selected')).toBe('true');
  });

  it('a session-updated frame with a renamed worker updates the tab and the rename control', async () => {
    // Renaming is a broadcast, not local state: the tab (and everything derived
    // from `activeTab.name`, e.g. the error fallback's `workerName`) follows
    // the session's worker name. `workerName` is only rendered by the worker
    // error fallback, so there is no always-visible panel header to assert on.
    const user = userEvent.setup();
    await renderSessionPage();
    await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(2));
    await user.click(screen.getByRole('tab', { name: 'Shell 1' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Shell 1' }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.getByRole('button', { name: 'Rename Shell 1' })).toBeTruthy();

    const appSocket = MockWebSocket.getInstances().find(ws => ws.url.includes('/ws/app'));
    expect(appSocket).toBeDefined();
    act(() => {
      appSocket!.simulateOpen();
      appSocket!.simulateMessage(JSON.stringify(completeWireBody({
        type: 'session-updated',
        session: createMockSession({
          workers: [AGENT_WORKER, { ...TERMINAL_WORKER, name: 'build watch' } as Worker],
        }),
      })));
    });

    await waitFor(() => expect(screen.getByRole('tab', { name: 'build watch' })).toBeTruthy());
    expect(screen.queryByRole('tab', { name: 'Shell 1' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Rename build watch' })).toBeTruthy();
  });

  it('clicking the tab activator switches the active tab', async () => {
    await renderSessionPage();
    await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(2));

    const terminalTab = screen.getByRole('tab', { name: 'Shell 1' });
    expect(terminalTab.getAttribute('aria-selected')).toBe('false');

    act(() => {
      terminalTab.click();
    });

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Shell 1' }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.getByRole('tab', { name: 'Agent' }).getAttribute('aria-selected')).toBe('false');
  });

  it('roving tabindex: Tab order visits the active tab\'s activator, its rename pencil, then its close control, and Enter on the close control closes it', async () => {
    await renderSessionPage();
    await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(2));

    // Activate the terminal tab (the closeable one) so both the activator
    // and the close control carry tabIndex=0.
    act(() => {
      screen.getByRole('tab', { name: 'Shell 1' }).click();
    });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Shell 1' }).getAttribute('aria-selected')).toBe('true'));

    const terminalTab = screen.getByRole('tab', { name: 'Shell 1' });
    const agentTab = screen.getByRole('tab', { name: 'Agent' });
    const closeButton = screen.getByRole('button', { name: 'Close tab' });

    expect(terminalTab.getAttribute('tabindex')).toBe('0');
    expect(closeButton.getAttribute('tabindex')).toBe('0');
    expect(agentTab.getAttribute('tabindex')).toBe('-1');

    const user = userEvent.setup();
    (document.activeElement as HTMLElement | null)?.blur();

    await user.tab();
    expect(document.activeElement).toBe(terminalTab);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename Shell 1' }));

    await user.tab();
    expect(document.activeElement).toBe(closeButton);

    await user.keyboard('{Enter}');

    await waitForAbsent(() => screen.queryByRole('tab', { name: 'Shell 1' }));
  });

  it('ArrowLeft/ArrowRight still moves aria-selected between the two tab activators (production handleTabKeyDown path)', async () => {
    await renderSessionPage();
    await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(2));

    const agentTab = screen.getByRole('tab', { name: 'Agent' });
    expect(agentTab.getAttribute('aria-selected')).toBe('true');

    const user = userEvent.setup();
    agentTab.focus();
    await user.keyboard('{ArrowRight}');

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Shell 1' }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.getByRole('tab', { name: 'Agent' }).getAttribute('aria-selected')).toBe('false');

    await user.keyboard('{ArrowLeft}');

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Agent' }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.getByRole('tab', { name: 'Shell 1' }).getAttribute('aria-selected')).toBe('false');
  });

  it('gives a closeable tab activator tight padding next to its close control, and a non-closeable activator its full padding with no close control (Issue #1945)', async () => {
    await renderSessionPage();
    await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(2));

    // Closeable tab (Terminal "Shell 1"): activator sits flush against its
    // close control (pr-1), and the close control keeps its own padding
    // (pr-3) rather than the old zero-padding (p-0).
    const terminalTab = screen.getByRole('tab', { name: 'Shell 1' });
    expect(terminalTab.className.includes('pr-1')).toBe(true);
    expect(terminalTab.className.includes('pr-4')).toBe(false);

    const closeButton = screen.getByRole('button', { name: 'Close tab' });
    expect(closeButton.className.includes('pr-3')).toBe(true);
    expect(closeButton.className.includes('p-0')).toBe(false);

    // Non-closeable tab (primary agent "Agent"): activator keeps its full
    // right padding, and there is no close control at all for it.
    const agentTab = screen.getByRole('tab', { name: 'Agent' });
    expect(agentTab.className.includes('pr-4')).toBe(true);

    const closeButtons = screen.queryAllByRole('button', { name: 'Close tab' });
    expect(closeButtons.length).toBe(1);
  });

  describe('tab labels stay on one line and the bar scrolls (Issue #2216)', () => {
    // happy-dom has no layout, so these pin the classes that produce the
    // behaviour: a tab that may shrink or wrap is squeezed to "Vi" / wrapped
    // at 390 px instead of letting the bar scroll. Desktop is unchanged
    // because the bar only overflows when the tabs do not fit.
    // Keyed by Worker['type'] so a new worker kind is a compile error here,
    // i.e. the pin covers every tab kind.
    const ONE_PER_KIND = {
      agent: createMockWorker({ id: 'w-agent', type: 'agent', name: 'Claude Code', agentId: 'claude-code', activated: true }),
      'embedded-agent': createMockWorker({ id: 'w-embedded', type: 'embedded-agent', name: 'An embedded agent with a long name', embeddedAgentId: 'e-1', activated: true, autoCompaction: true, reasoningEffort: null, hasParameterOverride: false }),
      terminal: createMockWorker({ id: 'w-term', type: 'terminal', name: 'A very long worker tab name', activated: true }),
      'git-diff': createMockWorker({ id: 'w-diff', type: 'git-diff', name: 'Diff', baseCommit: 'abc123' }),
      'file-viewer': createMockWorker({ id: 'w-viewer', type: 'file-viewer', name: 'File Viewer' }),
    } satisfies Record<Worker['type'], Worker>;
    const WORKERS = Object.values(ONE_PER_KIND);

    async function renderAllKinds() {
      routeFetch(WORKERS);
      await renderSessionPage();
      await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(WORKERS.length));
    }

    it('every tab kind: the tab container and the tab activator are no-shrink and no-wrap', async () => {
      await renderAllKinds();

      for (const worker of WORKERS) {
        const tab = screen.getByRole('tab', { name: worker.name });
        const classes = tab.className.split(/\s+/);
        expect(classes).toContain('shrink-0');
        expect(classes).toContain('whitespace-nowrap');
        const containerClasses = tab.parentElement!.className.split(/\s+/);
        expect(containerClasses).toContain('shrink-0');
        expect(containerClasses).toContain('whitespace-nowrap');
      }
    });

    it('the tab bar scrolls horizontally and holds every tab, while the add button sits outside it', async () => {
      await renderAllKinds();

      const tablist = screen.getByRole('tablist', { name: 'Worker tabs' });
      expect(tablist.className.split(/\s+/)).toContain('overflow-x-auto');
      expect(within(tablist).getAllByRole('tab').length).toBe(WORKERS.length);
      // Positive control: the add button exists, and is not one of the scrolled tabs.
      expect(screen.getByRole('button', { name: 'Add agent worker' })).toBeTruthy();
      expect(within(tablist).queryByRole('button', { name: 'Add agent worker' })).toBeNull();
    });
  });
});

describe('SessionPage stop/pause task banner', () => {
  let restoreWebSocket: () => void;
  let originalLocation: Location;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
    routeFetch();
    originalLocation = window.location;
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
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  function stopTasksWith(task: SessionStopTask | undefined, overrides: Partial<UseSessionStopTasksReturn> = {}): UseSessionStopTasksReturn {
    return {
      ...sessionStopTasksValue,
      tasks: task ? [task] : [],
      getTask: (id: string) => (task && task.sessionId === id ? task : undefined),
      ...overrides,
    };
  }

  function pauseCallCount(): number {
    return mockFetch.mock.calls.filter(([input]) => urlToString(input).includes('/api/sessions/session-1/pause')).length;
  }

  it('shows no banner when there is no task', async () => {
    await renderSessionPage(stopTasksWith(undefined));
    await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy());
    expect(screen.queryByText('Pausing this session...')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows only the in-flight text (no Retry/Dismiss) for a pending task', async () => {
    const task: SessionStopTask = { sessionId: 'session-1', action: 'pause', status: 'pending', error: null };
    await renderSessionPage(stopTasksWith(task));
    await waitFor(() => expect(screen.getByText('Pausing this session...')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('shows no banner for a succeeded task', async () => {
    const task: SessionStopTask = { sessionId: 'session-1', action: 'pause', status: 'succeeded', error: null };
    await renderSessionPage(stopTasksWith(task));
    await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy());
    expect(screen.queryByText('Pausing this session...')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('failed task renders the error with Retry and Dismiss; Dismiss removes the task', async () => {
    const task: SessionStopTask = { sessionId: 'session-1', action: 'pause', status: 'failed', error: 'Pause blew up' };
    const removeTask = mock(() => {});
    await renderSessionPage(stopTasksWith(task, { removeTask }));

    await waitFor(() => expect(screen.getByText('Pause blew up')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(removeTask).toHaveBeenCalledWith('session-1');
  });

  it('Retry resets the task to pending and re-invokes the pause API exactly once', async () => {
    const task: SessionStopTask = { sessionId: 'session-1', action: 'pause', status: 'failed', error: 'Pause blew up' };
    const markAsPending = mock(() => {});
    const markAsFailed = mock(() => {});
    await renderSessionPage(stopTasksWith(task, { markAsPending, markAsFailed }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy());
    expect(pauseCallCount()).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(pauseCallCount()).toBe(1));
    expect(markAsPending).toHaveBeenCalledWith('session-1');
    expect(markAsFailed).not.toHaveBeenCalled();
  });

  it('Retry on a failed stop task calls the delete API instead of pause', async () => {
    const task: SessionStopTask = { sessionId: 'session-1', action: 'stop', status: 'failed', error: 'Stop blew up' };
    await renderSessionPage(stopTasksWith(task));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      const deletes = mockFetch.mock.calls.filter(
        ([input, init]) =>
          urlToString(input).includes('/api/sessions/session-1') &&
          !urlToString(input).includes('/pause') &&
          (init as RequestInit | undefined)?.method === 'DELETE'
      );
      expect(deletes.length).toBe(1);
    });
    expect(pauseCallCount()).toBe(0);
  });
});

describe('SessionPage pause/resume hook failure reporting', () => {
  let restoreWebSocket: () => void;
  let originalLocation: Location;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let pauseBody: unknown;
  let resumeBody: unknown;

  const failure = { success: false, error: 'exit code 3', output: 'out' };

  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
    pauseBody = { success: true };
    resumeBody = { session: createMockSession() };
    originalLocation = window.location;
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
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  /** Route pause/resume POSTs to the configurable bodies, everything else to routeFetch. */
  function routeWith(sessionOverrides: Partial<Session> = {}) {
    routeFetch([], sessionOverrides);
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.includes('/api/sessions/session-1/pause')) return Promise.resolve(jsonResponse(pauseBody));
      if (url.includes('/api/sessions/session-1/resume')) return Promise.resolve(jsonResponse(resumeBody));
      return base(input);
    });
  }

  function stopTasks(overrides: Partial<UseSessionStopTasksReturn>): UseSessionStopTasksReturn {
    return { ...sessionStopTasksValue, ...overrides };
  }

  const failedPauseTask: SessionStopTask = {
    sessionId: 'session-1',
    action: 'pause',
    sessionTitle: 'T',
    status: 'failed',
    error: 'Pause blew up',
  };

  async function retryPause(reportHookFailure: UseSessionStopTasksReturn['reportHookFailure']) {
    routeWith();
    await renderSessionPage(
      stopTasks({
        tasks: [failedPauseTask],
        getTask: (id: string) => (id === 'session-1' ? failedPauseTask : undefined),
        reportHookFailure,
      })
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  }

  it('Retry of a pause reports a failing pauseCommandResult through the root slot', async () => {
    pauseBody = { success: true, pauseCommandResult: failure };
    const reportHookFailure = mock(() => {});

    await retryPause(reportHookFailure);

    await waitFor(() => expect(reportHookFailure).toHaveBeenCalledTimes(1));
    expect(reportHookFailure).toHaveBeenCalledWith({ kind: 'pause', sessionTitle: 'T', result: failure });
  });

  it('Retry of a pause reports nothing for a successful result or an absent key', async () => {
    const reportHookFailure = mock(() => {});
    pauseBody = { success: true, pauseCommandResult: { success: true } };

    await retryPause(reportHookFailure);
    await waitFor(() =>
      expect(mockFetch.mock.calls.some(([i]) => urlToString(i).includes('/session-1/pause'))).toBe(true)
    );
    await Promise.resolve();

    expect(reportHookFailure).not.toHaveBeenCalled();
  });

  async function clickResumeOnPausedPage(reportHookFailure: UseSessionStopTasksReturn['reportHookFailure']) {
    routeWith({ pausedAt: new Date().toISOString() });
    await renderSessionPage(stopTasks({ reportHookFailure }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume Session' })).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Resume Session' }));
    await waitFor(() =>
      expect(mockFetch.mock.calls.some(([i]) => urlToString(i).includes('/session-1/resume'))).toBe(true)
    );
  }

  it('the paused-page Resume reports a failing resumeCommandResult through the root slot', async () => {
    resumeBody = { session: createMockSession(), resumeCommandResult: failure };
    const reportHookFailure = mock(() => {});

    await clickResumeOnPausedPage(reportHookFailure);

    await waitFor(() => expect(reportHookFailure).toHaveBeenCalledTimes(1));
    expect(reportHookFailure).toHaveBeenCalledWith({ kind: 'resume', sessionTitle: 'T', result: failure });
  });

  it('the paused-page Resume reports nothing for a successful result or an absent key', async () => {
    const reportHookFailure = mock(() => {});

    resumeBody = { session: createMockSession(), resumeCommandResult: { success: true } };
    await clickResumeOnPausedPage(reportHookFailure);
    await Promise.resolve();
    expect(reportHookFailure).not.toHaveBeenCalled();

    cleanup();
    resumeBody = { session: createMockSession() };
    await clickResumeOnPausedPage(reportHookFailure);
    await Promise.resolve();
    expect(reportHookFailure).not.toHaveBeenCalled();
  });
});

describe('SessionPage owner badge (Issue #684)', () => {
  const SELF = { id: 'self-uuid', username: 'me', homeDir: '/home/me' };
  let restoreWebSocket: () => void;
  let originalLocation: Location;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
    originalLocation = window.location;
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
    resetAuth();
    restoreWebSocket();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("shows another user's session owner in the amber (others) colour in multi-user mode", async () => {
    setAuthMode('multi-user');
    setCurrentUser(SELF);
    routeFetch([], { createdBy: 'other-uuid', createdByUsername: 'alice' });
    await renderSessionPage();

    const badge = await screen.findByTestId('session-creator-username');
    expect(badge.textContent).toBe('alice');
    expect(badge.className).toContain('amber');
    expect(badge.className).not.toContain('indigo');
  });

  it('shows the owner in the indigo (mine) colour when the current user owns the session', async () => {
    setAuthMode('multi-user');
    setCurrentUser(SELF);
    routeFetch([], { createdBy: 'self-uuid', createdByUsername: 'me' });
    await renderSessionPage();

    const badge = await screen.findByTestId('session-creator-username');
    expect(badge.textContent).toBe('me');
    expect(badge.className).toContain('indigo');
    expect(badge.className).not.toContain('amber');
  });

  it('renders no badge in multi-user mode when the session has no owner username', async () => {
    setAuthMode('multi-user');
    setCurrentUser(SELF);
    routeFetch([], { createdBy: 'self-uuid', createdByUsername: null });
    await renderSessionPage();

    // Positive control: the page (and its status bar) has rendered.
    await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy());
    expect(screen.queryByTestId('session-creator-username')).toBeNull();
  });

  it('renders no badge in single-user mode even when the session has an owner username', async () => {
    // authMode defaults to 'none' from resetAuth()
    routeFetch([], { createdBy: 'self-uuid', createdByUsername: 'me' });
    await renderSessionPage();

    await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy());
    expect(screen.queryByTestId('session-creator-username')).toBeNull();
  });
});
