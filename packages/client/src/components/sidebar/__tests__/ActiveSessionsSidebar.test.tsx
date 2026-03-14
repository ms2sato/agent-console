import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { ActiveSessionsSidebar } from '../ActiveSessionsSidebar';
import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
} from '../../../hooks/useSidebarState';
import type { SessionWithActivity } from '../../../hooks/useActiveSessionsWithActivity';
import type { AgentActivityState, WorktreeSession, QuickSession, Session } from '@agent-console/shared';

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
  });

  afterEach(() => {
    cleanup();
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
  });
});
