import { describe, it, expect as bunExpect, mock, beforeEach, afterAll, afterEach, spyOn } from 'bun:test';
import {
  fetchConfig,
  createSession,
  getSession,
  deleteSession,
  createWorker,
  deleteWorker,
  restartAgentWorker,
  restartWorkerAsEmbeddedAgent,
  restartAllAgentWorkers,
  updateEmbeddedAgentWorker,
  setMcpServerPermissions,
  fetchRepositories,
  registerRepository,
  updateRepository,
  registerAgent,
  updateAgent,
  unregisterRepository,
  fetchRepository,
  fetchWorkers,
  fetchWorktrees,
  fetchBranches,
  fetchAgents,
  fetchSessionBranches,
  fetchBranchCommits,
  fetchGitHubIssue,
  fetchSessionPrLink,
  getRemoteBranchStatus,
  fetchCloneJobStatus,
  validateSessions,
  fetchSessionMemo,
  updateSessionMemo,
  fetchRepositorySlackIntegration,
  fetchNotificationStatus,
  fetchReviewQueue,
  fetchAgent,
  fetchMessageTemplates,
  fetchSkills,
  fetchCurrentUser,
  generateRepositoryDescription,
  resumeSession,
  openInVSCode,
  fetchArtifacts,
  fetchTodos,
  createTodo,
  updateTodo,
  resolveTodo,
  dismissTodo,
  deleteTodo,
  fetchUsers,
  deleteArtifact,
  fetchNotifications,
  markNotificationsSeen,
  refreshDefaultBranch,
  raiseOrchestratorDesignation,
  clearOrchestratorDesignation,
  updateSessionMetadata,
  ServerUnavailableError,
  ApiError,
} from '../api';
import * as capabilitiesModule from '../capabilities';
import { UpdateEmbeddedAgentWorkerRequestSchema } from '@agent-console/shared';
import * as v from 'valibot';
import { completeWireBody } from '../../test/wire-fixtures';

// Bun's expect().toEqual() enforces strict generic matching between actual and expected types.
// Tests use partial mock data intentionally (verifying passthrough, not shape), so we wrap
// expect to accept unknown values. This avoids `any` while allowing structural comparison.
const expect = (value: unknown) => bunExpect(value);

// Save original fetch and set up mock
const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

// Restore original fetch after all tests
afterAll(() => {
  globalThis.fetch = originalFetch;
});

// A body-valid quick session (what GET /api/sessions/:id sends inside `{ session }`).
const validQuickSession = {
  id: 's1',
  type: 'quick',
  locationPath: '/path',
  status: 'active',
  activationState: 'running',
  createdAt: '2026-01-01T00:00:00.000Z',
  workers: [],
  isShared: false,
  recoveryState: 'healthy',
};

// Helper to create mock Response
function createMockResponse(body: unknown, options: { status?: number; ok?: boolean } = {}) {
  const { status = 200, ok = true } = options;
  return {
    ok,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: mock(() => Promise.resolve(body)),
  } as unknown as Response;
}

// Helper to get the URL from the fetch call (Hono RPC client may pass URL or Request object)
function getLastFetchUrl(): string {
  const calls = mockFetch.mock.calls as unknown[][];
  const arg = calls[calls.length - 1]?.[0];
  if (typeof arg === 'string') return arg;
  if (arg instanceof URL) return arg.toString();
  if (arg instanceof Request) return arg.url;
  return String(arg);
}

// Helper to get the method from the fetch call
function getLastFetchMethod(): string {
  const calls = mockFetch.mock.calls as unknown[][];
  const arg0 = calls[calls.length - 1]?.[0];
  const arg1 = calls[calls.length - 1]?.[1] as { method?: string } | undefined;
  if (arg0 instanceof Request) return arg0.method;
  return arg1?.method || 'GET';
}

// Helper to get the body from the fetch call
async function getLastFetchBody(): Promise<unknown> {
  const calls = mockFetch.mock.calls as unknown[][];
  const arg0 = calls[calls.length - 1]?.[0];
  const arg1 = calls[calls.length - 1]?.[1] as { body?: string } | undefined;
  if (arg0 instanceof Request) {
    const text = await arg0.text();
    return text ? JSON.parse(text) : undefined;
  }
  return arg1?.body ? JSON.parse(arg1.body) : undefined;
}

/**
 * Asserts a body the client actually sent is accepted by the server's own
 * wire schema (UpdateEmbeddedAgentWorkerRequestSchema). Checks the issues
 * array first so a failure reports the schema's own message text instead of
 * a bare `false`.
 */
function expectAcceptedByWireSchema(body: unknown): void {
  const result = v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, body);
  expect(result.issues?.map((issue) => issue.message) ?? []).toEqual([]);
  expect(result.success).toBe(true);
}

