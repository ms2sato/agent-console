import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { ActiveSessionsSidebar } from '../ActiveSessionsSidebar';
import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
} from '../../../hooks/useSidebarState';
import type { SessionWithActivity } from '../../../hooks/useActiveSessionsWithActivity';
import type { AgentActivityState, WorktreeSession, QuickSession } from '@agent-console/shared';

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
    locationPath: '/path/to/worktree',
    title: 'test-branch',
    status: 'active' as const,
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

      const sidebar = screen.getByRole('complementary');
      expect(sidebar.style.width).toBe(`${SIDEBAR_COLLAPSED_WIDTH}px`);
    });

    it('should use provided width when expanded', async () => {
      const customWidth = 280;
      await renderWithRouter(
        <ActiveSessionsSidebar {...defaultProps()} width={customWidth} />
      );

      const sidebar = screen.getByRole('complementary');
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
  });
});
