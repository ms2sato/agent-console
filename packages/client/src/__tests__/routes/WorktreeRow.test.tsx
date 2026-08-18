import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { screen, within, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../../test/renderWithRouter';
import { WorktreeDeletionTasksContext, SessionStopTasksContext } from '../../contexts/root-contexts';
import { setCapabilities } from '../../lib/capabilities';
import { WorktreeRow, type WorktreeRowProps, type SessionWithActivity } from '../../routes/index';
import type { UseWorktreeDeletionTasksReturn } from '../../hooks/useWorktreeDeletionTasks';
import type { UseSessionStopTasksReturn } from '../../hooks/useSessionStopTasks';
import type { Worktree, WorktreeSession, WorktreeDeletionTask, Session } from '@agent-console/shared';

// lib/capabilities reads from a module-level cache populated at app boot via the
// real setCapabilities() setter. Using the setter instead of `mock.module` avoids
// process-global poisoning of other test files that real-import lib/capabilities
// in the same process (testing.md Anti-Pattern #2; e.g. routes/__tests__/index.test.tsx
// spies on the real module's hasVSCode export).
beforeEach(() => {
  setCapabilities({ vscode: false, vscodeOpenMode: 'local-spawn', vscodeRemoteHost: null });
});

afterEach(cleanup);

// deleteWorktreeAsync uses manual fetch (wildcard route), mocked at the
// network boundary per testing.md.
const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));

beforeEach(() => {
  globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;
  mockFetch.mockReset();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, options: { status?: number; ok?: boolean } = {}) {
  const { status = 200, ok = true } = options;
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

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
    isShared: false,
    recoveryState: 'healthy',
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
    isShared: false,
    recoveryState: 'healthy',
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

// WorktreeRow always calls useSessionStopTasksContext() (Issue #1247), so every
// render needs a Provider ancestor even when the test doesn't exercise a
// stop/pause task.
function createMockSessionStopTasks(
  overrides?: Partial<UseSessionStopTasksReturn>
): UseSessionStopTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => true),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    markAsFailed: mock(() => {}),
    ...overrides,
  };
}

// -- Render helper --

async function renderWorktreeRow(
  props: Partial<WorktreeRowProps> = {},
  deletionContext?: UseWorktreeDeletionTasksReturn,
  sessionStopTasks?: UseSessionStopTasksReturn
) {
  const defaultProps: WorktreeRowProps = {
    worktree: createTestWorktree(),
    repositoryId: 'repo-1',
    isPulling: false,
    onPull: mock(() => {}),
    ...props,
  };

  const ctx = deletionContext ?? createMockDeletionContext();
  const stopTasksCtx = sessionStopTasks ?? createMockSessionStopTasks();

  return renderWithRouter(
    <WorktreeDeletionTasksContext.Provider value={ctx}>
      <SessionStopTasksContext.Provider value={stopTasksCtx}>
        <WorktreeRow {...defaultProps} />
      </SessionStopTasksContext.Provider>
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

    it('addTask is keyed off the server-generated jobId, not a client-generated id (new-mechanism contract)', async () => {
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(jsonResponse({ accepted: true, jobId: 'server-job-123' }));
      const worktree = createTestWorktree();
      const session = createTestSession();
      const ctx = createMockDeletionContext();

      await renderWorktreeRow({ worktree, session }, ctx);

      await user.click(screen.getByText('Delete'));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(ctx.addTask).toHaveBeenCalledTimes(1);
      });
      expect(ctx.addTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'server-job-123', worktreePath: worktree.path })
      );
    });

    it('does not add a task and surfaces an error dialog when the API call fails immediately (invariant-preservation: no task exists to attach the failure to)', async () => {
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(
        jsonResponse({ error: 'Deletion already in progress' }, { ok: false, status: 409 })
      );
      const worktree = createTestWorktree();
      const ctx = createMockDeletionContext();

      await renderWorktreeRow({ worktree }, ctx);

      await user.click(screen.getByText('Delete'));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(screen.getByText('Deletion already in progress')).toBeTruthy();
      });
      expect(ctx.addTask).not.toHaveBeenCalled();
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
