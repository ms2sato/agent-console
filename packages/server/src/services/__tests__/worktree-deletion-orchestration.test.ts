import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { HookCommandResult, Worktree } from '@agent-console/shared';
import type { SessionManager } from '../session-manager.js';

// --- Mock worktreeService ---

const mockListWorktrees = mock<(repoPath: string, repoId: string) => Promise<Worktree[]>>(() =>
  Promise.resolve([]),
);
const mockRemoveWorktree = mock<
  (repoPath: string, path: string, force: boolean) => Promise<{ success: boolean; error?: string }>
>(() => Promise.resolve({ success: true }));
const mockExecuteHookCommand = mock<
  (cmd: string, cwd: string, vars: Record<string, unknown>) => Promise<HookCommandResult>
>(() => Promise.resolve({ success: true }));

mock.module('../worktree-service.js', () => ({
  worktreeService: {
    listWorktrees: mockListWorktrees,
    removeWorktree: mockRemoveWorktree,
    executeHookCommand: mockExecuteHookCommand,
  },
}));

// --- Mock logger ---
mock.module('../../lib/logger.js', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Note: The Bun shell ($) tagged template literal cannot be reliably mocked
// via mock.module('bun', ...). The gitStatus capture path runs a real `git -C`
// command which will fail in test environments (directories don't exist),
// exercising the catch branch that leaves gitStatus undefined.

// Import after mocks are set up
const {
  orchestrateWorktreeDeletion,
  _getDeletionsInProgress,
} = await import('../worktree-deletion-service.js');

// --- Helper to create mock SessionManager ---

function createMockSessionManager(): SessionManager & {
  killSessionWorkers: ReturnType<typeof mock>;
  deleteSession: ReturnType<typeof mock>;
} {
  return {
    killSessionWorkers: mock(() => {}),
    deleteSession: mock(() => Promise.resolve(true)),
  } as unknown as SessionManager & {
    killSessionWorkers: ReturnType<typeof mock>;
    deleteSession: ReturnType<typeof mock>;
  };
}

const DEFAULT_PARAMS = {
  repoPath: '/repos/my-repo',
  repoId: 'repo-1',
  repoName: 'my-repo',
  worktreePath: '/repos/my-repo/worktrees/wt-1',
  force: false,
};

describe('orchestrateWorktreeDeletion', () => {
  beforeEach(() => {
    // Clear concurrency guard
    _getDeletionsInProgress().clear();

    // Reset all mocks
    mockListWorktrees.mockReset();
    mockRemoveWorktree.mockReset();
    mockExecuteHookCommand.mockReset();

    // Default mock implementations
    mockRemoveWorktree.mockImplementation(() => Promise.resolve({ success: true }));
    mockExecuteHookCommand.mockImplementation(() => Promise.resolve({ success: true, output: 'ok' }));
    mockListWorktrees.mockImplementation(() =>
      Promise.resolve([
        {
          path: '/repos/my-repo/worktrees/wt-1',
          branch: 'feature-1',
          isMain: false,
          repositoryId: 'repo-1',
          index: 1,
        },
      ]),
    );

  });

  it('happy path: runs cleanup, kills workers, removes worktree, deletes session', async () => {
    const sm = createMockSessionManager();
    const result = await orchestrateWorktreeDeletion(
      { ...DEFAULT_PARAMS, cleanupCommand: 'echo cleanup', sessionId: 'sess-1' },
      sm,
    );

    expect(result.success).toBe(true);
    expect(result.cleanupCommandResult).toEqual({ success: true, output: 'ok' });
    expect(mockExecuteHookCommand).toHaveBeenCalledTimes(1);
    expect(sm.killSessionWorkers).toHaveBeenCalledWith('sess-1');
    expect(mockRemoveWorktree).toHaveBeenCalledTimes(1);
    expect(sm.deleteSession).toHaveBeenCalledWith('sess-1');
  });

  it('happy path without session: skips kill and delete', async () => {
    const sm = createMockSessionManager();
    const result = await orchestrateWorktreeDeletion(
      { ...DEFAULT_PARAMS, cleanupCommand: 'echo cleanup' },
      sm,
    );

    expect(result.success).toBe(true);
    expect(sm.killSessionWorkers).not.toHaveBeenCalled();
    expect(sm.deleteSession).not.toHaveBeenCalled();
  });

  it('happy path without cleanup command: skips cleanup execution', async () => {
    const sm = createMockSessionManager();
    const result = await orchestrateWorktreeDeletion(
      { ...DEFAULT_PARAMS, sessionId: 'sess-1' },
      sm,
    );

    expect(result.success).toBe(true);
    expect(result.cleanupCommandResult).toBeUndefined();
    expect(mockExecuteHookCommand).not.toHaveBeenCalled();
  });

  it('returns failure when deletion is already in progress', async () => {
    _getDeletionsInProgress().add(DEFAULT_PARAMS.worktreePath);

    const sm = createMockSessionManager();
    const result = await orchestrateWorktreeDeletion(
      { ...DEFAULT_PARAMS, sessionId: 'sess-1' },
      sm,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Deletion already in progress');
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('clears concurrency guard after successful deletion', async () => {
    const sm = createMockSessionManager();
    await orchestrateWorktreeDeletion(
      { ...DEFAULT_PARAMS, sessionId: 'sess-1' },
      sm,
    );

    expect(_getDeletionsInProgress().has(DEFAULT_PARAMS.worktreePath)).toBe(false);
  });

  it('clears concurrency guard after worktree removal failure', async () => {
    mockRemoveWorktree.mockImplementation(() =>
      Promise.resolve({ success: false, error: 'dirty worktree' }),
    );

    const sm = createMockSessionManager();
    await orchestrateWorktreeDeletion(
      { ...DEFAULT_PARAMS, sessionId: 'sess-1' },
      sm,
    );

    expect(_getDeletionsInProgress().has(DEFAULT_PARAMS.worktreePath)).toBe(false);
  });

  it('returns failure and does not delete session when worktree removal fails', async () => {
    mockRemoveWorktree.mockImplementation(() =>
      Promise.resolve({ success: false, error: 'dirty worktree' }),
    );

    const sm = createMockSessionManager();
    const result = await orchestrateWorktreeDeletion(
      { ...DEFAULT_PARAMS, sessionId: 'sess-1' },
      sm,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('dirty worktree');
    // In test, git status capture fails (nonexistent dir) so gitStatus is undefined.
    // This exercises the catch branch that gracefully omits gitStatus.
    expect(result.gitStatus).toBeUndefined();
    // Session should NOT be deleted on failure — preserved for retry
    expect(sm.deleteSession).not.toHaveBeenCalled();
  });

  it('returns default error message when removeWorktree error is empty', async () => {
    mockRemoveWorktree.mockImplementation(() =>
      Promise.resolve({ success: false, error: '' }),
    );

    const sm = createMockSessionManager();
    const result = await orchestrateWorktreeDeletion(
      { ...DEFAULT_PARAMS, sessionId: 'sess-1' },
      sm,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to remove worktree');
  });

  it('returns success even when deleteSession throws', async () => {
    const sm = createMockSessionManager();
    sm.deleteSession.mockImplementation(() => Promise.reject(new Error('DB error')));

    const result = await orchestrateWorktreeDeletion(
      { ...DEFAULT_PARAMS, sessionId: 'sess-1' },
      sm,
    );

    // Worktree was removed successfully, so overall result is success
    expect(result.success).toBe(true);
    expect(sm.deleteSession).toHaveBeenCalledWith('sess-1');
  });
});
