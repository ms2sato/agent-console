import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { screen, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { SessionPage } from '../SessionPage';
import { SessionStopTasksContext, SessionDataContext, WorktreeDeletionTasksContext } from '../../../contexts/root-contexts';
import type { SessionDataContextValue } from '../../../contexts/root-contexts';
import type { UseSessionStopTasksReturn } from '../../../hooks/useSessionStopTasks';
import type { UseWorktreeDeletionTasksReturn } from '../../../hooks/useWorktreeDeletionTasks';
import { _reset as resetWebSocket } from '../../../lib/app-websocket';
import { installMockWebSocket } from '../../../test/mock-websocket';
import { _resetTerminals } from '../../terminal/terminal-store';
import type { Session, Worker } from '@agent-console/shared';

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

function routeFetch(workers: Worker[] = []): void {
  mockFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = urlToString(input);
    if (
      url.includes('/api/sessions/session-1') &&
      !url.includes('/memo') &&
      !url.includes('/artifacts') &&
      !url.includes('/bookmarks') &&
      !url.includes('/pr-link') &&
      !url.includes('/workers')
    ) {
      return Promise.resolve(jsonResponse({ session: createMockSession({ workers }) }));
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

    // Asserted synchronously, not via waitFor: awaiting the close request's
    // continuation (mounted-agent-tab + this specific sibling-click shape)
    // can hang the real terminal store for many seconds -- tracked as #1899,
    // a pre-existing defect unrelated to this PR's DOM-nesting fix. The
    // keyboard test below covers tab removal on the active-tab close path
    // (fast, measured) instead.
    const deleteCall = mockFetch.mock.calls.find(([input, init]) => {
      return urlToString(input).includes(`/api/sessions/session-1/workers/${TERMINAL_WORKER.id}`)
        && init?.method === 'DELETE';
    });
    expect(deleteCall).toBeDefined();

    // The sibling click never bubbles into the activator's onClick (the
    // activator and the close control are DOM siblings, not nested) -- the
    // active tab must still be Agent.
    expect(screen.getByRole('tab', { name: 'Agent' }).getAttribute('aria-selected')).toBe('true');
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

  it('roving tabindex: Tab order visits the active tab\'s activator then its close control, and Enter on the close control closes it', async () => {
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
    expect(document.activeElement).toBe(closeButton);

    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Shell 1' })).toBeNull());
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
});
