/**
 * `set_agent_parameters` MCP tool tests (agent-surface.md Phase 3, mid-run
 * model / reasoning-effort / context-window change).
 *
 * Drives the REAL `createMcpApp` handler chain via `callTool` (real MCP
 * JSON-RPC transport), against a real `SessionManager` with a real
 * `EmbeddedAgentManager`, mirroring `create-bookmark.test.ts`'s shape.
 *
 * The guard is the reason this file exists as its own file rather than a
 * describe block elsewhere: this is the only tool in `mcp-server.ts` whose
 * authorization is STRICTER than `checkCallerOwnsSession` alone, and the two
 * extra conditions (own worker, and a verified identity required in EVERY
 * auth mode) each need their own negative case.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { JobQueue } from '../../jobs/job-queue.js';
import { registerJobHandlers } from '../../jobs/handlers.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import { SessionManager } from '../../services/session-manager.js';
import { RepositoryManager } from '../../services/repository-manager.js';
import { AgentManager, CLAUDE_CODE_AGENT_ID } from '../../services/agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { JsonSessionRepository } from '../../repositories/index.js';
import { SqliteRepositoryRepository } from '../../repositories/sqlite-repository-repository.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { SqliteArtifactRepository } from '../../repositories/sqlite-artifact-repository.js';
import { SqliteBookmarkRepository } from '../../repositories/sqlite-bookmark-repository.js';
import { WorktreeService } from '../../services/worktree-service.js';
import { TimerManager } from '../../services/timer-manager.js';
import { ConditionalWakeupManager } from '../../services/conditional-wakeup-manager.js';
import { InteractiveProcessManager } from '../../services/interactive-process-manager.js';
import { AnnotationService } from '../../services/annotation-service.js';
import { InterSessionMessageService } from '../../services/inter-session-message-service.js';
import { SingleUserMode } from '../../services/user-mode.js';
import { EmbeddedAgentManager } from '../../services/embedded-agent-manager.js';
import { SqliteEmbeddedAgentRepository } from '../../repositories/sqlite-embedded-agent-repository.js';
import { createMcpApp } from '../mcp-server.js';
import { McpTokenRegistry, type McpAuthMode } from '../mcp-auth.js';
import { AgentDirectory } from '../../services/agent-directory.js';
import { createWorktreeWithSession } from '../../services/worktree-creation-service.js';
import { deleteWorktree } from '../../services/worktree-deletion-service.js';
import { initializeMcp, callTool, parseToolResult } from './mcp-protocol-test-helpers.js';

const TEST_CONFIG_DIR = '/test/config-set-agent-parameters';
const TEST_REPO_PATH = '/test/repo-set-agent-parameters';
const TEST_REPO_ID = 'repo-set-agent-parameters';

describe('set_agent_parameters', () => {
  const ptyFactory = createMockPtyFactory();
  let app: Hono;
  let sessionManager: SessionManager;
  let repositoryManager: RepositoryManager;
  let agentManager: AgentManager;
  let embeddedAgentManager: EmbeddedAgentManager;
  let userRepository: SqliteUserRepository;
  let worktreeService: WorktreeService;
  let agentDirectory: AgentDirectory;
  let artifactRepository: SqliteArtifactRepository;
  let bookmarkRepository: SqliteBookmarkRepository;
  let testJobQueue: JobQueue;
  let mcpSessionId: string;
  let registry: McpTokenRegistry;
  let nextId: number;

  async function mountMcpApp(mcpAuthMode: McpAuthMode = 'off'): Promise<void> {
    registry = new McpTokenRegistry();
    const mcpApp = createMcpApp({
      sessionManager,
      repositoryManager,
      agentManager,
      agentDirectory,
      timerManager: new TimerManager(() => {}),
      conditionalWakeupManager: new ConditionalWakeupManager(() => {}),
      interactiveProcessManager: new InteractiveProcessManager(() => {}, () => {}),
      worktreeService,
      annotationService: new AnnotationService(),
      interSessionMessageService: new InterSessionMessageService(),
      suggestSessionMetadata: async () => ({ branch: 'unused', title: 'unused' }),
      createWorktreeWithSession,
      deleteWorktree,
      userRepository,
      artifactRepository,
      bookmarkRepository,
      broadcastToApp: () => {},
      findOpenPullRequest: async () => null,
      fetchPullRequestUrl: async () => null,
      mcpAuthMode,
      mcpTokenRegistry: registry,
    });
    app = new Hono();
    app.route('', mcpApp);

    let initializeHeaders: Record<string, string> | undefined;
    if (mcpAuthMode === 'enforce') {
      const handshakeToken = registry.mint({
        sessionId: 'handshake-session',
        workerId: 'handshake-worker',
        userId: 'handshake-user',
      });
      initializeHeaders = { Authorization: `Bearer ${handshakeToken}` };
    }
    mcpSessionId = await initializeMcp(app, initializeHeaders);
  }

  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    await initializeDatabase(':memory:');
    testJobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());

    resetProcessMock();
    mockProcess.markAlive(process.pid);
    ptyFactory.reset();
    resetGitMocks();

    const db = getDatabase();
    agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
    userRepository = new SqliteUserRepository(db);
    artifactRepository = new SqliteArtifactRepository(db);
    bookmarkRepository = new SqliteBookmarkRepository(db);

    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);
    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      embeddedAgentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      annotationService: new AnnotationService(),
      userRepository,
      repositoryLookup: { getRepositorySlug: async (id: string) => repositoryManager?.getRepositorySlug(id) },
      repositoryEnvLookup: {
        getRepositoryInfo: (id: string) => {
          const r = repositoryManager?.getRepository(id);
          return r ? { name: r.name, path: r.path, envVars: r.envVars } : undefined;
        },
        getWorktreeIndexNumber: async () => 0,
      },
    });

    const sqliteRepoRepo = new SqliteRepositoryRepository(db);
    await sqliteRepoRepo.save({
      id: TEST_REPO_ID,
      name: 'test-repo',
      path: TEST_REPO_PATH,
      createdAt: new Date().toISOString(),
      clonedSourceRepoPath: null,
    });
    repositoryManager = await RepositoryManager.create({ repository: sqliteRepoRepo, jobQueue: testJobQueue });

    worktreeService = new WorktreeService({ db });
    agentDirectory = new AgentDirectory({ terminal: agentManager, embedded: embeddedAgentManager });

    await mountMcpApp();
    nextId = 10;
  });

  afterEach(async () => {
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  async function createEmbeddedAgentDef(): Promise<string> {
    const def = await embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Stub embedded agent',
        provider: { baseUrl: 'http://localhost:9/v1', model: 'stub-model' },
        contextWindowTokens: 128_000,
      },
      'creator-user-id',
    );
    return def.id;
  }

  /** A session owned by `osUid`, carrying one embedded-agent worker. */
  async function createEmbeddedWorker(osUid = 9001, username = 'params-owner') {
    const owner = await userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const embeddedAgentId = await createEmbeddedAgentDef();
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH },
      { createdBy: owner.id },
    );
    const worker = await sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId,
    });
    return { sessionId: session.id, workerId: worker!.id, userId: owner.id, embeddedAgentId };
  }

  function readWorker(sessionId: string, workerId: string) {
    const worker = sessionManager.getSession(sessionId)!.workers.find((w) => w.id === workerId)!;
    if (worker.type !== 'embedded-agent') throw new Error('expected an embedded-agent worker');
    return worker;
  }

  function authHeader(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  // ---------- Happy path ----------

  it("sets the caller's own worker's parameters and returns the updated worker", async () => {
    const { sessionId, workerId, userId } = await createEmbeddedWorker();
    const token = registry.mint({ sessionId, workerId, userId });

    const response = await callTool(
      app,
      mcpSessionId,
      'set_agent_parameters',
      { sessionId, workerId, model: 'qwen3:72b', contextWindowTokens: 32_000 },
      nextId++,
      authHeader(token),
    );

    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as {
      worker: { model?: string; contextWindowTokens?: number; hasParameterOverride: boolean };
    };
    expect(data.worker.model).toBe('qwen3:72b');
    expect(data.worker.contextWindowTokens).toBe(32_000);
    expect(data.worker.hasParameterOverride).toBe(true);

    // And it actually reached the durable state, not just the response.
    expect(readWorker(sessionId, workerId).model).toBe('qwen3:72b');
  });

  it('clears an override when the field is null (absent and null are different instructions)', async () => {
    const { sessionId, workerId, userId } = await createEmbeddedWorker();
    const token = registry.mint({ sessionId, workerId, userId });
    await callTool(
      app,
      mcpSessionId,
      'set_agent_parameters',
      { sessionId, workerId, reasoningEffort: 'high' },
      nextId++,
      authHeader(token),
    );

    const response = await callTool(
      app,
      mcpSessionId,
      'set_agent_parameters',
      { sessionId, workerId, reasoningEffort: null },
      nextId++,
      authHeader(token),
    );

    expect(response.result?.isError).toBeUndefined();
    expect(readWorker(sessionId, workerId).reasoningEffort).toBeNull();
    expect(readWorker(sessionId, workerId).hasParameterOverride).toBe(false);
  });

  it('persists the trimmed value (the shared validator normalises, the tool does not re-trim)', async () => {
    const { sessionId, workerId, userId } = await createEmbeddedWorker();
    const token = registry.mint({ sessionId, workerId, userId });

    await callTool(
      app,
      mcpSessionId,
      'set_agent_parameters',
      { sessionId, workerId, reasoningEffort: '  high  ' },
      nextId++,
      authHeader(token),
    );

    expect(readWorker(sessionId, workerId).reasoningEffort).toBe('high');
  });

  // ---------- The guard, which is stricter than checkCallerOwnsSession ----------

  it('refuses a TOKENLESS caller even in off mode, where every other tool proceeds', async () => {
    // Not a forgotten mode check: a caller with no verified identity has no
    // "own worker", so this tool's entire contract is unsatisfiable.
    const { sessionId, workerId } = await createEmbeddedWorker();

    const response = await callTool(
      app,
      mcpSessionId,
      'set_agent_parameters',
      { sessionId, workerId, reasoningEffort: 'high' },
      nextId++,
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('verified caller identity');
    expect(readWorker(sessionId, workerId).reasoningEffort).toBeNull();
  });

  it('refuses a tokenless caller in warn mode too (the other tools log and proceed there)', async () => {
    await mountMcpApp('warn');
    const { sessionId, workerId } = await createEmbeddedWorker();

    const response = await callTool(
      app,
      mcpSessionId,
      'set_agent_parameters',
      { sessionId, workerId, reasoningEffort: 'high' },
      nextId++,
    );

    expect(response.result?.isError).toBe(true);
    expect(readWorker(sessionId, workerId).reasoningEffort).toBeNull();
  });

  it("refuses a SIBLING worker in the caller's own session (checkCallerOwnsSession alone would accept it)", async () => {
    // This is the case the session-ownership check cannot see: same session,
    // same owner, different worker. Without the own-worker check the write
    // would go through.
    const { sessionId, workerId, userId, embeddedAgentId } = await createEmbeddedWorker();
    const sibling = await sessionManager.createWorker(sessionId, {
      type: 'embedded-agent',
      embeddedAgentId,
    });
    const token = registry.mint({ sessionId, workerId, userId });

    const response = await callTool(
      app,
      mcpSessionId,
      'set_agent_parameters',
      { sessionId, workerId: sibling!.id, reasoningEffort: 'high' },
      nextId++,
      authHeader(token),
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('your own worker');
    expect(readWorker(sessionId, sibling!.id).reasoningEffort).toBeNull();
  });

  it("refuses another user's session with the ownership mismatch, before the own-worker check", async () => {
    const a = await createEmbeddedWorker(9002, 'params-owner-a');
    const b = await createEmbeddedWorker(9003, 'params-owner-b');
    expect(a.userId).not.toBe(b.userId);
    const tokenA = registry.mint({ sessionId: a.sessionId, workerId: a.workerId, userId: a.userId });

    const response = await callTool(
      app,
      mcpSessionId,
      'set_agent_parameters',
      { sessionId: b.sessionId, workerId: b.workerId, reasoningEffort: 'high' },
      nextId++,
      authHeader(tokenA),
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('identity mismatch');
    expect(readWorker(b.sessionId, b.workerId).reasoningEffort).toBeNull();
  });

  it('refuses a TERMINAL-agent caller with a classified message naming the alternative', async () => {
    const owner = await userRepository.upsertByOsUid(9004, 'terminal-owner', '/home/terminal-owner');
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH, agentId: CLAUDE_CODE_AGENT_ID },
      { createdBy: owner.id },
    );
    const agentWorker = session.workers.find((w) => w.type === 'agent')!;
    const token = registry.mint({ sessionId: session.id, workerId: agentWorker.id, userId: owner.id });

    const response = await callTool(
      app,
      mcpSessionId,
      'set_agent_parameters',
      { sessionId: session.id, workerId: agentWorker.id, reasoningEffort: 'high' },
      nextId++,
      authHeader(token),
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('terminal agents have no runtime parameter path');
    expect(data.error).toContain('restart with a model instead');
  });

  it('reports a session that does not exist rather than silently succeeding', async () => {
    const { sessionId, workerId, userId } = await createEmbeddedWorker();
    const token = registry.mint({ sessionId, workerId, userId });

    const response = await callTool(
      app,
      mcpSessionId,
      'set_agent_parameters',
      { sessionId: 'no-such-session', workerId, reasoningEffort: 'high' },
      nextId++,
      authHeader(token),
    );

    expect(response.result?.isError).toBe(true);
    expect((parseToolResult(response) as { error: string }).error).toContain('no-such-session');
  });

  // ---------- Ruling 4, through the SAME wire schema the REST PATCH uses ----------

  it('rejects contextWindowTokens with no model, with the wire schema\'s own message', async () => {
    const { sessionId, workerId, userId } = await createEmbeddedWorker();
    const token = registry.mint({ sessionId, workerId, userId });

    const response = await callTool(
      app,
      mcpSessionId,
      'set_agent_parameters',
      { sessionId, workerId, contextWindowTokens: 32_000 },
      nextId++,
      authHeader(token),
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('contextWindowTokens is a property of a model override');
  });

  it('rejects a non-null model with no contextWindowTokens', async () => {
    const { sessionId, workerId, userId } = await createEmbeddedWorker();
    const token = registry.mint({ sessionId, workerId, userId });

    const response = await callTool(
      app,
      mcpSessionId,
      'set_agent_parameters',
      { sessionId, workerId, model: 'qwen3:72b' },
      nextId++,
      authHeader(token),
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('pass null to declare no window');
  });

  it('rejects a call carrying none of the three parameter fields (a call that would change nothing)', async () => {
    const { sessionId, workerId, userId } = await createEmbeddedWorker();
    const token = registry.mint({ sessionId, workerId, userId });

    const response = await callTool(
      app,
      mcpSessionId,
      'set_agent_parameters',
      { sessionId, workerId },
      nextId++,
      authHeader(token),
    );

    expect(response.result?.isError).toBe(true);
    expect((parseToolResult(response) as { error: string }).error).toContain('at least one of');
  });

  it('surfaces a validator rejection (an unaccepted effort value) as a tool error, not a silent no-op', async () => {
    const { sessionId, workerId, userId } = await createEmbeddedWorker();
    const token = registry.mint({ sessionId, workerId, userId });

    const response = await callTool(
      app,
      mcpSessionId,
      'set_agent_parameters',
      { sessionId, workerId, reasoningEffort: '   ' },
      nextId++,
      authHeader(token),
    );

    expect(response.result?.isError).toBe(true);
    expect((parseToolResult(response) as { error: string }).error).toContain(
      'reasoningEffort must not be empty',
    );
    expect(readWorker(sessionId, workerId).reasoningEffort).toBeNull();
  });

  // ---------- Registration / description ----------

  it('is registered with all five parameters and a description that states persistence and next-response timing', async () => {
    const listRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': mcpSessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: nextId++ }),
    });
    const listBody = (await listRes.json()) as {
      result?: {
        tools?: Array<{
          name: string;
          description?: string;
          inputSchema?: { properties?: Record<string, unknown> };
        }>;
      };
    };
    const tool = listBody.result?.tools?.find((t) => t.name === 'set_agent_parameters');

    expect(tool).toBeDefined();
    expect(Object.keys(tool!.inputSchema?.properties ?? {}).sort()).toEqual([
      'contextWindowTokens',
      'model',
      'reasoningEffort',
      'sessionId',
      'workerId',
    ]);
    expect(tool!.description).toContain('persisted');
    expect(tool!.description).toContain('next response');
  });

  it('does NOT promise a restart for an effort change (a real SDK probe disproved that ruling before it shipped)', async () => {
    // Both engines apply both parameters live, so a description mentioning a
    // restart would be a false promise to the model reading it. Pinned
    // because the dropped ruling is still written down in the Issue text a
    // future reader may find.
    const listRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': mcpSessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: nextId++ }),
    });
    const listBody = (await listRes.json()) as {
      result?: { tools?: Array<{ name: string; description?: string }> };
    };
    const tool = listBody.result?.tools?.find((t) => t.name === 'set_agent_parameters');

    // The description DOES promise the override survives a restart (Ruling 4,
    // and true). What it must never say is that a change CAUSES one -- the
    // two are opposite claims that share the word, so a bare
    // `not.toContain('restart')` would be wrong rather than strict.
    expect(tool!.description).toMatch(/survives a restart/i);
    expect(tool!.description).not.toMatch(/requires? a restart/i);
    expect(tool!.description).not.toMatch(/restarts? (the|your) (agent|process|worker)/i);
  });
});
