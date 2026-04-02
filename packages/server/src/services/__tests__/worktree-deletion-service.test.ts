import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { HookCommandResult, Worktree, Session } from '@agent-console/shared';
import type { SessionManager } from '../session-manager.js';
import type { DeleteWorktreeDeps } from '../worktree-deletion-service.js';
import { getRepositoriesDir } from '../../lib/config.js';

// Use the real repositories directory path to avoid mocking config.js
// (Bun's mock.module is global and pollutes other test files)
const REPOS_DIR = getRepositoriesDir();
const REPO_PATH = `${REPOS_DIR}/my-repo`;
const WORKTREE_PATH = `${REPOS_DIR}/my-repo/worktrees/wt-1`;
const OTHER_WORKTREE_PATH = `${REPOS_DIR}/my-repo/worktrees/wt-other`;

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
const mockIsWorktreeOf = mock<
  (repoPath: string, worktreePath: string, repoId: string) => Promise<boolean>
>(() => Promise.resolve(true));

mock.module('../worktree-service.js', () => ({
  worktreeService: {
    listWorktrees: mockListWorktrees,
    removeWorktree: mockRemoveWorktree,
    executeHookCommand: mockExecuteHookCommand,
    isWorktreeOf: mockIsWorktreeOf,
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
  deleteWorktree,
  _getDeletionsInProgress,
} = await import('../worktree-deletion-service.js');

// --- Helper to create mock SessionManager ---

function createMockSessionManager(sessions: Session[] = []): SessionManager & {
  killSessionWorkers: ReturnType<typeof mock>;
  deleteSession: ReturnType<typeof mock>;
  getAllSessions: ReturnType<typeof mock>;
} {
  return {
    killSessionWorkers: mock(() => Promise.resolve()),
    deleteSession: mock(() => Promise.resolve(true)),
    getAllSessions: mock(() => sessions),
  } as unknown as SessionManager & {
    killSessionWorkers: ReturnType<typeof mock>;
    deleteSession: ReturnType<typeof mock>;
    getAllSessions: ReturnType<typeof mock>;
  };
}

// --- Helper to create mock dependencies ---

function createMockDeps(overrides: {
  sessions?: Session[];
  repo?: { name: string; path: string; cleanupCommand?: string | null };
  findOpenPullRequest?: DeleteWorktreeDeps['findOpenPullRequest'];
  getCurrentBranch?: DeleteWorktreeDeps['getCurrentBranch'];
} = {}): DeleteWorktreeDeps & {
  sessionManager: ReturnType<typeof createMockSessionManager>;
} {
  const sessionManager = createMockSessionManager(overrides.sessions ?? []);
  return {
    sessionManager,
    repositoryManager: {
      getRepository: () => overrides.repo ?? { name: 'my-repo', path: REPO_PATH },
    },
    findOpenPullRequest: overrides.findOpenPullRequest ?? (async () => null),
    getCurrentBranch: overrides.getCurrentBranch ?? (async () => 'feature-1'),
  };
}

const DEFAULT_WORKTREE_SESSION: Session = {
  id: 'sess-1',
  type: 'worktree',
  repositoryId: 'repo-1',
  repositoryName: 'my-repo',
  worktreeId: 'feature-1',
  isMainWorktree: false,
  locationPath: WORKTREE_PATH,
  status: 'active',
  activationState: 'running',
  createdAt: new Date().toISOString(),
  workers: [],
};

describe('deleteWorktree', () => {
  beforeEach(() => {
    _getDeletionsInProgress().clear();

    mockListWorktrees.mockReset();
    mockRemoveWorktree.mockReset();
    mockExecuteHookCommand.mockReset();
    mockIsWorktreeOf.mockReset();

    mockRemoveWorktree.mockImplementation(() => Promise.resolve({ success: true }));
    mockExecuteHookCommand.mockImplementation(() => Promise.resolve({ success: true, output: 'ok' }));
    mockIsWorktreeOf.mockImplementation(() => Promise.resolve(true));
    mockListWorktrees.mockImplementation(() =>
      Promise.resolve([
        {
          path: WORKTREE_PATH,
          branch: 'feature-1',
          isMain: false,
          repositoryId: 'repo-1',
          index: 1,
        },
      ]),
    );
  });

  // --- Repository lookup ---

  it('returns not-found error when repository does not exist', async () => {
    const deps = createMockDeps({ repo: undefined as unknown as { name: string; path: string } });
    (deps.repositoryManager as { getRepository: () => undefined }).getRepository = () => undefined;

    const result = await deleteWorktree(
      { repoId: 'non-existent', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('not-found');
    expect(result.error).toContain('Repository not found');
  });

  // --- Path validation ---

  it('returns validation error when worktree path fails validation', async () => {
    mockIsWorktreeOf.mockImplementation(() => Promise.resolve(false));

    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });
    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('validation');
    expect(result.error).toContain('Invalid worktree path');
  });

  it('returns validation error when worktree path is outside managed directory', async () => {
    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });
    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: '/outside/path', force: false },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('validation');
    expect(result.error).toContain('outside managed directory');
  });

  // --- Main worktree protection ---

  it('returns validation error when session is main worktree', async () => {
    const mainSession: Session = {
      ...DEFAULT_WORKTREE_SESSION,
      isMainWorktree: true,
    };

    const deps = createMockDeps({ sessions: [mainSession] });
    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('validation');
    expect(result.error).toContain('Cannot remove the main worktree');
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  // --- Open PR check ---

  it('returns open-pr error when branch has an open PR', async () => {
    const deps = createMockDeps({
      sessions: [DEFAULT_WORKTREE_SESSION],
      findOpenPullRequest: async () => ({ number: 42, title: 'Some PR' }),
      getCurrentBranch: async () => 'feature-1',
    });

    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('open-pr');
    expect(result.error).toContain('open PR #42');
  });

  it('skips PR check when force=true', async () => {
    const mockFindPr = mock(async () => ({ number: 42, title: 'Some PR' }));
    const deps = createMockDeps({
      sessions: [DEFAULT_WORKTREE_SESSION],
      findOpenPullRequest: mockFindPr,
    });

    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: true },
      deps,
    );

    expect(result.success).toBe(true);
    expect(mockFindPr).not.toHaveBeenCalled();
  });

  it('returns open-pr error when PR check fails (fail-closed)', async () => {
    const deps = createMockDeps({
      sessions: [DEFAULT_WORKTREE_SESSION],
      findOpenPullRequest: async () => { throw new Error('gh not found'); },
    });

    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('open-pr');
    expect(result.error).toContain('Failed to check for open PRs');
  });

  it('skips PR check when branch is detached', async () => {
    const mockFindPr = mock(async () => null);
    const deps = createMockDeps({
      sessions: [DEFAULT_WORKTREE_SESSION],
      findOpenPullRequest: mockFindPr,
      getCurrentBranch: async () => '(detached)',
    });

    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(true);
    expect(mockFindPr).not.toHaveBeenCalled();
  });

  // --- Concurrency guard ---

  it('returns conflict error when deletion is already in progress', async () => {
    _getDeletionsInProgress().add(WORKTREE_PATH);

    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });
    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('conflict');
    expect(result.error).toBe('Deletion already in progress');
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('clears concurrency guard after successful deletion', async () => {
    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });
    await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(_getDeletionsInProgress().has(WORKTREE_PATH)).toBe(false);
  });

  it('clears concurrency guard after worktree removal failure', async () => {
    mockRemoveWorktree.mockImplementation(() =>
      Promise.resolve({ success: false, error: 'dirty worktree' }),
    );

    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });
    await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(_getDeletionsInProgress().has(WORKTREE_PATH)).toBe(false);
  });

  // --- Happy paths ---

  it('happy path: runs cleanup, kills workers, removes worktree, deletes session', async () => {
    const deps = createMockDeps({
      sessions: [DEFAULT_WORKTREE_SESSION],
      repo: { name: 'my-repo', path: REPO_PATH, cleanupCommand: 'echo cleanup' },
    });

    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.cleanupCommandResult).toEqual({ success: true, output: 'ok' });
    expect(result.sessionIds).toEqual(['sess-1']);
    expect(mockExecuteHookCommand).toHaveBeenCalledTimes(1);
    expect(deps.sessionManager.killSessionWorkers).toHaveBeenCalledWith('sess-1');
    expect(mockRemoveWorktree).toHaveBeenCalledTimes(1);
    expect(deps.sessionManager.deleteSession).toHaveBeenCalledWith('sess-1');
  });

  it('happy path without sessions: skips kill and delete', async () => {
    const deps = createMockDeps({
      sessions: [],
      repo: { name: 'my-repo', path: REPO_PATH, cleanupCommand: 'echo cleanup' },
    });

    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.sessionIds).toEqual([]);
    expect(deps.sessionManager.killSessionWorkers).not.toHaveBeenCalled();
    expect(deps.sessionManager.deleteSession).not.toHaveBeenCalled();
  });

  it('happy path without cleanup command: skips cleanup execution', async () => {
    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });

    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.cleanupCommandResult).toBeUndefined();
    expect(mockExecuteHookCommand).not.toHaveBeenCalled();
  });

  // --- Failure paths ---

  it('returns failure and does not delete session when worktree removal fails', async () => {
    mockRemoveWorktree.mockImplementation(() =>
      Promise.resolve({ success: false, error: 'dirty worktree' }),
    );

    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });
    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('dirty worktree');
    expect(result.sessionIds).toEqual(['sess-1']);
    expect(deps.sessionManager.deleteSession).not.toHaveBeenCalled();
  });

  it('returns default error message when removeWorktree error is empty', async () => {
    mockRemoveWorktree.mockImplementation(() =>
      Promise.resolve({ success: false, error: '' }),
    );

    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });
    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to remove worktree');
  });

  it('returns success with sessionDeleteError when deleteSession throws', async () => {
    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });
    deps.sessionManager.deleteSession.mockImplementation(() => Promise.reject(new Error('DB error')));

    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.sessionDeleteError).toBe('sess-1: DB error');
  });

  // --- Multiple sessions ---

  it('kills workers and deletes all sessions matching the worktree path', async () => {
    const session2: Session = {
      ...DEFAULT_WORKTREE_SESSION,
      id: 'sess-2',
    };

    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION, session2] });
    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.sessionIds).toEqual(['sess-1', 'sess-2']);
    expect(deps.sessionManager.killSessionWorkers).toHaveBeenCalledWith('sess-1');
    expect(deps.sessionManager.killSessionWorkers).toHaveBeenCalledWith('sess-2');
    expect(deps.sessionManager.deleteSession).toHaveBeenCalledWith('sess-1');
    expect(deps.sessionManager.deleteSession).toHaveBeenCalledWith('sess-2');
  });

  it('captures errors from multiple session deletions', async () => {
    const session2: Session = {
      ...DEFAULT_WORKTREE_SESSION,
      id: 'sess-2',
    };

    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION, session2] });
    deps.sessionManager.deleteSession.mockImplementation((id: string) => {
      if (id === 'sess-2') return Promise.reject(new Error('DB error'));
      return Promise.resolve(true);
    });

    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.sessionDeleteError).toBe('sess-2: DB error');
    expect(deps.sessionManager.deleteSession).toHaveBeenCalledWith('sess-1');
    expect(deps.sessionManager.deleteSession).toHaveBeenCalledWith('sess-2');
  });

  // --- Session filtering ---

  it('only includes sessions matching the worktree path', async () => {
    const otherSession: Session = {
      ...DEFAULT_WORKTREE_SESSION,
      id: 'sess-other',
      locationPath: OTHER_WORKTREE_PATH,
    };

    // getAllSessions returns all sessions, but only matching ones should be processed
    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION, otherSession] });
    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.sessionIds).toEqual(['sess-1']);
    expect(deps.sessionManager.killSessionWorkers).toHaveBeenCalledTimes(1);
    expect(deps.sessionManager.killSessionWorkers).toHaveBeenCalledWith('sess-1');
  });
});
