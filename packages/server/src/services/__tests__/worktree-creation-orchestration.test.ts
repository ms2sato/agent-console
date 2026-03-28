import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { HookCommandResult, Worktree, Session } from '@agent-console/shared';
import type { SessionManager } from '../session-manager.js';

// --- Mock worktreeService ---

const mockListWorktrees = mock<(repoPath: string, repoId: string) => Promise<Worktree[]>>(() =>
  Promise.resolve([]),
);
const mockCreateWorktree = mock<
  (repoPath: string, branch: string, repoId: string, baseBranch?: string) => Promise<{ worktreePath: string; error?: string }>
>(() => Promise.resolve({ worktreePath: '/repos/my-repo/worktrees/wt-new' }));
const mockRemoveWorktree = mock<
  (repoPath: string, path: string, force: boolean) => Promise<{ success: boolean; error?: string }>
>(() => Promise.resolve({ success: true }));
const mockExecuteHookCommand = mock<
  (cmd: string, cwd: string, vars: Record<string, unknown>) => Promise<HookCommandResult>
>(() => Promise.resolve({ success: true }));

mock.module('../worktree-service.js', () => ({
  worktreeService: {
    listWorktrees: mockListWorktrees,
    createWorktree: mockCreateWorktree,
    removeWorktree: mockRemoveWorktree,
    executeHookCommand: mockExecuteHookCommand,
  },
}));

// --- Mock fetchRemote ---

const mockFetchRemote = mock<(branch: string, cwd: string) => Promise<void>>(() =>
  Promise.resolve(),
);

mock.module('../../lib/git.js', () => ({
  fetchRemote: mockFetchRemote,
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

// Import after mocks
const { createWorktreeWithSession } = await import('../worktree-creation-service.js');

// --- Helpers ---

const CREATED_PATH = '/repos/my-repo/worktrees/wt-new';

const WORKTREE: Worktree = {
  path: CREATED_PATH,
  branch: 'feature-new',
  isMain: false,
  repositoryId: 'repo-1',
  index: 2,
};

const MOCK_SESSION: Session = {
  id: 'sess-new',
  type: 'worktree',
  repositoryId: 'repo-1',
  repositoryName: 'my-repo',
  worktreeId: 'feature-new',
  isMainWorktree: false,
  locationPath: CREATED_PATH,
  status: 'active',
  activationState: 'running',
  workers: [],
  agentId: 'claude',
  createdAt: '2026-01-01T00:00:00Z',
} as Session;

function createMockSessionManager(): SessionManager & {
  createSession: ReturnType<typeof mock>;
} {
  return {
    createSession: mock(() => Promise.resolve(MOCK_SESSION)),
  } as unknown as SessionManager & {
    createSession: ReturnType<typeof mock>;
  };
}

const DEFAULT_PARAMS = {
  repoPath: '/repos/my-repo',
  repoId: 'repo-1',
  repoName: 'my-repo',
  branch: 'feature-new',
  baseBranch: 'main',
  useRemote: true,
  agentId: 'claude',
};

describe('createWorktreeWithSession', () => {
  beforeEach(() => {
    mockListWorktrees.mockReset();
    mockCreateWorktree.mockReset();
    mockRemoveWorktree.mockReset();
    mockExecuteHookCommand.mockReset();
    mockFetchRemote.mockReset();

    // Default implementations
    mockFetchRemote.mockImplementation(() => Promise.resolve());
    mockCreateWorktree.mockImplementation(() =>
      Promise.resolve({ worktreePath: CREATED_PATH, index: 2 }),
    );
    mockListWorktrees.mockImplementation(() => Promise.resolve([WORKTREE]));
    mockRemoveWorktree.mockImplementation(() => Promise.resolve({ success: true }));
    mockExecuteHookCommand.mockImplementation(() =>
      Promise.resolve({ success: true, output: 'setup done' }),
    );
  });

  it('happy path: fetch, create worktree, setup command, create session', async () => {
    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(
      { ...DEFAULT_PARAMS, setupCommand: 'npm install' },
      sm,
    );

    expect(result.success).toBe(true);
    expect(result.worktree).toEqual(WORKTREE);
    expect(result.session).toEqual(MOCK_SESSION);
    expect(result.setupCommandResult).toEqual({ success: true, output: 'setup done' });

    // Verify fetch was called with remote branch
    expect(mockFetchRemote).toHaveBeenCalledWith('main', '/repos/my-repo');
    // Verify createWorktree used origin/ prefix
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      '/repos/my-repo', 'feature-new', 'repo-1', 'origin/main',
    );
    expect(sm.createSession).toHaveBeenCalledTimes(1);
  });

  it('skips fetch when useRemote is false', async () => {
    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(
      { ...DEFAULT_PARAMS, useRemote: false },
      sm,
    );

    expect(result.success).toBe(true);
    expect(mockFetchRemote).not.toHaveBeenCalled();
    // baseBranch is passed as-is (no origin/ prefix)
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      '/repos/my-repo', 'feature-new', 'repo-1', 'main',
    );
  });

  it('skips setup command when not configured', async () => {
    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm);

    expect(result.success).toBe(true);
    expect(result.setupCommandResult).toBeUndefined();
    expect(mockExecuteHookCommand).not.toHaveBeenCalled();
  });

  it('falls back to local branch when fetch fails', async () => {
    mockFetchRemote.mockImplementation(() => Promise.reject(new Error('network error')));

    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm);

    expect(result.success).toBe(true);
    expect(result.fetchFailed).toBe(true);
    expect(result.fetchError).toBe('Failed to fetch remote branch, created from local branch instead');
    // baseBranch should remain local (no origin/ prefix)
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      '/repos/my-repo', 'feature-new', 'repo-1', 'main',
    );
  });

  it('returns failure when createWorktree returns error', async () => {
    mockCreateWorktree.mockImplementation(() =>
      Promise.resolve({ worktreePath: '', error: 'branch already exists' }),
    );

    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm);

    expect(result.success).toBe(false);
    expect(result.error).toBe('branch already exists');
    expect(sm.createSession).not.toHaveBeenCalled();
  });

  it('rolls back worktree and returns failure when worktree not found after creation', async () => {
    // listWorktrees returns empty — the created worktree is not found
    mockListWorktrees.mockImplementation(() => Promise.resolve([]));

    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Worktree was created but could not be found in the list');

    // Rollback should have been called
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/repos/my-repo', CREATED_PATH, true);
  });

  it('rolls back worktree and returns failure when session creation fails', async () => {
    const sm = createMockSessionManager();
    sm.createSession.mockImplementation(() => Promise.reject(new Error('DB connection lost')));

    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm);

    expect(result.success).toBe(false);
    expect(result.error).toBe('DB connection lost');

    // Rollback should have been called
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/repos/my-repo', CREATED_PATH, true);
  });

  it('skips session creation when autoStartSession is false', async () => {
    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(
      { ...DEFAULT_PARAMS, autoStartSession: false },
      sm,
    );

    expect(result.success).toBe(true);
    expect(result.worktree).toEqual(WORKTREE);
    expect(result.session).toBeUndefined();
    expect(sm.createSession).not.toHaveBeenCalled();
  });

  it('returns original error even when rollback fails', async () => {
    const sm = createMockSessionManager();
    sm.createSession.mockImplementation(() => Promise.reject(new Error('original error')));
    mockRemoveWorktree.mockImplementation(() => Promise.reject(new Error('rollback failed')));

    // The original error should be returned, not the rollback error
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm);

    expect(result.success).toBe(false);
    expect(result.error).toBe('original error');
  });
});
