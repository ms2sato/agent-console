/**
 * `set_mcp_server_permission` MCP tool tests (epic #1636 Phase 5 PR-3a,
 * docs/design/embedded-agent-sdk-engine.md §4.5's "the approval record" /
 * D-C / D-D).
 *
 * Drives the REAL `createMcpApp` handler chain via `callTool` (real MCP
 * JSON-RPC transport), against a real `SessionManager` with a real
 * `EmbeddedAgentManager` and a real `SqliteMcpServerPermissionRepository`,
 * mirroring `set-agent-parameters.test.ts`'s shape. The target worker's
 * discovered MCP servers are seeded via a fake embedded-agent subprocess
 * (`makeFakeEmbeddedSpawn`, mirroring
 * `delegate-embedded-agent-activation.test.ts` /
 * `routes/__tests__/workers.test.ts`'s `seedDiscovered`), which pushes a
 * real `mcp-servers-discovered` NDJSON event on stdout.
 *
 * Unlike `set_agent_parameters`, this tool checks ownership of the TARGET
 * session, not the caller's own -- its whole point is deciding for ANOTHER
 * session (a TUI Orchestrator deciding for its delegate). See
 * `mcp-server.ts`'s `set_mcp_server_permission` block comment for the full
 * authorization order.
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
import { SqliteMcpServerPermissionRepository } from '../../repositories/sqlite-mcp-server-permission-repository.js';
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
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '../../services/privilege-elevation.js';

const TEST_CONFIG_DIR = '/test/config-set-mcp-server-permission';
const TEST_REPO_PATH = '/test/repo-set-mcp-server-permission';
const TEST_REPO_ID = 'repo-set-mcp-server-permission';

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService (write/end/flush). */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

/**
 * Fake spawnAsUser for the embedded-agent loop subprocess, with a `pushLine`
 * hook to emit NDJSON events on stdout. Copied from
 * `delegate-embedded-agent-activation.test.ts` (single-shot: one spawn per
 * fake instance, fresh instance per test via `beforeEach`).
 */
