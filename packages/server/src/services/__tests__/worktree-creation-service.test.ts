import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as fs from 'fs';
import type { HookCommandResult, Worktree } from '@agent-console/shared';
import type { SessionManager } from '../session-manager.js';
import { buildWorktreeSession } from '../../__tests__/utils/build-test-data.js';
import { GitError, mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import {
  EmptyRepositoryError,
  EMPTY_REPOSITORY_ERROR_MESSAGE,
} from '../worktree-service.js';
// --- Mock worktreeService (now passed as parameter, no mock.module needed) ---

const mockVerifyRepoAccessible = mock<(repoPath: string) => Promise<void>>(() =>
  Promise.resolve(),
);
const mockEnsureRepoHasCommits = mock<
  (repoPath: string, requestUsername?: string | null) => Promise<void>
>(() => Promise.resolve());
const mockCreateWorktree = mock<
  (
    repoPath: string,
    branch: string,
    repoId: string,
    baseBranch?: string,
    requestUsername?: string | null,
  ) => Promise<{ worktreePath: string; error?: string; index?: number }>
>(() => Promise.resolve({ worktreePath: '/repos/my-repo/worktrees/wt-new' }));
const mockRemoveWorktree = mock<
  (
    repoPath: string,
    path: string,
    force: boolean,
    requestUsername?: string | null,
  ) => Promise<{ success: boolean; error?: string }>
>(() => Promise.resolve({ success: true }));
const mockExecuteHookCommand = mock<
  (
    cmd: string,
    cwd: string,
    vars: Record<string, unknown>,
    requestUsername?: string | null,
  ) => Promise<HookCommandResult>
>(() => Promise.resolve({ success: true }));

const mockWorktreeService = {
  verifyRepoAccessible: mockVerifyRepoAccessible,
  ensureRepoHasCommits: mockEnsureRepoHasCommits,
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

// The orchestration no longer derives the worktree from `listWorktrees`; it
// builds it directly from the create call's result + the request params.
// The expected shape mirrors that construction.
const EXPECTED_WORKTREE: Worktree = {
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
  // `fs.promises.stat` is called by the production code as a sanity safety
  // net after `createWorktree` reports success. The default spy resolves so
  // the happy-path tests succeed without a real filesystem; the sanity-net
  // test overrides it to reject. `mockRestore` runs after each test so the
  // spy never leaks into sibling test files.
  let statSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    resetGitMocks();
    mockVerifyRepoAccessible.mockReset();
    mockEnsureRepoHasCommits.mockReset();
    mockCreateWorktree.mockReset();
    mockRemoveWorktree.mockReset();
    mockExecuteHookCommand.mockReset();

    // Default implementations
    mockVerifyRepoAccessible.mockImplementation(() => Promise.resolve());
    mockEnsureRepoHasCommits.mockImplementation(() => Promise.resolve());
    mockCreateWorktree.mockImplementation(() =>
      Promise.resolve({ worktreePath: CREATED_PATH, index: 2 }),
    );
    mockRemoveWorktree.mockImplementation(() => Promise.resolve({ success: true }));
    mockExecuteHookCommand.mockImplementation(() =>
      Promise.resolve({ success: true, output: 'setup done' }),
    );

    // Default fs.promises.stat spy: resolve so the sanity check passes.
    // The production call site uses the single-arg form `fsPromises.stat(path)`
    // which always returns Promise<Stats>; the rejected-promise pattern below
    // (used by the sanity-net failure test) mirrors the same cast already
    // present in worktree-service.test.ts.
    statSpy = spyOn(fs.promises, 'stat').mockImplementation(
      ((_p: fs.PathLike) =>
        Promise.resolve({ isDirectory: () => true } as fs.Stats)) as typeof fs.promises.stat,
    );
  });

  afterEach(() => {
    statSpy?.mockRestore();
    statSpy = undefined;
  });

  it('happy path: fetch, create worktree, setup command, create session', async () => {
    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(
      { ...DEFAULT_PARAMS, setupCommand: 'npm install' },
      sm,
      mockWorktreeService,
    );

    expect(result.success).toBe(true);
    expect(result.worktree).toEqual(EXPECTED_WORKTREE);
    expect(result.session).toEqual(MOCK_SESSION);
    expect(result.setupCommandResult).toEqual({ success: true, output: 'setup done' });

    // Verify fetch was called with remote branch. `requestUsername` is
    // forwarded from `CreateWorktreeParams` -- undefined here because
    // DEFAULT_PARAMS does not set it (single-user defaults).
    expect(mockGit.fetchRemote).toHaveBeenCalledWith('main', '/repos/my-repo', undefined);
    // Verify createWorktree used origin/ prefix. `requestUsername` is
    // forwarded from `CreateWorktreeParams` -- undefined here because
    // DEFAULT_PARAMS does not set it (single-user defaults).
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      '/repos/my-repo', 'feature-new', 'repo-1', 'origin/main', undefined,
    );
    // Verify the Issue #921 pre-check runs on the happy path with the same
    // `requestUsername` (undefined for single-user defaults). Guarantees the
    // pre-check does not silently regress to no-op.
    expect(mockEnsureRepoHasCommits).toHaveBeenCalledTimes(1);
    expect(mockEnsureRepoHasCommits).toHaveBeenCalledWith('/repos/my-repo', undefined);
    expect(sm.createSession).toHaveBeenCalledTimes(1);
  });

  it('forwards embeddedAgentId (no agentId) to sessionManager.createSession (Issue #1038)', async () => {
    const sm = createMockSessionManager();
    const { agentId: _agentId, ...paramsWithoutAgentId } = DEFAULT_PARAMS;
    const result = await createWorktreeWithSession(
      { ...paramsWithoutAgentId, embeddedAgentId: 'embedded-agent-1' },
      sm,
      mockWorktreeService,
    );

    expect(result.success).toBe(true);
    expect(sm.createSession).toHaveBeenCalledTimes(1);
    expect(sm.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: undefined,
        embeddedAgentId: 'embedded-agent-1',
      }),
      undefined,
    );
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

  // --- Issue #854: pre-probe + sanity-net (replaces the old post-create
  // listWorktrees-find-rollback branch which was removed in favour of a
  // pre-create accessibility probe). ---

  it('returns "Cannot access repository" when pre-probe throws GitError (Issue #854)', async () => {
    mockVerifyRepoAccessible.mockImplementation(() =>
      Promise.reject(
        new GitError(
          'git worktree failed: fatal: detected dubious ownership in repository at /repo',
          128,
          "fatal: detected dubious ownership in repository at '/repo'",
        ),
      ),
    );

    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm, mockWorktreeService);

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Cannot access repository: fatal: detected dubious ownership in repository at '/repo'",
    );
    // Pre-probe failure aborts BEFORE any filesystem side effect.
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(sm.createSession).not.toHaveBeenCalled();
  });

  it('falls back to git exit code when probe GitError stderr is empty (Issue #854)', async () => {
    mockVerifyRepoAccessible.mockImplementation(() =>
      Promise.reject(new GitError('git worktree failed', 128, '   ')),
    );

    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm, mockWorktreeService);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot access repository: git exit code 128');
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it('surfaces plain Error message when pre-probe throws non-GitError (Issue #854)', async () => {
    mockVerifyRepoAccessible.mockImplementation(() => Promise.reject(new Error('unexpected boom')));

    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm, mockWorktreeService);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot access repository: unexpected boom');
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  // --- Issue #921: empty source-repo pre-check ---

  it('returns actionable domain error when source repo has no commits (Issue #921)', async () => {
    // `git worktree add <path> main` on an unborn HEAD would surface as
    // `fatal: invalid reference: main`, which does not tell the user what
    // to do. The pre-check translates this into a fixed, actionable message
    // BEFORE any filesystem side effect.
    mockEnsureRepoHasCommits.mockImplementation(() =>
      Promise.reject(new EmptyRepositoryError()),
    );

    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm, mockWorktreeService);

    expect(result.success).toBe(false);
    expect(result.error).toBe(EMPTY_REPOSITORY_ERROR_MESSAGE);
    // Exact-string check: the user-facing message must not drift silently.
    expect(result.error).toBe(
      'The source repository has no commits yet. Create at least one commit (an empty commit is fine: git commit --allow-empty -m "initial commit") in the source repo before creating a worktree.',
    );
    // Pre-check must abort BEFORE any filesystem or network side effect.
    expect(mockGit.fetchRemote).not.toHaveBeenCalled();
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(sm.createSession).not.toHaveBeenCalled();
  });

  it('surfaces plain Error message when ensureRepoHasCommits throws non-EmptyRepositoryError (Issue #921)', async () => {
    // Any error OTHER than EmptyRepositoryError propagates its message
    // verbatim (mirrors the verifyRepoAccessible non-GitError branch above).
    mockEnsureRepoHasCommits.mockImplementation(() =>
      Promise.reject(new Error('rev-parse spawn crashed')),
    );

    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm, mockWorktreeService);

    expect(result.success).toBe(false);
    expect(result.error).toBe('rev-parse spawn crashed');
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it('threads requestUsername to ensureRepoHasCommits for multi-user pre-check (Issue #921)', async () => {
    // The pre-check must run as the same user the subsequent `git worktree
    // add` runs as, so it observes the same repo state (e.g. under a
    // per-user `safe.directory` gitconfig).
    const sm = createMockSessionManager();
    await createWorktreeWithSession(
      { ...DEFAULT_PARAMS, requestUsername: 'alice' },
      sm,
      mockWorktreeService,
    );

    expect(mockEnsureRepoHasCommits).toHaveBeenCalledWith('/repos/my-repo', 'alice');
  });

  it('rolls back and returns "directory is missing" when sanity-net stat fails (Issue #854)', async () => {
    // createWorktree reports success but the path does not actually exist
    // on disk -- the sanity-net stat catches it and triggers rollback.
    statSpy?.mockRestore();
    statSpy = spyOn(fs.promises, 'stat').mockImplementation((() =>
      Promise.reject(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }))
    ) as typeof fs.promises.stat);

    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm, mockWorktreeService);

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      `Worktree create reported success but directory is missing: ${CREATED_PATH}`,
    );
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/repos/my-repo', CREATED_PATH, true, undefined);
    expect(sm.createSession).not.toHaveBeenCalled();
  });

  it('rolls back worktree and returns failure when session creation fails', async () => {
    const sm = createMockSessionManager();
    sm.createSession.mockImplementation(() => Promise.reject(new Error('DB connection lost')));

    const result = await createWorktreeWithSession(DEFAULT_PARAMS, sm, mockWorktreeService);

    expect(result.success).toBe(false);
    expect(result.error).toBe('DB connection lost');

    // Rollback should have been called
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/repos/my-repo', CREATED_PATH, true, undefined);
  });

  it('skips session creation when autoStartSession is false', async () => {
    const sm = createMockSessionManager();
    const result = await createWorktreeWithSession(
      { ...DEFAULT_PARAMS, autoStartSession: false },
      sm,
      mockWorktreeService,
    );

    expect(result.success).toBe(true);
    expect(result.worktree).toEqual(EXPECTED_WORKTREE);
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

  it('threads requestUsername to fetchRemote for SSH-credential elevation (Issue #912)', async () => {
    // Without this threading, the pre-worktree `git fetch origin <baseBranch>`
    // runs as the server user (`agentconsole`), which has no SSH credentials
    // and silently falls back to the local branch -- exactly the symptom
    // Issue #912 catches for SSH-URL remotes.
    const sm = createMockSessionManager();
    await createWorktreeWithSession(
      { ...DEFAULT_PARAMS, requestUsername: 'alice' },
      sm,
      mockWorktreeService,
    );

    expect(mockGit.fetchRemote).toHaveBeenCalledWith('main', '/repos/my-repo', 'alice');
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

  it('threads requestUsername to executeHookCommand for the setup hook (Issue #883)', async () => {
    // Without this threading, the setup hook would run as the server user
    // (`agentconsole`) inside a worktree owned by the requesting user, with
    // no access to that user's gh / ssh credentials and unable to write
    // user-owned files. Mirrors the same one-line plumbing as Issue #838.
    const sm = createMockSessionManager();
    await createWorktreeWithSession(
      { ...DEFAULT_PARAMS, setupCommand: 'npm install', requestUsername: 'alice' },
      sm,
      mockWorktreeService,
    );

    expect(mockExecuteHookCommand).toHaveBeenCalledWith(
      'npm install',
      CREATED_PATH,
      { worktreeNum: 2, branch: 'feature-new', repo: 'my-repo' },
      'alice',
    );
  });

  it('threads requestUsername to rollback removeWorktree on post-worktree failure (Issue #882)', async () => {
    // Sibling of mcp-server.ts:717 delegate_to_worktree rollback. Without
    // this threading, the rollback would run as the server user and hit
    // the same Permission-denied symptom Issue #882 was filed to fix when
    // the worktree is owned by the requesting user (multi-user mode).
    const sm = createMockSessionManager();
    sm.createSession.mockImplementation(() => Promise.reject(new Error('boom')));

    await createWorktreeWithSession(
      { ...DEFAULT_PARAMS, requestUsername: 'alice' },
      sm,
      mockWorktreeService,
    );

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/repos/my-repo', CREATED_PATH, true, 'alice');
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
