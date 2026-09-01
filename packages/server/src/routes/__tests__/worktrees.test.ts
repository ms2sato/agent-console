import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { onApiError } from '../../lib/error-handler.js';
import { api } from '../api.js';
import type { AppBindings } from '../../app-context.js';
import type { WorktreeService } from '../../services/worktree-service.js';
import type { RepositoryManager } from '../../services/repository-manager.js';
import type { SessionManager } from '../../services/session-manager.js';
import type { AppServerMessage, Repository, WorktreeDeletePayload } from '@agent-console/shared';
import { asAppContext, TEST_AUTH_USER } from '../../__tests__/test-utils.js';
import { mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { _getPullsInProgress, _getDeletionsInProgress } from '../worktrees.js';
import { CLAUDE_CODE_AGENT_ID } from '../../services/agent-manager.js';
import { AgentDirectory } from '../../services/agent-directory.js';
import { SharedAccountRegistry } from '../../services/shared-account-registry.js';
import type { AuthUser } from '@agent-console/shared';
import { JobQueue, type JobHandler } from '../../jobs/index.js';
import { registerWorktreeDeleteJobHandler } from '../../jobs/worktree-delete-job-handler.js';
import { createDatabaseForTest } from '../../database/connection.js';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_CONFIG_DIR = '/test/config';
const REPO_PATH = `${TEST_CONFIG_DIR}/repositories/owner/repo`;

const TEST_REPO: Repository = {
  id: 'repo-1',
  name: 'test-repo',
  path: REPO_PATH,
  createdAt: new Date().toISOString(),
  clonedSourceRepoPath: null,
};

const WORKTREE_PATH = `${REPO_PATH}/worktrees/wt-1`;

// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------

function createMockWorktreeService() {
  return {
    listWorktrees: mock(() => Promise.resolve([])),
    // Pre-create accessibility probe (Issue #854). Default to success so
    // tests that don't care about the probe see the legacy behaviour;
    // probe-failure tests override per-call.
    verifyRepoAccessible: mock(() => Promise.resolve()),
    // Issue #921 pre-check: default no-op (repo has commits). Tests that
    // exercise the empty-repo branch override this per-call.
    ensureRepoHasCommits: mock(() => Promise.resolve()),
    isWorktreeOf: mock(() => Promise.resolve(true)),
    getDefaultBranch: mock(() => Promise.resolve('main')),
    listLocalBranches: mock(() => Promise.resolve([])),
    listRemoteBranches: mock(() => Promise.resolve([])),
    executeHookCommand: mock(() => Promise.resolve(null)),
    removeWorktree: mock(() => Promise.resolve({ success: true })),
    removeOrphanedWorktree: mock(() => Promise.resolve()),
    getWorktreeIndexNumber: mock(() => Promise.resolve(null)),
    // Default no-op for createWorktree; overridden in tests that exercise
    // the POST /worktrees route.
    createWorktree: mock(() => Promise.resolve({ worktreePath: '', error: 'not implemented in mock' })),
  } as unknown as WorktreeService;
}

function createMockRepositoryManager() {
  return {
    getRepository: mock((id: string) => (id === TEST_REPO.id ? TEST_REPO : undefined)),
    getAllRepositories: mock(() => [TEST_REPO]),
  } as unknown as RepositoryManager;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Worktrees API', () => {
  let app: Hono<AppBindings>;
  let mockWorktreeService: WorktreeService;
  let mockRepositoryManager: RepositoryManager;

  beforeEach(() => {
    resetGitMocks();

    mockWorktreeService = createMockWorktreeService();
    mockRepositoryManager = createMockRepositoryManager();

    // Setup memfs with the worktree directory structure
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
      [`${REPO_PATH}/.keep`]: '',
      [`${WORKTREE_PATH}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Set default git mock behavior
    mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('feature-branch'));

    // Build the Hono app with mocked services
    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', asAppContext({
        repositoryManager: mockRepositoryManager,
        worktreeService: mockWorktreeService,
      }));
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
  });

  afterEach(() => {
    _getPullsInProgress().clear();
    _getDeletionsInProgress().clear();
    cleanupMemfs();
  });

  // =========================================================================
  // GET /api/repositories/:id/worktrees
  // =========================================================================

  describe('GET /api/repositories/:id/worktrees', () => {
    it('should return 404 for unknown repository ID', async () => {
      const res = await app.request('/api/repositories/unknown-id/worktrees', {
        method: 'GET',
      });

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Repository');
    });

    it('should return worktrees array for valid repo', async () => {
      const mockWorktrees = [
        { path: WORKTREE_PATH, branch: 'feature-1', isMainWorktree: false },
      ];
      (mockWorktreeService.listWorktrees as ReturnType<typeof mock>)
        .mockImplementation(() => Promise.resolve(mockWorktrees));

      const res = await app.request(`/api/repositories/${TEST_REPO.id}/worktrees`, {
        method: 'GET',
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as { worktrees: unknown[] };
      expect(body.worktrees).toBeArray();
      expect(body.worktrees).toHaveLength(1);
    });
  });

  // =========================================================================
  // POST /api/repositories/:id/worktrees  (Issue #838: requestUsername plumbing)
  // =========================================================================

  describe('POST /api/repositories/:id/worktrees (Issue #838 requestUsername plumbing)', () => {
    /**
     * The route handler kicks worktree creation off in a fire-and-forget
     * background promise; the HTTP response returns 202 immediately. To
     * deterministically observe the inner `worktreeService.createWorktree`
     * call, the mock resolves a promise the test awaits before asserting.
     */
    function createCapturingWorktreeMock() {
      let resolveCall!: (args: unknown[]) => void;
      const captured = new Promise<unknown[]>((resolve) => {
        resolveCall = resolve;
      });
      const mockFn = mock((...args: unknown[]) => {
        resolveCall(args);
        // Return error so the route's success-broadcast path is skipped --
        // the test only needs to observe the createWorktree call args.
        return Promise.resolve({ worktreePath: '', error: 'short-circuit for test' });
      });
      return { mockFn, captured };
    }

    it("forwards authUser.username as requestUsername to worktreeService.createWorktree", async () => {
      // Mock the agent manager so the route passes the agent validation.
      const mockAgentManager = {
        getAgent: mock(() => ({ id: 'claude-code-builtin', name: 'Claude Code' })),
      } as unknown as Parameters<typeof asAppContext>[0]['agentManager'];

      const { mockFn: createCapture, captured } = createCapturingWorktreeMock();
      (mockWorktreeService as unknown as { createWorktree: typeof createCapture }).createWorktree = createCapture;

      // Re-mount the app with the augmented appContext (agentManager +
      // sessionManager + broadcastToApp + suggestSessionMetadata). The
      // default suggestSessionMetadata is not invoked because we use
      // `mode: 'custom'`, which uses the explicit branch verbatim.
      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: mockAgentManager,
          // sessionManager is invoked downstream by createWorktreeWithSession
          // only when the worktree creation succeeds; the short-circuit error
          // above ensures it never runs.
          sessionManager: { createSession: mock() } as unknown as SessionManager,
          broadcastToApp: () => {},
          suggestSessionMetadata: mock(async () => ({ branch: '', title: '', error: 'unused' })),
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: 'task-issue-838',
            mode: 'custom',
            branch: 'issue-838-feature',
            baseBranch: 'main',
            useRemote: false,
            autoStartSession: false,
            agentId: 'claude-code-builtin',
          }),
        },
      );

      expect(res.status).toBe(202);

      // The route's fire-and-forget call MUST run before the test ends.
      // The promise resolves the moment createWorktree is invoked.
      const args = await captured;
      // Signature: (repoPath, branch, repoId, baseBranch, requestUsername)
      expect(args[0]).toBe(REPO_PATH);
      expect(args[1]).toBe('issue-838-feature');
      expect(args[2]).toBe(TEST_REPO.id);
      // The default SingleUserMode used by asAppContext is constructed with
      // TEST_AUTH_USER (username='testuser'), so the route MUST forward
      // 'testuser' as the 5th positional arg.
      expect(args[4]).toBe('testuser');
    });

    it("forwards authUser.username as requestUser to suggestSessionMetadata (Issue #856)", async () => {
      // For `mode: 'prompt'`, the route invokes `suggestSessionMetadata` to
      // auto-generate a branch name + title. After Issue #856 the route must
      // thread `authUser.username` down so the headless agent command runs
      // as the requesting user in multi-user mode (via runAsUser inside the
      // suggester). The default SingleUserMode used by asAppContext is
      // constructed with TEST_AUTH_USER (username='testuser'), so we assert
      // the route forwards 'testuser' as `requestUser`.
      const mockAgentManager = {
        getAgent: mock(() => ({ id: 'claude-code-builtin', name: 'Claude Code' })),
      } as unknown as Parameters<typeof asAppContext>[0]['agentManager'];

      // Capture the args the suggester receives. Resolve to an error so the
      // downstream worktree creation falls back to `task-<timestamp>` and we
      // do not need to mock the success-broadcast path further.
      let resolveSuggestionCall!: (args: unknown[]) => void;
      const suggestionCaptured = new Promise<unknown[]>((resolve) => {
        resolveSuggestionCall = resolve;
      });
      const suggestionMock = mock((...args: unknown[]) => {
        resolveSuggestionCall(args);
        return Promise.resolve({ branch: undefined, title: undefined, error: 'short-circuit for test' });
      });

      // Short-circuit the worktree creation so we do not exercise the full
      // pipeline; we only care that the suggester was called with the right
      // requestUser.
      const { mockFn: createCapture } = createCapturingWorktreeMock();
      (mockWorktreeService as unknown as { createWorktree: typeof createCapture }).createWorktree = createCapture;

      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: mockAgentManager,
          sessionManager: { createSession: mock() } as unknown as SessionManager,
          broadcastToApp: () => {},
          suggestSessionMetadata: suggestionMock as unknown as Parameters<typeof asAppContext>[0]['suggestSessionMetadata'],
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: 'task-issue-856',
            mode: 'prompt',
            initialPrompt: 'Add a dark mode toggle',
            baseBranch: 'main',
            useRemote: false,
            autoStartSession: false,
            agentId: 'claude-code-builtin',
          }),
        },
      );

      expect(res.status).toBe(202);

      // The suggester is invoked from the fire-and-forget IIFE; await the
      // captured-args promise so we observe the call deterministically.
      const args = await suggestionCaptured;
      const req = args[0] as { prompt: string; repositoryPath: string; requestUser: string | null };
      expect(req.prompt).toBe('Add a dark mode toggle');
      expect(req.repositoryPath).toBe(REPO_PATH);
      // Primary assertion: requestUser must equal the authenticated OS user.
      expect(req.requestUser).toBe('testuser');
    });
  });

  // =========================================================================
  // POST /api/repositories/:id/worktrees (Issue #1286: shared worktree
  // sessions). Mirrors POST /api/sessions (see sessions.test.ts's "shared
  // sessions" describe block) -- `body.shared` is translated into
  // createdBy/initiatedBy ownership and the whole creation pipeline
  // (createWorktree, session creation) runs under `requestUsername`.
  // =========================================================================

  describe('POST /api/repositories/:id/worktrees (Issue #1286 shared worktree sessions)', () => {
    const mockAgentManager = {
      getAgent: mock(() => ({ id: 'claude-code-builtin', name: 'Claude Code' })),
    } as unknown as Parameters<typeof asAppContext>[0]['agentManager'];

    /**
     * The route kicks off worktree creation in a fire-and-forget IIFE; the
     * mock resolves a promise the test awaits before asserting the args it
     * was called with (mirrors createCapturingWorktreeMock above, but
     * resolves a success shape so the pipeline continues to session
     * creation instead of short-circuiting).
     */
    function createCapturingCreateWorktreeMock(worktreePath: string) {
      let resolveCall!: (args: unknown[]) => void;
      const captured = new Promise<unknown[]>((resolve) => {
        resolveCall = resolve;
      });
      const mockFn = mock((...args: unknown[]) => {
        resolveCall(args);
        return Promise.resolve({ worktreePath, index: 0 });
      });
      return { mockFn, captured };
    }

    function createCapturingSessionMock() {
      let resolveCall!: (args: unknown[]) => void;
      const captured = new Promise<unknown[]>((resolve) => {
        resolveCall = resolve;
      });
      const mockFn = mock((...args: unknown[]) => {
        resolveCall(args);
        return Promise.resolve({ id: 'session-shared-1' });
      });
      return { mockFn, captured };
    }

    /**
     * Builds a real SharedAccountRegistry (enabled or disabled) backed by a
     * fake UserRepository, mirroring sessions.test.ts's setupCommon pattern.
     * The registry's public API (isEnabled / getDefaultUserId /
     * getDefaultUsername) is exercised for real; only the OS lookup + DB
     * upsert are faked.
     */
    async function createSharedAccountRegistry(opts: { enabled: boolean }): Promise<SharedAccountRegistry> {
      if (!opts.enabled) {
        return SharedAccountRegistry.createDisabled();
      }
      const fakeUserRepository = {
        upsertByOsUid: mock((_uid: number, username: string, homeDir: string) =>
          Promise.resolve({ id: 'shared-user-id', username, homeDir } satisfies AuthUser),
        ),
        findById: mock(() => Promise.resolve(null)),
      };
      return SharedAccountRegistry.create({
        username: 'shared-user',
        userRepository: fakeUserRepository as unknown as Parameters<typeof SharedAccountRegistry.create>[0]['userRepository'],
        lookupOsUser: () => Promise.resolve({ uid: 6000, homeDir: '/home/shared-user' }),
      });
    }

    it('shared:true + registry disabled -> 400 with exact message, createWorktree not called', async () => {
      const sharedAccountRegistry = await createSharedAccountRegistry({ enabled: false });
      const { mockFn: createCapture } = createCapturingCreateWorktreeMock(WORKTREE_PATH);
      (mockWorktreeService as unknown as { createWorktree: typeof createCapture }).createWorktree = createCapture;

      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: mockAgentManager,
          sessionManager: { createSession: mock() } as unknown as SessionManager,
          broadcastToApp: () => {},
          suggestSessionMetadata: mock(async () => ({ branch: '', title: '', error: 'unused' })),
          sharedAccountRegistry,
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(`/api/repositories/${TEST_REPO.id}/worktrees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: 'task-1286-disabled',
          mode: 'custom',
          branch: 'feature/shared-disabled',
          baseBranch: 'main',
          useRemote: false,
          autoStartSession: false,
          agentId: 'claude-code-builtin',
          shared: true,
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Shared sessions are not enabled on this server.');
      // Failure happens synchronously (before the fire-and-forget block), so
      // the worktree creation pipeline must never have been entered.
      expect(createCapture).not.toHaveBeenCalled();
    });

    it('shared:true + registry enabled -> createWorktree + session creation run under the shared account', async () => {
      const sharedAccountRegistry = await createSharedAccountRegistry({ enabled: true });
      const sharedUserId = sharedAccountRegistry.getDefaultUserId();
      const sharedUsername = sharedAccountRegistry.getDefaultUsername();
      expect(sharedUserId).not.toBeNull();
      expect(sharedUsername).toBe('shared-user');

      const { mockFn: createCapture, captured: createCaptured } = createCapturingCreateWorktreeMock(WORKTREE_PATH);
      (mockWorktreeService as unknown as { createWorktree: typeof createCapture }).createWorktree = createCapture;

      const { mockFn: sessionCapture, captured: sessionCaptured } = createCapturingSessionMock();

      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: mockAgentManager,
          sessionManager: { createSession: sessionCapture } as unknown as SessionManager,
          broadcastToApp: () => {},
          suggestSessionMetadata: mock(async () => ({ branch: '', title: '', error: 'unused' })),
          sharedAccountRegistry,
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(`/api/repositories/${TEST_REPO.id}/worktrees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: 'task-1286-enabled',
          mode: 'custom',
          branch: 'feature/shared-enabled',
          baseBranch: 'main',
          useRemote: false,
          autoStartSession: true,
          agentId: 'claude-code-builtin',
          shared: true,
        }),
      });

      expect(res.status).toBe(202);

      // createWorktree signature: (repoPath, branch, repoId, baseBranch, requestUsername)
      const createArgs = await createCaptured;
      expect(createArgs[4]).toBe(sharedUsername);

      // sessionManager.createSession signature: (sessionParams, context)
      const sessionArgs = await sessionCaptured;
      const context = sessionArgs[1] as { createdBy?: string; initiatedBy?: string };
      expect(context.createdBy).toBe(sharedUserId!);
      expect(context.initiatedBy).toBe(TEST_AUTH_USER.id);
    });

    it('shared:true + registry enabled -> prompt-mode suggestSessionMetadata receives the shared account username', async () => {
      const sharedAccountRegistry = await createSharedAccountRegistry({ enabled: true });
      const sharedUsername = sharedAccountRegistry.getDefaultUsername();

      const { mockFn: createCapture } = createCapturingWorktreeMockShortCircuit();

      let resolveSuggestionCall!: (args: unknown[]) => void;
      const suggestionCaptured = new Promise<unknown[]>((resolve) => {
        resolveSuggestionCall = resolve;
      });
      const suggestionMock = mock((...args: unknown[]) => {
        resolveSuggestionCall(args);
        return Promise.resolve({ branch: undefined, title: undefined, error: 'short-circuit for test' });
      });

      (mockWorktreeService as unknown as { createWorktree: typeof createCapture }).createWorktree = createCapture;

      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: mockAgentManager,
          sessionManager: { createSession: mock() } as unknown as SessionManager,
          broadcastToApp: () => {},
          suggestSessionMetadata: suggestionMock as unknown as Parameters<typeof asAppContext>[0]['suggestSessionMetadata'],
          sharedAccountRegistry,
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(`/api/repositories/${TEST_REPO.id}/worktrees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: 'task-1286-prompt-shared',
          mode: 'prompt',
          initialPrompt: 'Add a shared-session feature',
          baseBranch: 'main',
          useRemote: false,
          autoStartSession: false,
          agentId: 'claude-code-builtin',
          shared: true,
        }),
      });

      expect(res.status).toBe(202);

      const args = await suggestionCaptured;
      const req = args[0] as { requestUser: string | null };
      expect(req.requestUser).toBe(sharedUsername);
    });

    it('default (no shared field) -> personal ownership (createdBy = authUser, initiatedBy undefined)', async () => {
      const sharedAccountRegistry = await createSharedAccountRegistry({ enabled: true });

      const { mockFn: createCapture, captured: createCaptured } = createCapturingCreateWorktreeMock(WORKTREE_PATH);
      (mockWorktreeService as unknown as { createWorktree: typeof createCapture }).createWorktree = createCapture;

      const { mockFn: sessionCapture, captured: sessionCaptured } = createCapturingSessionMock();

      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: mockAgentManager,
          sessionManager: { createSession: sessionCapture } as unknown as SessionManager,
          broadcastToApp: () => {},
          suggestSessionMetadata: mock(async () => ({ branch: '', title: '', error: 'unused' })),
          sharedAccountRegistry,
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(`/api/repositories/${TEST_REPO.id}/worktrees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: 'task-1286-default',
          mode: 'custom',
          branch: 'feature/personal',
          baseBranch: 'main',
          useRemote: false,
          autoStartSession: true,
          agentId: 'claude-code-builtin',
        }),
      });

      expect(res.status).toBe(202);

      const createArgs = await createCaptured;
      // requestUsername forwarded to createWorktree must be the authenticated
      // user's OS username, unaffected by the (enabled but unused) registry.
      expect(createArgs[4]).toBe('testuser');

      const sessionArgs = await sessionCaptured;
      const context = sessionArgs[1] as { createdBy?: string; initiatedBy?: string };
      expect(context.createdBy).toBe(TEST_AUTH_USER.id);
      expect(context.initiatedBy).toBeUndefined();
    });

    /** Short-circuit variant used by the prompt-mode suggestion test, mirroring createCapturingWorktreeMock above. */
    function createCapturingWorktreeMockShortCircuit() {
      const mockFn = mock(() => Promise.resolve({ worktreePath: '', error: 'short-circuit for test' }));
      return { mockFn };
    }
  });

  // =========================================================================
  // POST /api/repositories/:id/worktrees (Issue #1038: embedded-agent
  // selection as the initial worker)
  // =========================================================================

  describe('POST /api/repositories/:id/worktrees (Issue #1038 embedded-agent selection)', () => {
    // Widened (agent-surface migration PR-B) so this mock can also serve as
    // the `terminal` surface of a real `AgentDirectory` -- the route's
    // embedded-agent validation now reads `agentDirectory.get('embedded', ...)`
    // instead of `embeddedAgentManager.getEmbeddedAgent(...)`, and the
    // `AgentDirectory` constructor requires a working `AgentSurface` for
    // every kind at construction time (compile-time exhaustiveness gate).
    const getAgent = mock(() => ({ id: 'claude-code-builtin', name: 'Claude Code' }));
    const mockAgentManager = {
      getAgent,
      kind: 'terminal' as const,
      list: () => [],
      get: () => {
        const agent = getAgent();
        return agent ? { kind: 'terminal' as const, agent } : undefined;
      },
      findByName: () => [],
    } as unknown as Parameters<typeof asAppContext>[0]['agentManager'];

    // Widened the same way as mockAgentManager above, so it can serve as the
    // `embedded` surface of a real `AgentDirectory`.
    function createMockEmbeddedAgentManager(knownId: string) {
      const getEmbeddedAgent = mock((id: string) =>
        id === knownId ? { id: knownId, name: 'My Embedded Agent' } : undefined,
      );
      return {
        getEmbeddedAgent,
        kind: 'embedded' as const,
        list: () => [],
        get: (id: string) => {
          const agent = getEmbeddedAgent(id);
          return agent ? { kind: 'embedded' as const, agent } : undefined;
        },
        findByName: () => [],
      } as unknown as Parameters<typeof asAppContext>[0]['embeddedAgentManager'];
    }

    // mockAgentManager / createMockEmbeddedAgentManager are cast to the real
    // AgentManager / EmbeddedAgentManager classes above (both of which
    // `implements AgentSurface<K>`, agent-surface migration PR-A), so they
    // are directly assignable here without further casting. The trailing
    // `!` strips the `| undefined` that `Parameters<typeof asAppContext>`
    // widens to (asAppContext's param type is a Partial<AppContext>) -- the
    // mocks above always construct a real object, never undefined.
    function createAgentDirectory(knownEmbeddedId: string) {
      return new AgentDirectory({
        terminal: mockAgentManager!,
        embedded: createMockEmbeddedAgentManager(knownEmbeddedId)!,
      });
    }

    /**
     * The route kicks off worktree creation in a fire-and-forget IIFE that
     * eventually calls `sessionManager.createSession`. Mirror
     * `createCapturingWorktreeMock` above: the mock resolves a promise the
     * test awaits before asserting, instead of polling with `Bun.sleep(0)`.
     */
    function createCapturingSessionMock() {
      let resolveCall!: (args: unknown[]) => void;
      const captured = new Promise<unknown[]>((resolve) => {
        resolveCall = resolve;
      });
      const mockFn = mock((...args: unknown[]) => {
        resolveCall(args);
        return Promise.resolve(undefined);
      });
      return { mockFn, captured };
    }

    it('returns 400 when embeddedAgentId references an unknown embedded agent', async () => {
      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: mockAgentManager,
          embeddedAgentManager: createMockEmbeddedAgentManager('known-embedded-agent'),
          agentDirectory: createAgentDirectory('known-embedded-agent'),
          sessionManager: { createSession: mock() } as unknown as SessionManager,
          broadcastToApp: () => {},
          suggestSessionMetadata: mock(async () => ({ branch: '', title: '', error: 'unused' })),
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: 'task-issue-1038-unknown',
            mode: 'custom',
            branch: 'issue-1038-feature',
            baseBranch: 'main',
            useRemote: false,
            autoStartSession: false,
            embeddedAgentId: 'unknown-embedded-agent',
          }),
        },
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Embedded agent not found: unknown-embedded-agent');
    });

    it('forwards embeddedAgentId to createWorktreeWithSession with agentId undefined (happy path)', async () => {
      const { mockFn: createSessionMock, captured } = createCapturingSessionMock();
      (mockWorktreeService as unknown as { createWorktree: ReturnType<typeof mock> }).createWorktree =
        mock(() => Promise.resolve({ worktreePath: WORKTREE_PATH, index: 1 }));

      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: mockAgentManager,
          embeddedAgentManager: createMockEmbeddedAgentManager('known-embedded-agent'),
          agentDirectory: createAgentDirectory('known-embedded-agent'),
          sessionManager: { createSession: createSessionMock } as unknown as SessionManager,
          broadcastToApp: () => {},
          suggestSessionMetadata: mock(async () => ({ branch: '', title: '', error: 'unused' })),
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: 'task-issue-1038-happy',
            mode: 'custom',
            branch: 'issue-1038-feature',
            baseBranch: 'main',
            useRemote: false,
            embeddedAgentId: 'known-embedded-agent',
          }),
        },
      );

      expect(res.status).toBe(202);

      await captured; // resolves as soon as createSession is invoked -- no sleep needed

      expect(createSessionMock).toHaveBeenCalledTimes(1);
      const sessionRequest = createSessionMock.mock.calls[0]![0] as unknown as {
        agentId?: string;
        embeddedAgentId?: string;
      };
      expect(sessionRequest.embeddedAgentId).toBe('known-embedded-agent');
      expect(sessionRequest.agentId).toBeUndefined();
    });

    it('regression: agentId-only request still forwards agentId with embeddedAgentId undefined', async () => {
      const { mockFn: createSessionMock, captured } = createCapturingSessionMock();
      (mockWorktreeService as unknown as { createWorktree: ReturnType<typeof mock> }).createWorktree =
        mock(() => Promise.resolve({ worktreePath: WORKTREE_PATH, index: 1 }));

      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: mockAgentManager,
          embeddedAgentManager: createMockEmbeddedAgentManager('known-embedded-agent'),
          sessionManager: { createSession: createSessionMock } as unknown as SessionManager,
          broadcastToApp: () => {},
          suggestSessionMetadata: mock(async () => ({ branch: '', title: '', error: 'unused' })),
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: 'task-issue-1038-regression',
            mode: 'custom',
            branch: 'issue-1038-regression-feature',
            baseBranch: 'main',
            useRemote: false,
            agentId: 'claude-code-builtin',
          }),
        },
      );

      expect(res.status).toBe(202);

      await captured; // resolves as soon as createSession is invoked -- no sleep needed

      expect(createSessionMock).toHaveBeenCalledTimes(1);
      const sessionRequest = createSessionMock.mock.calls[0]![0] as unknown as {
        agentId?: string;
        embeddedAgentId?: string;
      };
      expect(sessionRequest.agentId).toBe('claude-code-builtin');
      expect(sessionRequest.embeddedAgentId).toBeUndefined();
    });

    it('forwards model and reasoningEffort to createWorktreeWithSession (Issue #1541)', async () => {
      const { mockFn: createSessionMock, captured } = createCapturingSessionMock();
      (mockWorktreeService as unknown as { createWorktree: ReturnType<typeof mock> }).createWorktree =
        mock(() => Promise.resolve({ worktreePath: WORKTREE_PATH, index: 1 }));

      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: mockAgentManager,
          embeddedAgentManager: createMockEmbeddedAgentManager('known-embedded-agent'),
          sessionManager: { createSession: createSessionMock } as unknown as SessionManager,
          broadcastToApp: () => {},
          suggestSessionMetadata: mock(async () => ({ branch: '', title: '', error: 'unused' })),
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: 'task-issue-1541-model',
            mode: 'custom',
            branch: 'issue-1541-feature',
            baseBranch: 'main',
            useRemote: false,
            agentId: 'claude-code-builtin',
            model: 'claude-opus-4-6',
            reasoningEffort: 'high',
          }),
        },
      );

      expect(res.status).toBe(202);

      await captured; // resolves as soon as createSession is invoked -- no sleep needed

      expect(createSessionMock).toHaveBeenCalledTimes(1);
      const sessionRequest = createSessionMock.mock.calls[0]![0] as unknown as {
        model?: string;
        reasoningEffort?: string;
      };
      expect(sessionRequest.model).toBe('claude-opus-4-6');
      expect(sessionRequest.reasoningEffort).toBe('high');
    });

    it('regression: no-agent-specified request still defaults agentId with embeddedAgentId undefined', async () => {
      const { mockFn: createSessionMock, captured } = createCapturingSessionMock();
      (mockWorktreeService as unknown as { createWorktree: ReturnType<typeof mock> }).createWorktree =
        mock(() => Promise.resolve({ worktreePath: WORKTREE_PATH, index: 1 }));

      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: mockAgentManager,
          embeddedAgentManager: createMockEmbeddedAgentManager('known-embedded-agent'),
          sessionManager: { createSession: createSessionMock } as unknown as SessionManager,
          broadcastToApp: () => {},
          suggestSessionMetadata: mock(async () => ({ branch: '', title: '', error: 'unused' })),
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: 'task-issue-1038-default',
            mode: 'custom',
            branch: 'issue-1038-default-feature',
            baseBranch: 'main',
            useRemote: false,
          }),
        },
      );

      expect(res.status).toBe(202);

      await captured; // resolves as soon as createSession is invoked -- no sleep needed

      expect(createSessionMock).toHaveBeenCalledTimes(1);
      const sessionRequest = createSessionMock.mock.calls[0]![0] as unknown as {
        agentId?: string;
        embeddedAgentId?: string;
      };
      // No agentId in request body -> selectedAgentId falls back to
      // CLAUDE_CODE_AGENT_ID (route default), forwarded unchanged.
      expect(sessionRequest.agentId).toBe('claude-code-builtin');
      expect(sessionRequest.embeddedAgentId).toBeUndefined();
    });
  });

  // =========================================================================
  // POST /api/repositories/:id/worktrees (Issue #1061: prompt mode +
  // embedded-agent combination)
  // =========================================================================

  describe('POST /api/repositories/:id/worktrees (Issue #1061 prompt mode + embedded-agent combination)', () => {
    /**
     * The route's worktree creation runs in a fire-and-forget background
     * promise; short-circuit it with an error result so the test only
     * needs to observe that the suggester ran, not the full success path.
     */
    function createCapturingWorktreeMock() {
      const mockFn = mock(() => Promise.resolve({ worktreePath: '', error: 'short-circuit for test' }));
      return { mockFn };
    }

    // Widened (agent-surface migration PR-B) so this mock can also serve as
    // the `embedded` surface of a real `AgentDirectory` -- the route's
    // embedded-agent validation now reads `agentDirectory.get('embedded', ...)`.
    function createMockEmbeddedAgentManager(knownId: string) {
      const getEmbeddedAgent = mock((id: string) =>
        id === knownId ? { id: knownId, name: 'My Embedded Agent' } : undefined,
      );
      return {
        getEmbeddedAgent,
        kind: 'embedded' as const,
        list: () => [],
        get: (id: string) => {
          const agent = getEmbeddedAgent(id);
          return agent ? { kind: 'embedded' as const, agent } : undefined;
        },
        findByName: () => [],
      } as unknown as Parameters<typeof asAppContext>[0]['embeddedAgentManager'];
    }

    /**
     * Unlike the fixed-id mock used elsewhere in this file, this manager
     * echoes back whatever id it was asked for. That distinguishes which
     * terminal agent id the route actually resolved and forwarded to
     * `suggestSessionMetadata`, rather than always observing a single
     * hardcoded id regardless of the route's fallback logic.
     */
    function createEchoingAgentManager() {
      return {
        getAgent: mock((id: string) => ({ id, name: 'Mock Agent' })),
      } as unknown as Parameters<typeof asAppContext>[0]['agentManager'];
    }

    /**
     * The route's terminal-agent resolution (`agentManager.getAgent(...)`,
     * feeding `suggestSessionMetadata`) is untouched by the agent-surface
     * migration and still reads `createEchoingAgentManager()` directly, not
     * `agentDirectory`. This test only needs `agentDirectory`'s `embedded`
     * surface (for the `embeddedAgentId` existence check), so the `terminal`
     * surface here is an unused stub satisfying the constructor's
     * compile-time exhaustiveness gate.
     */
    const emptyTerminalSurface = {
      kind: 'terminal' as const,
      list: () => [],
      get: () => undefined,
      findByName: () => [],
    };

    /**
     * Mirrors the capture helpers used elsewhere in this file: resolve a
     * promise with the call args so the test can await the fire-and-forget
     * IIFE deterministically, and short-circuit so the downstream success
     * path does not need to be mocked further.
     */
    function createCapturingSuggestionMock() {
      let resolveCall!: (args: unknown[]) => void;
      const captured = new Promise<unknown[]>((resolve) => {
        resolveCall = resolve;
      });
      const mockFn = mock((...args: unknown[]) => {
        resolveCall(args);
        return Promise.resolve({ branch: undefined, title: undefined, error: 'short-circuit for test' });
      });
      return { mockFn, captured };
    }

    it('resolves the terminal agent fallback for suggestSessionMetadata when the initial worker uses an embedded agent', async () => {
      const { mockFn: suggestionMock, captured } = createCapturingSuggestionMock();

      const { mockFn: createCapture } = createCapturingWorktreeMock();
      (mockWorktreeService as unknown as { createWorktree: typeof createCapture }).createWorktree = createCapture;

      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: createEchoingAgentManager(),
          embeddedAgentManager: createMockEmbeddedAgentManager('known-embedded-agent'),
          agentDirectory: new AgentDirectory({
            terminal: emptyTerminalSurface,
            embedded: createMockEmbeddedAgentManager('known-embedded-agent')!,
          }),
          sessionManager: { createSession: mock() } as unknown as SessionManager,
          broadcastToApp: () => {},
          suggestSessionMetadata: suggestionMock as unknown as Parameters<typeof asAppContext>[0]['suggestSessionMetadata'],
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: 'task-issue-1061-embedded',
            mode: 'prompt',
            initialPrompt: 'Add a dark mode toggle',
            baseBranch: 'main',
            useRemote: false,
            autoStartSession: false,
            embeddedAgentId: 'known-embedded-agent',
          }),
        },
      );

      expect(res.status).toBe(202);

      const args = await captured;
      const req = args[0] as { agent: { id: string } };
      expect(req.agent.id).toBe(CLAUDE_CODE_AGENT_ID);
    });

    it('regression: an explicit non-default agentId is still forwarded to suggestSessionMetadata unchanged', async () => {
      const { mockFn: suggestionMock, captured } = createCapturingSuggestionMock();

      const { mockFn: createCapture } = createCapturingWorktreeMock();
      (mockWorktreeService as unknown as { createWorktree: typeof createCapture }).createWorktree = createCapture;

      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: createEchoingAgentManager(),
          sessionManager: { createSession: mock() } as unknown as SessionManager,
          broadcastToApp: () => {},
          suggestSessionMetadata: suggestionMock as unknown as Parameters<typeof asAppContext>[0]['suggestSessionMetadata'],
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: 'task-issue-1061-explicit',
            mode: 'prompt',
            initialPrompt: 'Add a dark mode toggle',
            baseBranch: 'main',
            useRemote: false,
            autoStartSession: false,
            agentId: 'custom-terminal-agent',
          }),
        },
      );

      expect(res.status).toBe(202);

      const args = await captured;
      const req = args[0] as { agent: { id: string } };
      expect(req.agent.id).toBe('custom-terminal-agent');
      expect(req.agent.id).not.toBe(CLAUDE_CODE_AGENT_ID);
    });
  });

  // =========================================================================
  // POST /api/repositories/:id/worktrees/pull
  // =========================================================================

  describe('POST /api/repositories/:id/worktrees/pull', () => {
    const pullRequest = (worktreePath: string, taskId = 'task-1') => ({
      method: 'POST' as const,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktreePath, taskId }),
    });

    it('should return 404 for unknown repository', async () => {
      const res = await app.request(
        '/api/repositories/unknown-id/worktrees/pull',
        pullRequest(WORKTREE_PATH),
      );

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Repository');
    });

    it('should return 400 when worktreePath is outside managed directory', async () => {
      const outsidePath = '/outside/managed/dir';
      // Create the directory in memfs so stat succeeds
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${REPO_PATH}/.keep`]: '',
        [`${WORKTREE_PATH}/.keep`]: '',
        [`${outsidePath}/.keep`]: '',
      });

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(outsidePath),
      );

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('outside managed directory');
    });

    it('should return 400 for path traversal attempt', async () => {
      // Attempt to escape via /../
      const traversalPath = `${TEST_CONFIG_DIR}/repositories/owner/repo/worktrees/wt-1/../../../../../../etc/passwd`;

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(traversalPath),
      );

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      // resolvePath normalizes the traversal, so it ends up outside managed dir
      expect(body.error).toContain('outside managed directory');
    });

    it('should return 400 when isWorktreeOf returns false', async () => {
      (mockWorktreeService.isWorktreeOf as ReturnType<typeof mock>)
        .mockImplementation(() => Promise.resolve(false));

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(WORKTREE_PATH),
      );

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Invalid worktree path');
    });

    it('should return 400 when worktree directory does not exist', async () => {
      const nonexistentPath = `${REPO_PATH}/worktrees/does-not-exist`;

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(nonexistentPath),
      );

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('does not exist');
    });

    it('should return 400 for detached HEAD', async () => {
      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('(detached)'));

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(WORKTREE_PATH),
      );

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('detached HEAD');
    });

    it('should return 409 for concurrent pull guard', async () => {
      _getPullsInProgress().add(WORKTREE_PATH);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(WORKTREE_PATH),
      );

      expect(res.status).toBe(409);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('already in progress');
    });

    it('should return 409 when deletion is in progress', async () => {
      _getDeletionsInProgress().add(WORKTREE_PATH);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(WORKTREE_PATH),
      );

      expect(res.status).toBe(409);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('being deleted');
    });

    it('should return 202 for valid pull request', async () => {
      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(WORKTREE_PATH),
      );

      expect(res.status).toBe(202);

      const body = (await res.json()) as { accepted: boolean };
      expect(body.accepted).toBe(true);
    });

    it('forwards authUser.username as requestUser to pullFastForward', async () => {
      // The pull is fire-and-forget; observe the pullFastForward invocation
      // deterministically by resolving a captured-args promise from inside
      // the mock. The default SingleUserMode used by asAppContext is
      // constructed with TEST_AUTH_USER (username='testuser'), so the route
      // MUST forward 'testuser' as the 2nd positional arg. Without this,
      // multi-user pull of an SSH-URL remote fails with Permission denied
      // because the git process runs as the server user rather than the
      // requesting user (no SSH_AUTH_SOCK, no gh auth token).
      let resolveCall!: (args: unknown[]) => void;
      const captured = new Promise<unknown[]>((resolve) => {
        resolveCall = resolve;
      });
      mockGit.pullFastForward.mockImplementation((...args: unknown[]) => {
        resolveCall(args);
        return Promise.resolve(0);
      });

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(WORKTREE_PATH),
      );

      expect(res.status).toBe(202);

      const args = await captured;
      expect(args[0]).toBe(WORKTREE_PATH);
      expect(args[1]).toBe('testuser');
    });

    it('should return 202 even when background pull encounters an error', async () => {
      // Simulate pullFastForward throwing — the fire-and-forget IIFE's
      // internal try-catch handles it, and the outer .catch() guards
      // against any unexpected escapes. Either way, the HTTP response
      // is 202 Accepted because it returns before the async work runs.
      mockGit.pullFastForward.mockImplementation(() => Promise.reject(new Error('network timeout')));

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(WORKTREE_PATH),
      );

      expect(res.status).toBe(202);

      const body = (await res.json()) as { accepted: boolean };
      expect(body.accepted).toBe(true);
    });

    it('should allow pull on primary worktree (repo root)', async () => {
      // The primary worktree is the repo root itself, which may be outside
      // the managed worktrees subdirectory. The route skips the boundary
      // check for the primary worktree.
      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(REPO_PATH),
      );

      expect(res.status).toBe(202);

      const body = (await res.json()) as { accepted: boolean };
      expect(body.accepted).toBe(true);

      // isWorktreeOf should NOT have been called for the primary worktree
      expect(mockWorktreeService.isWorktreeOf).not.toHaveBeenCalled();
    });

    it('should return 400 for missing worktreePath', async () => {
      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: 'task-1' }),
        },
      );

      expect(res.status).toBe(400);
    });

    it('should return 400 for empty worktreePath', async () => {
      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreePath: '   ', taskId: 'task-1' }),
        },
      );

      expect(res.status).toBe(400);
    });

    it('should return 400 for missing taskId', async () => {
      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreePath: WORKTREE_PATH }),
        },
      );

      expect(res.status).toBe(400);
    });

    it('should return 400 for empty taskId', async () => {
      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreePath: WORKTREE_PATH, taskId: '' }),
        },
      );

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // DELETE /api/repositories/:id/worktrees/*
  // =========================================================================

  describe('DELETE /api/repositories/:id/worktrees/*', () => {
    const encodedPath = (wtPath: string) => encodeURIComponent(wtPath);

    it('should return 409 when deletion already in progress', async () => {
      _getDeletionsInProgress().add(WORKTREE_PATH);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/${encodedPath(WORKTREE_PATH)}`,
        { method: 'DELETE' },
      );

      expect(res.status).toBe(409);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Deletion already in progress');
    });

    it('should return 409 when pull is in progress', async () => {
      _getPullsInProgress().add(WORKTREE_PATH);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/${encodedPath(WORKTREE_PATH)}`,
        { method: 'DELETE' },
      );

      expect(res.status).toBe(409);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Pull is in progress');
    });

    it('should return 400 for empty worktree path', async () => {
      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/`,
        { method: 'DELETE' },
      );

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('required');
    });

    it('forwards authUser.username to findOpenPullRequest via deleteWorktree (Issue #885)', async () => {
      // The DELETE handler must thread authUser.username into deleteWorktree's
      // params (`requestUsername`), which deleteWorktree then forwards to the
      // injected `findOpenPullRequest` as the 3rd positional arg so the gh
      // CLI elevation in github-pr-service receives the requesting user.
      // The default SingleUserMode used by asAppContext is constructed with
      // TEST_AUTH_USER (username='testuser'), so we assert 'testuser' lands.
      const mockFindOpenPullRequest = mock<
        (branch: string, cwd: string, requestUsername: string | null) =>
          Promise<{ number: number; title: string } | null>
      >(async () => null);

      const mockSessionManager = {
        getAllSessions: () => [],
        killSessionWorkers: mock(() => Promise.resolve()),
        deleteSession: mock(() => Promise.resolve(true)),
      } as unknown as SessionManager;

      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          sessionManager: mockSessionManager,
          findOpenPullRequest: mockFindOpenPullRequest,
          broadcastToApp: () => {},
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      // Sync deletion path (no taskId) so we can await the result and assert.
      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/${encodedPath(WORKTREE_PATH)}`,
        { method: 'DELETE' },
      );

      expect(res.status).toBe(200);
      expect(mockFindOpenPullRequest).toHaveBeenCalledTimes(1);
      const [, , requestUsername] = mockFindOpenPullRequest.mock.calls[0];
      expect(requestUsername).toBe('testuser');
    });

    // =======================================================================
    // Async mode (?async=true), driven through a real JobQueue (Issue #1327)
    // =======================================================================
    //
    // The route no longer processes anything in the background -- it just
    // enqueues a `worktree:delete` job and returns. `testJobQueue` is backed
    // by a standalone in-memory database and is NEVER `.start()`ed, so
    // enqueued jobs stay `pending`; tests drive the handler deterministically
    // via `driveEnqueuedWorktreeDeleteJob` instead of racing a background
    // timer (mirrors `repository-manager.test.ts`'s
    // `runLatestCleanupRepositoryJob` pattern).
    describe('async mode (?async=true) via job queue (Issue #1327)', () => {
      let testDb: Kysely<Database> | null = null;
      let testJobQueue: JobQueue | null = null;

      beforeEach(async () => {
        testDb = await createDatabaseForTest();
        testJobQueue = new JobQueue(testDb);
      });

      afterEach(async () => {
        if (testJobQueue) {
          await testJobQueue.stop();
          testJobQueue = null;
        }
        if (testDb) {
          await testDb.destroy();
          testDb = null;
        }
      });

      /**
       * Fetch the single enqueued `worktree:delete` job's payload and run it
       * through the REAL `registerWorktreeDeleteJobHandler` handler (not a
       * re-implementation), via a capture-only fake queue -- same harness
       * shape as `jobs/__tests__/handlers.test.ts` and
       * `repository-manager.test.ts`'s `runLatestCleanupRepositoryJob`.
       */
      async function driveEnqueuedWorktreeDeleteJob(
        sessionManager: SessionManager,
        broadcastToApp: (msg: AppServerMessage) => void,
      ): Promise<void> {
        const jobs = await testJobQueue!.getJobs({ type: 'worktree:delete' });
        expect(jobs.length).toBe(1);
        const payload = JSON.parse(jobs[0]!.payload) as WorktreeDeletePayload;

        const handlers = new Map<string, JobHandler<unknown>>();
        const fakeQueue = {
          registerHandler: <T>(type: string, handler: JobHandler<T>) => {
            handlers.set(type, handler as JobHandler<unknown>);
          },
        } as unknown as JobQueue;

        registerWorktreeDeleteJobHandler(fakeQueue, {
          deletionDeps: {
            worktreeService: mockWorktreeService,
            sessionManager,
            repositoryManager: mockRepositoryManager,
            findOpenPullRequest: async () => null,
            getCurrentBranch: async () => 'feature-branch',
          },
          broadcastToApp,
        });

        const handler = handlers.get('worktree:delete')!;
        await handler(payload);
      }

      it('should return 409 when deletion already in progress and must not enqueue a job', async () => {
        _getDeletionsInProgress().add(WORKTREE_PATH);

        app = new Hono<AppBindings>();
        app.use('*', async (c, next) => {
          c.set('appContext', asAppContext({
            repositoryManager: mockRepositoryManager,
            worktreeService: mockWorktreeService,
            jobQueue: testJobQueue!,
          }));
          await next();
        });
        app.onError(onApiError);
        app.route('/api', api);

        const res = await app.request(
          `/api/repositories/${TEST_REPO.id}/worktrees/${encodedPath(WORKTREE_PATH)}?async=true`,
          { method: 'DELETE' },
        );

        expect(res.status).toBe(409);
        const jobs = await testJobQueue!.getJobs({ type: 'worktree:delete' });
        expect(jobs.length).toBe(0);
      });

      it('should return 409 when pull is in progress and must not enqueue a job', async () => {
        _getPullsInProgress().add(WORKTREE_PATH);

        app = new Hono<AppBindings>();
        app.use('*', async (c, next) => {
          c.set('appContext', asAppContext({
            repositoryManager: mockRepositoryManager,
            worktreeService: mockWorktreeService,
            jobQueue: testJobQueue!,
          }));
          await next();
        });
        app.onError(onApiError);
        app.route('/api', api);

        const res = await app.request(
          `/api/repositories/${TEST_REPO.id}/worktrees/${encodedPath(WORKTREE_PATH)}?async=true`,
          { method: 'DELETE' },
        );

        expect(res.status).toBe(409);
        const jobs = await testJobQueue!.getJobs({ type: 'worktree:delete' });
        expect(jobs.length).toBe(0);
      });

      it('should broadcast worktree-deletion-completed with empty sessionIds when repository is unregistered (orphan async path, refs #815, #1327)', async () => {
        // Refs #815. When the repository row is missing from the in-memory
        // registry (e.g., the primary repo dir was deleted out-of-band so
        // RepositoryManager.initialize() skipped it), the worktree has lost
        // its anchor. The deletion service routes into git-less orphan
        // cleanup and the handler must emit a SUCCESS broadcast — not
        // failure — with the worktree's session IDs (here: [] because no
        // sessions were registered against this orphaned worktree).
        const broadcasts: AppServerMessage[] = [];

        const mockSessionManager = {
          getAllSessions: () => [],
          killSessionWorkers: mock(() => Promise.resolve()),
          deleteSession: mock(() => Promise.resolve(true)),
        } as unknown as SessionManager;

        app = new Hono<AppBindings>();
        app.use('*', async (c, next) => {
          c.set('appContext', asAppContext({
            repositoryManager: mockRepositoryManager,
            worktreeService: mockWorktreeService,
            sessionManager: mockSessionManager,
            jobQueue: testJobQueue!,
          }));
          await next();
        });
        app.onError(onApiError);
        app.route('/api', api);

        const unknownRepoId = 'non-existent-repo-id';
        const res = await app.request(
          `/api/repositories/${unknownRepoId}/worktrees/${encodedPath(WORKTREE_PATH)}?async=true`,
          { method: 'DELETE' },
        );

        // Async path returns 202 immediately with the server-generated jobId.
        expect(res.status).toBe(202);
        const body = (await res.json()) as { accepted: boolean; jobId: string };
        expect(body.accepted).toBe(true);
        expect(typeof body.jobId).toBe('string');
        expect(body.jobId.length).toBeGreaterThan(0);

        // The job was enqueued with maxAttempts: 1 -- deletion must not be
        // silently retried.
        const job = await testJobQueue!.getJob(body.jobId);
        expect(job).not.toBeNull();
        expect(job!.type).toBe('worktree:delete');
        expect(job!.max_attempts).toBe(1);
        expect(job!.status).toBe('pending');

        // Nothing has run yet -- testJobQueue is never started. Drive the
        // handler deterministically.
        await driveEnqueuedWorktreeDeleteJob(mockSessionManager, (msg) => broadcasts.push(msg));

        const completedBroadcasts = broadcasts.filter(
          (b): b is Extract<AppServerMessage, { type: 'worktree-deletion-completed' }> =>
            b.type === 'worktree-deletion-completed' && b.taskId === body.jobId,
        );
        expect(completedBroadcasts.length).toBe(1);
        expect(completedBroadcasts[0].sessionIds).toEqual([]);

        // No failure should be emitted for the orphan path.
        const failedBroadcasts = broadcasts.filter(
          (b) => b.type === 'worktree-deletion-failed' && b.taskId === body.jobId,
        );
        expect(failedBroadcasts.length).toBe(0);

        // The git-less helper must be the one that ran (not the git-bound
        // removeWorktree). The payload threads `authUser.username`
        // ('testuser' in the test fixture) down to the helper for Issue
        // #882 multi-user elevation. In single-user mode `runAsUser`
        // ignores the value, but the payload still carries it -- this
        // assertion is the boundary test that proves the enqueue closes
        // the threading gap end-to-end.
        expect(mockWorktreeService.removeOrphanedWorktree).toHaveBeenCalledWith(WORKTREE_PATH, 'testuser');
        expect(mockWorktreeService.removeWorktree).not.toHaveBeenCalled();
      });
    });
  });
});
