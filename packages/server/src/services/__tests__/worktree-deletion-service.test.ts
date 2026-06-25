import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { HookCommandResult, Worktree, Session } from '@agent-console/shared';
import type { SessionManager } from '../session-manager.js';
import type { DeleteWorktreeDeps } from '../worktree-deletion-service.js';
import { getRepositoriesDir } from '../../lib/config.js';
import { buildWorktreeSession } from '../../__tests__/utils/build-test-data.js';

// Use the real repositories directory path to avoid mocking config.js
// (Bun's mock.module is global and pollutes other test files)
const REPOS_DIR = getRepositoriesDir();
const REPO_PATH = `${REPOS_DIR}/my-repo`;
const WORKTREE_PATH = `${REPOS_DIR}/my-repo/worktrees/wt-1`;
const OTHER_WORKTREE_PATH = `${REPOS_DIR}/my-repo/worktrees/wt-other`;

// --- Mock worktreeService (now passed as parameter via DeleteWorktreeDeps) ---

const mockListWorktrees = mock<(repoPath: string, repoId: string) => Promise<Worktree[]>>(() =>
  Promise.resolve([]),
);
const mockRemoveWorktree = mock<
  (
    repoPath: string,
    path: string,
    force: boolean,
    requestUsername?: string | null,
  ) => Promise<{ success: boolean; error?: string }>
>(() => Promise.resolve({ success: true }));
const mockExecuteHookCommand = mock<
  (cmd: string, cwd: string, vars: Record<string, unknown>) => Promise<HookCommandResult>
>(() => Promise.resolve({ success: true }));
const mockIsWorktreeOf = mock<
  (repoPath: string, worktreePath: string, repoId: string) => Promise<boolean>
>(() => Promise.resolve(true));
const mockRemoveOrphanedWorktree = mock<
  (worktreePath: string, requestUsername?: string | null) => Promise<void>
>(() => Promise.resolve());

const mockWorktreeService = {
  listWorktrees: mockListWorktrees,
  removeWorktree: mockRemoveWorktree,
  executeHookCommand: mockExecuteHookCommand,
  isWorktreeOf: mockIsWorktreeOf,
  removeOrphanedWorktree: mockRemoveOrphanedWorktree,
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
    worktreeService: mockWorktreeService,
    sessionManager,
    repositoryManager: {
      getRepository: () => overrides.repo ?? { name: 'my-repo', path: REPO_PATH },
    },
    findOpenPullRequest: overrides.findOpenPullRequest ?? (async () => null),
    getCurrentBranch: overrides.getCurrentBranch ?? (async () => 'feature-1'),
  };
}

const DEFAULT_WORKTREE_SESSION = buildWorktreeSession({
  id: 'sess-1',
  repositoryName: 'my-repo',
  worktreeId: 'feature-1',
  locationPath: WORKTREE_PATH,
});

