import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { ActiveSessionsSidebar, formatRestartMessage } from '../ActiveSessionsSidebar';
import { QUICK_SESSIONS_GROUP_KEY } from '../group-sessions-by-repository';
import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
} from '../../../hooks/useSidebarState';
import type { SessionWithActivity } from '../../../hooks/useActiveSessionsWithActivity';
import { setAuthMode, setCurrentUser, setSharedAccountsAvailable, _reset as resetAuth } from '../../../lib/auth';
import { repositoryKeys } from '../../../lib/query-keys';
import type { AgentActivityState, WorktreeSession, QuickSession, Session, Repository } from '@agent-console/shared';

// --- Global fetch mock (Issue #1643 PR-2) ---
//
// ActiveSessionsSidebar now always issues a `GET /api/repositories` query
// (to know each repository's designated-Orchestrator session for the flag
// control), so every test in this file needs a fetch stub even when it does
// not itself exercise the flag control. `repositoriesResponse` lets
// individual tests configure the repositories list; `orchestratorDesignationCalls`
// records POST/DELETE calls to the raise/clear endpoint so click-behavior
// tests can assert on them without their own bespoke fetch mock.
const originalGlobalFetch = globalThis.fetch;
let repositoriesResponse: { repositories: Repository[] } = { repositories: [] };
let orchestratorDesignationCalls: Array<{ method: string; sessionId: string }> = [];