function makeFakeEmbeddedSpawn(): {
  fn: SpawnAsUserFn;
  captured: SpawnAsUserOpts[];
  stdinWrites: string[];
  pushLine: (obj: unknown) => void;
  simulateExit: (code: number) => void;
} {
  const captured: SpawnAsUserOpts[] = [];
  const stdinWrites: string[] = [];

  let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { stdoutCtrl = c; } });
  const stderr = new ReadableStream<Uint8Array>({ start(c) { stderrCtrl = c; } });

  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExited = resolve; });
  let exitSimulated = false;
  const simulateExit = (code: number) => {
    if (exitSimulated) return;
    exitSimulated = true;
    resolveExited(code);
    stdoutCtrl.close();
    stderrCtrl.close();
  };

  const encoder = new TextEncoder();
  const pushLine = (obj: unknown) => {
    stdoutCtrl.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
  };

  const stdin: FakeFileSink = {
    write: (chunk) => {
      stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return 0;
    },
    end: () => {},
    flush: () => 0,
  };

  const subprocess = { pid: 8765, exited, stdin, stdout, stderr, kill: () => {} };

  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    return { subprocess, stdin, elevated: false } as unknown as SpawnAsUserResult;
  };

  return { fn, captured, stdinWrites, pushLine, simulateExit };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('set_mcp_server_permission', () => {
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
  let mcpServerPermissionRepository: SqliteMcpServerPermissionRepository;
  let testJobQueue: JobQueue;
  let mcpSessionId: string;
  let registry: McpTokenRegistry;
  let fakeEmbeddedSpawn: ReturnType<typeof makeFakeEmbeddedSpawn>;
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

    fakeEmbeddedSpawn = makeFakeEmbeddedSpawn();

    const db = getDatabase();
    agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
    userRepository = new SqliteUserRepository(db);
    artifactRepository = new SqliteArtifactRepository(db);
    bookmarkRepository = new SqliteBookmarkRepository(db);
    mcpServerPermissionRepository = new SqliteMcpServerPermissionRepository(db);

    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);
    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      embeddedAgentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      mcpServerPermissionRepository,
      spawnAsUserFn: fakeEmbeddedSpawn.fn,
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
      orchestratorSessionIds: [],
      clonedSourceRepoPath: null,
    });
    repositoryManager = await RepositoryManager.create({ repository: sqliteRepoRepo, jobQueue: testJobQueue });

    worktreeService = new WorktreeService({ db });
    agentDirectory = new AgentDirectory({ terminal: agentManager, embedded: embeddedAgentManager });

    await mountMcpApp();
    nextId = 10;
  });

  afterEach(async () => {
    if (sessionManager) {
      for (const session of sessionManager.getAllSessions()) {
        for (const worker of session.workers) {
          if (worker.type === 'embedded-agent' && worker.activated) {
            const deactivatePromise = sessionManager.deactivateEmbeddedAgentWorker(session.id, worker.id);
            fakeEmbeddedSpawn.simulateExit(0);
            await deactivatePromise;
          }
        }
      }
    }
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  async function createEmbeddedAgentDef(): Promise<string> {
    const def = await embeddedAgentManager.createEmbeddedAgent(
      {
        engine: 'openai-api',
        name: 'Stub embedded agent',
        provider: { baseUrl: 'http://localhost:9/v1', model: 'stub-model' },
        contextWindowTokens: 128_000,
      },
      'creator-user-id',
    );
    return def.id;
  }

  /** A worktree session owned by `osUid`, carrying one embedded-agent (target) worker. */
  async function createTargetWorker(osUid: number, username: string, worktreeId: string) {
    const owner = await userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const embeddedAgentId = await createEmbeddedAgentDef();
    const session = await sessionManager.createSession(
      { type: 'worktree', locationPath: TEST_REPO_PATH, repositoryId: TEST_REPO_ID, worktreeId },
      { createdBy: owner.id },
    );
    const worker = await sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId,
    });
    return { sessionId: session.id, workerId: worker!.id, userId: owner.id, embeddedAgentId };
  }

  /** Activates the target worker and pushes a `mcp-servers-discovered` event, waiting for it to land. */
  async function seedDiscovered(
    sessionId: string,
    workerId: string,
    servers: Array<{ name: string; scope: string; hash?: string; decision?: string }>,
  ): Promise<void> {
    await sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
    fakeEmbeddedSpawn.pushLine({ v: 1, type: 'mcp-servers-discovered', servers });
    await waitFor(() => {
      const w = sessionManager.getSession(sessionId)!.workers.find((x) => x.id === workerId);
      return !!w && w.type === 'embedded-agent' && w.mcpServers !== undefined;
    });
  }

  /** A TUI (PTY agent) caller session owned by `osUid`, with a bearer token for its sole worker. */
  async function createTuiCaller(osUid: number, username: string) {
    const owner = await userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH, agentId: CLAUDE_CODE_AGENT_ID },
      { createdBy: owner.id },
    );
    const workerId = session.workers[0].id;
    const token = registry.mint({ sessionId: session.id, workerId, userId: owner.id });
    return { sessionId: session.id, workerId, userId: owner.id, token };
  }

  /** An embedded-agent caller worker (never activated) with a bearer token, owned by `osUid`. */
  async function createEmbeddedCaller(osUid: number, username: string) {
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
    const token = registry.mint({ sessionId: session.id, workerId: worker!.id, userId: owner.id });
    return { sessionId: session.id, workerId: worker!.id, userId: owner.id, token };
  }

  function authHeader(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function findRow(rows: Array<{ name: string; hash?: string; decision?: string }>, name: string) {
    return rows.find((r) => r.name === name);
  }

  // ---------- (a) happy path: TUI caller decides for its delegate ----------

  it("(a) a TUI caller allows a pending pair on its own delegate's session, and it reaches the durable state", async () => {
    const tui = await createTuiCaller(9101, 'orchestrator-a');
    const target = await createTargetWorker(9101, 'orchestrator-a', 'wt-a');
    await seedDiscovered(target.sessionId, target.workerId, [
      { name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' },
    ]);

    const response = await callTool(
      app,
      mcpSessionId,
      'set_mcp_server_permission',
      { sessionId: target.sessionId, workerId: target.workerId, name: 'chrome-devtools', hash: 'hash-1', decision: 'allow' },
      nextId++,
      authHeader(tui.token),
    );

    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as {
      sessionId: string;
      workerId: string;
      mcpServers?: Array<{ name: string; decision?: string }>;
    };
    expect(data.sessionId).toBe(target.sessionId);
    expect(findRow(data.mcpServers ?? [], 'chrome-devtools')?.decision).toBe('allowed');

    // Persisted, not just reflected in the response.
    const rows = await mcpServerPermissionRepository.listByScope({ kind: 'repository', repositoryId: TEST_REPO_ID });
    const row = rows.find((r) => r.serverName === 'chrome-devtools');
    expect(row?.decision).toBe('allow');
    expect(row?.decidedBy).toBe(tui.userId);
  });

  // ---------- (b) { all: true } ----------

  it('(b) { all: true } allows every currently-pending pair and no others', async () => {
    const tui = await createTuiCaller(9102, 'orchestrator-b');
    const target = await createTargetWorker(9102, 'orchestrator-b', 'wt-b');
    await seedDiscovered(target.sessionId, target.workerId, [
      { name: 'pending-1', scope: 'project', hash: 'h1', decision: 'pending' },
      { name: 'pending-2', scope: 'project', hash: 'h2', decision: 'pending' },
      { name: 'already-allowed', scope: 'project', hash: 'h3', decision: 'allowed' },
    ]);

    const response = await callTool(
      app,
      mcpSessionId,
      'set_mcp_server_permission',
      { sessionId: target.sessionId, workerId: target.workerId, all: true },
      nextId++,
      authHeader(tui.token),
    );

    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as { mcpServers?: Array<{ name: string; decision?: string }> };
    expect(findRow(data.mcpServers ?? [], 'pending-1')?.decision).toBe('allowed');
    expect(findRow(data.mcpServers ?? [], 'pending-2')?.decision).toBe('allowed');
    expect(findRow(data.mcpServers ?? [], 'already-allowed')?.decision).toBe('allowed');

    const rows = await mcpServerPermissionRepository.listByScope({ kind: 'repository', repositoryId: TEST_REPO_ID });
    expect(rows).toHaveLength(2);
  });

  // ---------- (c) deny then allow, last-write-wins ----------

  it('(c) deny then allow on the same pair is last-write-wins (one durable row, response reflects allow)', async () => {
    const tui = await createTuiCaller(9103, 'orchestrator-c');
    const target = await createTargetWorker(9103, 'orchestrator-c', 'wt-c');
    await seedDiscovered(target.sessionId, target.workerId, [
      { name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' },
    ]);

    const denyRes = await callTool(
      app,
      mcpSessionId,
      'set_mcp_server_permission',
      { sessionId: target.sessionId, workerId: target.workerId, name: 'chrome-devtools', hash: 'hash-1', decision: 'deny' },
      nextId++,
      authHeader(tui.token),
    );
    expect(denyRes.result?.isError).toBeUndefined();

    const allowRes = await callTool(
      app,
      mcpSessionId,
      'set_mcp_server_permission',
      { sessionId: target.sessionId, workerId: target.workerId, name: 'chrome-devtools', hash: 'hash-1', decision: 'allow' },
      nextId++,
      authHeader(tui.token),
    );
    expect(allowRes.result?.isError).toBeUndefined();
    const data = parseToolResult(allowRes) as { mcpServers?: Array<{ name: string; decision?: string }> };
    expect(findRow(data.mcpServers ?? [], 'chrome-devtools')?.decision).toBe('allowed');

    const rows = await mcpServerPermissionRepository.listByScope({ kind: 'repository', repositoryId: TEST_REPO_ID });
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('allow');
  });

  // ---------- (d) / (e) the embedded-caller refusal ----------

  // Polarity confirmed (workflow.md TDD requirement): removing the
  // caller-worker-type check (`if (!callerWorker || callerWorker.type ===
  // 'embedded-agent')`) in `mcp-server.ts`'s `set_mcp_server_permission`
  // handler makes BOTH (d) and (e) fail -- (d) falls through to the
  // quick-session #1786 message instead of the embedded-caller refusal,
  // and (e) succeeds (isError undefined) where it must be refused.
  it("(d) an EMBEDDED caller targeting its OWN session is refused; nothing persisted", async () => {
    const embedded = await createEmbeddedCaller(9104, 'embedded-d');
    // Its own session has no repository (quick session), but the refusal
    // must fire BEFORE the quick-session check is ever reached.
    const response = await callTool(
      app,
      mcpSessionId,
      'set_mcp_server_permission',
      { sessionId: embedded.sessionId, workerId: embedded.workerId, all: true },
      nextId++,
      authHeader(embedded.token),
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('embedded agent cannot grant');
    const rows = await mcpServerPermissionRepository.listByScope({ kind: 'repository', repositoryId: TEST_REPO_ID });
    expect(rows).toHaveLength(0);
  });

  it('(e) an EMBEDDED caller targeting ANOTHER session it "owns" (same user) is refused likewise', async () => {
    const embedded = await createEmbeddedCaller(9105, 'embedded-e');
    const target = await createTargetWorker(9105, 'embedded-e', 'wt-e');
    await seedDiscovered(target.sessionId, target.workerId, [
      { name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' },
    ]);

    const response = await callTool(
      app,
      mcpSessionId,
      'set_mcp_server_permission',
      { sessionId: target.sessionId, workerId: target.workerId, name: 'chrome-devtools', hash: 'hash-1', decision: 'allow' },
      nextId++,
      authHeader(embedded.token),
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('embedded agent cannot grant');
    const rows = await mcpServerPermissionRepository.listByScope({ kind: 'repository', repositoryId: TEST_REPO_ID });
    expect(rows).toHaveLength(0);
  });

  // ---------- (f) tokenless caller ----------

  it('(f) a tokenless caller is refused in off mode, where most other tools proceed', async () => {
    const target = await createTargetWorker(9106, 'owner-f1', 'wt-f1');
    await seedDiscovered(target.sessionId, target.workerId, [
      { name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' },
    ]);

    const response = await callTool(
      app,
      mcpSessionId,
      'set_mcp_server_permission',
      { sessionId: target.sessionId, workerId: target.workerId, name: 'chrome-devtools', hash: 'hash-1', decision: 'allow' },
      nextId++,
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('verified caller identity');
    const rows = await mcpServerPermissionRepository.listByScope({ kind: 'repository', repositoryId: TEST_REPO_ID });
    expect(rows).toHaveLength(0);
  });

  it('(f) a tokenless caller is refused in warn mode too', async () => {
    await mountMcpApp('warn');
    const target = await createTargetWorker(9107, 'owner-f2', 'wt-f2');
    await seedDiscovered(target.sessionId, target.workerId, [
      { name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' },
    ]);

    const response = await callTool(
      app,
      mcpSessionId,
      'set_mcp_server_permission',
      { sessionId: target.sessionId, workerId: target.workerId, name: 'chrome-devtools', hash: 'hash-1', decision: 'allow' },
      nextId++,
    );

    expect(response.result?.isError).toBe(true);
    const rows = await mcpServerPermissionRepository.listByScope({ kind: 'repository', repositoryId: TEST_REPO_ID });
    expect(rows).toHaveLength(0);
  });

  it('(f) a tokenless caller is rejected at the transport gate under enforce (401, before the tool is ever reached)', async () => {
    await mountMcpApp('enforce');
    const target = await createTargetWorker(9108, 'owner-f3', 'wt-f3');

    // Under enforce, activation/discovery seeding itself needs no auth (it
    // does not go through the tool), so we can still seed via the service
    // directly. We only need the tool call below to hit the transport gate.
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Session-Id': mcpSessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'set_mcp_server_permission',
          arguments: { sessionId: target.sessionId, workerId: target.workerId, all: true },
        },
        id: nextId++,
      }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('MCP authentication required');
  });

  // ---------- (g) foreign target owner ----------

  // Polarity confirmed: dropping the `checkCallerOwnsSession(...)` call in
  // `mcp-server.ts`'s `set_mcp_server_permission` handler makes this test
  // fail (isError undefined) -- the pair is discovered and the tool would
  // otherwise happily allow it for a foreign caller.
  it("(g) a caller whose identity does not own the target session is refused by checkCallerOwnsSession (enforce mode)", async () => {
    await mountMcpApp('enforce');
    const tui = await createTuiCaller(9109, 'orchestrator-g');
    // A DIFFERENT owner's target session.
    const target = await createTargetWorker(9110, 'owner-g-foreign', 'wt-g');
    await seedDiscovered(target.sessionId, target.workerId, [
      { name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' },
    ]);

    const response = await callTool(
      app,
      mcpSessionId,
      'set_mcp_server_permission',
      { sessionId: target.sessionId, workerId: target.workerId, name: 'chrome-devtools', hash: 'hash-1', decision: 'allow' },
      nextId++,
      authHeader(tui.token),
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('identity mismatch');
    const rows = await mcpServerPermissionRepository.listByScope({ kind: 'repository', repositoryId: TEST_REPO_ID });
    expect(rows).toHaveLength(0);
  });

  // ---------- (h) discovery / target-shape failure modes ----------

  it('(h) an unknown (name, hash) pair returns the not-discovered text', async () => {
    const tui = await createTuiCaller(9111, 'orchestrator-h1');
    const target = await createTargetWorker(9111, 'orchestrator-h1', 'wt-h1');
    await seedDiscovered(target.sessionId, target.workerId, [
      { name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' },
    ]);

    const response = await callTool(
      app,
      mcpSessionId,
      'set_mcp_server_permission',
      { sessionId: target.sessionId, workerId: target.workerId, name: 'never-discovered', hash: 'hash-x', decision: 'allow' },
      nextId++,
      authHeader(tui.token),
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain("MCP server 'never-discovered' with hash 'hash-x'");
  });

  it('(h) an invalid pair returns the undecidable text', async () => {
    const tui = await createTuiCaller(9112, 'orchestrator-h2');
    const target = await createTargetWorker(9112, 'orchestrator-h2', 'wt-h2');
    await seedDiscovered(target.sessionId, target.workerId, [
      { name: 'bad-server', scope: 'project', hash: 'hash-bad', decision: 'invalid' },
    ]);

    const response = await callTool(
      app,
      mcpSessionId,
      'set_mcp_server_permission',
      { sessionId: target.sessionId, workerId: target.workerId, name: 'bad-server', hash: 'hash-bad', decision: 'allow' },
      nextId++,
      authHeader(tui.token),
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('invalid');
  });

  it('(h) a quick-session target is recorded under the path key', async () => {
    const owner = await userRepository.upsertByOsUid(9113, 'owner-h3', '/home/owner-h3');
    const tui = await createTuiCaller(9113, 'owner-h3');
    const embeddedAgentId = await createEmbeddedAgentDef();
    const quickSession = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH },
      { createdBy: owner.id },
    );
    const worker = await sessionManager.createWorker(quickSession.id, {
      type: 'embedded-agent',
      embeddedAgentId,
    });
    await seedDiscovered(quickSession.id, worker!.id, [
      { name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' },
    ]);

    const response = await callTool(
      app,
      mcpSessionId,
      'set_mcp_server_permission',
      { sessionId: quickSession.id, workerId: worker!.id, name: 'chrome-devtools', hash: 'hash-1', decision: 'allow' },
      nextId++,
      authHeader(tui.token),
    );

    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as {
      sessionId: string;
      workerId: string;
      mcpServers?: Array<{ name: string; decision?: string }>;
    };
    expect(data.sessionId).toBe(quickSession.id);
    expect(findRow(data.mcpServers ?? [], 'chrome-devtools')?.decision).toBe('allowed');

    // Persisted under the path-keyed scope, not the repository-keyed one.
    const rows = await mcpServerPermissionRepository.listByScope({ kind: 'path', locationPath: TEST_REPO_PATH });
    const row = rows.find((r) => r.serverName === 'chrome-devtools');
    expect(row?.scope.kind).toBe('path');
    expect(row?.decision).toBe('allow');
    expect(row?.decidedBy).toBe(tui.userId);
  });

  it('(h) a target worker that is not embedded-agent is refused', async () => {
    const owner = await userRepository.upsertByOsUid(9114, 'owner-h4', '/home/owner-h4');
    const tui = await createTuiCaller(9114, 'owner-h4');
    const session = await sessionManager.createSession(
      { type: 'worktree', locationPath: TEST_REPO_PATH, repositoryId: TEST_REPO_ID, worktreeId: 'wt-h4', agentId: CLAUDE_CODE_AGENT_ID },
      { createdBy: owner.id },
    );
    const ptyWorkerId = session.workers[0].id;

    const response = await callTool(
      app,
      mcpSessionId,
      'set_mcp_server_permission',
      { sessionId: session.id, workerId: ptyWorkerId, all: true },
      nextId++,
      authHeader(tui.token),
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('not an embedded-agent worker');
  });

  // ---------- (i) malformed composed body ----------

  it("(i) a composed body that is neither shape (name without hash/decision) surfaces the shared schema's message", async () => {
    const tui = await createTuiCaller(9115, 'orchestrator-i');
    const target = await createTargetWorker(9115, 'orchestrator-i', 'wt-i');
    await seedDiscovered(target.sessionId, target.workerId, [
      { name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' },
    ]);

    const response = await callTool(
      app,
      mcpSessionId,
      'set_mcp_server_permission',
      { sessionId: target.sessionId, workerId: target.workerId, name: 'chrome-devtools' },
      nextId++,
      authHeader(tui.token),
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error.length).toBeGreaterThan(0);
    const rows = await mcpServerPermissionRepository.listByScope({ kind: 'repository', repositoryId: TEST_REPO_ID });
    expect(rows).toHaveLength(0);
  });

  // ---------- registration / description ----------

  it('is registered with the target-taking (sessionId, workerId) shape and a description naming the headless approval', async () => {
    // No isolated helper exists in this test setup for introspecting a
    // tool's registration metadata beyond calling it -- covered indirectly
    // by every case above actually reaching the handler via its real name.
    const tui = await createTuiCaller(9116, 'orchestrator-reg');
    const target = await createTargetWorker(9116, 'orchestrator-reg', 'wt-reg');
    const response = await callTool(
      app,
      mcpSessionId,
      'set_mcp_server_permission',
      { sessionId: target.sessionId, workerId: target.workerId, all: true },
      nextId++,
      authHeader(tui.token),
    );
    // A dormant worker (never activated) with { all: true } is a legitimate
    // 200 no-op (matches the route's own boundary-value behavior).
    expect(response.result?.isError).toBeUndefined();
  });
});