describe('API Client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('fetchConfig', () => {
    it('should fetch config successfully', async () => {
      const mockConfig = {
        homeDir: '/home/user',
        capabilities: {
          vscode: false,
          vscodeOpenMode: 'local-spawn' as const,
          vscodeRemoteHost: null,
        },
        serverPid: 1234,
        serverPort: 3457,
        authMode: 'none' as const,
        sharedAccountsAvailable: false,
        sharedAccountsEnvVarIgnored: false,
        deployedSha: null,
      };
      mockFetch.mockResolvedValue(createMockResponse(mockConfig));

      const result = await fetchConfig();

      // Hono RPC client passes explicit options even for GET requests
      expect((mockFetch.mock.calls as unknown[][])[0]?.[0]).toBe('/api/config');
      expect(result).toEqual(mockConfig);
    });

    it('should throw error on failure', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({}, { status: 500, ok: false })
      );

      await expect(fetchConfig()).rejects.toThrow('Failed to fetch config');
    });
  });

  describe('createSession', () => {
    it('should create worktree session', async () => {
      const mockSession = completeWireBody({ session: { id: '1', type: 'worktree' } });
      mockFetch.mockResolvedValue(createMockResponse(mockSession));

      const result = await createSession({
        type: 'worktree',
        repositoryId: 'repo-1',
        worktreeId: 'main',
        locationPath: '/path/to/worktree',
      });

      expect(getLastFetchUrl()).toContain('/api/sessions');
      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      expect(body).toEqual({
        type: 'worktree',
        repositoryId: 'repo-1',
        worktreeId: 'main',
        locationPath: '/path/to/worktree',
      });
      expect(result).toEqual(mockSession);
    });

    it('should create quick session', async () => {
      const mockSession = completeWireBody({ session: { id: '1', type: 'quick' } });
      mockFetch.mockResolvedValue(createMockResponse(mockSession));

      const result = await createSession({
        type: 'quick',
        locationPath: '/path/to/project',
      });

      expect(getLastFetchUrl()).toContain('/api/sessions');
      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      expect(body).toEqual({
        type: 'quick',
        locationPath: '/path/to/project',
      });
      expect(result).toEqual(mockSession);
    });

    it('should extract error message from JSON response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Detailed error message' })),
      } as unknown as Response);

      await expect(createSession({ type: 'quick', locationPath: '/path' })).rejects.toThrow('Detailed error message');
    });

    it('should fall back to statusText when JSON parsing fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: mock(() => Promise.reject(new Error('Parse error'))),
      } as unknown as Response);

      await expect(createSession({ type: 'quick', locationPath: '/path' })).rejects.toThrow('Internal Server Error');
    });
  });

  describe('getSession', () => {
    it('should return session when exists', async () => {
      const mockSession = { session: validQuickSession };
      mockFetch.mockResolvedValue(createMockResponse(mockSession));

      const result = await getSession('session-id');

      expect(result).toEqual(mockSession.session);
    });

    it('should throw a validation error (not null, not ServerUnavailableError) when a 200 body has no session', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}));

      const error = await getSession('session-id').then(() => null, (e: unknown) => e);

      expect(error instanceof v.ValiError).toBe(true);
    });

    it('should return null when session not found (404)', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({}, { status: 404, ok: false })
      );

      const result = await getSession('non-existent');

      expect(result).toBeNull();
    });

    it('should throw ServerUnavailableError on 5xx errors', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({}, { status: 500, ok: false })
      );

      await expect(getSession('session-id')).rejects.toThrow(ServerUnavailableError);
    });

    it('should throw ServerUnavailableError on network error', async () => {
      mockFetch.mockRejectedValue(new TypeError('Network error'));

      await expect(getSession('session-id')).rejects.toThrow(ServerUnavailableError);
    });
  });

  describe('deleteSession', () => {
    it('should delete session successfully', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await deleteSession('session-id');

      expect(getLastFetchUrl()).toContain('/api/sessions/session-id');
      expect(getLastFetchMethod()).toBe('DELETE');
    });
  });

  describe('raiseOrchestratorDesignation', () => {
    it('should POST to the orchestrator-designation endpoint with the session id', async () => {
      const mockResult = { repositoryId: 'repo-1', orchestratorSessionIds: ['session-id'] };
      mockFetch.mockResolvedValue(createMockResponse(mockResult));

      const result = await raiseOrchestratorDesignation('session-id');

      expect(getLastFetchUrl()).toContain('/api/sessions/session-id/orchestrator-designation');
      expect(getLastFetchMethod()).toBe('POST');
      expect(result).toEqual(mockResult);
    });
  });

  describe('clearOrchestratorDesignation', () => {
    it('should DELETE the orchestrator-designation endpoint with the session id', async () => {
      const mockResult = { repositoryId: 'repo-1', removed: true, orchestratorSessionIds: [] };
      mockFetch.mockResolvedValue(createMockResponse(mockResult));

      const result = await clearOrchestratorDesignation('session-id');

      expect(getLastFetchUrl()).toContain('/api/sessions/session-id/orchestrator-designation');
      expect(getLastFetchMethod()).toBe('DELETE');
      expect(result).toEqual(mockResult);
    });
  });

  describe('createWorker', () => {
    // Note: Client API only supports creating terminal workers
    // Agent workers are created automatically by the server during session creation

    it('should create terminal worker', async () => {
      const mockWorker = completeWireBody({ worker: { id: 'worker-2', type: 'terminal', name: 'Shell 1' } });
      mockFetch.mockResolvedValue(createMockResponse(mockWorker));

      const result = await createWorker('session-id', { type: 'terminal', name: 'Shell 1' });

      expect(getLastFetchUrl()).toContain('/api/sessions/session-id/workers');
      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      expect(body).toEqual({ type: 'terminal', name: 'Shell 1' });
      expect(result).toEqual(mockWorker);
    });
  });

  describe('deleteWorker', () => {
    it('should delete worker successfully', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await deleteWorker('session-id', 'worker-id');

      expect(getLastFetchUrl()).toContain('/api/sessions/session-id/workers/worker-id');
      expect(getLastFetchMethod()).toBe('DELETE');
    });
  });

  describe('restartAgentWorker', () => {
    it('should restart agent worker', async () => {
      const mockWorker = completeWireBody({ worker: { id: 'worker-1', type: 'agent', name: 'Claude' } });
      mockFetch.mockResolvedValue(createMockResponse(mockWorker));

      const result = await restartAgentWorker('session-id', 'worker-id', true);

      expect(getLastFetchUrl()).toContain('/api/sessions/session-id/workers/worker-id/restart');
      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      expect(body).toEqual({ continueConversation: true });
      expect(result).toEqual(mockWorker);
    });

    it('should pass agentId when provided', async () => {
      const mockWorker = completeWireBody({ worker: { id: 'worker-1', type: 'agent', name: 'Custom Agent' } });
      mockFetch.mockResolvedValue(createMockResponse(mockWorker));

      const result = await restartAgentWorker('session-id', 'worker-id', false, 'custom-agent-id');

      expect(getLastFetchUrl()).toContain('/api/sessions/session-id/workers/worker-id/restart');
      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      expect(body).toEqual({ continueConversation: false, agentId: 'custom-agent-id' });
      expect(result).toEqual(mockWorker);
    });

    it('should not include agentId when not provided', async () => {
      const mockWorker = completeWireBody({ worker: { id: 'worker-1', type: 'agent', name: 'Claude' } });
      mockFetch.mockResolvedValue(createMockResponse(mockWorker));

      await restartAgentWorker('session-id', 'worker-id', false);

      const body = await getLastFetchBody();
      expect(body).toEqual({ continueConversation: false });
      expect(body).not.toHaveProperty('agentId');
    });
  });

  describe('restartWorkerAsEmbeddedAgent (cross-type restart, #1171)', () => {
    it('should restart a PTY agent worker as an embedded-agent worker', async () => {
      const mockWorker = completeWireBody({ worker: { id: 'worker-1', type: 'embedded-agent', name: 'Local GPT' } });
      mockFetch.mockResolvedValue(createMockResponse(mockWorker));

      const result = await restartWorkerAsEmbeddedAgent('session-id', 'worker-id', 'embedded-1');

      expect(getLastFetchUrl()).toContain('/api/sessions/session-id/workers/worker-id/restart');
      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      // Distinct wire shape from restartAgentWorker's: no continueConversation,
      // no agentId -- EmbeddedRestartSchema structurally rejects both.
      expect(body).toEqual({ embeddedAgentId: 'embedded-1' });
      expect(body).not.toHaveProperty('continueConversation');
      expect(body).not.toHaveProperty('agentId');
      expect(result).toEqual(mockWorker);
    });

    it('should pass branch when provided', async () => {
      const mockWorker = completeWireBody({ worker: { id: 'worker-1', type: 'embedded-agent', name: 'Local GPT' } });
      mockFetch.mockResolvedValue(createMockResponse(mockWorker));

      await restartWorkerAsEmbeddedAgent('session-id', 'worker-id', 'embedded-1', 'feat/new-branch');

      const body = await getLastFetchBody();
      expect(body).toEqual({ embeddedAgentId: 'embedded-1', branch: 'feat/new-branch' });
    });

    it('should not include branch when not provided', async () => {
      const mockWorker = completeWireBody({ worker: { id: 'worker-1', type: 'embedded-agent', name: 'Local GPT' } });
      mockFetch.mockResolvedValue(createMockResponse(mockWorker));

      await restartWorkerAsEmbeddedAgent('session-id', 'worker-id', 'embedded-1');

      const body = await getLastFetchBody();
      expect(body).not.toHaveProperty('branch');
    });
  });

  describe('restartAllAgentWorkers', () => {
    it('should call restart-all-agents endpoint', async () => {
      const mockResult = { restarted: 2, failed: 0, skipped: 0, results: [] };
      mockFetch.mockResolvedValue(createMockResponse(mockResult));

      const result = await restartAllAgentWorkers();

      expect(getLastFetchUrl()).toContain('/api/sessions/restart-all-agents');
      expect(getLastFetchMethod()).toBe('POST');
      expect(result).toEqual(mockResult);
    });
  });

  describe('updateEmbeddedAgentWorker (agent-surface.md Phase 3, mid-run model/effort override)', () => {
    it('sends the compaction-toggle body unchanged (pre-existing shape)', async () => {
      const mockWorker = completeWireBody({ worker: { id: 'worker-1', type: 'embedded-agent', name: 'Local GPT' } });
      mockFetch.mockResolvedValue(createMockResponse(mockWorker));

      const result = await updateEmbeddedAgentWorker('session-id', 'worker-id', { autoCompaction: true });

      expect(getLastFetchUrl()).toContain('/api/sessions/session-id/workers/worker-id');
      expect(getLastFetchMethod()).toBe('PATCH');
      const body = await getLastFetchBody();
      expect(body).toEqual({ autoCompaction: true });
      expectAcceptedByWireSchema(body);
      expect(result).toEqual(mockWorker);
    });

    it('sends a model override together with its context window (Ruling 4 pairing)', async () => {
      const mockWorker = completeWireBody({ worker: { id: 'worker-1', type: 'embedded-agent', name: 'Local GPT' } });
      mockFetch.mockResolvedValue(createMockResponse(mockWorker));

      await updateEmbeddedAgentWorker('session-id', 'worker-id', {
        model: 'opus',
        contextWindowTokens: 128_000,
        reasoningEffort: 'high',
      });

      expect(getLastFetchMethod()).toBe('PATCH');
      const body = await getLastFetchBody();
      expect(body).toEqual({ model: 'opus', contextWindowTokens: 128_000, reasoningEffort: 'high' });
      expectAcceptedByWireSchema(body);
    });

    it('sends a null context window when the caller declares no window for the model', async () => {
      const mockWorker = completeWireBody({ worker: { id: 'worker-1', type: 'embedded-agent', name: 'Local GPT' } });
      mockFetch.mockResolvedValue(createMockResponse(mockWorker));

      await updateEmbeddedAgentWorker('session-id', 'worker-id', {
        model: 'opus',
        contextWindowTokens: null,
        reasoningEffort: null,
      });

      const body = await getLastFetchBody();
      expect(body).toEqual({ model: 'opus', contextWindowTokens: null, reasoningEffort: null });
      expectAcceptedByWireSchema(body);
    });

    it('clears the override with exactly { model: null, reasoningEffort: null } -- no contextWindowTokens key', async () => {
      const mockWorker = completeWireBody({ worker: { id: 'worker-1', type: 'embedded-agent', name: 'Local GPT' } });
      mockFetch.mockResolvedValue(createMockResponse(mockWorker));

      await updateEmbeddedAgentWorker('session-id', 'worker-id', { model: null, reasoningEffort: null });

      const body = await getLastFetchBody();
      expect(body).toEqual({ model: null, reasoningEffort: null });
      expect(body).not.toHaveProperty('contextWindowTokens');
      expectAcceptedByWireSchema(body);
    });

    // `updateEmbeddedAgentWorker`'s parameter type makes a model-without-window
    // body unconstructible at any call site (Ruling 4 pairing is enforced
    // structurally on the client), so there is no call through the wrapper to
    // pin here -- calling the schema directly is the point: it confirms the
    // wire still agrees with the shape the client type forbids, so a future
    // widening of either side can't drift silently against the other.
    it('rejects a model override sent without contextWindowTokens (agent-surface.md Ruling 4)', () => {
      const result = v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, { model: 'opus' });

      expect(result.success).toBe(false);
      expect(result.issues?.map((issue) => issue.message)).toEqual([
        'setting a model requires contextWindowTokens; pass null to declare no window',
      ]);
    });
  });

  describe('setMcpServerPermissions (epic #1636 Phase 5 PR-3b)', () => {
    it('sends a named-decision body to the mcp-permissions endpoint', async () => {
      const mockWorker = completeWireBody({ worker: { id: 'worker-id', type: 'embedded-agent', name: 'Local GPT' } });
      mockFetch.mockResolvedValue(createMockResponse(mockWorker));

      const result = await setMcpServerPermissions('session-id', 'worker-id', {
        name: 'chrome-devtools',
        hash: 'abc123',
        decision: 'allow',
      });

      expect(getLastFetchUrl()).toContain('/api/sessions/session-id/workers/worker-id/mcp-permissions');
      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      expect(body).toEqual({ name: 'chrome-devtools', hash: 'abc123', decision: 'allow' });
      expect(result).toEqual(mockWorker);
    });

    it('sends the { all: true } body for "allow all pending"', async () => {
      const mockWorker = completeWireBody({ worker: { id: 'worker-id', type: 'embedded-agent', name: 'Local GPT' } });
      mockFetch.mockResolvedValue(createMockResponse(mockWorker));

      await setMcpServerPermissions('session-id', 'worker-id', { all: true });

      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      expect(body).toEqual({ all: true });
    });

    it('throws error on failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        json: mock(() => Promise.resolve({ error: 'The .mcp.json entry has changed; re-fetch and try again' })),
      } as unknown as Response);

      await expect(
        setMcpServerPermissions('session-id', 'worker-id', { name: 'chrome-devtools', hash: 'abc123', decision: 'allow' })
      ).rejects.toThrow('The .mcp.json entry has changed; re-fetch and try again');
    });
  });

  describe('fetchRepositories', () => {
    it('should fetch repositories successfully', async () => {
      const mockRepos = { repositories: [{ id: '1', name: 'repo1', path: '/repo1', createdAt: '2026-01-01T00:00:00.000Z', orchestratorSessionIds: [], clonedSourceRepoPath: null }] };
      mockFetch.mockResolvedValue(createMockResponse(mockRepos));

      const result = await fetchRepositories();

      // Hono RPC client passes explicit options even for GET requests
      expect((mockFetch.mock.calls as unknown[][])[0]?.[0]).toBe('/api/repositories');
      expect(result).toEqual(mockRepos);
    });

    it('should throw when the body has no repositories key', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}));

      await expect(fetchRepositories()).rejects.toThrow();
    });
  });

  describe('registerRepository', () => {
    it('should register repository successfully', async () => {
      const mockRepo = {
        repository: {
          id: '1',
          name: 'repo',
          path: '/path',
          createdAt: '2026-01-01T00:00:00.000Z',
          orchestratorSessionIds: [],
          clonedSourceRepoPath: null,
        },
      };
      mockFetch.mockResolvedValue(createMockResponse(mockRepo));

      const result = await registerRepository({ path: '/path/to/repo' });

      expect(getLastFetchUrl()).toContain('/api/repositories');
      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      expect(body).toEqual({ path: '/path/to/repo' });
      expect(result).toEqual(mockRepo);
    });

    it('should throw error with message from response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Not a git repository' })),
      } as unknown as Response);

      await expect(registerRepository({ path: '/not/git' })).rejects.toThrow('Not a git repository');
    });
  });

  describe('unregisterRepository', () => {
    it('should unregister repository successfully', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await unregisterRepository('repo-id');

      expect(getLastFetchUrl()).toContain('/api/repositories/repo-id');
      expect(getLastFetchMethod()).toBe('DELETE');
    });

    it('sends DELETE without a body when called with id only', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await unregisterRepository('repo-id');

      expect(getLastFetchUrl()).toContain('/api/repositories/repo-id');
      expect(getLastFetchMethod()).toBe('DELETE');
      const body = await getLastFetchBody();
      expect(body).toBeUndefined();
    });

    it('sends DELETE with body { removeSourceRepo: true } when opts.removeSourceRepo is true', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await unregisterRepository('repo-id', { removeSourceRepo: true });

      expect(getLastFetchUrl()).toContain('/api/repositories/repo-id');
      expect(getLastFetchMethod()).toBe('DELETE');
      const body = await getLastFetchBody();
      expect(body).toEqual({ removeSourceRepo: true });
    });

    it('sends DELETE with body { removeSourceRepo: false } when opts.removeSourceRepo is false', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await unregisterRepository('repo-id', { removeSourceRepo: false });

      expect(getLastFetchUrl()).toContain('/api/repositories/repo-id');
      expect(getLastFetchMethod()).toBe('DELETE');
      const body = await getLastFetchBody();
      expect(body).toEqual({ removeSourceRepo: false });
    });

    it('throws ApiError when DELETE fails', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: 'cleanup failed' }), {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await expect(
        unregisterRepository('repo-id', { removeSourceRepo: true })
      ).rejects.toThrow('cleanup failed');
    });
  });

  describe('fetchWorktrees', () => {
    it('should fetch worktrees successfully', async () => {
      const mockWorktrees = {
        worktrees: [{ path: '/path', branch: 'main', isMain: true, repositoryId: 'repo-id' }],
        pathStatus: 'ok',
      };
      mockFetch.mockResolvedValue(createMockResponse(mockWorktrees));

      const result = await fetchWorktrees('repo-id');

      expect(getLastFetchUrl()).toContain('/api/repositories/repo-id/worktrees');
      expect(getLastFetchMethod()).toBe('GET');
      expect(result).toEqual(mockWorktrees);
    });

    it('should pass the listing pathStatus through to the caller', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ worktrees: [], pathStatus: 'missing' }));

      const result = await fetchWorktrees('repo-id');

      expect(result.pathStatus).toBe('missing');
      expect(result.worktrees).toEqual([]);
    });
  });

  describe('fetchBranches', () => {
    it('should fetch branches successfully', async () => {
      const mockBranches = { local: ['main'], remote: ['origin/main'], defaultBranch: 'main' };
      mockFetch.mockResolvedValue(createMockResponse(mockBranches));

      const result = await fetchBranches('repo-id');

      expect(getLastFetchUrl()).toContain('/api/repositories/repo-id/branches');
      expect(getLastFetchMethod()).toBe('GET');
      expect(result).toEqual(mockBranches);
    });
  });

  describe('createWorktree (legacy sync)', () => {
    it('should create worktree successfully with custom mode', async () => {
      const { createWorktree } = await import('../api');
      const mockResponse = { accepted: true };
      mockFetch.mockResolvedValue(createMockResponse(mockResponse));

      const result = await createWorktree('repo-id', { mode: 'custom', branch: 'feature-1', taskId: 'test-task-id' });

      expect(getLastFetchUrl()).toContain('/api/repositories/repo-id/worktrees');
      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      expect(body).toEqual({ mode: 'custom', branch: 'feature-1', taskId: 'test-task-id' });
      expect(result).toEqual(mockResponse);
    });

    it('should throw error on failure', async () => {
      const { createWorktree } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Branch already exists' })),
      } as unknown as Response);

      await expect(createWorktree('repo-id', { mode: 'custom', branch: 'existing', taskId: 'test-task-id' })).rejects.toThrow(
        'Branch already exists'
      );
    });
  });

  describe('createWorktreeAsync', () => {
    it('should create worktree asynchronously and return accepted', async () => {
      const { createWorktreeAsync } = await import('../api');
      const mockResponse = { accepted: true };
      mockFetch.mockResolvedValue(createMockResponse(mockResponse));

      const result = await createWorktreeAsync('repo-id', { mode: 'custom', branch: 'feature-1', taskId: 'test-task-id' });

      expect(getLastFetchUrl()).toContain('/api/repositories/repo-id/worktrees');
      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      expect(body).toEqual({ mode: 'custom', branch: 'feature-1', taskId: 'test-task-id' });
      expect(result).toEqual(mockResponse);
    });
  });

  describe('pullWorktreeAsync', () => {
    it('should pull worktree asynchronously and return accepted', async () => {
      const { pullWorktreeAsync } = await import('../api');
      const mockResponse = { accepted: true };
      mockFetch.mockResolvedValue(createMockResponse(mockResponse));

      const result = await pullWorktreeAsync('repo-id', '/path/to/worktree', 'task-123');

      expect(getLastFetchUrl()).toContain('/api/repositories/repo-id/worktrees/pull');
      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      expect(body).toEqual({ worktreePath: '/path/to/worktree', taskId: 'task-123' });
      expect(result).toEqual(mockResponse);
    });

    it('should throw error on failure', async () => {
      const { pullWorktreeAsync } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Not a fast-forward' })),
      } as unknown as Response);

      await expect(pullWorktreeAsync('repo-id', '/path', 'task-123')).rejects.toThrow(
        'Not a fast-forward'
      );
    });
  });

  describe('deleteWorktree', () => {
    // NOTE: deleteWorktree still uses manual fetch because the server uses a wildcard route
    it('should delete worktree successfully', async () => {
      const { deleteWorktree } = await import('../api');
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await deleteWorktree('repo-id', '/path/to/worktree');

      expect(getLastFetchUrl()).toBe('/api/repositories/repo-id/worktrees/%2Fpath%2Fto%2Fworktree');
      expect(getLastFetchMethod()).toBe('DELETE');
    });

    it('should include force flag when specified', async () => {
      const { deleteWorktree } = await import('../api');
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await deleteWorktree('repo-id', '/path/to/worktree', true);

      expect(getLastFetchUrl()).toBe('/api/repositories/repo-id/worktrees/%2Fpath%2Fto%2Fworktree?force=true');
      expect(getLastFetchMethod()).toBe('DELETE');
    });

    it('should throw error on failure', async () => {
      const { deleteWorktree } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Worktree has uncommitted changes' })),
      } as unknown as Response);

      await expect(deleteWorktree('repo-id', '/path')).rejects.toThrow(
        'Worktree has uncommitted changes'
      );
    });
  });

  describe('deleteWorktreeAsync', () => {
    // NOTE: deleteWorktreeAsync still uses manual fetch because the server uses a wildcard route
    it('sends ?async=true and returns the server-generated jobId', async () => {
      const { deleteWorktreeAsync } = await import('../api');
      mockFetch.mockResolvedValue(createMockResponse({ accepted: true, jobId: 'job-123' }));

      const result = await deleteWorktreeAsync('repo-id', '/path/to/worktree');

      expect(getLastFetchUrl()).toBe('/api/repositories/repo-id/worktrees/%2Fpath%2Fto%2Fworktree?async=true');
      expect(getLastFetchMethod()).toBe('DELETE');
      expect(result).toEqual({ accepted: true, jobId: 'job-123' });
    });

    it('includes force flag alongside async when specified', async () => {
      const { deleteWorktreeAsync } = await import('../api');
      mockFetch.mockResolvedValue(createMockResponse({ accepted: true, jobId: 'job-456' }));

      await deleteWorktreeAsync('repo-id', '/path/to/worktree', true);

      expect(getLastFetchUrl()).toBe(
        '/api/repositories/repo-id/worktrees/%2Fpath%2Fto%2Fworktree?force=true&async=true'
      );
    });

    it('throws error on failure', async () => {
      const { deleteWorktreeAsync } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        json: mock(() => Promise.resolve({ error: 'Deletion already in progress' })),
      } as unknown as Response);

      await expect(deleteWorktreeAsync('repo-id', '/path')).rejects.toThrow(
        'Deletion already in progress'
      );
    });
  });

  describe('fetchAgents', () => {
    it('should fetch agents successfully', async () => {
      const mockAgents = {
        agents: [
          {
            id: 'claude-code',
            name: 'Claude Code',
            commandTemplate: 'claude {{prompt}}',
            isBuiltIn: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
          },
        ],
      };
      mockFetch.mockResolvedValue(createMockResponse(mockAgents));

      const result = await fetchAgents();

      // Hono RPC client passes explicit options even for GET requests
      expect((mockFetch.mock.calls as unknown[][])[0]?.[0]).toBe('/api/agents');
      expect(result).toEqual(mockAgents);
    });

    it('should throw when the body has no agents key', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}));

      await expect(fetchAgents()).rejects.toThrow();
    });

    it('should throw error on failure', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({}, { status: 500, ok: false })
      );

      await expect(fetchAgents()).rejects.toThrow('Failed to fetch agents');
    });
  });

  describe('fetchAgent', () => {
    it('should fetch agent by id', async () => {
      const { fetchAgent } = await import('../api');
      const mockAgent = {
        agent: {
          id: 'claude-code',
          name: 'Claude Code',
          commandTemplate: 'claude {{prompt}}',
          isBuiltIn: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
        },
      };
      mockFetch.mockResolvedValue(createMockResponse(mockAgent));

      const result = await fetchAgent('claude-code');

      expect(getLastFetchUrl()).toContain('/api/agents/claude-code');
      expect(getLastFetchMethod()).toBe('GET');
      expect(result).toEqual(mockAgent);
    });

    it('should throw error for non-existent agent', async () => {
      const { fetchAgent } = await import('../api');
      mockFetch.mockResolvedValue(
        createMockResponse({}, { status: 404, ok: false })
      );

      await expect(fetchAgent('non-existent')).rejects.toThrow('Failed to fetch agent');
    });
  });

  describe('registerAgent', () => {
    it('should register agent successfully', async () => {
      const { registerAgent } = await import('../api');
      const mockAgent = {
        agent: {
          id: 'new-agent',
          name: 'New Agent',
          commandTemplate: 'new-cmd {{prompt}}',
          isBuiltIn: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          capabilities: {
            supportsContinue: false,
            supportsHeadlessMode: false,
            supportsActivityDetection: false,
          },
        },
      };
      mockFetch.mockResolvedValue(createMockResponse(mockAgent));

      const result = await registerAgent({ name: 'New Agent', commandTemplate: 'new-cmd {{prompt}}' });

      expect(getLastFetchUrl()).toContain('/api/agents');
      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      expect(body).toEqual({ name: 'New Agent', commandTemplate: 'new-cmd {{prompt}}' });
      expect(result).toEqual(mockAgent);
    });

    it('should throw error on failure', async () => {
      const { registerAgent } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Invalid commandTemplate' })),
      } as unknown as Response);

      await expect(registerAgent({ name: 'Test', commandTemplate: '' })).rejects.toThrow(
        'Invalid commandTemplate'
      );
    });
  });

  describe('updateAgent', () => {
    it('should update agent successfully', async () => {
      const { updateAgent } = await import('../api');
      const mockAgent = {
        agent: {
          id: 'agent-1',
          name: 'Updated Agent',
          commandTemplate: 'cmd {{prompt}}',
          isBuiltIn: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
        },
      };
      mockFetch.mockResolvedValue(createMockResponse(mockAgent));

      const result = await updateAgent('agent-1', { name: 'Updated Agent' });

      expect(getLastFetchUrl()).toContain('/api/agents/agent-1');
      expect(getLastFetchMethod()).toBe('PATCH');
      const body = await getLastFetchBody();
      expect(body).toEqual({ name: 'Updated Agent' });
      expect(result).toEqual(mockAgent);
    });

    it('should throw error when updating built-in agent', async () => {
      const { updateAgent } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Cannot update built-in agent' })),
      } as unknown as Response);

      await expect(updateAgent('claude-code', { name: 'New Name' })).rejects.toThrow(
        'Cannot update built-in agent'
      );
    });
  });

  describe('unregisterAgent', () => {
    it('should unregister agent successfully', async () => {
      const { unregisterAgent } = await import('../api');
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await unregisterAgent('agent-1');

      expect(getLastFetchUrl()).toContain('/api/agents/agent-1');
      expect(getLastFetchMethod()).toBe('DELETE');
    });

    it('should throw error when unregistering built-in agent', async () => {
      const { unregisterAgent } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Cannot unregister built-in agent' })),
      } as unknown as Response);

      await expect(unregisterAgent('claude-code')).rejects.toThrow(
        'Cannot unregister built-in agent'
      );
    });
  });

  describe('createEmbeddedAgent', () => {
    it('should create embedded agent successfully', async () => {
      const { createEmbeddedAgent } = await import('../api');
      const mockEmbeddedAgent = {
        embeddedAgent: {
          id: 'new-embedded-agent',
          name: 'Ollama qwen3',
          provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
          createdBy: 'user-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      };
      mockFetch.mockResolvedValue(createMockResponse(mockEmbeddedAgent));

      const result = await createEmbeddedAgent({
        engine: 'openai-api',
        name: 'Ollama qwen3',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
      });

      expect(getLastFetchUrl()).toContain('/api/embedded-agents');
      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      expect(body).toEqual({
        engine: 'openai-api',
        name: 'Ollama qwen3',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
      });
      expect(result).toEqual(mockEmbeddedAgent);
    });

    it('should throw error on failure', async () => {
      const { createEmbeddedAgent } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Invalid provider' })),
      } as unknown as Response);

      await expect(
        createEmbeddedAgent({
          engine: 'openai-api',
          name: 'Test',
          provider: { baseUrl: 'not-a-url', model: '' },
        })
      ).rejects.toThrow('Invalid provider');
    });
  });

  describe('updateEmbeddedAgent', () => {
    it('should update embedded agent successfully', async () => {
      const { updateEmbeddedAgent } = await import('../api');
      const mockEmbeddedAgent = {
        embeddedAgent: {
          id: 'embedded-1',
          name: 'Updated Name',
          provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
          createdBy: 'user-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      };
      mockFetch.mockResolvedValue(createMockResponse(mockEmbeddedAgent));

      const result = await updateEmbeddedAgent('embedded-1', { name: 'Updated Name' });

      expect(getLastFetchUrl()).toContain('/api/embedded-agents/embedded-1');
      expect(getLastFetchMethod()).toBe('PATCH');
      const body = await getLastFetchBody();
      expect(body).toEqual({ name: 'Updated Name' });
      expect(result).toEqual(mockEmbeddedAgent);
    });

    it('should throw error on failure', async () => {
      const { updateEmbeddedAgent } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: mock(() => Promise.resolve({ error: 'Only the creator can update this embedded agent' })),
      } as unknown as Response);

      await expect(updateEmbeddedAgent('embedded-1', { name: 'X' })).rejects.toThrow(
        'Only the creator can update this embedded agent'
      );
    });
  });

  describe('deleteEmbeddedAgent', () => {
    it('should delete embedded agent successfully', async () => {
      const { deleteEmbeddedAgent } = await import('../api');
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await deleteEmbeddedAgent('embedded-1');

      expect(getLastFetchUrl()).toContain('/api/embedded-agents/embedded-1');
      expect(getLastFetchMethod()).toBe('DELETE');
    });

    it('should throw error on failure', async () => {
      const { deleteEmbeddedAgent } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: mock(() => Promise.resolve({ error: 'Only the creator can delete this embedded agent' })),
      } as unknown as Response);

      await expect(deleteEmbeddedAgent('embedded-1')).rejects.toThrow(
        'Only the creator can delete this embedded agent'
      );
    });
  });

  describe('generateRepositoryDescription', () => {
    it('should generate repository description', async () => {
      const mockDescription = { description: 'A web application for managing AI agents.' };
      mockFetch.mockResolvedValue(createMockResponse(mockDescription));

      const result = await generateRepositoryDescription('repo-1');

      expect(getLastFetchUrl()).toContain('/repositories/repo-1/generate-description');
      expect(getLastFetchMethod()).toBe('POST');
      expect(result.description).toBe('A web application for managing AI agents.');
    });

    it('should throw on error response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: mock(() => Promise.resolve({ error: 'No README file found in repository' })),
      } as unknown as Response);

      await expect(generateRepositoryDescription('repo-1')).rejects.toThrow('No README file found in repository');
    });
  });

  describe('login', () => {
    it('should login successfully and return user', async () => {
      const { login } = await import('../api');
      const mockResponse = { user: { id: 'user-1', username: 'alice', homeDir: '/home/alice' } };
      mockFetch.mockResolvedValue(createMockResponse(mockResponse));

      const result = await login({ username: 'alice', password: 'pass123' });

      expect(getLastFetchUrl()).toContain('/api/auth/login');
      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      expect(body).toEqual({ username: 'alice', password: 'pass123' });
      expect(result).toEqual(mockResponse);
    });

    it('should throw error on failed login', async () => {
      const { login } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: mock(() => Promise.resolve({ error: 'Invalid credentials' })),
      } as unknown as Response);

      await expect(login({ username: 'bad', password: 'bad' })).rejects.toThrow('Invalid credentials');
    });
  });

  describe('logout', () => {
    it('should logout successfully', async () => {
      const { logout } = await import('../api');
      mockFetch.mockResolvedValue(createMockResponse({}));

      await logout();

      expect(getLastFetchUrl()).toContain('/api/auth/logout');
      expect(getLastFetchMethod()).toBe('POST');
    });

    it('should throw error on failed logout', async () => {
      const { logout } = await import('../api');
      mockFetch.mockResolvedValue(
        createMockResponse({}, { status: 500, ok: false })
      );

      await expect(logout()).rejects.toThrow('Logout failed');
    });
  });

  describe('fetchCurrentUser', () => {
    it('should fetch current user successfully', async () => {
      const { fetchCurrentUser } = await import('../api');
      const mockResponse = { user: { id: 'user-1', username: 'alice', homeDir: '/home/alice' } };
      mockFetch.mockResolvedValue(createMockResponse(mockResponse));

      const result = await fetchCurrentUser();

      expect(getLastFetchUrl()).toContain('/api/auth/me');
      expect(getLastFetchMethod()).toBe('GET');
      expect(result).toEqual(mockResponse);
    });

    it('should return null user when not authenticated', async () => {
      const { fetchCurrentUser } = await import('../api');
      const mockResponse = { user: null };
      mockFetch.mockResolvedValue(createMockResponse(mockResponse));

      const result = await fetchCurrentUser();

      expect(result).toEqual({ user: null });
    });

    it('should throw error on server error', async () => {
      const { fetchCurrentUser } = await import('../api');
      mockFetch.mockResolvedValue(
        createMockResponse({}, { status: 500, ok: false })
      );

      await expect(fetchCurrentUser()).rejects.toThrow('Failed to fetch current user');
    });
  });

  describe('handleApiError', () => {
    it('should extract error from response with both error and message fields', async () => {
      const { createSession } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Error field', message: 'Message field' })),
      } as unknown as Response);

      await expect(createSession({ type: 'quick', locationPath: '/path' })).rejects.toThrow('Error field');
    });

    it('should use message field when error field is empty string', async () => {
      const { createSession } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: '', message: 'Message fallback' })),
      } as unknown as Response);

      await expect(createSession({ type: 'quick', locationPath: '/path' })).rejects.toThrow('Message fallback');
    });

    it('should use message field when error field is not present', async () => {
      const { createSession } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ message: 'Only message' })),
      } as unknown as Response);

      await expect(createSession({ type: 'quick', locationPath: '/path' })).rejects.toThrow('Only message');
    });

    it('should combine fallback message with statusText when response has no error or message', async () => {
      const { createSession } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({})),
      } as unknown as Response);

      await expect(createSession({ type: 'quick', locationPath: '/path' })).rejects.toThrow('Failed to create session: Bad Request');
    });

    it('should use fallback message when statusText is empty string', async () => {
      const { createSession } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: '',
        json: mock(() => Promise.resolve({})),
      } as unknown as Response);

      await expect(createSession({ type: 'quick', locationPath: '/path' })).rejects.toThrow('Failed to create session');
    });

    it('should handle non-object JSON response gracefully', async () => {
      const { createSession } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: mock(() => Promise.resolve('string response')),
      } as unknown as Response);

      await expect(createSession({ type: 'quick', locationPath: '/path' })).rejects.toThrow('Failed to create session: Internal Server Error');
    });

    it('should throw ApiError that preserves status and code fields', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        json: mock(() => Promise.resolve({ error: 'Cannot resume', code: 'session_orphaned' })),
      } as unknown as Response);

      let thrown: unknown;
      try {
        await resumeSession('session-id');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ApiError);
      expect(thrown).toBeInstanceOf(Error);
      if (thrown instanceof ApiError) {
        expect(thrown.message).toBe('Cannot resume');
        expect(thrown.status).toBe(409);
        expect(thrown.code).toBe('session_orphaned');
      }
    });

    it('should throw ApiError with undefined code when response body has no code field', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Some error' })),
      } as unknown as Response);

      let thrown: unknown;
      try {
        await resumeSession('session-id');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ApiError);
      if (thrown instanceof ApiError) {
        expect(thrown.status).toBe(400);
        expect(thrown.code).toBeUndefined();
      }
    });
  });

  /**
   * openInVSCode() dispatches between two modes based on the server-provided
   * capabilities cache. These tests exercise both branches: the legacy REST
   * POST path (local-spawn) and the client-side URL-scheme navigation
   * (remote-url-scheme).
   *
   * `getVSCodeOpenMode` and `getVSCodeRemoteHost` are replaced per-test via
   * `spyOn` (NOT mock.module, which is process-global in bun:test and would
   * leak into other test files). This mirrors the pattern used in
   * `routes/__tests__/index.test.tsx` for `hasVSCode`.
   */
  describe('openInVSCode', () => {
    let windowOpenSpy: ReturnType<typeof spyOn>;
    let modeSpy: ReturnType<typeof spyOn>;
    let hostSpy: ReturnType<typeof spyOn>;
    let originalLocation: Location;

    beforeEach(() => {
      // window.open is spied to capture the URL-scheme invocation. Provide a
      // no-op impl so no actual popup / navigation is attempted in jsdom.
      windowOpenSpy = spyOn(window, 'open').mockImplementation(() => null);
      originalLocation = window.location;
    });

    afterEach(() => {
      windowOpenSpy.mockRestore();
      modeSpy?.mockRestore();
      hostSpy?.mockRestore();
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
      });
    });

    it('mode=local-spawn: POSTs to /api/system/open-in-vscode and does NOT invoke window.open', async () => {
      modeSpy = spyOn(capabilitiesModule, 'getVSCodeOpenMode').mockImplementation(
        () => 'local-spawn'
      );
      hostSpy = spyOn(capabilitiesModule, 'getVSCodeRemoteHost').mockImplementation(
        () => null
      );
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await openInVSCode('/home/user/foo.ts');

      expect(getLastFetchUrl()).toContain('/api/system/open-in-vscode');
      expect(getLastFetchMethod()).toBe('POST');
      const body = await getLastFetchBody();
      expect(body).toEqual({ path: '/home/user/foo.ts' });
      // Negative: URL-scheme path MUST NOT fire in local-spawn mode.
      expect(windowOpenSpy).not.toHaveBeenCalled();
    });

    it('mode=remote-url-scheme + configured host: navigates via window.open and does NOT hit the REST endpoint', async () => {
      modeSpy = spyOn(capabilitiesModule, 'getVSCodeOpenMode').mockImplementation(
        () => 'remote-url-scheme'
      );
      hostSpy = spyOn(capabilitiesModule, 'getVSCodeRemoteHost').mockImplementation(
        () => 'srv.example.com'
      );

      await openInVSCode('/home/user/foo.ts');

      // Positive: window.open invoked once with the expected URL + target.
      expect(windowOpenSpy).toHaveBeenCalledTimes(1);
      const call = windowOpenSpy.mock.calls[0] as [string, string];
      expect(call[0]).toBe(
        'vscode://vscode-remote/ssh-remote+srv.example.com/home/user/foo.ts'
      );
      expect(call[1]).toBe('_self');
      // Negative: REST fetch MUST NOT fire in remote-url-scheme mode.
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('mode=remote-url-scheme + vscodeRemoteHost=null: falls back to window.location.hostname', async () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: 'fallback.local', protocol: 'http:', host: 'fallback.local' },
        writable: true,
      });
      modeSpy = spyOn(capabilitiesModule, 'getVSCodeOpenMode').mockImplementation(
        () => 'remote-url-scheme'
      );
      hostSpy = spyOn(capabilitiesModule, 'getVSCodeRemoteHost').mockImplementation(
        () => null
      );

      await openInVSCode('/tmp/x.ts');

      expect(windowOpenSpy).toHaveBeenCalledTimes(1);
      const call = windowOpenSpy.mock.calls[0] as [string, string];
      expect(call[0]).toBe(
        'vscode://vscode-remote/ssh-remote+fallback.local/tmp/x.ts'
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('fetchArtifacts', () => {
    it('fetches artifacts and parses the response through the wire schema', async () => {
      const mockArtifacts = {
        artifacts: [
          { id: 'artifact-1', title: 'My Dashboard', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 1234, updatedAt: null },
        ],
      };
      mockFetch.mockResolvedValue(createMockResponse(mockArtifacts));

      const result = await fetchArtifacts();

      expect((mockFetch.mock.calls as unknown[][])[0]?.[0]).toBe('/api/artifacts');
      expect(result).toEqual(mockArtifacts.artifacts);
    });

    it('throws when the response fails schema validation (e.g. a dropped field)', async () => {
      // sizeBytes is missing -- ArtifactsListResponseSchema must reject this,
      // not silently pass through `undefined` (the #926 silent-drop gap).
      mockFetch.mockResolvedValue(
        createMockResponse({ artifacts: [{ id: 'artifact-1', title: 'My Dashboard', createdAt: '2026-08-16T00:00:00.000Z', updatedAt: null }] })
      );

      await expect(fetchArtifacts()).rejects.toThrow();
    });

    it('throws error on failure', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({}, { status: 500, ok: false })
      );

      await expect(fetchArtifacts()).rejects.toThrow('Failed to fetch artifacts');
    });
  });

  describe('fetchTodos', () => {
    const validTodo = {
      id: 'todo-1',
      kind: 'action',
      scope: 'session',
      title: 'Run the migration',
      body: 'body',
      sessionId: 'session-1',
      createdBy: { workerId: 'worker-1' },
      assigneeUserId: null,
      status: 'open',
      resolutionText: null,
      resolvedByUserId: null,
      resolvedByWorkerId: null,
      resolvedAt: null,
      createdAt: '2026-10-15T00:00:00.000Z',
      updatedAt: '2026-10-15T00:00:00.000Z',
    };

    it('sends only the defined filters as query params and returns the parsed list', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ todos: [validTodo] }));

      const result = await fetchTodos({ sessionId: 'session-1', status: undefined });

      const url = new URL(getLastFetchUrl(), 'http://localhost');
      expect(url.pathname).toBe('/api/todos');
      expect(url.searchParams.get('sessionId')).toBe('session-1');
      expect(url.searchParams.has('status')).toBe(false);
      expect(result).toEqual([validTodo]);
    });

    it('calls the bare endpoint when no filter is given', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ todos: [] }));

      const result = await fetchTodos();

      const url = new URL(getLastFetchUrl(), 'http://localhost');
      expect(url.pathname).toBe('/api/todos');
      expect([...url.searchParams.keys()]).toEqual([]);
      expect(result).toEqual([]);
    });

    it('throws when the response fails schema validation (e.g. a dropped field)', async () => {
      const { resolutionText: _dropped, ...withoutResolutionText } = validTodo;
      mockFetch.mockResolvedValue(createMockResponse({ todos: [withoutResolutionText] }));

      await expect(fetchTodos({ sessionId: 'session-1' })).rejects.toThrow();
    });

    it('throws error on failure', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, { status: 500, ok: false }));

      await expect(fetchTodos()).rejects.toThrow('Failed to fetch to-do items');
    });
  });

  describe('to-do write calls and the user directory', () => {
    const wireTodo = {
      id: 'todo-1',
      kind: 'action',
      scope: 'global',
      title: 'Run the migration',
      body: '',
      sessionId: null,
      createdBy: { userId: 'user-1' },
      assigneeUserId: null,
      status: 'open',
      resolutionText: null,
      resolvedByUserId: null,
      resolvedByWorkerId: null,
      resolvedAt: null,
      createdAt: '2026-10-15T00:00:00.000Z',
      updatedAt: '2026-10-15T00:00:00.000Z',
    };

    function serverRefusal(status: number, error: string) {
      return {
        ok: false,
        status,
        statusText: 'Error',
        json: mock(() => Promise.resolve({ error })),
      } as unknown as Response;
    }

    it('createTodo POSTs the request and returns the parsed item', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ todo: wireTodo }, { status: 201 }));

      const result = await createTodo({ kind: 'action', title: 'Run the migration', body: '' });

      expect(new URL(getLastFetchUrl(), 'http://localhost').pathname).toBe('/api/todos');
      expect(getLastFetchMethod()).toBe('POST');
      expect(await getLastFetchBody()).toEqual({ kind: 'action', title: 'Run the migration', body: '' });
      expect(result).toEqual(wireTodo);
    });

    it('updateTodo PATCHes the item with a null assignee that clears the assignment', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ todo: wireTodo }));

      await updateTodo('todo-1', { assigneeUserId: null });

      expect(new URL(getLastFetchUrl(), 'http://localhost').pathname).toBe('/api/todos/todo-1');
      expect(getLastFetchMethod()).toBe('PATCH');
      expect(await getLastFetchBody()).toEqual({ assigneeUserId: null });
    });

    it('resolveTodo POSTs the text to the resolve path', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ todo: wireTodo }));

      await resolveTodo('todo-1', 'done it');

      expect(new URL(getLastFetchUrl(), 'http://localhost').pathname).toBe('/api/todos/todo-1/resolve');
      expect(getLastFetchMethod()).toBe('POST');
      expect(await getLastFetchBody()).toEqual({ text: 'done it' });
    });

    it('dismissTodo POSTs to the dismiss path', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ todo: wireTodo }));

      await dismissTodo('todo-1');

      expect(new URL(getLastFetchUrl(), 'http://localhost').pathname).toBe('/api/todos/todo-1/dismiss');
      expect(getLastFetchMethod()).toBe('POST');
    });

    it('deleteTodo sends DELETE to the item path', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await deleteTodo('todo-1');

      expect(new URL(getLastFetchUrl(), 'http://localhost').pathname).toBe('/api/todos/todo-1');
      expect(getLastFetchMethod()).toBe('DELETE');
    });

    it('a single-item response with a dropped field fails the strict parse', async () => {
      const { resolutionText: _dropped, ...withoutResolutionText } = wireTodo;
      mockFetch.mockResolvedValue(createMockResponse({ todo: withoutResolutionText }));

      await expect(dismissTodo('todo-1')).rejects.toThrow();
    });

    it('a single-item response with an unknown field fails the strict parse', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ todo: { ...wireTodo, extra: 1 } }));

      await expect(resolveTodo('todo-1', 'x')).rejects.toThrow();
    });

    it.each([
      ['createTodo', () => createTodo({ kind: 'action', title: 't', body: '' }), 400],
      ['updateTodo', () => updateTodo('todo-1', { scope: 'session' }), 400],
      ['resolveTodo', () => resolveTodo('todo-1'), 400],
      ['dismissTodo', () => dismissTodo('todo-1'), 409],
      ['deleteTodo', () => deleteTodo('todo-1'), 404],
    ] as const)('%s surfaces the server error message on a refusal', async (_name, call, status) => {
      mockFetch.mockResolvedValue(serverRefusal(status, 'The server said no'));

      await expect(call()).rejects.toThrow('The server said no');
    });

    it('fetchUsers GETs the directory and returns the parsed users', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ users: [{ id: 'user-1', username: 'alice' }] }));

      const result = await fetchUsers();

      expect(new URL(getLastFetchUrl(), 'http://localhost').pathname).toBe('/api/users');
      expect(result).toEqual([{ id: 'user-1', username: 'alice' }]);
    });

    it('fetchUsers rejects an entry carrying an extra field (the directory is id and username only)', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({ users: [{ id: 'user-1', username: 'alice', homeDir: '/home/alice' }] }),
      );

      await expect(fetchUsers()).rejects.toThrow();
    });

    it('fetchUsers throws the fallback message on failure', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, { status: 500, ok: false }));

      await expect(fetchUsers()).rejects.toThrow('Failed to fetch users');
    });
  });

  describe('deleteArtifact', () => {
    it('should delete artifact successfully', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await deleteArtifact('artifact-1');

      expect(getLastFetchUrl()).toContain('/api/artifacts/artifact-1');
      expect(getLastFetchMethod()).toBe('DELETE');
    });

    it('throws error on failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: mock(() => Promise.resolve({ error: 'Only the owner can delete this artifact' })),
      } as unknown as Response);

      await expect(deleteArtifact('artifact-1')).rejects.toThrow(
        'Only the owner can delete this artifact'
      );
    });
  });

  describe('fetchNotifications', () => {
    it('fetches the notification feed and parses the response through the wire schema', async () => {
      const mockFeed = {
        items: [
          {
            kind: 'artifact-created',
            id: 'artifact-1',
            occurredAt: '2026-08-16T00:00:00.000Z',
            title: 'My Dashboard',
            link: '/artifacts/artifact-1',
          },
        ],
        lastSeenAt: null,
        unreadCount: 1,
      };
      mockFetch.mockResolvedValue(createMockResponse(mockFeed));

      const result = await fetchNotifications();

      expect((mockFetch.mock.calls as unknown[][])[0]?.[0]).toBe('/api/notifications');
      expect(result).toEqual(mockFeed);
    });

    it('throws when the response fails schema validation (e.g. a dropped field)', async () => {
      // unreadCount is missing -- NotificationsResponseSchema must reject
      // this, not silently pass through `undefined` (the #926 silent-drop gap).
      mockFetch.mockResolvedValue(
        createMockResponse({ items: [], lastSeenAt: null })
      );

      await expect(fetchNotifications()).rejects.toThrow();
    });

    it('throws error on failure', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({}, { status: 500, ok: false })
      );

      await expect(fetchNotifications()).rejects.toThrow('Failed to fetch notifications');
    });
  });

  describe('markNotificationsSeen', () => {
    it('sends the cursor timestamp via PUT and parses the response through the wire schema', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ lastSeenAt: '2026-08-16T00:00:00.000Z' }));

      const result = await markNotificationsSeen('2026-08-16T00:00:00.000Z');

      expect(getLastFetchUrl()).toContain('/api/notifications/seen');
      expect(getLastFetchMethod()).toBe('PUT');
      expect(await getLastFetchBody()).toEqual({ lastSeenAt: '2026-08-16T00:00:00.000Z' });
      expect(result).toEqual({ lastSeenAt: '2026-08-16T00:00:00.000Z' });
    });

    it('throws error on failure', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({ error: 'lastSeenAt must not be in the future' }, { status: 400, ok: false })
      );

      await expect(markNotificationsSeen('2026-08-16T00:00:00.000Z')).rejects.toThrow(
        'lastSeenAt must not be in the future'
      );
    });
  });

  describe('refreshDefaultBranch', () => {
    it('posts to the repository route and parses the response through the wire schema', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ defaultBranch: 'develop' }));

      const result = await refreshDefaultBranch('repo-1');

      expect(getLastFetchUrl()).toContain('/api/repositories/repo-1/refresh-default-branch');
      expect(getLastFetchMethod()).toBe('POST');
      expect(result).toEqual({ defaultBranch: 'develop' });
    });

    it.each([
      ['an unknown extra field (the schema is strict)', { defaultBranch: 'main', extra: 1 }],
      ['a missing defaultBranch', {}],
      ['an empty defaultBranch', { defaultBranch: '' }],
      ['a non-string defaultBranch', { defaultBranch: 42 }],
    ])('throws when the response has %s', async (_label, body) => {
      mockFetch.mockResolvedValue(createMockResponse(body));

      await expect(refreshDefaultBranch('repo-1')).rejects.toThrow();
    });

    it('throws error on failure', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({ error: 'Failed to refresh default branch: no remote' }, { status: 400, ok: false })
      );

      await expect(refreshDefaultBranch('repo-1')).rejects.toThrow('no remote');
    });
  });

  // #1367 pass 1: these eight GET fetchers parse their response through a strict wire schema
  // (the same table is run against the REAL routes in packages/integration's
  // api-response-schemas-boundary.test.ts). A body with an unknown field or a missing
  // top-level key must throw, not be cast through.
  describe('strict response parsing (pass 1)', () => {
    const repository = {
      id: 'repo-1',
      name: 'repo',
      path: '/repo',
      createdAt: '2026-01-01T00:00:00.000Z',
      orchestratorSessionIds: [],
      clonedSourceRepoPath: null,
    };
    const agent = {
      id: 'a1',
      name: 'Agent',
      isBuiltIn: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      commandTemplate: 'run {{prompt}}',
      capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
    };
    const cases: Array<[string, () => Promise<unknown>, Record<string, unknown>, string]> = [
      ['fetchRepository', () => fetchRepository('repo-1'), { repository }, 'repository'],
      [
        'fetchWorkers',
        () => fetchWorkers('s1'),
        { workers: [{ id: 'w1', name: 'T', createdAt: '2026-01-01T00:00:00.000Z', type: 'terminal', activated: true }] },
        'workers',
      ],
      ['fetchWorktrees', () => fetchWorktrees('repo-1'), { worktrees: [], pathStatus: 'ok' }, 'pathStatus'],
      ['fetchBranches', () => fetchBranches('repo-1'), { local: [], remote: [], defaultBranch: null }, 'local'],
      ['fetchAgent', () => fetchAgent('a1'), { agent }, 'agent'],
      [
        'fetchMessageTemplates',
        () => fetchMessageTemplates(),
        {
          templates: [
            { id: 't1', title: 'T', content: 'c', sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
          ],
        },
        'templates',
      ],
      ['fetchSkills', () => fetchSkills(), { skills: [{ name: 'review', description: 'Review code' }] }, 'skills'],
      [
        'fetchCurrentUser',
        () => fetchCurrentUser(),
        { user: { id: 'u1', username: 'alice', homeDir: '/home/alice' }, preferences: { disableClaudeAiConnectors: false } },
        'user',
      ],
    ];

    it.each(cases)('%s resolves with a valid body', async (_name, call, valid) => {
      mockFetch.mockResolvedValue(createMockResponse(valid));
      expect(await call()).toEqual(valid);
    });

    it.each(cases)('%s throws on a body with an unknown extra field', async (_name, call, valid) => {
      mockFetch.mockResolvedValue(createMockResponse({ ...valid, extra: true }));
      await expect(call()).rejects.toThrow();
    });

    it.each(cases)('%s throws when a required key is missing', async (_name, call, valid, requiredKey) => {
      const { [requiredKey]: _dropped, ...rest } = valid;
      mockFetch.mockResolvedValue(createMockResponse(rest));
      await expect(call()).rejects.toThrow();
    });

    it('fetchCurrentUser accepts the unauthenticated body { user: null } (no preferences)', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ user: null }));
      expect(await fetchCurrentUser()).toEqual({ user: null });
    });
  });

  // #1367 pass 2: eight more read fetchers parse a strict wire schema (the same table is run
  // against the REAL routes in packages/integration's api-response-schemas-boundary.test.ts).
  describe('strict response parsing (pass 2)', () => {
    const repository = {
      id: 'repo-1',
      name: 'repo',
      path: '/repo',
      createdAt: '2026-01-01T00:00:00.000Z',
      orchestratorSessionIds: [],
      clonedSourceRepoPath: null,
    };
    const agent = {
      id: 'a1',
      name: 'Agent',
      isBuiltIn: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      commandTemplate: 'run {{prompt}}',
      capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
    };
    const commit = { hash: 'abc123', shortHash: 'abc', message: 'msg', author: 'me', date: '2026-01-01 00:00:00 +0000' };
    const cases: Array<[string, () => Promise<unknown>, Record<string, unknown>, string]> = [
      ['getSession', () => getSession('s1'), { session: validQuickSession }, 'session'],
      ['fetchRepositories', () => fetchRepositories(), { repositories: [repository] }, 'repositories'],
      [
        'fetchSessionBranches',
        () => fetchSessionBranches('s1'),
        { local: ['main'], remote: ['origin/main'], defaultBranch: 'main' },
        'local',
      ],
      ['fetchBranchCommits', () => fetchBranchCommits('s1', 'main'), { commits: [commit] }, 'commits'],
      [
        'fetchGitHubIssue',
        () => fetchGitHubIssue('repo-1', '#1'),
        { issue: { org: 'o', repo: 'r', number: 1, title: 'T', body: 'B', url: 'https://github.com/o/r/issues/1' } },
        'issue',
      ],
      ['fetchAgents', () => fetchAgents(), { agents: [agent] }, 'agents'],
      [
        'fetchSessionPrLink',
        () => fetchSessionPrLink('s1'),
        { prUrl: null, branchName: 'feat/x', orgRepo: 'o/r' },
        'branchName',
      ],
      ['getRemoteBranchStatus', () => getRemoteBranchStatus('repo-1', 'main'), { behind: 1, ahead: 2 }, 'behind'],
    ];

    it.each(cases)('%s resolves with a valid body', async (name, call, valid) => {
      mockFetch.mockResolvedValue(createMockResponse(valid));
      const result = await call();
      expect(name === 'getSession' ? { session: result } : result).toEqual(valid);
    });

    it.each(cases)('%s throws on a body with an unknown extra field', async (_name, call, valid) => {
      mockFetch.mockResolvedValue(createMockResponse({ ...valid, extra: true }));
      await expect(call()).rejects.toThrow();
    });

    it.each(cases)('%s throws when a required key is missing', async (_name, call, valid, requiredKey) => {
      const { [requiredKey]: _dropped, ...rest } = valid;
      mockFetch.mockResolvedValue(createMockResponse(rest));
      await expect(call()).rejects.toThrow();
    });

    it('fetchBranchCommits throws when ONE commit lacks a field (element-level strictness)', async () => {
      const { date: _date, ...withoutDate } = commit;
      mockFetch.mockResolvedValue(createMockResponse({ commits: [withoutDate] }));
      await expect(fetchBranchCommits('s1', 'main')).rejects.toThrow();
    });

    it('fetchBranchCommits throws when ONE commit carries an unknown field', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ commits: [{ ...commit, extra: true }] }));
      await expect(fetchBranchCommits('s1', 'main')).rejects.toThrow();
    });

    it('fetchBranchCommits accepts an empty commit list', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ commits: [] }));
      expect(await fetchBranchCommits('s1', 'main')).toEqual({ commits: [] });
    });

    it('fetchSessionPrLink accepts a pull-request URL with a null orgRepo', async () => {
      const body = { prUrl: 'https://github.com/o/r/pull/3', branchName: 'feat/x', orgRepo: null };
      mockFetch.mockResolvedValue(createMockResponse(body));
      expect(await fetchSessionPrLink('s1')).toEqual(body);
    });
  });
  // #1367 pass 3a: five write/action fetchers parse a strict wire schema (resume, register/update
  // agent, register/update repository). A malformed or extended body must throw, not be cast through.
  describe('strict response parsing (pass 3a)', () => {
    const repository = {
      id: 'repo-1',
      name: 'repo',
      path: '/repo',
      createdAt: '2026-01-01T00:00:00.000Z',
      orchestratorSessionIds: [],
      clonedSourceRepoPath: null,
    };
    const agent = {
      id: 'a1',
      name: 'Agent',
      isBuiltIn: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      commandTemplate: 'run {{prompt}}',
      capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
    };
    const cases: Array<[string, () => Promise<unknown>, Record<string, unknown>, string]> = [
      ['resumeSession', async () => ({ session: await resumeSession('s1') }), { session: validQuickSession }, 'session'],
      [
        'registerAgent',
        async () => registerAgent({ name: 'Agent', commandTemplate: 'run {{prompt}}' }),
        { agent },
        'agent',
      ],
      ['updateAgent', async () => updateAgent('a1', { name: 'Agent' }), { agent }, 'agent'],
      [
        'registerRepository',
        async () => registerRepository({ path: '/repo' }),
        { repository },
        'repository',
      ],
      [
        'updateRepository',
        async () => updateRepository('repo-1', { description: 'd' }),
        { repository },
        'repository',
      ],
    ];

    it.each(cases)('%s resolves with a valid body', async (_name, call, valid) => {
      mockFetch.mockResolvedValue(createMockResponse(valid));
      expect(await call()).toEqual(valid);
    });

    it.each(cases)('%s throws on a body with an unknown extra field', async (_name, call, valid) => {
      mockFetch.mockResolvedValue(createMockResponse({ ...valid, extra: true }));
      await expect(call()).rejects.toThrow();
    });

    it.each(cases)('%s throws when a required key is missing', async (_name, call, valid, requiredKey) => {
      const { [requiredKey]: _dropped, ...rest } = valid;
      mockFetch.mockResolvedValue(createMockResponse(rest));
      await expect(call()).rejects.toThrow();
    });

    it.each(cases)('%s throws when the nested record has a wrongly-typed field', async (_name, call, valid, requiredKey) => {
      const nested = valid[requiredKey] as Record<string, unknown>;
      mockFetch.mockResolvedValue(createMockResponse({ [requiredKey]: { ...nested, id: 42 } }));
      await expect(call()).rejects.toThrow();
    });
  });

  // #1367 pass 3: six more read fetchers (and the session-memo write that returns the same
  // envelope) parse a strict wire schema. The same table is run against the REAL routes in
  // packages/integration's api-response-schemas-boundary.test.ts.
  describe('strict response parsing (pass 3)', () => {
    const slackIntegration = {
      id: 'slack-1',
      repositoryId: 'repo-1',
      webhookUrl: 'https://hooks.slack.com/services/T00/B00/XXXX',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const reviewItem = {
      workerId: 'w1',
      sessionId: 's1',
      sessionTitle: 'Session',
      sourceSessionId: 's0',
      sourceSessionTitle: 'Source',
      annotationCount: 2,
      summary: { totalFiles: 3, reviewFiles: 1, mechanicalFiles: 2, confidence: 'high' },
      status: 'pending',
      commentCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const reviewGroup = { sourceSessionId: 's0', sourceSessionTitle: 'Source', items: [reviewItem] };
    const validation = {
      results: [
        {
          sessionId: 's1',
          session: { type: 'worktree', locationPath: '/p', worktreeId: 'feat/x', title: 'T' },
          valid: false,
          issues: [{ type: 'branch_not_found', message: 'Branch does not exist: feat/x' }],
        },
      ],
      hasIssues: true,
    };

    // [name, call, valid body, key whose removal must fail, what the call resolves with]
    const cases: Array<[string, () => Promise<unknown>, unknown, string | null, unknown]> = [
      [
        'fetchCloneJobStatus',
        () => fetchCloneJobStatus('job-1'),
        { jobId: 'job-1', status: 'succeeded', repositoryId: 'repo-1' },
        'jobId',
        { jobId: 'job-1', status: 'succeeded', repositoryId: 'repo-1' },
      ],
      ['validateSessions', () => validateSessions(), validation, 'hasIssues', validation],
      ['fetchSessionMemo', () => fetchSessionMemo('s1'), { content: 'notes' }, 'content', 'notes'],
      ['updateSessionMemo', () => updateSessionMemo('s1', 'notes'), { content: 'notes' }, 'content', { content: 'notes' }],
      [
        'fetchRepositorySlackIntegration',
        () => fetchRepositorySlackIntegration('repo-1'),
        slackIntegration,
        'webhookUrl',
        slackIntegration,
      ],
      [
        'fetchNotificationStatus',
        () => fetchNotificationStatus(),
        { baseUrl: 'https://example.com', isBaseUrlConfigured: true },
        'baseUrl',
        { baseUrl: 'https://example.com', isBaseUrlConfigured: true },
      ],
      ['fetchReviewQueue', () => fetchReviewQueue(), [reviewGroup], null, [reviewGroup]],
    ];

    it.each(cases)('%s resolves with a valid body', async (_name, call, valid, _key, expected) => {
      mockFetch.mockResolvedValue(createMockResponse(valid));
      expect(await call()).toEqual(expected);
    });

    // An object envelope gets an extra top-level key; the review queue is a bare array, so its
    // extra field goes on a group (below).
    const objectCases = cases.filter(([, , , key]) => key !== null);

    it.each(objectCases)('%s throws on a body with an unknown extra field', async (_name, call, valid) => {
      mockFetch.mockResolvedValue(createMockResponse({ ...(valid as object), extra: true }));
      await expect(call()).rejects.toThrow();
    });

    it.each(objectCases)('%s throws when a required key is missing', async (_name, call, valid, key) => {
      const { [key as string]: _dropped, ...rest } = valid as Record<string, unknown>;
      mockFetch.mockResolvedValue(createMockResponse(rest));
      await expect(call()).rejects.toThrow();
    });

    describe('fetchCloneJobStatus', () => {
      it('accepts pending (no optional keys) and failed (error only)', async () => {
        mockFetch.mockResolvedValue(createMockResponse({ jobId: 'j', status: 'pending' }));
        expect(await fetchCloneJobStatus('j')).toEqual({ jobId: 'j', status: 'pending' });

        const failed = { jobId: 'j', status: 'failed', error: { code: 'auth_failed', message: 'denied' } };
        mockFetch.mockResolvedValue(createMockResponse(failed));
        expect(await fetchCloneJobStatus('j')).toEqual(failed);
      });

      it('throws on an unknown status, an unknown error code and a null repositoryId', async () => {
        for (const body of [
          { jobId: 'j', status: 'exploded' },
          { jobId: 'j', status: 'failed', error: { code: 'nope', message: 'x' } },
          { jobId: 'j', status: 'pending', repositoryId: null },
        ]) {
          mockFetch.mockResolvedValue(createMockResponse(body));
          await expect(fetchCloneJobStatus('j')).rejects.toThrow();
        }
      });
    });

    describe('validateSessions', () => {
      it('throws when ONE result carries an unknown field or an unknown issue type', async () => {
        const [first] = validation.results;
        mockFetch.mockResolvedValue(createMockResponse({ ...validation, results: [{ ...first, extra: 1 }] }));
        await expect(validateSessions()).rejects.toThrow();

        const badIssue = { ...first, issues: [{ type: 'not_a_code', message: 'm' }] };
        mockFetch.mockResolvedValue(createMockResponse({ ...validation, results: [badIssue] }));
        await expect(validateSessions()).rejects.toThrow();
      });

      it('accepts an empty result list', async () => {
        mockFetch.mockResolvedValue(createMockResponse({ results: [], hasIssues: false }));
        expect(await validateSessions()).toEqual({ results: [], hasIssues: false });
      });
    });

    describe('session memo', () => {
      it('fetchSessionMemo resolves null when the session has no memo', async () => {
        mockFetch.mockResolvedValue(createMockResponse({ content: null }));
        expect(await fetchSessionMemo('s1')).toBeNull();
      });

      it('throws when content is not a string or null', async () => {
        mockFetch.mockResolvedValue(createMockResponse({ content: 42 }));
        await expect(fetchSessionMemo('s1')).rejects.toThrow();
        await expect(updateSessionMemo('s1', 'x')).rejects.toThrow();
      });
    });

    describe('fetchRepositorySlackIntegration', () => {
      it('resolves null on a 404 without parsing the body', async () => {
        mockFetch.mockResolvedValue(createMockResponse({ error: 'not found' }, { status: 404, ok: false }));
        expect(await fetchRepositorySlackIntegration('repo-1')).toBeNull();
      });
    });

    describe('fetchReviewQueue', () => {
      it('accepts an empty queue and an item with parent session fields', async () => {
        mockFetch.mockResolvedValue(createMockResponse([]));
        expect(await fetchReviewQueue()).toEqual([]);

        const withParent = [
          { ...reviewGroup, items: [{ ...reviewItem, parentSessionId: 'p1', parentSessionTitle: 'Parent' }] },
        ];
        mockFetch.mockResolvedValue(createMockResponse(withParent));
        expect(await fetchReviewQueue()).toEqual(withParent);
      });

      it('throws on a non-array body, a group extra field, an item extra field and a dropped item field', async () => {
        const { createdAt: _createdAt, ...itemWithoutCreatedAt } = reviewItem;
        for (const body of [
          { groups: [reviewGroup] },
          [{ ...reviewGroup, extra: 1 }],
          [{ ...reviewGroup, items: [{ ...reviewItem, extra: 1 }] }],
          [{ ...reviewGroup, items: [itemWithoutCreatedAt] }],
          [{ ...reviewGroup, items: [{ ...reviewItem, status: 'archived' }] }],
          [{ ...reviewGroup, items: [{ ...reviewItem, summary: { ...reviewItem.summary, confidence: 'certain' } }] }],
        ]) {
          mockFetch.mockResolvedValue(createMockResponse(body));
          await expect(fetchReviewQueue()).rejects.toThrow();
        }
      });
    });
  });

  // The ten session/worker mutations parse a strict wire schema. The same table is run against
  // the REAL routes in packages/integration's api-response-schemas-boundary.test.ts.
  describe('strict response parsing (pass 4)', () => {
    const quickSession = completeWireBody({ session: { id: 's1', type: 'quick' } }) as Record<string, unknown>;
    const terminalWorker = completeWireBody({ worker: { id: 'w1', type: 'terminal' } }) as Record<string, unknown>;
    const embeddedWorker = completeWireBody({ worker: { id: 'w1', type: 'embedded-agent' } }) as Record<string, unknown>;
    const restartAll = {
      restarted: 1,
      failed: 0,
      skipped: 1,
      results: [
        { sessionId: 's1', workerId: 'w1', workerType: 'agent', outcome: 'restarted' },
        { sessionId: 's1', workerId: 'w2', workerType: 'terminal', outcome: 'skipped', error: 'not an agent' },
      ],
    };
    const designation = { repositoryId: 'repo-1', orchestratorSessionIds: ['s1'] };
    const cleared = { repositoryId: 'repo-1', removed: true, orchestratorSessionIds: [] };

    // [name, call, valid body, key whose removal must fail]
    const cases: Array<[string, () => Promise<unknown>, Record<string, unknown>, string]> = [
      ['createSession', () => createSession({ type: 'quick', locationPath: '/p' }), quickSession, 'session'],
      ['createWorker', () => createWorker('s1', { type: 'terminal', name: 'Shell' }), terminalWorker, 'worker'],
      ['restartAgentWorker', () => restartAgentWorker('s1', 'w1'), terminalWorker, 'worker'],
      ['restartWorkerAsEmbeddedAgent', () => restartWorkerAsEmbeddedAgent('s1', 'w1', 'e1'), embeddedWorker, 'worker'],
      [
        'updateEmbeddedAgentWorker',
        () => updateEmbeddedAgentWorker('s1', 'w1', { autoCompaction: false }),
        embeddedWorker,
        'worker',
      ],
      [
        'setMcpServerPermissions',
        () => setMcpServerPermissions('s1', 'w1', { all: true }),
        embeddedWorker,
        'worker',
      ],
      ['restartAllAgentWorkers', () => restartAllAgentWorkers(), restartAll, 'results'],
      ['raiseOrchestratorDesignation', () => raiseOrchestratorDesignation('s1'), designation, 'repositoryId'],
      ['clearOrchestratorDesignation', () => clearOrchestratorDesignation('s1'), cleared, 'removed'],
      ['updateSessionMetadata', () => updateSessionMetadata('s1', { title: 'T' }), { success: true, title: 'T' }, 'success'],
    ];

    it.each(cases)('%s resolves with a valid body', async (_name, call, valid) => {
      mockFetch.mockResolvedValue(createMockResponse(valid));
      expect(await call()).toEqual(valid);
    });

    it.each(cases)('%s throws on a body with an unknown extra field', async (_name, call, valid) => {
      mockFetch.mockResolvedValue(createMockResponse({ ...valid, extra: true }));
      await expect(call()).rejects.toThrow();
    });

    it.each(cases)('%s throws when a required key is missing', async (_name, call, valid, requiredKey) => {
      const { [requiredKey]: _dropped, ...rest } = valid;
      mockFetch.mockResolvedValue(createMockResponse(rest));
      await expect(call()).rejects.toThrow();
    });

    it.each(cases.filter(([, , valid]) => 'worker' in valid))(
      '%s throws when the nested worker has an unknown field or a dropped required field',
      async (_name, call, valid) => {
        const worker = valid.worker as Record<string, unknown>;
        const { createdAt: _dropped, ...withoutCreatedAt } = worker;
        for (const body of [{ worker: { ...worker, extra: 1 } }, { worker: withoutCreatedAt }]) {
          mockFetch.mockResolvedValue(createMockResponse(body));
          await expect(call()).rejects.toThrow();
        }
      },
    );

    it('createSession throws when the nested session has an unknown field', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ session: { ...(quickSession.session as object), extra: 1 } }));
      await expect(createSession({ type: 'quick', locationPath: '/p' })).rejects.toThrow();
    });

    it('does not parse the body of a failed response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: mock(() => Promise.resolve({ error: 'boom' })),
      } as unknown as Response);
      await expect(createWorker('s1', { type: 'terminal', name: 'Shell' })).rejects.toThrow('boom');
    });

    describe('restartAllAgentWorkers', () => {
      it('accepts an empty results list (the vacuous case)', async () => {
        const empty = { restarted: 0, failed: 0, skipped: 0, results: [] };
        mockFetch.mockResolvedValue(createMockResponse(empty));
        expect(await restartAllAgentWorkers()).toEqual(empty);
      });

      it('throws when ONE result row lacks outcome, carries an unknown field or has an unknown workerType', async () => {
        const [first] = restartAll.results;
        const { outcome: _outcome, ...withoutOutcome } = first;
        for (const row of [withoutOutcome, { ...first, extra: 1 }, { ...first, workerType: 'git-diff' }]) {
          mockFetch.mockResolvedValue(createMockResponse({ ...restartAll, results: [first, row] }));
          await expect(restartAllAgentWorkers()).rejects.toThrow();
        }
      });
    });

    describe('clearOrchestratorDesignation', () => {
      it('accepts the idempotent no-op body (removed: false)', async () => {
        const noop = { repositoryId: 'repo-1', removed: false, orchestratorSessionIds: ['s2'] };
        mockFetch.mockResolvedValue(createMockResponse(noop));
        expect(await clearOrchestratorDesignation('s1')).toEqual(noop);
      });
    });

    describe('updateSessionMetadata', () => {
      it('accepts { success: true } without a title, and rejects false and a null title', async () => {
        mockFetch.mockResolvedValue(createMockResponse({ success: true }));
        expect(await updateSessionMetadata('s1', {})).toEqual({ success: true });

        for (const body of [{ success: false }, { success: true, title: null }]) {
          mockFetch.mockResolvedValue(createMockResponse(body));
          await expect(updateSessionMetadata('s1', {})).rejects.toThrow();
        }
      });
    });
  });
});
