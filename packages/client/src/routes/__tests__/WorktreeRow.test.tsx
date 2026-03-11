import { describe, it, expect, mock, afterEach } from 'bun:test';
import { screen, cleanup } from '@testing-library/react';
import { renderWithRouter } from '../../test/renderWithRouter';
import { WorktreeDeletionTasksContext } from '../__root';
import type { UseWorktreeDeletionTasksReturn } from '../../hooks/useWorktreeDeletionTasks';
import type { Worktree, WorktreeSession, WorktreeDeletionTask, Session } from '@agent-console/shared';

// Mock hasVSCode - reads from a module-level cache set during app initialization,
// so module-level mocking is appropriate here (no business logic or fetch involved).
mock.module('../../lib/capabilities', () => ({
  hasVSCode: () => false,
}));

// Import WorktreeRow AFTER mock.module calls to ensure mocks are applied
import { WorktreeRow, type WorktreeRowProps, type SessionWithActivity } from '../index';

afterEach(cleanup);

// -- Test data factories --

function createTestWorktree(overrides?: Partial<Worktree>): Worktree {
  return {
    path: '/test/worktrees/feature-branch',
    branch: 'feature-branch',
    isMain: false,
    index: 1,
    repositoryId: 'repo-1',
    ...overrides,
  };
}

function createTestSession(overrides?: Partial<WorktreeSession>): SessionWithActivity {
  return {
    id: 'session-1',
    type: 'worktree' as const,
    repositoryId: 'repo-1',
    repositoryName: 'my-repo',
    worktreeId: 'feature-branch',
    isMainWorktree: false,
    locationPath: '/test/worktrees/feature-branch',
    status: 'active' as const,
    activationState: 'running' as const,
    createdAt: new Date().toISOString(),
    workers: [],
    ...overrides,
  };
}

function createPausedSession(overrides?: Partial<WorktreeSession>): Session {
  return {
    id: 'paused-session-1',
    type: 'worktree' as const,
    repositoryId: 'repo-1',
    repositoryName: 'my-repo',
    worktreeId: 'feature-branch',
    isMainWorktree: false,
    locationPath: '/test/worktrees/feature-branch',
    status: 'inactive' as const,
    activationState: 'hibernated' as const,
    createdAt: new Date().toISOString(),
    workers: [],
    pausedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockDeletionContext(
  overrides?: Partial<UseWorktreeDeletionTasksReturn>
): UseWorktreeDeletionTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => {}),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    markAsFailed: mock(() => {}),
    handleWorktreeDeletionCompleted: mock(() => {}),
    handleWorktreeDeletionFailed: mock(() => {}),
    ...overrides,
  };
}

// -- Render helper --

async function renderWorktreeRow(
  props: Partial<WorktreeRowProps> = {},
  deletionContext?: UseWorktreeDeletionTasksReturn
) {
  const defaultProps: WorktreeRowProps = {
    worktree: createTestWorktree(),
    repositoryId: 'repo-1',
    isPulling: false,
    onPull: mock(() => {}),
    ...props,
  };

  const ctx = deletionContext ?? createMockDeletionContext();

  return renderWithRouter(
    <WorktreeDeletionTasksContext.Provider value={ctx}>
      <WorktreeRow {...defaultProps} />
    </WorktreeDeletionTasksContext.Provider>
  );
}

// -- Tests --