describe('deleteWorktree', () => {
  beforeEach(() => {
    _getDeletionsInProgress().clear();

    mockListWorktrees.mockReset();
    mockRemoveWorktree.mockReset();
    mockExecuteHookCommand.mockReset();
    mockIsWorktreeOf.mockReset();
    mockRemoveOrphanedWorktree.mockReset();

    mockRemoveWorktree.mockImplementation(() => Promise.resolve({ success: true }));
    mockExecuteHookCommand.mockImplementation(() => Promise.resolve({ success: true, output: 'ok' }));
    mockIsWorktreeOf.mockImplementation(() => Promise.resolve(true));
    mockRemoveOrphanedWorktree.mockImplementation(() => Promise.resolve());
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

  it('orphan path: succeeds with git-less cleanup when repository row is unregistered (no sessions)', async () => {
    // Refs #815. When the repository row is missing from the in-memory
    // registry, the worktree has lost its anchor. Instead of returning
    // "not-found" (which leaves the orphan stuck in 'deleting'), the
    // deletion service must perform a git-less fs.rm + DB-row delete.
    const deps = createMockDeps({ sessions: [] });
    (deps.repositoryManager as { getRepository: () => undefined }).getRepository = () => undefined;

    const result = await deleteWorktree(
      { repoId: 'unregistered-repo', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.sessionIds).toEqual([]);
    expect(mockRemoveOrphanedWorktree).toHaveBeenCalledWith(WORKTREE_PATH, null);
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(mockExecuteHookCommand).not.toHaveBeenCalled();
    expect(deps.sessionManager.killSessionWorkers).not.toHaveBeenCalled();
    expect(deps.sessionManager.deleteSession).not.toHaveBeenCalled();
  });

  it('orphan path: kills PTYs and deletes sessions when matching sessions exist', async () => {
    const session2 = buildWorktreeSession({
      id: 'sess-2',
      repositoryName: 'my-repo',
      worktreeId: 'feature-1',
      locationPath: WORKTREE_PATH,
    });
    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION, session2] });
    (deps.repositoryManager as { getRepository: () => undefined }).getRepository = () => undefined;

    const result = await deleteWorktree(
      { repoId: 'unregistered-repo', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.sessionIds).toEqual(['sess-1', 'sess-2']);
    expect(deps.sessionManager.killSessionWorkers).toHaveBeenCalledWith('sess-1');
    expect(deps.sessionManager.killSessionWorkers).toHaveBeenCalledWith('sess-2');
    expect(mockRemoveOrphanedWorktree).toHaveBeenCalledWith(WORKTREE_PATH, null);
    expect(deps.sessionManager.deleteSession).toHaveBeenCalledWith('sess-1');
    expect(deps.sessionManager.deleteSession).toHaveBeenCalledWith('sess-2');
    expect(mockRemoveWorktree).not.toHaveBeenCalled(); // git path not used
  });

  it('orphan path: idempotent — fs.rm and deleteByPath both no-op on missing artifacts', async () => {
    // mockRemoveOrphanedWorktree default resolution simulates the no-op
    // shape of removeOrphanedWorktree: rm with force does not throw on
    // missing paths, deleteByPath does not throw on missing rows.
    const deps = createMockDeps({ sessions: [] });
    (deps.repositoryManager as { getRepository: () => undefined }).getRepository = () => undefined;

    const result = await deleteWorktree(
      { repoId: 'unregistered-repo', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
      deps,
    );

    expect(result.success).toBe(true);
    expect(mockRemoveOrphanedWorktree).toHaveBeenCalledTimes(1);
  });

  it('orphan path: rejects worktreePath outside getRepositoriesDir() (security boundary preserved)', async () => {
    const deps = createMockDeps({ sessions: [] });
    (deps.repositoryManager as { getRepository: () => undefined }).getRepository = () => undefined;

    const result = await deleteWorktree(
      { repoId: 'unregistered-repo', worktreePath: '/outside/path', force: false, requestUsername: null },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('validation');
    expect(result.error).toContain('outside managed directory');
    expect(mockRemoveOrphanedWorktree).not.toHaveBeenCalled();
  });

  it('orphan path: rejects when a matching session is the main worktree (invariant preserved)', async () => {
    const mainSession = buildWorktreeSession({
      id: 'sess-main',
      repositoryName: 'my-repo',
      worktreeId: 'main',
      locationPath: WORKTREE_PATH,
      isMainWorktree: true,
    });
    const deps = createMockDeps({ sessions: [mainSession] });
    (deps.repositoryManager as { getRepository: () => undefined }).getRepository = () => undefined;

    const result = await deleteWorktree(
      { repoId: 'unregistered-repo', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('validation');
    expect(result.error).toContain('Cannot remove the main worktree');
    expect(mockRemoveOrphanedWorktree).not.toHaveBeenCalled();
  });

  it('orphan path: returns conflict when deletion is already in progress for the same path', async () => {
    _getDeletionsInProgress().add(WORKTREE_PATH);
    const deps = createMockDeps({ sessions: [] });
    (deps.repositoryManager as { getRepository: () => undefined }).getRepository = () => undefined;

    const result = await deleteWorktree(
      { repoId: 'unregistered-repo', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('conflict');
    expect(mockRemoveOrphanedWorktree).not.toHaveBeenCalled();
  });

  it('orphan path: collects killErrors but still proceeds with cleanup', async () => {
    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });
    (deps.repositoryManager as { getRepository: () => undefined }).getRepository = () => undefined;
    deps.sessionManager.killSessionWorkers.mockImplementation(() =>
      Promise.reject(new Error('kill failed')),
    );

    const result = await deleteWorktree(
      { repoId: 'unregistered-repo', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.killErrors).toEqual([{ sessionId: 'sess-1', error: 'kill failed' }]);
    expect(mockRemoveOrphanedWorktree).toHaveBeenCalledTimes(1);
    expect(deps.sessionManager.deleteSession).toHaveBeenCalledWith('sess-1');
  });

  it('orphan path: collects sessionDeleteError when deleteSession throws but still reports success', async () => {
    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });
    (deps.repositoryManager as { getRepository: () => undefined }).getRepository = () => undefined;
    deps.sessionManager.deleteSession.mockImplementation(() =>
      Promise.reject(new Error('DB error')),
    );

    const result = await deleteWorktree(
      { repoId: 'unregistered-repo', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.sessionDeleteError).toBe('sess-1: DB error');
  });

  // --- Path validation ---

  it('returns validation error when worktree path fails validation', async () => {
    mockIsWorktreeOf.mockImplementation(() => Promise.resolve(false));

    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });
    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('validation');
    expect(result.error).toContain('Invalid worktree path');
  });

  it('returns validation error when worktree path is outside managed directory', async () => {
    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });
    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: '/outside/path', force: false, requestUsername: null },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('validation');
    expect(result.error).toContain('outside managed directory');
  });

  // --- Main worktree protection ---

  it('returns validation error when session is main worktree', async () => {
    const mainSession = buildWorktreeSession({
      id: 'sess-1',
      repositoryName: 'my-repo',
      worktreeId: 'feature-1',
      locationPath: WORKTREE_PATH,
      isMainWorktree: true,
    });

    const deps = createMockDeps({ sessions: [mainSession] });
    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
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
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
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
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: true, requestUsername: null },
      deps,
    );

    expect(result.success).toBe(true);
    expect(mockFindPr).not.toHaveBeenCalled();
  });

  it('forwards requestUsername to findOpenPullRequest (Issue #885)', async () => {
    const mockFindPr = mock<DeleteWorktreeDeps['findOpenPullRequest']>(
      async () => null,
    );
    const deps = createMockDeps({
      sessions: [DEFAULT_WORKTREE_SESSION],
      findOpenPullRequest: mockFindPr,
      getCurrentBranch: async () => 'feature-1',
    });

    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: 'alice' },
      deps,
    );

    expect(result.success).toBe(true);
    // 3rd positional arg is requestUsername — the value the route handler
    // resolved from authUser.username for the gh CLI elevation in
    // github-pr-service (Issue #885).
    expect(mockFindPr).toHaveBeenCalledTimes(1);
    expect(mockFindPr.mock.calls[0]).toEqual(['feature-1', REPO_PATH, 'alice']);
  });

  it('returns open-pr error when PR check fails (fail-closed)', async () => {
    const deps = createMockDeps({
      sessions: [DEFAULT_WORKTREE_SESSION],
      findOpenPullRequest: async () => { throw new Error('gh not found'); },
    });

    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
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
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
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
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
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
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
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
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
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
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
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
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
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
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
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
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
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
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to remove worktree');
  });

  it('returns success with sessionDeleteError when deleteSession throws', async () => {
    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });
    deps.sessionManager.deleteSession.mockImplementation(() => Promise.reject(new Error('DB error')));

    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.sessionDeleteError).toBe('sess-1: DB error');
  });

  // --- Multiple sessions ---

  it('kills workers and deletes all sessions matching the worktree path', async () => {
    const session2 = buildWorktreeSession({
      id: 'sess-2',
      repositoryName: 'my-repo',
      worktreeId: 'feature-1',
      locationPath: WORKTREE_PATH,
    });

    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION, session2] });
    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
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
    const session2 = buildWorktreeSession({
      id: 'sess-2',
      repositoryName: 'my-repo',
      worktreeId: 'feature-1',
      locationPath: WORKTREE_PATH,
    });

    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION, session2] });
    deps.sessionManager.deleteSession.mockImplementation((id: string) => {
      if (id === 'sess-2') return Promise.reject(new Error('DB error'));
      return Promise.resolve(true);
    });

    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.sessionDeleteError).toBe('sess-2: DB error');
    expect(deps.sessionManager.deleteSession).toHaveBeenCalledWith('sess-1');
    expect(deps.sessionManager.deleteSession).toHaveBeenCalledWith('sess-2');
  });

  // --- Issue #882: requestUsername threading (multi-user elevation) ---

  describe('requestUsername threading (Issue #882)', () => {
    it('happy path threads requestUsername into worktreeService.removeWorktree', async () => {
      const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });

      const result = await deleteWorktree(
        {
          repoId: 'repo-1',
          worktreePath: WORKTREE_PATH,
          force: false,
          requestUsername: 'alice',
        },
        deps,
      );

      expect(result.success).toBe(true);
      expect(mockRemoveWorktree).toHaveBeenCalledWith(REPO_PATH, WORKTREE_PATH, false, 'alice');
    });

    it('orphan path threads requestUsername into worktreeService.removeOrphanedWorktree', async () => {
      const deps = createMockDeps({ sessions: [] });
      (deps.repositoryManager as { getRepository: () => undefined }).getRepository = () => undefined;

      const result = await deleteWorktree(
        {
          repoId: 'unregistered-repo',
          worktreePath: WORKTREE_PATH,
          force: false,
          requestUsername: 'alice',
        },
        deps,
      );

      expect(result.success).toBe(true);
      expect(mockRemoveOrphanedWorktree).toHaveBeenCalledWith(WORKTREE_PATH, 'alice');
    });

    it('orphan path: surfaces elevated rm failure as { success: false } with actionable error', async () => {
      // Simulate the elevated `rm -rf` failing (e.g. EACCES on a deeply nested
      // file). `removeOrphanedWorktree` throws; the deletion service must
      // convert the throw into an actionable failure result rather than
      // letting it propagate to the caller as an unhandled rejection.
      mockRemoveOrphanedWorktree.mockImplementation(() =>
        Promise.reject(
          new Error(
            "Failed to remove orphaned worktree as alice: rm: cannot remove '/var/lib/.../wt-1/locked': Permission denied",
          ),
        ),
      );
      const deps = createMockDeps({ sessions: [] });
      (deps.repositoryManager as { getRepository: () => undefined }).getRepository = () => undefined;

      const result = await deleteWorktree(
        {
          repoId: 'unregistered-repo',
          worktreePath: WORKTREE_PATH,
          force: false,
          requestUsername: 'alice',
        },
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
      expect(result.sessionIds).toEqual([]);
    });

    it('happy path with requestUsername=null preserves the single-user call shape', async () => {
      const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION] });

      await deleteWorktree(
        {
          repoId: 'repo-1',
          worktreePath: WORKTREE_PATH,
          force: true,
          requestUsername: null,
        },
        deps,
      );

      // null username explicitly threaded through — runAsUser will bypass.
      expect(mockRemoveWorktree).toHaveBeenCalledWith(REPO_PATH, WORKTREE_PATH, true, null);
    });
  });

  // --- Session filtering ---

  it('only includes sessions matching the worktree path', async () => {
    const otherSession = buildWorktreeSession({
      id: 'sess-other',
      repositoryName: 'my-repo',
      worktreeId: 'feature-1',
      locationPath: OTHER_WORKTREE_PATH,
    });

    // getAllSessions returns all sessions, but only matching ones should be processed
    const deps = createMockDeps({ sessions: [DEFAULT_WORKTREE_SESSION, otherSession] });
    const result = await deleteWorktree(
      { repoId: 'repo-1', worktreePath: WORKTREE_PATH, force: false, requestUsername: null },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.sessionIds).toEqual(['sess-1']);
    expect(deps.sessionManager.killSessionWorkers).toHaveBeenCalledTimes(1);
    expect(deps.sessionManager.killSessionWorkers).toHaveBeenCalledWith('sess-1');
  });
});
