import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { Session } from '@agent-console/shared';
import type { DeleteWorktreeDeps } from '../services/worktree-deletion-service.js';
import { deleteWorktree, _getDeletionsInProgress } from '../services/worktree-deletion-service.js';
// ---------- Test helpers ----------

// Control getRepositoriesDir() via AGENT_CONSOLE_HOME env var.
// With AGENT_CONSOLE_HOME=/test-home, getRepositoriesDir() returns /test-home/repositories.
const TEST_AGENT_CONSOLE_HOME = '/test-home';
const TEST_REPO_ID = 'repo-1';
const TEST_REPO_PATH = '/test-home/repositories/test-repo';
const TEST_WORKTREE_PATH = '/test-home/repositories/test-repo/worktrees/wt-1';

// --- Mock worktreeService (passed via DeleteWorktreeDeps) ---
const mockIsWorktreeOf = mock(() => Promise.resolve(true));
const mockRemoveWorktree = mock(() => Promise.resolve({ success: true }));
const mockListWorktrees = mock(() => Promise.resolve([]));
const mockExecuteHookCommand = mock(() => Promise.resolve({ success: true }));

const mockWorktreeService = {
  isWorktreeOf: mockIsWorktreeOf,
  removeWorktree: mockRemoveWorktree,
  listWorktrees: mockListWorktrees,
  executeHookCommand: mockExecuteHookCommand,
};

function createMockSession(id: string, locationPath: string): Session {
  return {
    id,
    locationPath,
    type: 'worktree',
    isMainWorktree: false,
  } as Session;
}

function createMockDeps(overrides?: {
  sessions?: Session[];
  killSessionWorkers?: (sid: string) => Promise<void>;
  deleteSession?: (sid: string) => Promise<boolean>;
  repoExists?: boolean;
  cleanupCommand?: string | null;
}): DeleteWorktreeDeps {
  const sessions = overrides?.sessions ?? [
    createMockSession('session-1', TEST_WORKTREE_PATH),
    createMockSession('session-2', TEST_WORKTREE_PATH),
  ];
  const killFn = overrides?.killSessionWorkers ?? (() => Promise.resolve());
  const deleteFn = overrides?.deleteSession ?? (() => Promise.resolve(true));

  return {
    worktreeService: mockWorktreeService,
    sessionManager: {
      getAllSessions: () => sessions,
      killSessionWorkers: mock(killFn),
      deleteSession: mock(deleteFn),
    } as unknown as DeleteWorktreeDeps['sessionManager'],
    repositoryManager: {
      getRepository: (_id: string) =>
        overrides?.repoExists === false
          ? undefined
          : {
              name: 'test-repo',
              path: TEST_REPO_PATH,
              cleanupCommand: overrides?.cleanupCommand ?? null,
            },
    },
    findOpenPullRequest: mock(() => Promise.resolve(null)),
    getCurrentBranch: mock(() => Promise.resolve('feature-branch')),
  };
}

// ---------- Tests ----------

describe('deleteWorktree — kill phase error handling', () => {
  let originalAgentConsoleHome: string | undefined;

  beforeEach(() => {
    originalAgentConsoleHome = process.env.AGENT_CONSOLE_HOME;
    process.env.AGENT_CONSOLE_HOME = TEST_AGENT_CONSOLE_HOME;

    _getDeletionsInProgress().clear();

    mockIsWorktreeOf.mockReset();
    mockRemoveWorktree.mockReset();
    mockListWorktrees.mockReset();
    mockExecuteHookCommand.mockReset();

    mockIsWorktreeOf.mockImplementation(() => Promise.resolve(true));
    mockRemoveWorktree.mockImplementation(() => Promise.resolve({ success: true }));
    mockListWorktrees.mockImplementation(() => Promise.resolve([]));
    mockExecuteHookCommand.mockImplementation(() => Promise.resolve({ success: true }));
  });

  afterEach(() => {
    if (originalAgentConsoleHome === undefined) {
      delete process.env.AGENT_CONSOLE_HOME;
    } else {
      process.env.AGENT_CONSOLE_HOME = originalAgentConsoleHome;
    }
  });

  it('should proceed with worktree deletion when killSessionWorkers fails for some sessions', async () => {
    const deps = createMockDeps({
      killSessionWorkers: (sid: string) => {
        if (sid === 'session-1') {
          return Promise.reject(new Error('PTY process not found'));
        }
        return Promise.resolve();
      },
    });

    const result = await deleteWorktree(
      { repoId: TEST_REPO_ID, worktreePath: TEST_WORKTREE_PATH, force: true },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.killErrors).toEqual([
      { sessionId: 'session-1', error: 'PTY process not found' },
    ]);
    expect(mockRemoveWorktree).toHaveBeenCalledTimes(1);
  });

  it('should proceed with worktree deletion when killSessionWorkers fails for all sessions', async () => {
    const deps = createMockDeps({
      killSessionWorkers: (_sid: string) => {
        return Promise.reject(new Error('kill failed'));
      },
    });

    const result = await deleteWorktree(
      { repoId: TEST_REPO_ID, worktreePath: TEST_WORKTREE_PATH, force: true },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.killErrors).toHaveLength(2);
    expect(result.killErrors![0].sessionId).toBe('session-1');
    expect(result.killErrors![1].sessionId).toBe('session-2');
    expect(mockRemoveWorktree).toHaveBeenCalledTimes(1);
  });

  it('should not include killErrors when all kills succeed', async () => {
    const deps = createMockDeps({
      killSessionWorkers: () => Promise.resolve(),
    });

    const result = await deleteWorktree(
      { repoId: TEST_REPO_ID, worktreePath: TEST_WORKTREE_PATH, force: true },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.killErrors).toBeUndefined();
  });

  it('should still report worktree removal failure even when kills succeed', async () => {
    mockRemoveWorktree.mockImplementation(() => Promise.resolve({ success: false, error: 'dirty tree' }));

    const deps = createMockDeps({
      killSessionWorkers: () => Promise.resolve(),
    });

    const result = await deleteWorktree(
      { repoId: TEST_REPO_ID, worktreePath: TEST_WORKTREE_PATH, force: true },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('dirty tree');
    expect(deps.sessionManager.deleteSession).not.toHaveBeenCalled();
  });
});