function installGlobalFetchMock() {
  globalThis.fetch = Object.assign(
    mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
      if (url.includes('/api/repositories') && method === 'GET') {
        return new Response(JSON.stringify(repositoriesResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const orchestratorMatch = url.match(/\/api\/sessions\/([^/]+)\/orchestrator-designation$/);
      if (orchestratorMatch && (method === 'POST' || method === 'DELETE')) {
        orchestratorDesignationCalls.push({ method, sessionId: orchestratorMatch[1] });
        const body =
          method === 'POST'
            ? { repositoryId: 'repo-1', orchestratorSessionId: orchestratorMatch[1] }
            : { repositoryId: 'repo-1', cleared: true };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
    { preconnect: () => {} }
  ) as typeof fetch;
}

// Helper to create mock worktree session
function createMockWorktreeSession(
  overrides: Partial<Omit<WorktreeSession, 'type'>> = {}
): WorktreeSession {
  return {
    id: `session-${Math.random().toString(36).slice(2)}`,
    type: 'worktree' as const,
    repositoryId: 'repo-1',
    repositoryName: 'my-repo',
    worktreeId: 'wt-1',
    isMainWorktree: false,
    locationPath: '/path/to/worktree',
    title: 'test-branch',
    status: 'active' as const,
    activationState: 'running' as const,
    createdAt: new Date().toISOString(),
    workers: [],
    isShared: false,
    recoveryState: 'healthy',
    ...overrides,
  };
}

// Helper to create mock quick session
function createMockQuickSession(
  overrides: Partial<Omit<QuickSession, 'type'>> = {}
): QuickSession {
  return {
    id: `session-${Math.random().toString(36).slice(2)}`,
    type: 'quick' as const,
    locationPath: '/some/path',
    status: 'active' as const,
    activationState: 'running' as const,
    createdAt: new Date().toISOString(),
    workers: [],
    isShared: false,
    recoveryState: 'healthy',
    ...overrides,
  };
}

// Helper to create SessionWithActivity
function createSessionWithActivity(
  session: SessionWithActivity['session'],
  activityState: AgentActivityState = 'idle'
): SessionWithActivity {
  return { session, activityState };
}

describe('ActiveSessionsSidebar', () => {
  let onToggle: ReturnType<typeof mock>;
  let onWidthChange: ReturnType<typeof mock>;

  const defaultProps = () => ({
    collapsed: false,
    onToggle,
    sessions: [] as SessionWithActivity[],
    width: SIDEBAR_DEFAULT_WIDTH,
    onWidthChange,
  });

  beforeEach(() => {
    onToggle = mock(() => {});
    onWidthChange = mock(() => {});
    resetAuth();
    repositoriesResponse = { repositories: [] };
    orchestratorDesignationCalls = [];
    installGlobalFetchMock();
  });

  afterEach(() => {
    cleanup();
    resetAuth();
    globalThis.fetch = originalGlobalFetch;
  });

  describe('Rendering', () => {
    it('should render "Active Sessions" header when expanded', async () => {
      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} />);

      expect(screen.getByText('Active Sessions')).toBeTruthy();
    });

    it('should not show header text when collapsed', async () => {
      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} collapsed={true} />
      );

      expect(screen.queryByText('Active Sessions')).toBeNull();
    });

    it('should show "No active sessions" message when empty and expanded', async () => {
      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} />);

      expect(screen.getByText('No active sessions')).toBeTruthy();
    });

    it('should not show empty message when collapsed', async () => {
      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} collapsed={true} />
      );

      expect(screen.queryByText('No active sessions')).toBeNull();
    });
  });

  describe('Session list', () => {
    it('should render session items', async () => {
      const sessions = [
        createSessionWithActivity(createMockWorktreeSession({ repositoryName: 'repo-a' }), 'idle'),
        createSessionWithActivity(createMockWorktreeSession({ repositoryName: 'repo-b' }), 'active'),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      expect(screen.getByText('repo-a')).toBeTruthy();
      expect(screen.getByText('repo-b')).toBeTruthy();
    });

    it('should display repository name and title for worktree sessions', async () => {
      const session = createMockWorktreeSession({
        repositoryName: 'my-repository',
        title: 'feature-branch',
      });
      const sessions = [createSessionWithActivity(session, 'idle')];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      expect(screen.getByText('my-repository')).toBeTruthy();
      expect(screen.getByText('feature-branch')).toBeTruthy();
    });

    it('should display "Quick Session" for quick sessions', async () => {
      const session = createMockQuickSession({ locationPath: '/Users/test/project' });
      const sessions = [createSessionWithActivity(session, 'idle')];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      expect(screen.getByText('Quick Session')).toBeTruthy();
      // Path is truncated: /Users/test/project -> ~/project
      expect(screen.getByText('~/project')).toBeTruthy();
    });

    it('should highlight active session matching current URL path', async () => {
      const session1 = createMockWorktreeSession({ id: 'session-1', repositoryName: 'repo-1' });
      const session2 = createMockWorktreeSession({ id: 'session-2', repositoryName: 'repo-2' });
      const sessions = [
        createSessionWithActivity(session1, 'idle'),
        createSessionWithActivity(session2, 'idle'),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />,
        '/sessions/session-1'
      );

      // Find the buttons for each session
      const buttons = screen.getAllByRole('button');
      // First button is toggle, rest are session items
      const sessionButtons = buttons.filter(btn =>
        btn.textContent?.includes('repo-1') || btn.textContent?.includes('repo-2')
      );

      // session-1 should have bg-slate-800 class (active)
      // session-2 should only have hover:bg-slate-800 (not active)
      const session1Button = sessionButtons.find(btn => btn.textContent?.includes('repo-1'));
      const session2Button = sessionButtons.find(btn => btn.textContent?.includes('repo-2'));

      // Active session has bg-slate-800 as a standalone class (not just in hover:)
      // Check by looking for the pattern " bg-slate-800" (with space before) or at the start
      const hasPermanentBgClass = (className: string | undefined) => {
        if (!className) return false;
        // Match bg-slate-800 that's not part of hover: or other pseudo-class
        return className.split(' ').includes('bg-slate-800');
      };

      expect(hasPermanentBgClass(session1Button?.className)).toBe(true);
      expect(hasPermanentBgClass(session2Button?.className)).toBe(false);
    });
  });

  describe('Toggle button', () => {
    it('should call onToggle when toggle button clicked', async () => {
      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} />);

      const toggleButton = screen.getByTitle('Collapse sidebar');
      fireEvent.click(toggleButton);

      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('should show "Expand sidebar" title when collapsed', async () => {
      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} collapsed={true} />
      );

      expect(screen.getByTitle('Expand sidebar')).toBeTruthy();
    });

    it('should show "Collapse sidebar" title when expanded', async () => {
      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} />);

      expect(screen.getByTitle('Collapse sidebar')).toBeTruthy();
    });
  });

  describe('Activity indicators', () => {
    it('should display activity indicator for each session', async () => {
      const sessions = [
        createSessionWithActivity(createMockWorktreeSession({ repositoryName: 'repo-a' }), 'idle'),
        createSessionWithActivity(createMockWorktreeSession({ repositoryName: 'repo-b' }), 'active'),
        createSessionWithActivity(createMockWorktreeSession({ repositoryName: 'repo-c' }), 'asking'),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      // ActivityIndicator has aria-label="Activity: {state}"
      const indicators = screen.getAllByLabelText(/^Activity:/);
      expect(indicators).toHaveLength(3);

      expect(screen.getByLabelText('Activity: idle')).toBeTruthy();
      expect(screen.getByLabelText('Activity: active')).toBeTruthy();
      expect(screen.getByLabelText('Activity: asking')).toBeTruthy();
    });

    it('should show tooltip with activity state label when collapsed', async () => {
      const session = createMockWorktreeSession({ repositoryName: 'my-repo', title: 'my-branch' });
      const sessions = [createSessionWithActivity(session, 'asking')];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} collapsed={true} sessions={sessions} />
      );

      // In collapsed mode, button has title with full info including activity label
      const buttons = screen.getAllByRole('button');
      const sessionButton = buttons.find(btn =>
        btn.getAttribute('title')?.includes('Waiting for input')
      );

      expect(sessionButton).toBeTruthy();
      expect(sessionButton?.getAttribute('title')).toContain('my-repo / my-branch');
      expect(sessionButton?.getAttribute('title')).toContain('Waiting for input');
    });
  });

  describe('Width', () => {
    it('should use SIDEBAR_COLLAPSED_WIDTH when collapsed', async () => {
      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} collapsed={true} width={300} />
      );

      const sidebar = screen.getByRole('complementary', { name: 'Active sessions' });
      expect(sidebar.style.width).toBe(`${SIDEBAR_COLLAPSED_WIDTH}px`);
    });

    it('should use provided width when expanded', async () => {
      const customWidth = 280;
      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} width={customWidth} />
      );

      const sidebar = screen.getByRole('complementary', { name: 'Active sessions' });
      expect(sidebar.style.width).toBe(`${customWidth}px`);
    });

    it('should have an explicit h-full class on the <aside> so it gets a bounded height even without a flex-row parent (Issue #1170)', async () => {
      // On desktop, the aside's height comes from `align-items: stretch` in
      // the parent flex row. On mobile, the aside is rendered inside a
      // non-flex-row drawer wrapper, so it needs its own explicit height to
      // bound the internal `overflow-y-auto` session list — otherwise the
      // list grows unbounded and long session lists get cut off.
      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} />);

      const sidebar = screen.getByRole('complementary', { name: 'Active sessions' });
      expect(sidebar.className.split(' ')).toContain('h-full');
    });
  });

  describe('Navigation', () => {
    it('should navigate to session page when session item clicked', async () => {
      const session = createMockWorktreeSession({ id: 'test-session-id', repositoryName: 'my-repo' });
      const sessions = [createSessionWithActivity(session, 'idle')];

      const { router } = await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      const sessionButton = screen.getByText('my-repo').closest('button');
      fireEvent.click(sessionButton!);

      expect(router.state.location.pathname).toBe('/sessions/test-session-id');
    });
  });

  describe('Resize handle', () => {
    it('should show resize handle when expanded', async () => {
      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} />);

      const resizeHandle = screen.getByTitle('Drag to resize');
      expect(resizeHandle).toBeTruthy();
    });

    it('should not show resize handle when collapsed', async () => {
      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} collapsed={true} />
      );

      expect(screen.queryByTitle('Drag to resize')).toBeNull();
    });

    it('should hide resize handle when hideResizeHandle is true', async () => {
      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} hideResizeHandle />
      );
      expect(screen.queryByTitle('Drag to resize')).toBeNull();
    });
  });

  describe('ARIA attributes', () => {
    it('should have aria-label="Collapse sidebar" on toggle button when expanded', async () => {
      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} />);

      const toggleButton = screen.getByRole('button', { name: 'Collapse sidebar' });
      expect(toggleButton).toBeTruthy();
    });

    it('should have aria-label="Expand sidebar" on toggle button when collapsed', async () => {
      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} collapsed={true} />
      );

      const toggleButton = screen.getByRole('button', { name: 'Expand sidebar' });
      expect(toggleButton).toBeTruthy();
    });

    it('should have aria-expanded={false} on paused sessions accordion button initially', async () => {
      const pausedSessions = [
        createMockWorktreeSession({ pausedAt: new Date().toISOString(), repositoryName: 'paused-repo' }),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} pausedSessions={pausedSessions} />
      );

      const pausedButton = screen.getByText('Paused').closest('button')!;
      expect(pausedButton.getAttribute('aria-expanded')).toBe('false');
    });

    it('should have aria-expanded={true} on paused sessions accordion button after clicking', async () => {
      const pausedSessions = [
        createMockWorktreeSession({ pausedAt: new Date().toISOString(), repositoryName: 'paused-repo' }),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} pausedSessions={pausedSessions} />
      );

      const pausedButton = screen.getByText('Paused').closest('button')!;
      fireEvent.click(pausedButton);

      expect(pausedButton.getAttribute('aria-expanded')).toBe('true');
    });

    it('should have aria-controls on paused button matching id of paused list container', async () => {
      const pausedSessions = [
        createMockWorktreeSession({ pausedAt: new Date().toISOString(), repositoryName: 'paused-repo' }),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} pausedSessions={pausedSessions} />
      );

      const pausedButton = screen.getByText('Paused').closest('button')!;
      const controlsId = pausedButton.getAttribute('aria-controls');
      expect(controlsId).toBe('paused-sessions-list');

      // Verify the controlled element exists with that id
      const controlledElement = document.getElementById(controlsId!);
      expect(controlledElement).toBeTruthy();
    });
  });

  describe('Paused sessions', () => {
    function createPausedSession(overrides: Partial<Session> = {}): Session {
      return createMockWorktreeSession({
        pausedAt: new Date().toISOString(),
        ...overrides,
      });
    }

    it('should show paused section when pausedSessions is provided and not empty', async () => {
      const pausedSessions = [createPausedSession({ repositoryName: 'paused-repo' })];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} pausedSessions={pausedSessions} />
      );

      expect(screen.getByText('Paused')).toBeTruthy();
    });

    it('should not show paused section when pausedSessions is empty', async () => {
      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} pausedSessions={[]} />
      );

      expect(screen.queryByText('Paused')).toBeNull();
    });

    it('should show paused count in header', async () => {
      const pausedSessions = [
        createPausedSession({ repositoryName: 'repo-1' }),
        createPausedSession({ repositoryName: 'repo-2' }),
        createPausedSession({ repositoryName: 'repo-3' }),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} pausedSessions={pausedSessions} />
      );

      // The count badge shows the number of paused sessions
      expect(screen.getByText('3')).toBeTruthy();
    });

    it('should sort paused sessions by pausedAt descending', async () => {
      const pausedSessions = [
        createPausedSession({
          id: 'oldest',
          repositoryName: 'repo-oldest',
          pausedAt: '2025-01-01T00:00:00Z',
        }),
        createPausedSession({
          id: 'newest',
          repositoryName: 'repo-newest',
          pausedAt: '2025-03-01T00:00:00Z',
        }),
        createPausedSession({
          id: 'middle',
          repositoryName: 'repo-middle',
          pausedAt: '2025-02-01T00:00:00Z',
        }),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} pausedSessions={pausedSessions} />
      );

      // Click the "Paused" accordion to expand it
      const pausedButton = screen.getByText('Paused').closest('button')!;
      fireEvent.click(pausedButton);

      // All three paused sessions should now be visible
      expect(screen.getByText('repo-oldest')).toBeTruthy();
      expect(screen.getByText('repo-newest')).toBeTruthy();
      expect(screen.getByText('repo-middle')).toBeTruthy();

      // Verify order: newest first, then middle, then oldest
      const allButtons = screen.getAllByRole('button');
      const pausedSessionButtons = allButtons.filter(btn =>
        btn.textContent?.includes('repo-oldest') ||
        btn.textContent?.includes('repo-newest') ||
        btn.textContent?.includes('repo-middle')
      );

      expect(pausedSessionButtons).toHaveLength(3);
      expect(pausedSessionButtons[0].textContent).toContain('repo-newest');
      expect(pausedSessionButtons[1].textContent).toContain('repo-middle');
      expect(pausedSessionButtons[2].textContent).toContain('repo-oldest');
    });

    it('should call onResumeSession when paused session is clicked', async () => {
      const onResumeSession = mock(() => {});
      const pausedSessions = [
        createPausedSession({ id: 'paused-session-1', repositoryName: 'repo-to-resume' }),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar
          {...defaultProps()}
          pausedSessions={pausedSessions}
          onResumeSession={onResumeSession}
        />
      );

      // Expand the paused section
      const pausedButton = screen.getByText('Paused').closest('button')!;
      fireEvent.click(pausedButton);

      // Click the paused session
      const sessionButton = screen.getByText('repo-to-resume').closest('button')!;
      fireEvent.click(sessionButton);

      expect(onResumeSession).toHaveBeenCalledTimes(1);
      expect(onResumeSession).toHaveBeenCalledWith('paused-session-1');
    });

    it('should navigate to session page only after resume succeeds', async () => {
      const onResumeSession = mock(() => Promise.resolve());
      const pausedSessions = [
        createPausedSession({ id: 'paused-session-nav', repositoryName: 'repo-nav' }),
      ];

      const { router } = await renderWithRouter(
        <ActiveSessionsSidebar
          {...defaultProps()}
          pausedSessions={pausedSessions}
          onResumeSession={onResumeSession}
        />
      );

      // Expand the paused section
      const pausedButton = screen.getByText('Paused').closest('button')!;
      fireEvent.click(pausedButton);

      // Click the paused session
      const sessionButton = screen.getByText('repo-nav').closest('button')!;
      fireEvent.click(sessionButton);

      // Navigation happens after resume succeeds
      await waitFor(() => {
        expect(router.state.location.pathname).toBe('/sessions/paused-session-nav');
      });
    });

    it('should not navigate when onResumeSession returns a rejected promise', async () => {
      const consoleErrorSpy = mock(() => {});
      const originalError = console.error;
      console.error = consoleErrorSpy;

      try {
        const onResumeSession = mock(() => Promise.reject(new Error('Resume failed')));
        const pausedSessions = [
          createPausedSession({ id: 'paused-fail', repositoryName: 'repo-fail' }),
        ];

        const { router } = await renderWithRouter(
          <ActiveSessionsSidebar
            {...defaultProps()}
            pausedSessions={pausedSessions}
            onResumeSession={onResumeSession}
          />
        );

        // Expand the paused section
        const pausedButton = screen.getByText('Paused').closest('button')!;
        fireEvent.click(pausedButton);

        // Click the paused session
        const sessionButton = screen.getByText('repo-fail').closest('button')!;
        fireEvent.click(sessionButton);

        // The error should be caught and logged, not thrown as unhandled rejection
        await waitFor(() => {
          expect(consoleErrorSpy).toHaveBeenCalled();
        });
        const errorCall = consoleErrorSpy.mock.calls.find(
          (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Failed to resume session')
        );
        expect(errorCall).toBeTruthy();

        // Navigation should NOT happen when resume fails
        expect(router.state.location.pathname).not.toBe('/sessions/paused-fail');
      } finally {
        console.error = originalError;
      }
    });

    it('should sort paused sessions deterministically when pausedAt values are equal', async () => {
      const samePausedAt = '2025-02-01T00:00:00Z';
      const pausedSessions = [
        createPausedSession({
          id: 'session-c',
          repositoryName: 'repo-c',
          pausedAt: samePausedAt,
        }),
        createPausedSession({
          id: 'session-a',
          repositoryName: 'repo-a',
          pausedAt: samePausedAt,
        }),
        createPausedSession({
          id: 'session-b',
          repositoryName: 'repo-b',
          pausedAt: samePausedAt,
        }),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} pausedSessions={pausedSessions} />
      );

      // Click the "Paused" accordion to expand it
      const pausedButton = screen.getByText('Paused').closest('button')!;
      fireEvent.click(pausedButton);

      // All three paused sessions should be visible
      const allButtons = screen.getAllByRole('button');
      const pausedSessionButtons = allButtons.filter(btn =>
        btn.textContent?.includes('repo-a') ||
        btn.textContent?.includes('repo-b') ||
        btn.textContent?.includes('repo-c')
      );

      expect(pausedSessionButtons).toHaveLength(3);
      // With equal pausedAt, should sort by id ascending (session-a, session-b, session-c)
      expect(pausedSessionButtons[0].textContent).toContain('repo-a');
      expect(pausedSessionButtons[1].textContent).toContain('repo-b');
      expect(pausedSessionButtons[2].textContent).toContain('repo-c');
    });
  });

  describe('Session filter toggle', () => {
    it('should render "All" and "Mine" buttons when sessionFilter is provided', async () => {
      const onChange = mock(() => {});

      await renderWithRouter(
        <ActiveSessionsSidebar
          {...defaultProps()}
          sessionFilter={{ mode: 'all', onChange }}
        />
      );

      expect(screen.getByText('All')).toBeTruthy();
      expect(screen.getByText('Mine')).toBeTruthy();
    });

    it('should not render filter toggle when sessionFilter is not provided', async () => {
      await renderWithRouter(
        <ActiveSessionsSidebar
          {...defaultProps()}
        />
      );

      expect(screen.queryByText('All')).toBeNull();
      expect(screen.queryByText('Mine')).toBeNull();
    });

    it('should not render filter toggle when collapsed', async () => {
      const onChange = mock(() => {});

      await renderWithRouter(
        <ActiveSessionsSidebar
          {...defaultProps()}
          collapsed={true}
          sessionFilter={{ mode: 'all', onChange }}
        />
      );

      expect(screen.queryByText('All')).toBeNull();
      expect(screen.queryByText('Mine')).toBeNull();
    });

    it('should call onChange with correct value when buttons are clicked', async () => {
      const onChange = mock(() => {});

      await renderWithRouter(
        <ActiveSessionsSidebar
          {...defaultProps()}
          sessionFilter={{ mode: 'all', onChange }}
        />
      );

      fireEvent.click(screen.getByText('Mine'));
      expect(onChange).toHaveBeenCalledWith('mine');

      fireEvent.click(screen.getByText('All'));
      expect(onChange).toHaveBeenCalledWith('all');
    });

    it('should reflect active mode via aria-pressed', async () => {
      const onChange = mock(() => {});

      await renderWithRouter(
        <ActiveSessionsSidebar
          {...defaultProps()}
          sessionFilter={{ mode: 'mine', onChange }}
        />
      );

      const allButton = screen.getByText('All');
      const mineButton = screen.getByText('Mine');

      expect(allButton.getAttribute('aria-pressed')).toBe('false');
      expect(mineButton.getAttribute('aria-pressed')).toBe('true');
    });

    it('should NOT render "Shared" filter button when sharedAccountsAvailable is false', async () => {
      const onChange = mock(() => {});
      setSharedAccountsAvailable(false);

      await renderWithRouter(
        <ActiveSessionsSidebar
          {...defaultProps()}
          sessionFilter={{ mode: 'all', onChange }}
        />
      );

      expect(screen.getByText('All')).toBeTruthy();
      expect(screen.getByText('Mine')).toBeTruthy();
      expect(screen.queryByText('Shared')).toBeNull();
    });

    it('should render "Shared" filter button when sharedAccountsAvailable is true', async () => {
      const onChange = mock(() => {});
      setSharedAccountsAvailable(true);

      await renderWithRouter(
        <ActiveSessionsSidebar
          {...defaultProps()}
          sessionFilter={{ mode: 'all', onChange }}
        />
      );

      expect(screen.getByText('Shared')).toBeTruthy();
    });

    it('should call onChange with "shared" when Shared button clicked', async () => {
      const onChange = mock(() => {});
      setSharedAccountsAvailable(true);

      await renderWithRouter(
        <ActiveSessionsSidebar
          {...defaultProps()}
          sessionFilter={{ mode: 'all', onChange }}
        />
      );

      fireEvent.click(screen.getByText('Shared'));
      expect(onChange).toHaveBeenCalledWith('shared');
    });

    it('should reflect shared mode via aria-pressed', async () => {
      const onChange = mock(() => {});
      setSharedAccountsAvailable(true);

      await renderWithRouter(
        <ActiveSessionsSidebar
          {...defaultProps()}
          sessionFilter={{ mode: 'shared', onChange }}
        />
      );

      expect(screen.getByText('Shared').getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByText('All').getAttribute('aria-pressed')).toBe('false');
    });
  });

  describe('Shared session badge', () => {
    it('should render "Shared" badge for sessions with isShared true', async () => {
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({ repositoryName: 'shared-repo', isShared: true }),
          'idle'
        ),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      expect(screen.getByText('shared-repo')).toBeTruthy();
      expect(screen.getByText('Shared')).toBeTruthy();
    });

    it('should NOT render "Shared" badge for sessions with isShared false', async () => {
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({ repositoryName: 'normal-repo', isShared: false }),
          'idle'
        ),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      expect(screen.getByText('normal-repo')).toBeTruthy();
      expect(screen.queryByText('Shared')).toBeNull();
    });

    it('should append [Shared] to tooltip in collapsed mode for shared sessions', async () => {
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({
            repositoryName: 'shared-repo',
            title: 'shared-branch',
            isShared: true,
          }),
          'idle'
        ),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} collapsed={true} sessions={sessions} />
      );

      const buttons = screen.getAllByRole('button');
      const sessionButton = buttons.find(btn =>
        btn.getAttribute('title')?.includes('shared-repo / shared-branch')
      );
      expect(sessionButton?.getAttribute('title')).toContain('[Shared]');
    });
  });

  describe('Worktree owner label (createdByUsername)', () => {
    it('should render creator username in multi-user mode when createdByUsername is set', async () => {
      setAuthMode('multi-user');
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({
            repositoryName: 'multi-user-repo',
            createdByUsername: 'alice',
          }),
          'idle'
        ),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      const label = screen.getByTestId('session-creator-username');
      expect(label.textContent).toBe('alice');
    });

    it('should NOT render creator username span when createdByUsername is null (legacy session)', async () => {
      setAuthMode('multi-user');
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({
            repositoryName: 'legacy-repo',
            createdByUsername: null,
          }),
          'idle'
        ),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      // The session item still renders, but the creator-username span must
      // not be mounted at all (truthy gate prevents <span>{null}</span> from
      // being emitted as an empty placeholder element).
      expect(screen.getByText('legacy-repo')).toBeTruthy();
      expect(screen.queryByTestId('session-creator-username')).toBeNull();
    });

    it('should NOT render creator username in single-user mode even when createdByUsername is set', async () => {
      // authMode defaults to 'none' from resetAuth(); do NOT call setAuthMode here
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({
            repositoryName: 'single-user-repo',
            createdByUsername: 'alice',
          }),
          'idle'
        ),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      // Gating: in single-user (authMode === 'none'), even a populated
      // createdByUsername must not be displayed.
      expect(screen.getByText('single-user-repo')).toBeTruthy();
      expect(screen.queryByTestId('session-creator-username')).toBeNull();
    });

    it('should style creator badge with indigo (self) when session.createdBy matches currentUser.id', async () => {
      setAuthMode('multi-user');
      setCurrentUser({ id: 'self-uuid', username: 'me', homeDir: '/home/me' });
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({
            repositoryName: 'my-own-repo',
            createdBy: 'self-uuid',
            createdByUsername: 'me',
          }),
          'idle'
        ),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      const label = screen.getByTestId('session-creator-username');
      const classes = label.className.split(' ');
      // Self: indigo present, amber absent (polarity-flip pair).
      // Uses Tailwind alpha-shorthand `bg-<color>-500/20` so the badge
      // tints the existing slate sidebar rather than punching a solid block.
      expect(classes).toContain('bg-indigo-500/20');
      expect(classes).toContain('text-indigo-200');
      expect(classes).not.toContain('bg-amber-500/20');
      expect(classes).not.toContain('text-amber-200');
    });

    it('should style creator badge with amber (other) when session.createdBy differs from currentUser.id', async () => {
      setAuthMode('multi-user');
      setCurrentUser({ id: 'self-uuid', username: 'me', homeDir: '/home/me' });
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({
            repositoryName: 'someone-elses-repo',
            createdBy: 'other-uuid',
            createdByUsername: 'alice',
          }),
          'idle'
        ),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      const label = screen.getByTestId('session-creator-username');
      const classes = label.className.split(' ');
      // Other: amber present, indigo absent (polarity-flip pair)
      expect(classes).toContain('bg-amber-500/20');
      expect(classes).toContain('text-amber-200');
      expect(classes).not.toContain('bg-indigo-500/20');
      expect(classes).not.toContain('text-indigo-200');
    });

    it('should style creator badge as "other" (amber) when currentUser is null (e.g. session loaded before login resolves)', async () => {
      setAuthMode('multi-user');
      // currentUser intentionally not set (null after resetAuth)
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({
            repositoryName: 'unknown-viewer-repo',
            createdBy: 'some-uuid',
            createdByUsername: 'alice',
          }),
          'idle'
        ),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      const label = screen.getByTestId('session-creator-username');
      const classes = label.className.split(' ');
      // Without a known viewer identity we conservatively treat the session
      // as "not mine" so it never falsely flags as the viewer's own.
      expect(classes).toContain('bg-amber-500/20');
      expect(classes).not.toContain('bg-indigo-500/20');
    });

    it('should render BOTH [Shared] badge and creator username for shared sessions (no collision)', async () => {
      setAuthMode('multi-user');
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({
            repositoryName: 'shared-repo',
            isShared: true,
            createdByUsername: 'shared-acct',
          }),
          'idle'
        ),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      // Both UI elements visible — they live in distinct DOM nodes so no
      // textual collision; visual collision is prevented by reserved
      // padding (pr-20 on the inner content column when the label renders).
      expect(screen.getByText('shared-repo')).toBeTruthy();
      const sharedBadge = screen.getByText('Shared');
      const creatorLabel = screen.getByTestId('session-creator-username');
      expect(sharedBadge).toBeTruthy();
      expect(creatorLabel.textContent).toBe('shared-acct');
      // Sanity: they are different DOM nodes (not the same element).
      expect(sharedBadge).not.toBe(creatorLabel);
    });
  });

  describe('Orphaned sessions', () => {
    it('should render "Unrecoverable" label for orphaned sessions in the active list', async () => {
      const orphaned = createMockWorktreeSession({
        repositoryName: 'broken-repo',
        title: 'broken-branch',
        recoveryState: 'orphaned',
      });
      const sessions = [createSessionWithActivity(orphaned, 'idle')];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      expect(screen.getByText('broken-repo')).toBeTruthy();
      expect(screen.getByText('Unrecoverable')).toBeTruthy();
      // Regular activity secondary line is replaced, so the title should NOT
      // be rendered for orphaned sessions.
      expect(screen.queryByText('broken-branch')).toBeNull();
    });

    it('should include "Unrecoverable" in the tooltip for orphaned active session', async () => {
      const orphaned = createMockWorktreeSession({
        repositoryName: 'broken-repo',
        title: 'broken-branch',
        recoveryState: 'orphaned',
      });
      const sessions = [createSessionWithActivity(orphaned, 'idle')];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
      );

      const sessionButton = screen.getByText('broken-repo').closest('button')!;
      expect(sessionButton.getAttribute('title')).toContain('Unrecoverable');
    });

    it('should render "Unrecoverable" label for orphaned sessions in the paused list', async () => {
      const orphaned = createMockWorktreeSession({
        repositoryName: 'orphan-paused',
        title: 'paused-title',
        pausedAt: new Date().toISOString(),
        recoveryState: 'orphaned',
      });

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} pausedSessions={[orphaned]} />
      );

      // Expand the paused accordion
      const pausedButton = screen.getByText('Paused').closest('button')!;
      fireEvent.click(pausedButton);

      expect(screen.getByText('orphan-paused')).toBeTruthy();
      expect(screen.getByText('Unrecoverable')).toBeTruthy();
    });
  });

  describe('Restart All Agents button', () => {
    const originalFetch = globalThis.fetch;
    let restartAllResponse: unknown;

    beforeEach(() => {
      restartAllResponse = { restarted: 0, failed: 0, skipped: 0, results: [] };
      globalThis.fetch = Object.assign(
        mock(async (input: RequestInfo | URL): Promise<Response> => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.includes('/restart-all-agents')) {
            return new Response(JSON.stringify(restartAllResponse), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        }),
        { preconnect: () => {} },
      ) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should render restart all agents button when expanded', async () => {
      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} />);
      const button = screen.getByTitle('Restart all agents');
      expect(button).toBeTruthy();
    });

    it('should not render restart all agents button when collapsed', async () => {
      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} collapsed={true} />);
      expect(screen.queryByTitle('Restart all agents')).toBeNull();
    });

    it('should show confirmation dialog when clicked', async () => {
      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} />);
      const user = userEvent.setup();
      await user.click(screen.getByTitle('Restart all agents'));

      await waitFor(() => {
        expect(screen.getByText('Restart All Agents')).toBeTruthy();
        expect(screen.getByText(/This will restart every active agent worker/)).toBeTruthy();
        expect(screen.getByText(/terminal agents \(such as Claude Code\)/i)).toBeTruthy();
        expect(screen.getByText(/embedded agents/i)).toBeTruthy();
        expect(screen.getByText(/conversations continue/i)).toBeTruthy();
        expect(screen.getByText(/never received its initial task/i)).toBeTruthy();
        expect(
          screen.getByText(/plain terminal \(shell\) workers are left running/i)
        ).toBeTruthy();
        expect(screen.queryByText(/Terminal workers will not be affected/)).toBeNull();
      });
    });

    it('should call API and show result message on confirm', async () => {
      restartAllResponse = { restarted: 3, failed: 0, skipped: 0, results: [] };
      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} />);

      const user = userEvent.setup();
      await user.click(screen.getByTitle('Restart all agents'));

      await waitFor(() => {
        expect(screen.getByText('Restart All')).toBeTruthy();
      });

      await user.click(screen.getByText('Restart All'));

      await waitFor(() => {
        expect(screen.getByText('Restarted 3 agents.')).toBeTruthy();
      });
    });

    // Issue #1519: `restarted === 0 && failed === 0` used to always mean "no
    // agent workers exist". After the fix it can also mean "every candidate
    // worker was skipped" (all-terminal sessions, or dormant/idle-evicted
    // embedded agents). These two cases must render distinguishable text.
    it('should distinguish "all skipped" from "no targets at all" when nothing was restarted or failed', async () => {
      restartAllResponse = { restarted: 0, failed: 0, skipped: 2, results: [] };
      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} />);

      const user = userEvent.setup();
      await user.click(screen.getByTitle('Restart all agents'));

      await waitFor(() => {
        expect(screen.getByText('Restart All')).toBeTruthy();
      });

      await user.click(screen.getByText('Restart All'));

      const noTargetsMessage = formatRestartMessage({ restarted: 0, failed: 0, skipped: 0, results: [] });
      const allSkippedMessage = formatRestartMessage({ restarted: 0, failed: 0, skipped: 2, results: [] });

      await waitFor(() => {
        expect(screen.getByText(allSkippedMessage)).toBeTruthy();
        expect(allSkippedMessage).not.toBe(noTargetsMessage);
        expect(screen.queryByText(noTargetsMessage)).toBeNull();
      });
    });

    it('should show a distinct message when there are no agent workers at all', async () => {
      restartAllResponse = { restarted: 0, failed: 0, skipped: 0, results: [] };
      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} />);

      const user = userEvent.setup();
      await user.click(screen.getByTitle('Restart all agents'));

      await waitFor(() => {
        expect(screen.getByText('Restart All')).toBeTruthy();
      });

      await user.click(screen.getByText('Restart All'));

      const noTargetsMessage = formatRestartMessage({ restarted: 0, failed: 0, skipped: 0, results: [] });

      await waitFor(() => {
        expect(screen.getByText(noTargetsMessage)).toBeTruthy();
      });
    });
  });

  describe('formatRestartMessage', () => {
    it('reports "no agent workers found" when restarted, failed, and skipped are all zero', () => {
      expect(formatRestartMessage({ restarted: 0, failed: 0, skipped: 0, results: [] })).toBe(
        'No agent workers found.'
      );
    });

    it('reports a distinct skipped-only message when nothing restarted or failed but some were skipped', () => {
      const message = formatRestartMessage({ restarted: 0, failed: 0, skipped: 2, results: [] });
      expect(message).not.toBe('No agent workers found.');
      expect(message).toContain('skipped');
      expect(message).toContain('2');
    });

    it('reports a simple restarted-count message when nothing failed or was skipped', () => {
      expect(formatRestartMessage({ restarted: 1, failed: 0, skipped: 0, results: [] })).toBe(
        'Restarted 1 agent.'
      );
      expect(formatRestartMessage({ restarted: 3, failed: 0, skipped: 0, results: [] })).toBe(
        'Restarted 3 agents.'
      );
    });

    it('includes failed and skipped counts when both are nonzero alongside restarted', () => {
      const message = formatRestartMessage({ restarted: 1, failed: 2, skipped: 3, results: [] });
      expect(message).toContain('Restarted 1');
      expect(message).toContain('failed 2');
      expect(message).toContain('skipped 3');
    });
  });

  describe('Repository grouping (Issue #1292)', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('renders a header per group with session counts when 2+ groups exist', async () => {
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'a1', repositoryId: 'repo-a', repositoryName: 'Repo A' }),
          'idle'
        ),
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'a2', repositoryId: 'repo-a', repositoryName: 'Repo A' }),
          'idle'
        ),
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'b1', repositoryId: 'repo-b', repositoryName: 'Repo B' }),
          'idle'
        ),
      ];

      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);

      const headerA = document.querySelector('[aria-controls="session-group-repo-a-list"]');
      const headerB = document.querySelector('[aria-controls="session-group-repo-b-list"]');
      expect(headerA).toBeTruthy();
      expect(headerB).toBeTruthy();
      expect(headerA?.textContent).toContain('Repo A');
      expect(headerA?.textContent).toContain('2');
      expect(headerB?.textContent).toContain('Repo B');
      expect(headerB?.textContent).toContain('1');
    });

    it('collapsing a group header hides its sessions but keeps the count badge visible', async () => {
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'a1', repositoryId: 'repo-a', repositoryName: 'Repo A', title: 'branch-a1' }),
          'idle'
        ),
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'b1', repositoryId: 'repo-b', repositoryName: 'Repo B', title: 'branch-b1' }),
          'idle'
        ),
      ];

      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);

      expect(screen.getByText('branch-a1')).toBeTruthy();

      const headerA = document.querySelector('[aria-controls="session-group-repo-a-list"]') as HTMLButtonElement;
      fireEvent.click(headerA);

      expect(screen.queryByText('branch-a1')).toBeNull();
      expect(headerA.textContent).toContain('1');
      expect(headerA.getAttribute('aria-expanded')).toBe('false');
      // The sibling group is unaffected by collapsing this one.
      expect(screen.getByText('branch-b1')).toBeTruthy();
    });

    it('persists group collapse state to localStorage on toggle and restores it on the next mount', async () => {
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'a1', repositoryId: 'repo-a', repositoryName: 'Repo A' }),
          'idle'
        ),
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'b1', repositoryId: 'repo-b', repositoryName: 'Repo B' }),
          'idle'
        ),
      ];

      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);

      const headerA = document.querySelector('[aria-controls="session-group-repo-a-list"]') as HTMLButtonElement;
      expect(headerA.getAttribute('aria-expanded')).toBe('true'); // default expanded (M3)
      fireEvent.click(headerA);

      expect(localStorage.getItem('agent-console:sidebar-group-collapsed:repo-a')).toBe('true');

      cleanup();

      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);
      const restoredHeaderA = document.querySelector('[aria-controls="session-group-repo-a-list"]');
      expect(restoredHeaderA?.getAttribute('aria-expanded')).toBe('false');
    });

    it('renders flat with no group header when exactly one group exists (R6 single-group degradation)', async () => {
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'a1', repositoryId: 'repo-a', repositoryName: 'Repo A' }),
          'idle'
        ),
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'a2', repositoryId: 'repo-a', repositoryName: 'Repo A' }),
          'idle'
        ),
      ];

      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);

      expect(document.querySelectorAll('[aria-controls^="session-group-"]')).toHaveLength(0);
      // Both sessions still render, just without a header.
      expect(screen.getAllByText('Repo A')).toHaveLength(2);
    });

    it('renders a flat icon list with no group headers when the sidebar is collapsed, even with multiple repositories (R5)', async () => {
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'a1', repositoryId: 'repo-a', repositoryName: 'Repo A' }),
          'idle'
        ),
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'b1', repositoryId: 'repo-b', repositoryName: 'Repo B' }),
          'idle'
        ),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} collapsed={true} sessions={sessions} />
      );

      expect(document.querySelectorAll('[aria-controls^="session-group-"]')).toHaveLength(0);
      // Still one activity indicator per session (flat icon list).
      expect(screen.getAllByLabelText(/^Activity:/)).toHaveLength(2);
    });

    it('R7: does not render an empty header once filtering removes every session for a repository', async () => {
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'a1', repositoryId: 'repo-a', repositoryName: 'Repo A' }),
          'idle'
        ),
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'b1', repositoryId: 'repo-b', repositoryName: 'Repo B' }),
          'idle'
        ),
      ];

      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);
      expect(document.querySelector('[aria-controls="session-group-repo-b-list"]')).toBeTruthy();
      cleanup();

      // Simulate the mine/shared filter (applied upstream in routes/__root.tsx,
      // BEFORE `sessions` reaches this component) having removed every
      // repo-b session. Filter-then-group composition (R7): the component
      // must never fabricate a lingering empty header for repo-b.
      const filteredSessions = sessions.filter(
        (s) => s.session.type === 'worktree' && s.session.repositoryId === 'repo-a'
      );
      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={filteredSessions} />);

      expect(document.querySelector('[aria-controls="session-group-repo-b-list"]')).toBeNull();
      // Down to a single group -> R6 degradation also applies, no header at all.
      expect(document.querySelectorAll('[aria-controls^="session-group-"]')).toHaveLength(0);
    });

    it('M5: shows an activity indicator on a collapsed group header when it contains a non-idle session', async () => {
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'a1', repositoryId: 'repo-a', repositoryName: 'Repo A' }),
          'asking'
        ),
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'b1', repositoryId: 'repo-b', repositoryName: 'Repo B' }),
          'idle'
        ),
      ];

      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);

      const headerA = document.querySelector('[aria-controls="session-group-repo-a-list"]') as HTMLButtonElement;
      const headerB = document.querySelector('[aria-controls="session-group-repo-b-list"]') as HTMLButtonElement;

      // Collapse both: repo-a has an attention-worthy (asking) session, repo-b is idle-only.
      fireEvent.click(headerA);
      fireEvent.click(headerB);

      expect(headerA.querySelector('[aria-label="Activity: asking"]')).toBeTruthy();
      expect(headerB.querySelector('[aria-label^="Activity:"]')).toBeNull();
    });

    it('does not show the collapsed-group activity indicator while the group is expanded', async () => {
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'a1', repositoryId: 'repo-a', repositoryName: 'Repo A' }),
          'asking'
        ),
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'b1', repositoryId: 'repo-b', repositoryName: 'Repo B' }),
          'idle'
        ),
      ];

      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);

      const headerA = document.querySelector('[aria-controls="session-group-repo-a-list"]') as HTMLButtonElement;
      // Still expanded (default) — the session's own indicator is visible
      // inline; the header itself must not duplicate it.
      expect(headerA.querySelector('[aria-label="Activity: asking"]')).toBeNull();
    });

    it('renders quick sessions under a dedicated "Quick sessions" group, ordered after repository groups', async () => {
      const sessions = [
        createSessionWithActivity(createMockQuickSession({ id: 'q1' }), 'idle'),
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'a1', repositoryId: 'repo-a', repositoryName: 'Repo A' }),
          'idle'
        ),
      ];

      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);

      const quickHeader = document.querySelector(`[aria-controls="session-group-${QUICK_SESSIONS_GROUP_KEY}-list"]`);
      expect(quickHeader).toBeTruthy();
      expect(quickHeader?.textContent).toContain('Quick sessions');

      const headers = Array.from(document.querySelectorAll('[aria-controls^="session-group-"]'));
      const headerIds = headers.map((h) => h.getAttribute('aria-controls'));
      expect(headerIds.indexOf('session-group-repo-a-list')).toBeLessThan(
        headerIds.indexOf(`session-group-${QUICK_SESSIONS_GROUP_KEY}-list`)
      );
    });

    it('invariant: the paused section still renders below the grouped session list (grouping does not swallow it)', async () => {
      const sessions = [
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'a1', repositoryId: 'repo-a', repositoryName: 'Repo A' }),
          'idle'
        ),
        createSessionWithActivity(
          createMockWorktreeSession({ id: 'b1', repositoryId: 'repo-b', repositoryName: 'Repo B' }),
          'idle'
        ),
      ];
      const pausedSessions = [
        createMockWorktreeSession({ pausedAt: new Date().toISOString(), repositoryName: 'paused-repo' }),
      ];

      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} pausedSessions={pausedSessions} />
      );

      // Exactly the 2 repository groups — the paused section is not folded
      // into the grouped region as a third group.
      expect(document.querySelectorAll('[aria-controls^="session-group-"]')).toHaveLength(2);
      expect(screen.getByText('Paused')).toBeTruthy();
    });

    it('invariant: "No active sessions" still renders when the session list is empty, unaffected by grouping', async () => {
      await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={[]} />);

      expect(screen.getByText('No active sessions')).toBeTruthy();
      expect(document.querySelectorAll('[aria-controls^="session-group-"]')).toHaveLength(0);
    });
  });
});

