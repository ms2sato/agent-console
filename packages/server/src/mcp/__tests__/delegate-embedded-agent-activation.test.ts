/**
 * Issue #1260 PR-1: `delegate_to_worktree` with an embedded initial worker
 * must activate it (subprocess spawn + init handshake + initialPrompt
 * delivery) as part of the tool call itself, with NO worker WebSocket
 * connection ever involved. This file drives the REAL `createMcpApp`
 * `delegate_to_worktree` handler chain -> real `SessionManager` -> a fake
 * loop subprocess injected via the `spawnAsUserFn` seam (mirrors
 * `websocket/__tests__/routes-embedded-agent.test.ts`'s `makeFakeSpawn`).
 *
 * Production path requirement (self-pass, see Issue #1260 AC): the test
 * below calls the real MCP tool handler via `callTool`, NOT
 * `sessionManager.activateEmbeddedAgentWorker` directly. No
 * `setupWebSocketRoutes` / worker WS `onOpen` is imported or invoked
 * anywhere in this file -- activation is caused ONLY by the
 * `delegate_to_worktree` tool call, which is the AC's core assertion.
 *
 * `delegate_to_worktree` has no dedicated `embeddedAgentId` tool parameter
 * -- an embedded agent is targeted via `agentId` (or `agentName`), resolved
 * cross-registry by `agentDirectory.resolve()` (see `mcp-server.ts`'s
 * `delegate_to_worktree` handler). The tests below pass the embedded
 * agent's definition id as `agentId`, exactly as a real MCP caller would.
 *
 * Polarity requirement (self-pass): against the pre-fix implementation, the
 * first test below fails at `expect(fake.captured.length).toBe(1)` because
 * `delegate_to_worktree` never calls `activateEmbeddedAgentWorker` for an
 * embedded-agent initial worker -- this is Issue #1260 Gap 1 itself.
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
import { McpTokenRegistry } from '../mcp-auth.js';
import { createWorktreeWithSession } from '../../services/worktree-creation-service.js';
import { deleteWorktree } from '../../services/worktree-deletion-service.js';
import { AgentDirectory } from '../../services/agent-directory.js';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '../../services/privilege-elevation.js';
import type { runAsUser } from '../../services/privilege-elevation.js';
import { initializeMcp, callTool, parseToolResult } from './mcp-protocol-test-helpers.js';

const TEST_CONFIG_DIR = '/test/config-1260';
const TEST_REPO_PATH = '/test/repo-1260';
const TEST_REPO_ID = 'repo-1260';

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService (write/end/flush). */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

/**
 * Fake spawnAsUser for the embedded-agent loop subprocess, with a `pushLine`
 * hook to emit NDJSON events on stdout (unlike routes-embedded-agent.test.ts's
 * `makeFakeSpawn`, which never emits stdout on its own -- this file needs to
 * simulate a `ready` event to exercise `maybeDeliverInitialPrompt`).
 * Single-shot (one spawn per fake instance), matching the existing pattern.
 */