describe('WorktreeRow', () => {
  describe('session action buttons', () => {
    it('shows "Open" link when active session exists', async () => {
      await renderWorktreeRow({ session: createTestSession() });

      expect(screen.getByText('Open')).not.toBeNull();
      expect(screen.queryByText('Resume')).toBeNull();
      expect(screen.queryByText('Restore')).toBeNull();
    });

    it('shows "Resume" button when paused session exists', async () => {
      await renderWorktreeRow({ pausedSession: createPausedSession() });

      expect(screen.getByText('Resume')).not.toBeNull();
      expect(screen.queryByText('Open')).toBeNull();
      expect(screen.queryByText('Restore')).toBeNull();
    });

    it('shows "Restore" button when no session exists', async () => {
      await renderWorktreeRow();

      expect(screen.getByText('Restore')).not.toBeNull();
      expect(screen.queryByText('Open')).toBeNull();
      expect(screen.queryByText('Resume')).toBeNull();
    });
  });

  describe('Pull button', () => {
    it('is always shown regardless of session state', async () => {
      // With active session
      const { unmount: u1 } = await renderWorktreeRow({ session: createTestSession() });
      expect(screen.getByText('Pull')).not.toBeNull();
      u1();

      // With paused session
      const { unmount: u2 } = await renderWorktreeRow({ pausedSession: createPausedSession() });
      expect(screen.getByText('Pull')).not.toBeNull();
      u2();

      // With no session
      await renderWorktreeRow();
      expect(screen.getByText('Pull')).not.toBeNull();
    });

    it('shows "Pulling..." when isPulling is true', async () => {
      await renderWorktreeRow({ isPulling: true });

      expect(screen.getByText('Pulling...')).not.toBeNull();
      expect(screen.queryByText('Pull')).toBeNull();
    });
  });

  describe('Delete button', () => {
    it('is shown for non-main worktrees', async () => {
      await renderWorktreeRow({ worktree: createTestWorktree({ isMain: false }) });

      expect(screen.getByText('Delete')).not.toBeNull();
    });

    it('is hidden for main worktree', async () => {
      await renderWorktreeRow({ worktree: createTestWorktree({ isMain: true }) });

      expect(screen.queryByText('Delete')).toBeNull();
    });

    it('shows "Deleting..." when deletion is in progress', async () => {
      const worktree = createTestWorktree();
      const deletionTask: WorktreeDeletionTask = {
        id: 'task-1',
        sessionId: 'session-1',
        sessionTitle: 'feature-branch',
        repositoryId: 'repo-1',
        worktreePath: worktree.path,
        status: 'deleting',
        createdAt: new Date().toISOString(),
      };
      const ctx = createMockDeletionContext({ tasks: [deletionTask] });

      await renderWorktreeRow({ worktree }, ctx);

      expect(screen.getByText('Deleting...')).not.toBeNull();
      expect(screen.queryByText('Delete')).toBeNull();
    });
  });

  describe('status dot', () => {
    it('is green for active session', async () => {
      const { container } = await renderWorktreeRow({ session: createTestSession() });

      expect(container.querySelector('.bg-green-500')).not.toBeNull();
      expect(container.querySelector('.bg-yellow-500')).toBeNull();
      expect(container.querySelector('.bg-gray-600')).toBeNull();
    });

    it('is yellow for paused session', async () => {
      const { container } = await renderWorktreeRow({ pausedSession: createPausedSession() });

      expect(container.querySelector('.bg-yellow-500')).not.toBeNull();
      expect(container.querySelector('.bg-green-500')).toBeNull();
      expect(container.querySelector('.bg-gray-600')).toBeNull();
    });

    it('is gray for no session', async () => {
      const { container } = await renderWorktreeRow();

      expect(container.querySelector('.bg-gray-600')).not.toBeNull();
      expect(container.querySelector('.bg-green-500')).toBeNull();
      expect(container.querySelector('.bg-yellow-500')).toBeNull();
    });
  });

  describe('worktree info display', () => {
    it('displays branch name', async () => {
      await renderWorktreeRow({ worktree: createTestWorktree({ branch: 'my-feature' }) });

      expect(screen.getByText('my-feature')).not.toBeNull();
    });

    it('shows "(primary)" label for main worktree', async () => {
      await renderWorktreeRow({ worktree: createTestWorktree({ isMain: true }) });

      expect(screen.getByText('(primary)')).not.toBeNull();
    });

    it('does not show "(primary)" label for non-main worktree', async () => {
      await renderWorktreeRow({ worktree: createTestWorktree({ isMain: false }) });

      expect(screen.queryByText('(primary)')).toBeNull();
    });
  });
});