describe('Orchestrator flag control (Issue #1643 PR-2)', () => {
  let onToggle: ReturnType<typeof mock>;
  let onWidthChange: ReturnType<typeof mock>;

  const defaultProps = () => ({
    collapsed: false,
    onToggle,
    sessions: [] as SessionWithActivity[],
    width: SIDEBAR_DEFAULT_WIDTH,
    onWidthChange,
  });

  beforeEach(() => {
    onToggle = mock(() => {});
    onWidthChange = mock(() => {});
    resetAuth();
    repositoriesResponse = { repositories: [] };
    orchestratorDesignationCalls = [];
    installGlobalFetchMock();
  });

  afterEach(() => {
    cleanup();
    resetAuth();
    globalThis.fetch = originalGlobalFetch;
  });

  function repository(overrides: Partial<Repository> = {}): Repository {
    return {
      id: 'repo-1',
      name: 'repo-1',
      path: '/path/to/repo-1',
      createdAt: new Date().toISOString(),
      orchestratorSessionId: null,
      ...overrides,
    } as Repository;
  }

  // AC invariant: a nested <button> is invalid HTML and explicitly ruled out.
  // This must hold across the whole rendered sidebar, not only the flag
  // control's own row, since a regression could just as easily reintroduce
  // nesting elsewhere.
  it('never nests a <button> inside another <button> anywhere in the sidebar', async () => {
    repositoriesResponse = { repositories: [repository({ id: 'repo-a', orchestratorSessionId: 'session-a' })] };
    const sessions = [
      createSessionWithActivity(
        createMockWorktreeSession({ id: 'session-a', repositoryId: 'repo-a', repositoryName: 'repo-a' }),
        'idle'
      ),
      createSessionWithActivity(
        createMockQuickSession({ id: 'quick-1' }),
        'idle'
      ),
    ];

    const { container } = await renderWithRouter(
      <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
    );

    const flagButton = await waitFor(() => screen.getByTestId('orchestrator-flag-session-a'));

    expect(container.querySelectorAll('button button')).toHaveLength(0);
    // The flag button must remain a DOM sibling of the row <button> (both
    // children of the same wrapping `relative` <div>), not merely absent
    // from inside it -- this still holds after the flag moved from
    // top-right to below the activity indicator (Issue #1660).
    const rowButton = flagButton.parentElement?.querySelector('button:not([data-orchestrator-flag])');
    expect(rowButton).toBeTruthy();
    expect(rowButton?.parentElement).toBe(flagButton.parentElement);
  });

  it('only renders the flag control for worktree sessions, never quick sessions', async () => {
    const sessions = [
      createSessionWithActivity(createMockQuickSession({ id: 'quick-1' }), 'idle'),
    ];

    await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);

    expect(document.querySelectorAll('[data-orchestrator-flag]')).toHaveLength(0);
  });

  it('renders exactly one lit flag for the repository holding the designation, and none lit otherwise', async () => {
    repositoriesResponse = { repositories: [repository({ id: 'repo-a', orchestratorSessionId: 'session-a' })] };
    const sessions = [
      createSessionWithActivity(
        createMockWorktreeSession({ id: 'session-a', repositoryId: 'repo-a', repositoryName: 'repo-a' }),
        'idle'
      ),
      createSessionWithActivity(
        createMockWorktreeSession({ id: 'session-b', repositoryId: 'repo-a', repositoryName: 'repo-a' }),
        'idle'
      ),
    ];

    await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);

    await waitFor(() => {
      const flags = Array.from(document.querySelectorAll('[data-orchestrator-flag]'));
      expect(flags).toHaveLength(2);
      const lit = flags.filter((el) => el.getAttribute('data-orchestrator-flag-lit') === 'true');
      expect(lit).toHaveLength(1);
      expect(lit[0]).toBe(screen.getByTestId('orchestrator-flag-session-a'));
    });
  });

  it('renders zero lit flags when the repository has no designation', async () => {
    repositoriesResponse = { repositories: [repository({ id: 'repo-a', orchestratorSessionId: null })] };
    const sessions = [
      createSessionWithActivity(
        createMockWorktreeSession({ id: 'session-a', repositoryId: 'repo-a', repositoryName: 'repo-a' }),
        'idle'
      ),
    ];

    await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);

    await waitFor(() => {
      expect(screen.getByTestId('orchestrator-flag-session-a')).toBeTruthy();
    });
    const lit = document.querySelectorAll('[data-orchestrator-flag-lit="true"]');
    expect(lit).toHaveLength(0);
  });

  it('raises the designation when an unlit flag is clicked, without triggering row navigation', async () => {
    repositoriesResponse = { repositories: [repository({ id: 'repo-a', orchestratorSessionId: null })] };
    const sessions = [
      createSessionWithActivity(
        createMockWorktreeSession({ id: 'session-a', repositoryId: 'repo-a', repositoryName: 'repo-a' }),
        'idle'
      ),
    ];

    const { router } = await renderWithRouter(
      <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
    );

    const flagButton = await waitFor(() => screen.getByTestId('orchestrator-flag-session-a'));
    fireEvent.click(flagButton);

    await waitFor(() => {
      expect(orchestratorDesignationCalls).toContainEqual({ method: 'POST', sessionId: 'session-a' });
    });
    // Row navigation must not have fired -- the click must not bubble to
    // the row's own onClick.
    expect(router.state.location.pathname).toBe('/');
  });

  it('clears the designation when a lit flag is clicked, without triggering row navigation', async () => {
    repositoriesResponse = { repositories: [repository({ id: 'repo-a', orchestratorSessionId: 'session-a' })] };
    const sessions = [
      createSessionWithActivity(
        createMockWorktreeSession({ id: 'session-a', repositoryId: 'repo-a', repositoryName: 'repo-a' }),
        'idle'
      ),
    ];

    const { router } = await renderWithRouter(
      <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
    );

    const flagButton = await waitFor(() => {
      const el = screen.getByTestId('orchestrator-flag-session-a');
      expect(el.getAttribute('data-orchestrator-flag-lit')).toBe('true');
      return el;
    });
    fireEvent.click(flagButton);

    await waitFor(() => {
      expect(orchestratorDesignationCalls).toContainEqual({ method: 'DELETE', sessionId: 'session-a' });
    });
    expect(router.state.location.pathname).toBe('/');
  });

  // CodeRabbit finding on PR #1657: a failed raise/clear request used to only
  // re-enable the button, with no visible feedback (e.g. a 403 for a
  // non-owner's session in multi-user `all` mode, or a network error).
  it('shows a transient, visible error message when raising the designation fails', async () => {
    repositoriesResponse = { repositories: [repository({ id: 'repo-a', orchestratorSessionId: null })] };
    globalThis.fetch = Object.assign(
      mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = input instanceof Request ? input.url : String(input);
        const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
        if (url.includes('/api/repositories') && method === 'GET') {
          return new Response(JSON.stringify(repositoriesResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.match(/\/api\/sessions\/([^/]+)\/orchestrator-designation$/) && method === 'POST') {
          return new Response(JSON.stringify({ error: 'Not authorized to designate this session' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
      { preconnect: () => {} }
    ) as typeof fetch;

    const sessions = [
      createSessionWithActivity(
        createMockWorktreeSession({ id: 'session-a', repositoryId: 'repo-a', repositoryName: 'repo-a' }),
        'idle'
      ),
    ];

    const { router } = await renderWithRouter(
      <ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />
    );

    const flagButton = await waitFor(() => screen.getByTestId('orchestrator-flag-session-a'));
    fireEvent.click(flagButton);

    await waitFor(() => {
      expect(screen.getByText('Not authorized to designate this session')).toBeTruthy();
    });
    // The button itself must re-enable (not stuck pending) and row
    // navigation must not have fired.
    expect(flagButton.hasAttribute('disabled')).toBe(false);
    expect(router.state.location.pathname).toBe('/');
  });

  it('shows a transient, visible error message when clearing the designation fails', async () => {
    repositoriesResponse = { repositories: [repository({ id: 'repo-a', orchestratorSessionId: 'session-a' })] };
    globalThis.fetch = Object.assign(
      mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = input instanceof Request ? input.url : String(input);
        const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
        if (url.includes('/api/repositories') && method === 'GET') {
          return new Response(JSON.stringify(repositoriesResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.match(/\/api\/sessions\/([^/]+)\/orchestrator-designation$/) && method === 'DELETE') {
          return new Response(null, { status: 500 });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
      { preconnect: () => {} }
    ) as typeof fetch;

    const sessions = [
      createSessionWithActivity(
        createMockWorktreeSession({ id: 'session-a', repositoryId: 'repo-a', repositoryName: 'repo-a' }),
        'idle'
      ),
    ];

    await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);

    const flagButton = await waitFor(() => {
      const el = screen.getByTestId('orchestrator-flag-session-a');
      expect(el.getAttribute('data-orchestrator-flag-lit')).toBe('true');
      return el;
    });
    fireEvent.click(flagButton);

    // No server-provided `error`/`message` field on a bare 500 -- falls back
    // to `handleApiError`'s fallback message + status text.
    await waitFor(() => {
      expect(screen.getByText(/Failed to clear Orchestrator designation/)).toBeTruthy();
    });
    expect(flagButton.hasAttribute('disabled')).toBe(false);
  });

  // Issue #1660: the flag moved from top-right (coupled to
  // `showCreatorUsername`'s right-28/right-2 toggle) to directly below the
  // activity indicator, left-aligned under it.
  it('positions the flag left-aligned under the indicator column, not top-right beside the creator badge', async () => {
    repositoriesResponse = { repositories: [repository({ id: 'repo-a', orchestratorSessionId: null })] };
    const sessions = [
      createSessionWithActivity(
        createMockWorktreeSession({ id: 'session-a', repositoryId: 'repo-a', repositoryName: 'repo-a' }),
        'idle'
      ),
    ];

    await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);

    const flagButton = await waitFor(() => screen.getByTestId('orchestrator-flag-session-a'));
    const classTokens = flagButton.className.split(/\s+/);
    expect(classTokens).toContain('left-3');
    // Token match, not substring: `right-28`/`right-2` must be fully gone,
    // not merely absent as a whole-string match.
    expect(classTokens).not.toContain('right-28');
    expect(classTokens).not.toContain('right-2');
    // Pin the composed vertical-offset token (0.75rem row p-3 + 0.375rem
    // column mt-1.5 + 1rem dot box h-4 + 0.25rem gap-1), full-token match so
    // a drift in any one term is caught, not just presence of `top-[calc(`.
    expect(classTokens).toContain('top-[calc(0.75rem_+_0.375rem_+_1rem_+_0.25rem)]');
  });

  it('reserves a spacer slot below the activity indicator for worktree sessions, but not for quick sessions', async () => {
    repositoriesResponse = { repositories: [repository({ id: 'repo-a', orchestratorSessionId: null })] };
    const sessions = [
      createSessionWithActivity(
        createMockWorktreeSession({ id: 'session-a', repositoryId: 'repo-a', repositoryName: 'repo-a' }),
        'idle'
      ),
      createSessionWithActivity(createMockQuickSession({ id: 'quick-1' }), 'idle'),
    ];

    await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);

    await waitFor(() => {
      expect(screen.getByTestId('orchestrator-flag-session-a')).toBeTruthy();
    });

    // Exactly one spacer: the worktree session's row reserves room for its
    // flag button; the quick session's row (no flag control) does not.
    expect(document.querySelectorAll('[data-orchestrator-flag-spacer]')).toHaveLength(1);
  });

  it('anchors the error tooltip to the left edge, not the right, now that the flag sits near the sidebar\'s left side', async () => {
    repositoriesResponse = { repositories: [repository({ id: 'repo-a', orchestratorSessionId: 'session-a' })] };
    globalThis.fetch = Object.assign(
      mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = input instanceof Request ? input.url : String(input);
        const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
        if (url.includes('/api/repositories') && method === 'GET') {
          return new Response(JSON.stringify(repositoriesResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.match(/\/api\/sessions\/([^/]+)\/orchestrator-designation$/) && method === 'DELETE') {
          return new Response(null, { status: 500 });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
      { preconnect: () => {} }
    ) as typeof fetch;

    const sessions = [
      createSessionWithActivity(
        createMockWorktreeSession({ id: 'session-a', repositoryId: 'repo-a', repositoryName: 'repo-a' }),
        'idle'
      ),
    ];

    await renderWithRouter(<ActiveSessionsSidebar {...defaultProps()} sessions={sessions} />);

    const flagButton = await waitFor(() => {
      const el = screen.getByTestId('orchestrator-flag-session-a');
      expect(el.getAttribute('data-orchestrator-flag-lit')).toBe('true');
      return el;
    });
    fireEvent.click(flagButton);

    const tooltip = await waitFor(() => screen.getByText(/Failed to clear Orchestrator designation/));
    const classTokens = tooltip.className.split(/\s+/);
    expect(classTokens).toContain('left-0');
    expect(classTokens).not.toContain('right-0');
  });

  // Collapsed sidebar takes SessionItem's separate early-return branch,
  // which never renders the flag control or its spacer (per #1657's
  // existing ruling, restated in #1660's PR body) -- pin that omission
  // explicitly rather than relying on it never having been tested.
  it('omits the flag control and its spacer entirely in collapsed mode, while still rendering the row icon', async () => {
    repositoriesResponse = { repositories: [repository({ id: 'repo-a', orchestratorSessionId: 'session-a' })] };
    const sessions = [
      createSessionWithActivity(
        createMockWorktreeSession({ id: 'session-a', repositoryId: 'repo-a', repositoryName: 'repo-a' }),
        'idle'
      ),
    ];

    const { queryClient } = await renderWithRouter(
      <ActiveSessionsSidebar {...defaultProps()} collapsed={true} sessions={sessions} />
    );

    // Wait for the ACTUAL repositories query to settle in this component's
    // own QueryClient -- not the `repositoriesResponse` fixture variable,
    // which is already true synchronously before any fetch or render
    // happens and so proves nothing about timing. This is the same async
    // work (queryFn -> QueryClient cache -> re-render) a regression
    // reintroducing the flag under `collapsed` would race against.
    await waitFor(() => {
      expect(queryClient.getQueryState(repositoryKeys.all())?.status).toBe('success');
    });

    expect(document.querySelectorAll('[data-orchestrator-flag]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-orchestrator-flag-spacer]')).toHaveLength(0);

    // Positive control: the collapsed row itself still rendered, via its
    // own simpler button (title includes the activity label), same pattern
    // as the "should show tooltip with activity state label when collapsed"
    // test above.
    const buttons = screen.getAllByRole('button');
    const collapsedRowButton = buttons.find((btn) => btn.getAttribute('title')?.includes('Idle'));
    expect(collapsedRowButton).toBeTruthy();
  });
});