function makeFakeEmbeddedSpawn(): {
  fn: SpawnAsUserFn;
  captured: SpawnAsUserOpts[];
  stdinWrites: string[];
  pushLine: (obj: unknown) => void;
  simulateExit: (code: number) => void;
  throwOnNextSpawn: Error | null;
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

  const subprocess = {
    pid: 9999,
    exited,
    stdin,
    stdout,
    stderr,
    kill: () => {},
  };

  const state = { throwOnNextSpawn: null as Error | null };

  const fn: SpawnAsUserFn = (opts) => {
    if (state.throwOnNextSpawn) {
      const err = state.throwOnNextSpawn;
      state.throwOnNextSpawn = null;
      throw err;
    }
    captured.push(opts);
    return { subprocess, stdin, elevated: false } as unknown as SpawnAsUserResult;
  };

  return {
    fn,
    captured,
    stdinWrites,
    pushLine,
    simulateExit,
    get throwOnNextSpawn() {
      return state.throwOnNextSpawn;
    },
    set throwOnNextSpawn(err: Error | null) {
      state.throwOnNextSpawn = err;
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * Always-success fake for WorkerManager's `runAsUser`-shaped elevation calls
 * (prompt-file write for an agent-worker initialPrompt, mirrors
 * mcp-server.test.ts's `fakeRunAsUserAlwaysSuccess`). Not AUTH_MODE-gated --
 * needed even in single-user mode for the terminal-agent regression test
 * below, which has a non-empty `initialPrompt`.
 */
const fakeRunAsUserAlwaysSuccess: typeof runAsUser = async () => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  timedOut: false,
});

describe('delegate_to_worktree: embedded-agent auto-activation (Issue #1260 PR-1)', () => {
  const ptyFactory = createMockPtyFactory();
  let app: Hono;
  let sessionManager: SessionManager;
  let repositoryManager: RepositoryManager;
  let agentManager: AgentManager;
  let embeddedAgentManager: EmbeddedAgentManager;
  let worktreeService: WorktreeService;
  let userRepository: SqliteUserRepository;
  let testJobQueue: JobQueue;
  let mcpSessionId: string;
  let fake: ReturnType<typeof makeFakeEmbeddedSpawn>;
  let nextId: number;

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

    fake = makeFakeEmbeddedSpawn();

    const db = getDatabase();
    agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
    userRepository = new SqliteUserRepository(db);
    const artifactRepository = new SqliteArtifactRepository(db);

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
      runAsUserImpl: fakeRunAsUserAlwaysSuccess,
      spawnAsUserFn: fake.fn,
      userRepository,
      repositoryLookup: { getRepositorySlug: (id: string) => repositoryManager?.getRepositorySlug(id) },
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

    worktreeService = new WorktreeService({
      db,
      runAsUserImpl: async (opts) => {
        const tokens = Array.from(opts.command.matchAll(/'([^']*)'/g)).map((m) => m[1]);
        const wtPath = tokens.find((t) => t.includes('/worktrees/wt-'));
        if (wtPath) {
          const fs = await import('fs');
          fs.mkdirSync(wtPath, { recursive: true });
        }
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      },
    });

    const agentDirectory = new AgentDirectory({ terminal: agentManager, embedded: embeddedAgentManager });
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
      broadcastToApp: () => {},
      findOpenPullRequest: async () => null,
      fetchPullRequestUrl: async () => null,
    });
    app = new Hono();
    app.route('', mcpApp);
    mcpSessionId = await initializeMcp(app);
    nextId = 10;
  });

  afterEach(async () => {
    if (sessionManager) {
      for (const session of sessionManager.getAllSessions()) {
        for (const worker of session.workers) {
          if (worker.type === 'embedded-agent' && worker.activated) {
            const deactivatePromise = sessionManager.deactivateEmbeddedAgentWorker(session.id, worker.id);
            fake.simulateExit(0);
            await deactivatePromise;
          }
        }
      }
    }
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  async function createEmbeddedAgentDef(): Promise<string> {
    const def = await embeddedAgentManager.createEmbeddedAgent(
      { name: 'Stub embedded agent', provider: { baseUrl: 'http://localhost:9/v1', model: 'stub-model' } },
      'creator-user-id',
    );
    return def.id;
  }

  it('activates the embedded-agent worker via the real delegate_to_worktree handler chain, with no worker WebSocket ever opened', async () => {
    const embeddedAgentId = await createEmbeddedAgentDef();
    const alice = await userRepository.upsertByOsUid(5001, 'alice', '/home/alice');
    const parentSession = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH },
      { createdBy: alice.id },
    );

    const activityBroadcasts: Array<{ sessionId: string; workerId: string; state: string }> = [];
    sessionManager.setGlobalActivityCallback((sessionId, workerId, state) => {
      activityBroadcasts.push({ sessionId, workerId, state });
    });

    expect(fake.captured.length).toBe(0);

    const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
      repositoryId: TEST_REPO_ID,
      prompt: 'Do the thing',
      branch: 'feat/1260-pr1-child',
      baseBranch: 'main',
      useRemote: false,
      // `delegate_to_worktree` has no dedicated `embeddedAgentId` param --
      // an embedded agent is targeted via `agentId`, resolved cross-registry
      // by `agentDirectory.resolve()`.
      agentId: embeddedAgentId,
      parentSessionId: parentSession.id,
      parentWorkerId: parentSession.workers.find((w) => w.type === 'agent' || w.type === 'embedded-agent')!.id,
      skipMessageCallbackPrompt: true,
    }, nextId++);

    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as { sessionId: string; workerId: string };

    // --- AC core: subprocess spawned as part of the delegate call itself.
    // No worker WebSocket route is set up anywhere in this file (no
    // setupWebSocketRoutes import, no onOpen call) -- the delegate call is
    // the ONLY thing that could have triggered this spawn. ---
    expect(fake.captured.length).toBe(1);
    expect(fake.captured[0].command).toContain('bun');
    expect(fake.stdinWrites.length).toBeGreaterThanOrEqual(1);
    const initCommand = JSON.parse(fake.stdinWrites[0]);
    expect(initCommand.type).toBe('init');

    const internalWorker = sessionManager.getWorker(data.sessionId, data.workerId);
    expect(internalWorker?.type === 'embedded-agent' && internalWorker.subprocess).not.toBeNull();

    // --- Gap 2: aggregated activity is 'idle', asserted at the state/sync
    // layer (direct query + the broadcast the app-level sync state relies
    // on), NOT by rendering the sidebar. ---
    expect(sessionManager.getWorkerActivityState(data.sessionId, data.workerId)).toBe('idle');
    expect(
      activityBroadcasts.some(
        (b) => b.sessionId === data.sessionId && b.workerId === data.workerId && b.state === 'idle',
      ),
    ).toBe(true);

    // --- initialPrompt delivery: loop reports `ready` -> maybeDeliverInitialPrompt
    // -> sendUserMessage over the SAME fake stdin -> session.initialPromptDelivered flips. ---
    fake.pushLine({ v: 1, type: 'ready' });
    await waitFor(() => sessionManager.getSession(data.sessionId)?.initialPromptDelivered === true);
    const userMessageWrite = fake.stdinWrites.map((w) => JSON.parse(w)).find((c) => c.type === 'user-message');
    expect(userMessageWrite).toBeDefined();
    expect(userMessageWrite.text).toBe('Do the thing');

    // --- Idempotency lock: a subsequent worker-WebSocket open would call the
    // SAME entry point (websocket/routes.ts:875) -- simulate it directly and
    // confirm it's a no-op: no second spawn, no epoch re-mint. ---
    const epochBefore = internalWorker?.type === 'embedded-agent' ? internalWorker.epoch : undefined;
    await sessionManager.activateEmbeddedAgentWorker(data.sessionId, data.workerId);
    expect(fake.captured.length).toBe(1);
    const internalWorkerAfter = sessionManager.getWorker(data.sessionId, data.workerId);
    expect(internalWorkerAfter?.type === 'embedded-agent' ? internalWorkerAfter.epoch : undefined).toBe(epochBefore);
  });

  it('scope containment: a UI/REST-created embedded session (bypassing delegate_to_worktree) is NOT auto-activated', async () => {
    const embeddedAgentId = await createEmbeddedAgentDef();
    const session = await sessionManager.createSession({ type: 'quick', locationPath: TEST_REPO_PATH });
    await sessionManager.createWorker(session.id, { type: 'embedded-agent', embeddedAgentId });

    const persisted = sessionManager.getSession(session.id);
    const embeddedWorker = persisted?.workers.find((w) => w.type === 'embedded-agent');
    expect(embeddedWorker).toBeDefined();
    expect(embeddedWorker?.type === 'embedded-agent' && embeddedWorker.activated).toBe(false);
    expect(fake.captured.length).toBe(0);
  });

  it('parentSessionId is schema-required, closing the route that used to reach the "no createdBy" activation failure (Issue #1293)', async () => {
    const embeddedAgentId = await createEmbeddedAgentDef();

    // Before Issue #1293, omitting parentSessionId let a session get created
    // with createdBy left undefined, and the mint step in
    // EmbeddedAgentWorkerService.runActivation threw
    // EmbeddedAgentActivationError('...has no createdBy...') (marker) --
    // AFTER the worktree/session already existed. parentSessionId is now
    // schema-required, so this route is closed before the handler runs at
    // all: no worktree, no session, no spawn attempt.
    const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
      repositoryId: TEST_REPO_ID,
      prompt: 'Do the thing',
      branch: 'feat/1260-pr1-no-createdby',
      baseBranch: 'main',
      useRemote: false,
      agentId: embeddedAgentId,
    }, nextId++);

    if (response.error) {
      expect(response.error).toBeDefined();
    } else {
      expect(response.result?.isError).toBe(true);
    }
    expect(fake.captured.length).toBe(0); // never reached the spawn step

    expect(sessionManager.getAllSessions().length).toBe(0);
    const worktrees = await worktreeService.listWorktrees(TEST_REPO_PATH, TEST_REPO_ID);
    expect(worktrees.length).toBe(0);
  });

  it('activation failure (spawn throws, non-marker) fails the tool call with the generic message, not the raw error', async () => {
    const embeddedAgentId = await createEmbeddedAgentDef();
    const bob = await userRepository.upsertByOsUid(5002, 'bob', '/home/bob');
    const parentSession = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH },
      { createdBy: bob.id },
    );

    fake.throwOnNextSpawn = new Error('ENOENT: unstructured internal detail nobody should see client-side');

    const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
      repositoryId: TEST_REPO_ID,
      prompt: 'Do the thing',
      branch: 'feat/1260-pr1-generic-failure',
      baseBranch: 'main',
      useRemote: false,
      agentId: embeddedAgentId,
      parentSessionId: parentSession.id,
      parentWorkerId: parentSession.workers.find((w) => w.type === 'agent' || w.type === 'embedded-agent')!.id,
      skipMessageCallbackPrompt: true,
    }, nextId++);

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).not.toContain('ENOENT');
    expect(data.error).toContain('Embedded-agent activation failed');

    // Unlike the "no createdBy" test above (which now rejects before any
    // session is created), this test creates a parent session (bob's) in
    // addition to the delegated session -- 2 total.
    expect(sessionManager.getAllSessions().length).toBe(2);
  });

  it('regression: terminal-agent delegate flow is unaffected (embedded spawn seam never touched)', async () => {
    const carol = await userRepository.upsertByOsUid(5003, 'carol', '/home/carol');
    const parentSession = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH },
      { createdBy: carol.id },
    );

    const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
      repositoryId: TEST_REPO_ID,
      prompt: 'Do the thing',
      branch: 'feat/1260-pr1-terminal-agent',
      baseBranch: 'main',
      useRemote: false,
      agentId: CLAUDE_CODE_AGENT_ID,
      parentSessionId: parentSession.id,
      parentWorkerId: parentSession.workers.find((w) => w.type === 'agent' || w.type === 'embedded-agent')!.id,
      skipMessageCallbackPrompt: true,
    }, nextId++);

    expect(response.result?.isError).toBeUndefined();
    expect(fake.captured.length).toBe(0);
  });
});
