import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { HookCommandResult, Worktree } from '@agent-console/shared';
import type { SessionManager } from '../session-manager.js';
import { buildWorktreeSession } from '../../__tests__/utils/build-test-data.js';
import { mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
// --- Mock worktreeService (now passed as parameter, no mock.module needed) ---

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

const mockWorktreeService = {
  listWorktrees: mockListWorktrees,
  createWorktree: mockCreateWorktree,
  removeWorktree: mockRemoveWorktree,
  executeHookCommand: mockExecuteHookCommand,
};

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

const MOCK_SESSION = buildWorktreeSession({
  id: 'sess-new',
  repositoryName: 'my-repo',
  worktreeId: 'feature-new',
  locationPath: CREATED_PATH,
  createdAt: '2026-01-01T00:00:00Z',
});

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
    resetGitMocks();
    mockListWorktrees.mockReset();
    mockCreateWorktree.mockReset();
    mockRemoveWorktree.mockReset();
    mockExecuteHookCommand.mockReset();

    // Default implementations
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
      mockWorktreeService,
    );

    expect(result.success).toBe(true);
    expect(result.worktree).toEqual(WORKTREE);
    expect(result.session).toEqual(MOCK_SESSION);
    expect(result.setupCommandResult).toEqual({ success: true, output: 'setup done' });

    // Verify fetch was called with remote branch
    expect(mockGit.fetchRemote).toHaveBeenCalledWith('main', '/repos/my-repo');
    // Verify createWorktree used origin/ prefix. `requestUsername` is
    // forwarded from `CreateWorktreeParams` -- undefined here because
    // DEFAULT_PARAMS does not set it (single-user defaults).
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      '/repos/my-repo', 'feature-new', 'repo-1', 'origin/main', undefined,
    );
    expect(sm.createSession).toHaveBeenCalledTimes(1);
  });

  it('skips fetch when useRemote is false', async () => {
    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(
      { ...DEFAULT_PARAMS, useRemote: false },
      sm,
      mockWorktreeService,
    );

    expect(result.success).toBe(true);
    expect(mockGit.fetchRemote).not.toHaveBeenCalled();
    // baseBranch is passed as-is (no origin/ prefix)
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      '/repos/my-repo', 'feature-new', 'repo-1', 'main', undefined,
    );
  });

  it('skips setup command when not configured', async () => {
    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm, mockWorktreeService);

    expect(result.success).toBe(true);
    expect(result.setupCommandResult).toBeUndefined();
    expect(mockExecuteHookCommand).not.toHaveBeenCalled();
  });

  it('falls back to local branch when fetch fails', async () => {
    mockGit.fetchRemote.mockImplementation(() => Promise.reject(new Error('network error')));

    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm, mockWorktreeService);

    expect(result.success).toBe(true);
    expect(result.fetchFailed).toBe(true);
    expect(result.fetchError).toBe('Failed to fetch remote branch, created from local branch instead');
    // baseBranch should remain local (no origin/ prefix)
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      '/repos/my-repo', 'feature-new', 'repo-1', 'main', undefined,
    );
  });

  it('returns failure when createWorktree returns error', async () => {
    mockCreateWorktree.mockImplementation(() =>
      Promise.resolve({ worktreePath: '', error: 'branch already exists' }),
    );

    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm, mockWorktreeService);

    expect(result.success).toBe(false);
    expect(result.error).toBe('branch already exists');
    expect(sm.createSession).not.toHaveBeenCalled();
  });

  it('rolls back worktree and returns failure when worktree not found after creation', async () => {
    // listWorktrees returns empty — the created worktree is not found
    mockListWorktrees.mockImplementation(() => Promise.resolve([]));

    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm, mockWorktreeService);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Worktree was created but could not be found in the list');

    // Rollback should have been called
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/repos/my-repo', CREATED_PATH, true);
  });

  it('rolls back worktree and returns failure when session creation fails', async () => {
    const sm = createMockSessionManager();
    sm.createSession.mockImplementation(() => Promise.reject(new Error('DB connection lost')));

    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm, mockWorktreeService);

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
      mockWorktreeService,
    );

    expect(result.success).toBe(true);
    expect(result.worktree).toEqual(WORKTREE);
    expect(result.session).toBeUndefined();
    expect(sm.createSession).not.toHaveBeenCalled();
  });

  it('passes context object (createdBy, parentSessionId, parentWorkerId, templateVars) to createSession', async () => {
    const sm = createMockSessionManager();
    const context = {
      createdBy: 'user-123',
      parentSessionId: 'parent-sess-1',
      parentWorkerId: 'parent-wkr-1',
      templateVars: { model: 'opus' },
    };

    await createWorktreeWithSession(
      { ...DEFAULT_PARAMS, initialPrompt: 'do stuff', title: 'My Task', context },
      sm,
      mockWorktreeService,
    );

    expect(sm.createSession).toHaveBeenCalledTimes(1);
    const [sessionRequest, passedContext] = sm.createSession.mock.calls[0];
    // Context fields are mapped to the request for schema compatibility
    expect(sessionRequest.parentSessionId).toBe('parent-sess-1');
    expect(sessionRequest.parentWorkerId).toBe('parent-wkr-1');
    expect(sessionRequest.templateVars).toEqual({ model: 'opus' });
    // createdBy is passed via the context parameter
    expect(passedContext).toEqual(context);
  });

  it('threads requestUsername to WorktreeService.createWorktree (Issue #838)', async () => {
    const sm = createMockSessionManager();
    await createWorktreeWithSession(
      { ...DEFAULT_PARAMS, requestUsername: 'alice' },
      sm,
      mockWorktreeService,
    );

    // The username arrives at WorktreeService as the 5th positional arg so
    // multi-user installs create the worktree as the requesting user.
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      '/repos/my-repo', 'feature-new', 'repo-1', 'origin/main', 'alice',
    );
  });

  it('returns original error even when rollback fails', async () => {
    const sm = createMockSessionManager();
    sm.createSession.mockImplementation(() => Promise.reject(new Error('original error')));
    mockRemoveWorktree.mockImplementation(() => Promise.reject(new Error('rollback failed')));

    // The original error should be returned, not the rollback error
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm, mockWorktreeService);

    expect(result.success).toBe(false);
    expect(result.error).toBe('original error');
  });
});
