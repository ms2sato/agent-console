import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { vol } from 'memfs';
import { Hono } from 'hono';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { JobQueue } from '../../jobs/job-queue.js';
import { registerJobHandlers } from '../../jobs/handlers.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import {
  SessionManager,
} from '../../services/session-manager.js';
import {
  RepositoryManager,
} from '../../services/repository-manager.js';
import { AgentManager } from '../../services/agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { JsonSessionRepository } from '../../repositories/index.js';
import { SqliteRepositoryRepository } from '../../repositories/sqlite-repository-repository.js';
import { SqliteWorktreeRepository } from '../../repositories/sqlite-worktree-repository.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { SqliteArtifactRepository } from '../../repositories/sqlite-artifact-repository.js';
import { SqliteBookmarkRepository } from '../../repositories/sqlite-bookmark-repository.js';
import { WorktreeService } from '../../services/worktree-service.js';
import type { PtySpawnOptions } from '../../lib/pty-provider.js';
import { extractPromptFromSpawnCommand } from '../../__tests__/utils/extract-prompt-from-command.js';
import { TimerManager } from '../../services/timer-manager.js';
import { ConditionalWakeupManager } from '../../services/conditional-wakeup-manager.js';
import { InteractiveProcessManager } from '../../services/interactive-process-manager.js';
import { AnnotationService } from '../../services/annotation-service.js';
import { InterSessionMessageService } from '../../services/inter-session-message-service.js';
import { SingleUserMode } from '../../services/user-mode.js';
import { createMcpApp } from '../mcp-server.js';
import { McpTokenRegistry, type McpAuthMode } from '../mcp-auth.js';
import { createWorktreeWithSession } from '../../services/worktree-creation-service.js';
import { deleteWorktree, _getDeletionsInProgress } from '../../services/worktree-deletion-service.js';
import type { SuggestSessionMetadataFn } from '../../services/session-metadata-suggester.js';
import { AgentDirectory } from '../../services/agent-directory.js';
import type { AgentDirectoryEntry, EmbeddedAgentDefinition, AppServerMessage } from '@agent-console/shared';
import type { PersistedWorker } from '../../services/persistence-service.js';
import type { runAsUser, SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '../../services/privilege-elevation.js';

// Mock session-metadata-suggester to avoid spawning real agent processes.
// Declaring the parameter type makes `mock.calls` typed correctly so the
// Issue #876 tests can read `mock.calls[0][0].requestUser` without casting.
const mockSuggestSessionMetadata = mock(
  async (_request: Parameters<SuggestSessionMetadataFn>[0]) => ({
    branch: 'feat/auto-generated-branch',
    title: 'Auto-Generated Title',
  }),
);

// github-pr-service mocks (injected via McpDependencies). Typed signatures
// so `mock.calls[0][2]` is reachable in the Issue #885 elevation tests.
const mockFindOpenPullRequest = mock<
  (branch: string, cwd: string, requestUsername: string | null) =>
    Promise<{ number: number; title: string } | null>
>(async () => null);
const mockFetchPullRequestUrl = mock<
  (branch: string, cwd: string, requestUsername: string | null) => Promise<string | null>
>(async () => null);

/**
 * Captures the content written to each prompt file via the injected
 * `runAsUserImpl` seam below (Issue #1234), keyed by destination file path.
 * `writeUserOwnedSecretFile`'s command ends in `cat > '<path>'`; the actual
 * payload travels via `opts.stdin`, never through argv/the command string
 * (see privilege-elevation.ts). Reset in `beforeEach`. Consumed by
 * `getAgentPromptForSession` below to recover the delivered prompt text now
 * that it no longer travels inline in the spawn command.
 */
const capturedPromptFileWrites = new Map<string, string>();

/**
 * Always-success fake for WorkerManager's `runAsUser`-shaped elevation
 * calls, injected via SessionManager's `runAsUserImpl` seam (Issue #1234).
 * `delegate_to_worktree` always activates its agent worker with a non-empty
 * `initialPrompt`, and that write is NOT AUTH_MODE-gated -- without this
 * fake, `activateAgentWorkerPty`'s prompt-file write would hit the REAL
 * elevation helper's `Bun.spawn(['sh', '-c', ...])` subprocess against the
 * real filesystem (memfs mocking here only covers `fs`/`fs/promises`, not
 * real subprocess spawns), and fail with a real `mkdir: Permission denied`
 * under the synthetic `TEST_CONFIG_DIR` used by this suite.
 *
 * Discriminates the prompt-file write call by its `cat >` command shape
 * (mirrors `createCommandDiscriminatingRunAsUser` in worker-manager.test.ts)
 * and captures its content rather than loosening the tests that inspect the
 * delivered prompt text.
 */
const fakeRunAsUserAlwaysSuccess: typeof runAsUser = async (opts) => {
  const writeMatch = opts.command.match(/cat > '((?:[^']|'\\'')*)'$/);
  if (writeMatch && typeof opts.stdin === 'string') {
    const filePath = writeMatch[1].replace(/'\\''/g, "'");
    capturedPromptFileWrites.set(filePath, opts.stdin);
  }
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
  };
};

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService (write/end/flush). */
interface McpDelegateFakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

/**
 * Fake spawnAsUser for the embedded-agent loop subprocess (Issue #1260
 * PR-1). Needed because `delegate_to_worktree` now eagerly activates an
 * embedded-agent initial worker as part of the tool call itself -- without
 * this seam, the two `should create an embedded-agent initial worker...`
 * tests below would hit the REAL `spawnAsUser` and attempt a real `bun`
 * subprocess spawn. Mirrors `websocket/__tests__/routes-embedded-agent.test.ts`'s
 * `makeFakeSpawn` (never emits stdout on its own -- these tests only assert
 * that activation was attempted, not on the loop's own event stream).
 * Reset in `beforeEach`; deactivated in `afterEach` via `simulateExit` so no
 * activated worker's `subprocess.exited` await / stdout reader outlives the
 * test.
 */
function makeFakeEmbeddedAgentDelegateSpawn(): {
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

  const stdin: McpDelegateFakeFileSink = {
    write: (chunk) => {
      stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return 0;
    },
    end: () => {},
    flush: () => 0,
  };

  const subprocess = {
    pid: 8765,
    exited,
    stdin,
    stdout,
    stderr,
    kill: () => {},
  };

  // Mirrors `delegate-embedded-agent-activation.test.ts`'s `makeFakeEmbeddedSpawn`
  // `throwOnNextSpawn` hook (Issue #1260 PR-2), used to simulate a non-marker
  // spawn failure for send_session_message's generic-fallback classification test.
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

// Test config directory
const TEST_CONFIG_DIR = '/test/config';
const TEST_REPO_PATH = '/test/repo';

// Embedded-agent definition the createWorker path resolves against, mirroring
// worker-lifecycle-manager.test.ts's EMBEDDED_AGENT_DEF. Used by the
// get_session_status activityState tests (Issue #1128).
const TEST_EMBEDDED_AGENT_DEF: EmbeddedAgentDefinition = {
  id: 'def-1',
  name: 'My Local Model',
  engine: 'openai-api',
  provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
  isBuiltIn: false,
  createdBy: 'user-1',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

// Map-backed embedded-agent registry stub, reset in `beforeEach` (mirrors
// `mcpRunAsUserCapture` / `mockSuggestSessionMetadata` reset pattern) so
// tests don't leak dynamically-registered fixtures into each other.
// Seeded with `TEST_EMBEDDED_AGENT_DEF` by default so the pre-existing
// `get_session_status` activityState tests keep resolving 'def-1'.
// `getAllEmbeddedAgents` is required by `delegate_to_worktree`'s
// agentName resolver (Issue #1161).
let embeddedAgentDefsById: Map<string, EmbeddedAgentDefinition>;

// Also satisfies AgentSurface<'embedded'> (Issue #1160 PR-A) so it can be
// passed as the `embedded` surface to a real AgentDirectory in tests. The
// pre-existing getEmbeddedAgent/getAllEmbeddedAgents methods are kept
// unmodified -- SessionManager.create(...) still consumes this same stub
// object via its `Pick<EmbeddedAgentManager, 'getEmbeddedAgent'>` param.
const testEmbeddedAgentManagerStub = {
  kind: 'embedded' as const,
  getEmbeddedAgent: (id: string): EmbeddedAgentDefinition | undefined =>
    embeddedAgentDefsById.get(id),
  getAllEmbeddedAgents: (): EmbeddedAgentDefinition[] =>
    Array.from(embeddedAgentDefsById.values()),
  list: (): Extract<AgentDirectoryEntry, { kind: 'embedded' }>[] =>
    Array.from(embeddedAgentDefsById.values()).map((agent) => ({ kind: 'embedded' as const, agent })),
  get: (id: string): Extract<AgentDirectoryEntry, { kind: 'embedded' }> | undefined => {
    const agent = embeddedAgentDefsById.get(id);
    return agent ? { kind: 'embedded', agent } : undefined;
  },
  findByName: (name: string): Extract<AgentDirectoryEntry, { kind: 'embedded' }>[] =>
    Array.from(embeddedAgentDefsById.values())
      .filter((a) => a.name === name)
      .map((agent) => ({ kind: 'embedded' as const, agent })),
};

// Create mock PTY factory
const ptyFactory = createMockPtyFactory(30000);

// ---------- MCP protocol helpers ----------

/**
 * Initialize MCP session by sending the initialize request and notifications/initialized.
 * Returns the Mcp-Session-Id header value (may be empty if sessions are not managed).
 */
async function initializeMcp(app: Hono, extraHeaders?: Record<string, string>): Promise<string> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
      id: 1,
    }),
  });

  expect(res.status).toBe(200);

  const sessionId = res.headers.get('mcp-session-id') ?? '';

  // Send initialized notification
  await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  });

  return sessionId;
}

/**
 * Call an MCP tool and return the parsed JSON-RPC response.
 */
async function callTool(
  app: Hono,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  id: number = 2,
  extraHeaders?: Record<string, string>,
): Promise<{ result?: { content: Array<{ type: string; text: string }>; isError?: boolean }; error?: unknown }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name, arguments: args },
      id,
    }),
  });

  expect(res.status).toBe(200);
  return (await res.json()) as {
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
    error?: unknown;
  };
}

/**
 * Extract the parsed text content from a tool call result.
 */
function parseToolResult(response: Awaited<ReturnType<typeof callTool>>): unknown {
  const text = response.result?.content?.[0]?.text;
  if (!text) return undefined;
  return JSON.parse(text);
}

/**
 * Call an MCP tool expecting a TRANSPORT-level rejection (Issue #1269): a
 * caller with no verified identity under `AGENT_CONSOLE_MCP_AUTH=enforce`
 * never reaches the tool body at all -- `createMcpAuthMiddleware` rejects
 * the request with an HTTP 401 and a plain `{ error: string }` body before
 * `transport.handleRequest` (and therefore any `checkCallerOwnsSession`
 * call site) ever runs. This is a different response shape from `callTool`,
 * which asserts HTTP 200 and expects a JSON-RPC tool-result envelope --
 * appropriate for the "presented but rejected inside the tool" scenarios,
 * not for "rejected before the tool was ever reached".
 */
async function callToolExpectTransportRejection(
  app: Hono,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  id: number = 2,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; error: string }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name, arguments: args },
      id,
    }),
  });
  const body = (await res.json()) as { error: string };
  return { status: res.status, error: body.error };
}

// ---------- Tests ----------

describe('MCP Server Tools', () => {
  let app: Hono;
  let sessionManager: SessionManager;
  let agentManager: AgentManager;
  let repositoryManager: RepositoryManager;
  let timerManager: TimerManager;
  let conditionalWakeupManager: ConditionalWakeupManager;
  let interactiveProcessManager: InteractiveProcessManager;
  let worktreeService: WorktreeService;
  let annotationService: AnnotationService;
  let userRepository: SqliteUserRepository;
  let artifactRepository: SqliteArtifactRepository;
  let bookmarkRepository: SqliteBookmarkRepository;
  let testJobQueue: JobQueue;
  let mcpSessionId: string;
  // Track unique IDs for tool calls to avoid collisions in the shared transport
  let nextId: number;
  // Issue #1260 PR-1: embedded-agent loop subprocess fake, see
  // `makeFakeEmbeddedAgentDelegateSpawn` above.
  let fakeEmbeddedSpawn: ReturnType<typeof makeFakeEmbeddedAgentDelegateSpawn>;

  /**
   * Capture of the `runAsUser` invocation made by the injected stub on the
   * `WorktreeService`. The `setupDelegateEnvironment` helper reads
   * `capturedWorktreePath` to drive `listWorktrees` so the orchestration
   * tests see the just-created worktree. Tests that need to simulate
   * `git worktree add` failing can override `responseOverride`. Reset in
   * each `beforeEach`.
   */
  const mcpRunAsUserCapture: {
    lastCommand: string;
    capturedWorktreePath: string;
    responseOverride: { stdout: string; stderr: string; exitCode: number; timedOut: boolean } | null;
  } = {
    lastCommand: '',
    capturedWorktreePath: '',
    responseOverride: null,
  };

  /**
   * Re-create the MCP app and initialize a new MCP session.
   * Call this after replacing the repositoryManager to ensure
   * the MCP tools see the updated dependencies.
   */
  async function remountMcpApp(
    authOpts?: {
      mcpAuthMode?: McpAuthMode;
      mcpTokenRegistry?: McpTokenRegistry;
      broadcastToApp?: (msg: AppServerMessage) => void;
    },
  ): Promise<void> {
    const agentDirectory = new AgentDirectory({ terminal: agentManager, embedded: testEmbeddedAgentManagerStub });
    const mcpApp = createMcpApp({ sessionManager, repositoryManager, agentManager, agentDirectory, timerManager, conditionalWakeupManager, interactiveProcessManager, worktreeService, annotationService, interSessionMessageService: new InterSessionMessageService(), suggestSessionMetadata: mockSuggestSessionMetadata, createWorktreeWithSession, deleteWorktree, userRepository, artifactRepository, bookmarkRepository, broadcastToApp: authOpts?.broadcastToApp ?? (() => {}), findOpenPullRequest: mockFindOpenPullRequest, fetchPullRequestUrl: mockFetchPullRequestUrl, mcpAuthMode: authOpts?.mcpAuthMode, mcpTokenRegistry: authOpts?.mcpTokenRegistry });
    app = new Hono();
    app.route('', mcpApp);

    // Issue #1269: under `enforce`, the transport-level gate now rejects the
    // handshake itself when tokenless (it runs for EVERY /mcp request, not
    // just tool calls). Mint a throwaway "test harness" token purely to get
    // this helper's `initialize` / `notifications/initialized` calls past
    // that gate. This is unrelated to -- and does not interfere with -- the
    // per-test tool-call token scenarios below: `mcpCallerStorage` resolves
    // the caller fresh from the Authorization header on EACH HTTP request,
    // not once per MCP session, so a tool call that presents no token (or a
    // different token) still exercises exactly the auth path it intends to.
    let initializeHeaders: Record<string, string> | undefined;
    if (authOpts?.mcpAuthMode === 'enforce' && authOpts.mcpTokenRegistry) {
      const handshakeToken = authOpts.mcpTokenRegistry.mint({
        sessionId: 'test-harness-handshake-session',
        workerId: 'test-harness-handshake-worker',
        userId: 'test-harness-handshake-user',
      });
      initializeHeaders = { Authorization: `Bearer ${handshakeToken}` };
    }

    mcpSessionId = await initializeMcp(app, initializeHeaders);
  }

  beforeEach(async () => {
    await closeDatabase();

    // Setup memfs with config directory structure
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Initialize in-memory database
    await initializeDatabase(':memory:');

    // Create job queue with the in-memory database
    testJobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());

    // Reset process mock and mark current process as alive
    resetProcessMock();
    mockProcess.markAlive(process.pid);

    // Reset PTY factory
    ptyFactory.reset();

    // Reset git mocks to defaults
    resetGitMocks();

    // Reset the runAsUser capture (used by setupDelegateEnvironment to
    // resolve the worktree path captured from the spawned git command).
    mcpRunAsUserCapture.lastCommand = '';
    mcpRunAsUserCapture.capturedWorktreePath = '';
    mcpRunAsUserCapture.responseOverride = null;

    // Reset the prompt-file write capture (Issue #1234, used by
    // getAgentPromptForSession below).
    capturedPromptFileWrites.clear();

    // Reset the embedded-agent registry stub, seeded with the default
    // fixture (see `testEmbeddedAgentManagerStub` comment above).
    embeddedAgentDefsById = new Map([[TEST_EMBEDDED_AGENT_DEF.id, TEST_EMBEDDED_AGENT_DEF]]);

    // Reset session metadata suggester mock
    mockSuggestSessionMetadata.mockReset();
    mockSuggestSessionMetadata.mockImplementation(async () => ({
      branch: 'feat/auto-generated-branch',
      title: 'Auto-Generated Title',
    }));

    // Reset worktree-deletion-service state
    _getDeletionsInProgress().clear();

    // Reset github-pr-service mocks
    mockFindOpenPullRequest.mockReset();
    mockFindOpenPullRequest.mockImplementation(async () => null);
    mockFetchPullRequestUrl.mockReset();
    mockFetchPullRequestUrl.mockImplementation(async () => null);

    // Create session repository
    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    // Create AgentManager for dependency injection
    const db = getDatabase();
    agentManager = await AgentManager.create(new SqliteAgentRepository(db));

    // Create UserRepository for delegate_to_worktree's username resolution.
    // Tests that exercise the resolved-username path seed entries via
    // `userRepository.upsertByOsUid(...)`; tests that exercise the null
    // fallback rely on findById returning null for unknown UUIDs.
    userRepository = new SqliteUserRepository(db);
    artifactRepository = new SqliteArtifactRepository(db);
    bookmarkRepository = new SqliteBookmarkRepository(db);

    // Create AnnotationService
    annotationService = new AnnotationService();

    // Issue #1260 PR-1: fresh fake for each test (see declaration comment
    // above); `delegate_to_worktree` now eagerly activates an embedded-agent
    // initial worker, so this seam is required even though most tests never
    // exercise it.
    fakeEmbeddedSpawn = makeFakeEmbeddedAgentDelegateSpawn();

    // Create SessionManager directly
    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      annotationService,
      mcpTokenRegistry: new McpTokenRegistry(),
      runAsUserImpl: fakeRunAsUserAlwaysSuccess,
      spawnAsUserFn: fakeEmbeddedSpawn.fn,
      repositoryLookup: { getRepositorySlug: async (id: string) => repositoryManager?.getRepositorySlug(id) },
      repositoryEnvLookup: {
        getRepositoryInfo: (id: string) => {
          const r = repositoryManager?.getRepository(id);
          return r ? { name: r.name, path: r.path, envVars: r.envVars } : undefined;
        },
        getWorktreeIndexNumber: async () => 0,
      },
      embeddedAgentManager: testEmbeddedAgentManagerStub,
    });

    // Create RepositoryManager (initially empty). Tests that create worktree
    // sessions via sessionManager must call `registerRepoForTests('repo-1')`
    // before doing so.
    repositoryManager = await RepositoryManager.create({ jobQueue: testJobQueue });

    // Create TimerManager (no-op callback for tests)
    timerManager = new TimerManager(() => {});

    // Create ConditionalWakeupManager (no-op callback for tests)
    conditionalWakeupManager = new ConditionalWakeupManager(() => {});

    // Create InteractiveProcessManager (no-op callbacks for tests)
    interactiveProcessManager = new InteractiveProcessManager(() => {}, () => {});

    // Create WorktreeService with in-memory database. Inject a stub
    // `runAsUser` that pretends `git worktree add` succeeded. The
    // `delegate_to_worktree` tests below also need to capture the worktree
    // path from the spawn command (the path is generated with a random
    // suffix), so the stub parses the command and shares the captured value
    // via `mcpRunAsUserCapture` for the per-test `setupDelegateEnvironment`
    // helper. The detailed `git worktree add` shape is verified by
    // worktree-service.test.ts and privilege-elevation.test.ts.
    worktreeService = new WorktreeService({
      db,
      runAsUserImpl: async (opts) => {
        mcpRunAsUserCapture.lastCommand = opts.command;
        // The command shape is: `'git' 'worktree' 'add' ['-b' '<branch>'] '<path>' [<branch>|<base>]`
        // with single-quote escaped args. The worktree path is the first
        // (and only) token containing `/worktrees/wt-`. The test data does
        // not include single quotes inside arg values, so a simple
        // `'[^']*'` pattern is sufficient -- shell single-quote escaping
        // (real form: `'\''` = end-quote, literal-quote, start-quote) is
        // not exercised here.
        const tokens = Array.from(opts.command.matchAll(/'([^']*)'/g)).map(
          (m) => m[1],
        );
        const wtPath = tokens.find((t) => t.includes('/worktrees/wt-'));
        if (wtPath) {
          mcpRunAsUserCapture.capturedWorktreePath = wtPath;
          // Mirror what real `git worktree add` does on disk so the
          // post-create sanity-net `fsPromises.stat` (Issue #854) finds
          // the directory. The stub still bypasses real git, but the
          // creation-service contract assumes the directory exists after
          // a successful exitCode 0.
          const fs = await import('fs');
          fs.mkdirSync(wtPath, { recursive: true });
        }
        if (mcpRunAsUserCapture.responseOverride) {
          return mcpRunAsUserCapture.responseOverride;
        }
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      },
    });

    // Create MCP app with injected dependencies and initialize MCP session
    await remountMcpApp();
    nextId = 10;
  });

  /**
   * Register `repo-1` in the current RepositoryManager so tests that create
   * worktree sessions via `sessionManager.createSession({ repositoryId: 'repo-1' })`
   * can resolve the slug. After Stage 2 of the session-data-path refactor,
   * unknown repositories throw RepositoryNotFoundError at creation time.
   */
  async function registerTestRepo(
    id = 'repo-1',
    name = 'test-repo',
    repoPath = '/test/repo',
  ): Promise<void> {
    const db = getDatabase();
    const sqliteRepoRepo = new SqliteRepositoryRepository(db);
    await sqliteRepoRepo.save({
      id,
      name,
      path: repoPath,
      createdAt: new Date().toISOString(),
      clonedSourceRepoPath: null,
    });
    // Ensure the path exists in memfs so RepositoryManager.initialize()
    // doesn't filter it out on load.
    const fs = await import('fs');
    fs.mkdirSync(repoPath, { recursive: true });
    repositoryManager = await RepositoryManager.create({
      repository: sqliteRepoRepo,
      jobQueue: testJobQueue,
    });
    await remountMcpApp();
  }

  /**
   * Create a real, owned parent session and return the ids `delegate_to_worktree`
   * now requires (Issue #1293 S1/S3/S3b). `createdBy` only needs to be a
   * non-empty string -- it does not need to resolve in `userRepository` --
   * since S3(b) only rejects an UNSET `createdBy`, not an orphan UUID.
   * `parentWorkerId` must be the REAL id of an agent worker on the created
   * session (S3b resolves it against `parentSession.workers` and requires
   * `canReceiveSessionMessages`) -- a fabricated placeholder string is no
   * longer accepted. Tests that specifically exercise parent-resolution
   * edge cases (missing session, no createdBy, orphan UUID, missing/wrong
   * worker) create their own parent session inline instead of using this
   * helper.
   */
  async function createValidDelegateParent(
    createdBy = 'delegate-test-parent-user',
  ): Promise<{ parentSessionId: string; parentWorkerId: string }> {
    const parent = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH },
      { createdBy },
    );
    const agentWorker = parent.workers.find((w) => w.type === 'agent' || w.type === 'embedded-agent');
    if (!agentWorker) {
      throw new Error('createValidDelegateParent: created session has no agent worker');
    }
    return { parentSessionId: parent.id, parentWorkerId: agentWorker.id };
  }

  /**
   * Find a real message-capable worker id on an already-created session
   * (Issue #1293 S3b), for tests that construct their own parent session
   * inline (e.g. to control `createdBy`) rather than using
   * `createValidDelegateParent`.
   */
  function firstAgentWorkerId(session: Awaited<ReturnType<typeof sessionManager.createSession>>): string {
    const worker = session.workers.find((w) => w.type === 'agent' || w.type === 'embedded-agent');
    if (!worker) {
      throw new Error('firstAgentWorkerId: session has no agent worker');
    }
    return worker.id;
  }

  afterEach(async () => {
    // Issue #1260 PR-1: deactivate any embedded-agent worker `delegate_to_worktree`
    // activated during the test (mirrors routes-embedded-agent.test.ts's afterEach)
    // so the fake subprocess's `exited` await / stdout reader don't outlive the test.
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
    timerManager.disposeAll();
    conditionalWakeupManager.disposeAll();
    interactiveProcessManager.disposeAll();
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    resetProcessMock();
  });

  // ===========================================================================
  // list_agents
  // ===========================================================================

  describe('list_agents', () => {
    it('should return the built-in claude-code agent by default', async () => {
      const response = await callTool(app, mcpSessionId, 'list_agents', {}, nextId++);
      const data = parseToolResult(response) as {
        agents: Array<{
          id: string;
          name: string;
          description?: string;
          isBuiltIn: boolean;
          capabilities: {
            supportsContinue: boolean;
            supportsHeadlessMode: boolean;
            supportsActivityDetection: boolean;
          };
        }>;
      };

      expect(response.result?.isError).toBeUndefined();
      expect(data.agents.length).toBeGreaterThanOrEqual(1);

      const builtIn = data.agents.find((a) => a.id === 'claude-code-builtin');
      expect(builtIn).toBeDefined();
      expect(builtIn!.name).toBe('Claude Code');
      expect(builtIn!.isBuiltIn).toBe(true);
      expect(builtIn!.capabilities).toBeDefined();
    });

    it('should include custom agents after registration', async () => {
      await agentManager.registerAgent({
        name: 'Custom Agent',
        commandTemplate: 'custom-agent {{prompt}}',
        description: 'A custom test agent',
      });

      const response = await callTool(app, mcpSessionId, 'list_agents', {}, nextId++);
      const data = parseToolResult(response) as {
        agents: Array<{
          kind: string;
          id: string;
          name: string;
          description?: string;
          isBuiltIn?: boolean;
        }>;
      };

      // `beforeEach` always seeds `embeddedAgentDefsById` with one entry
      // (Issue #1160 PR-A parity), so the total count includes it. Filter
      // to terminal agents to keep this test's focus on terminal
      // registration count.
      const terminalAgents = data.agents.filter((a) => a.kind === 'terminal');
      expect(terminalAgents).toHaveLength(2);

      const custom = terminalAgents.find((a) => a.name === 'Custom Agent');
      expect(custom).toBeDefined();
      expect(custom!.description).toBe('A custom test agent');
      expect(custom!.isBuiltIn).toBe(false);
    });

    it('should include embedded agents with kind "embedded" and no terminal-only fields', async () => {
      const response = await callTool(app, mcpSessionId, 'list_agents', {}, nextId++);
      const data = parseToolResult(response) as {
        agents: Array<Record<string, unknown>>;
      };

      const embedded = data.agents.find((a) => a.kind === 'embedded');
      expect(embedded).toBeDefined();
      expect(embedded!.id).toBe(TEST_EMBEDDED_AGENT_DEF.id);
      expect(embedded!.name).toBe(TEST_EMBEDDED_AGENT_DEF.name);
      expect(embedded).not.toHaveProperty('isBuiltIn');
      expect(embedded).not.toHaveProperty('capabilities');
    });

    it('should tag terminal agents with kind "terminal"', async () => {
      const response = await callTool(app, mcpSessionId, 'list_agents', {}, nextId++);
      const data = parseToolResult(response) as {
        agents: Array<{ kind: string; id: string }>;
      };

      const builtIn = data.agents.find((a) => a.id === 'claude-code-builtin');
      expect(builtIn).toBeDefined();
      expect(builtIn!.kind).toBe('terminal');
    });

    it('should not expose internal template fields', async () => {
      const response = await callTool(app, mcpSessionId, 'list_agents', {}, nextId++);
      const data = parseToolResult(response) as {
        agents: Array<Record<string, unknown>>;
      };

      for (const agent of data.agents) {
        expect(agent).not.toHaveProperty('commandTemplate');
        expect(agent).not.toHaveProperty('continueTemplate');
        expect(agent).not.toHaveProperty('headlessTemplate');
        expect(agent).not.toHaveProperty('activityPatterns');
        expect(agent).not.toHaveProperty('createdAt');
      }
    });

    it('should include all capability flags as booleans (terminal agents only)', async () => {
      const response = await callTool(app, mcpSessionId, 'list_agents', {}, nextId++);
      const data = parseToolResult(response) as {
        agents: Array<{
          kind: string;
          capabilities?: {
            supportsContinue: unknown;
            supportsHeadlessMode: unknown;
            supportsActivityDetection: unknown;
          };
        }>;
      };

      const terminalAgents = data.agents.filter((a) => a.kind === 'terminal');
      expect(terminalAgents.length).toBeGreaterThanOrEqual(1);
      for (const agent of terminalAgents) {
        expect(agent.capabilities).toBeDefined();
        expect(typeof agent.capabilities!.supportsContinue).toBe('boolean');
        expect(typeof agent.capabilities!.supportsHeadlessMode).toBe('boolean');
        expect(typeof agent.capabilities!.supportsActivityDetection).toBe('boolean');
      }
    });
  });

  // ===========================================================================
  // list_repositories
  // ===========================================================================

  describe('list_repositories', () => {
    async function setupRepoManager(repos: Array<{
      id: string;
      name: string;
      path: string;
      description?: string | null;
    }> = []): Promise<void> {
      const db = getDatabase();
      const sqliteRepoRepo = new SqliteRepositoryRepository(db);
      for (const repo of repos) {
        await sqliteRepoRepo.save({
          ...repo,
          createdAt: new Date().toISOString(),
          clonedSourceRepoPath: null,
        });
      }
      repositoryManager = await RepositoryManager.create({
        jobQueue: testJobQueue,
        repository: sqliteRepoRepo,
      });
      await remountMcpApp();
    }

    it('should return empty repositories array when no repositories registered', async () => {
      await setupRepoManager();
      const response = await callTool(app, mcpSessionId, 'list_repositories', {}, nextId++);
      const data = parseToolResult(response) as { repositories: unknown[] };
      expect(response.result?.isError).toBeUndefined();
      expect(data.repositories).toEqual([]);
    });

    it('should return repository info with id, name, and description', async () => {
      // Need to set up memfs with the repo path for RepositoryManager to load it
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      // Mock getRemoteUrl to return a known URL
      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');

      await setupRepoManager([{
        id: 'repo-1',
        name: 'my-repo',
        path: TEST_REPO_PATH,
        description: 'A test repository for unit tests',
      }]);

      const response = await callTool(app, mcpSessionId, 'list_repositories', {}, nextId++);
      const data = parseToolResult(response) as {
        repositories: Array<Record<string, unknown>>;
      };

      expect(response.result?.isError).toBeUndefined();
      expect(data.repositories).toHaveLength(1);
      expect(data.repositories[0].id).toBe('repo-1');
      expect(data.repositories[0].name).toBe('my-repo');
      expect(data.repositories[0].remoteUrl).toBe('git@github.com:owner/repo.git');
      expect(data.repositories[0].description).toBe('A test repository for unit tests');
    });

    it('should not expose path, setupCommand, or envVars', async () => {
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');

      await setupRepoManager([{
        id: 'repo-1',
        name: 'my-repo',
        path: TEST_REPO_PATH,
      }]);

      const response = await callTool(app, mcpSessionId, 'list_repositories', {}, nextId++);
      const data = parseToolResult(response) as {
        repositories: Array<Record<string, unknown>>;
      };

      for (const repo of data.repositories) {
        expect(repo).not.toHaveProperty('path');
        expect(repo).not.toHaveProperty('setupCommand');
        expect(repo).not.toHaveProperty('envVars');
      }
    });
  });

  // ===========================================================================
  // update_repository
  // ===========================================================================

  describe('update_repository', () => {
    async function setupRepoManager(repos: Array<{
      id: string;
      name: string;
      path: string;
      description?: string | null;
      setupCommand?: string | null;
      cleanupCommand?: string | null;
      envVars?: string | null;
      defaultAgentId?: string | null;
    }> = []): Promise<void> {
      const db = getDatabase();
      const sqliteRepoRepo = new SqliteRepositoryRepository(db);
      for (const repo of repos) {
        await sqliteRepoRepo.save({
          ...repo,
          createdAt: new Date().toISOString(),
          clonedSourceRepoPath: null,
        });
      }
      repositoryManager = await RepositoryManager.create({
        jobQueue: testJobQueue,
        repository: sqliteRepoRepo,
      });
      await remountMcpApp();
    }

    beforeEach(() => {
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');
    });

    it('should persist a single-field update and expose it via the response', async () => {
      await setupRepoManager([{
        id: 'repo-1',
        name: 'my-repo',
        path: TEST_REPO_PATH,
        description: 'initial description',
      }]);

      const response = await callTool(app, mcpSessionId, 'update_repository', {
        repositoryId: 'repo-1',
        setupCommand: 'bun install',
      }, nextId++);
      const data = parseToolResult(response) as {
        repository?: Record<string, unknown>;
        error?: string;
      };

      expect(response.result?.isError).toBeUndefined();
      expect(data.repository).toBeDefined();
      expect(data.repository!.id).toBe('repo-1');
      expect(data.repository!.name).toBe('my-repo');
      expect(data.repository!.setupCommand).toBe('bun install');

      // Persisted via RepositoryManager
      const stored = repositoryManager.getRepository('repo-1');
      expect(stored?.setupCommand).toBe('bun install');

      // list_repositories still shows the repo unchanged in id/name/description
      const listResponse = await callTool(app, mcpSessionId, 'list_repositories', {}, nextId++);
      const listData = parseToolResult(listResponse) as {
        repositories: Array<Record<string, unknown>>;
      };
      expect(listData.repositories).toHaveLength(1);
      expect(listData.repositories[0].id).toBe('repo-1');
      expect(listData.repositories[0].name).toBe('my-repo');
      expect(listData.repositories[0].description).toBe('initial description');
    });

    it('should not clobber other fields when a single field is updated', async () => {
      await setupRepoManager([{
        id: 'repo-1',
        name: 'my-repo',
        path: TEST_REPO_PATH,
        description: 'orig description',
      }]);

      const response = await callTool(app, mcpSessionId, 'update_repository', {
        repositoryId: 'repo-1',
        setupCommand: 'echo x',
      }, nextId++);
      const data = parseToolResult(response) as {
        repository?: Record<string, unknown>;
      };

      expect(response.result?.isError).toBeUndefined();
      expect(data.repository!.description).toBe('orig description');
      expect(data.repository!.setupCommand).toBe('echo x');

      const stored = repositoryManager.getRepository('repo-1');
      expect(stored?.description).toBe('orig description');
      expect(stored?.setupCommand).toBe('echo x');
    });

    it('should return a structured MCP tool error for an unknown repositoryId', async () => {
      await setupRepoManager();

      const response = await callTool(app, mcpSessionId, 'update_repository', {
        repositoryId: 'nonexistent-id',
        setupCommand: 'bun install',
      }, nextId++);
      const data = parseToolResult(response) as { error?: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('nonexistent-id');
    });

    it('should persist all provided fields in a multi-field update', async () => {
      await setupRepoManager([{
        id: 'repo-1',
        name: 'my-repo',
        path: TEST_REPO_PATH,
      }]);

      const response = await callTool(app, mcpSessionId, 'update_repository', {
        repositoryId: 'repo-1',
        setupCommand: 'bun install',
        cleanupCommand: 'bun run cleanup',
        description: 'updated description',
      }, nextId++);
      const data = parseToolResult(response) as {
        repository?: Record<string, unknown>;
      };

      expect(response.result?.isError).toBeUndefined();
      expect(data.repository!.setupCommand).toBe('bun install');
      expect(data.repository!.cleanupCommand).toBe('bun run cleanup');
      expect(data.repository!.description).toBe('updated description');

      const stored = repositoryManager.getRepository('repo-1');
      expect(stored?.setupCommand).toBe('bun install');
      expect(stored?.cleanupCommand).toBe('bun run cleanup');
      expect(stored?.description).toBe('updated description');
    });

    it('should persist envVars but not echo it in the response (v1 parity with REST + secret-read gate)', async () => {
      await setupRepoManager([{
        id: 'repo-1',
        name: 'my-repo',
        path: TEST_REPO_PATH,
      }]);

      const response = await callTool(app, mcpSessionId, 'update_repository', {
        repositoryId: 'repo-1',
        envVars: 'FOO=bar',
      }, nextId++);
      const data = parseToolResult(response) as {
        repository?: Record<string, unknown>;
      };

      expect(response.result?.isError).toBeUndefined();
      // envVars must not be echoed back — that would create a read channel
      // for stored plaintext secrets via an arbitrary write call.
      expect(data.repository).not.toHaveProperty('envVars');

      // Persisted correctly at the storage layer.
      const stored = repositoryManager.getRepository('repo-1');
      expect(stored?.envVars).toBe('FOO=bar');
    });

    it('should treat an empty string as a request to clear the field', async () => {
      await setupRepoManager([{
        id: 'repo-1',
        name: 'my-repo',
        path: TEST_REPO_PATH,
        description: 'to be cleared',
      }]);

      const response = await callTool(app, mcpSessionId, 'update_repository', {
        repositoryId: 'repo-1',
        description: '',
      }, nextId++);
      const data = parseToolResult(response) as {
        repository?: Record<string, unknown>;
      };

      expect(response.result?.isError).toBeUndefined();
      // Response uses `?? undefined` on description; empty string cleared -> undefined
      expect(data.repository!.description).toBeUndefined();

      const stored = repositoryManager.getRepository('repo-1');
      expect(stored?.description).toBeNull();
    });
  });

  // ===========================================================================
  // list_sessions
  // ===========================================================================

  describe('list_sessions', () => {
    it('should return empty sessions array when no sessions exist', async () => {
      const response = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const data = parseToolResult(response) as { sessions: unknown[] };

      expect(response.result?.isError).toBeUndefined();
      expect(data.sessions).toEqual([]);
    });

    it('should return session info after creating a session', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const data = parseToolResult(response) as { sessions: Array<{ id: string; type: string; status: string; workers: unknown[] }> };

      expect(response.result?.isError).toBeUndefined();
      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0].id).toBe(session.id);
      expect(data.sessions[0].type).toBe('quick');
      expect(data.sessions[0].status).toBe('active');
      expect(data.sessions[0].workers.length).toBeGreaterThan(0);
    });

    it('should return multiple sessions', async () => {
      await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path1',
        agentId: 'claude-code',
      });
      await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path2',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const data = parseToolResult(response) as { sessions: unknown[] };

      expect(data.sessions).toHaveLength(2);
    });

    it('should include worktreeId for worktree sessions', async () => {
      await registerTestRepo();
      await sessionManager.createSession({
        type: 'worktree',
        locationPath: '/test/worktree',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const data = parseToolResult(response) as { sessions: Array<{ worktreeId?: string }> };

      expect(data.sessions[0].worktreeId).toBe('feature-branch');
    });

    it('should include repositoryId and repositoryName for worktree sessions', async () => {
      await registerTestRepo();
      await sessionManager.createSession({
        type: 'worktree',
        locationPath: '/test/worktree',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const data = parseToolResult(response) as {
        sessions: Array<{ repositoryId?: string; repositoryName?: string; type: string }>;
      };

      expect(data.sessions[0].repositoryId).toBe('repo-1');
      expect(data.sessions[0].repositoryName).toBeDefined();
    });

    it('should not include repositoryId for quick sessions', async () => {
      await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const data = parseToolResult(response) as {
        sessions: Array<{ repositoryId?: string }>;
      };

      expect(data.sessions[0].repositoryId).toBeUndefined();
    });
  });

  // ===========================================================================
  // get_session_status
  // ===========================================================================

  describe('get_session_status', () => {
    it('should return session info for an existing session', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
        title: 'Test Session',
      });

      const response = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as {
        sessionId: string;
        status: string;
        title: string;
        workers: Array<{ id: string; type: string; activityState: string }>;
      };

      expect(response.result?.isError).toBeUndefined();
      expect(data.sessionId).toBe(session.id);
      expect(data.status).toBe('active');
      expect(data.title).toBe('Test Session');
      expect(data.workers.length).toBeGreaterThan(0);
    });

    it('should return error for non-existent session', async () => {
      const response = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: 'non-existent-id',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Session not found');
    });

    it('should include worktreeId for worktree sessions', async () => {
      await registerTestRepo();
      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: '/test/worktree',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as { worktreeId?: string };

      expect(data.worktreeId).toBe('feature-branch');
    });

    it('should include repositoryId and repositoryName for worktree sessions', async () => {
      await registerTestRepo();
      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: '/test/worktree',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as {
        repositoryId?: string;
        repositoryName?: string;
      };

      expect(data.repositoryId).toBe('repo-1');
      expect(data.repositoryName).toBeDefined();
    });

    it('should report worker activity states', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as {
        workers: Array<{ id: string; type: string; activityState: string }>;
      };

      // Agent workers should have an activity state
      const agentWorker = data.workers.find((w) => w.type === 'agent');
      expect(agentWorker).toBeDefined();
      expect(agentWorker!.activityState).toBeDefined();
    });

    it('should report embedded-agent worker activity state (Issue #1128)', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const embeddedWorker = await sessionManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: TEST_EMBEDDED_AGENT_DEF.id,
      });
      expect(embeddedWorker).toBeDefined();

      // Simulate a loop-emitted activityState update (see
      // worker-lifecycle-manager.ts getWorkerActivityState, which reads this
      // field directly for embedded-agent workers instead of going through
      // ActivityDetector).
      const internalWorker = sessionManager.getWorker(session.id, embeddedWorker!.id)!;
      expect(internalWorker).toBeDefined();
      expect(internalWorker.type).toBe('embedded-agent');
      if (internalWorker.type === 'embedded-agent') {
        internalWorker.activityState = 'active';
      }

      const response = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as {
        workers: Array<{ id: string; type: string; activityState: string }>;
      };

      const embeddedAgentWorker = data.workers.find((w) => w.type === 'embedded-agent');
      expect(embeddedAgentWorker).toBeDefined();
      expect(embeddedAgentWorker!.activityState).toBe('active');
    });

    it('should report terminated worker when PTY has exited', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Simulate PTY exit for the agent worker
      const agentPty = ptyFactory.instances[0];
      expect(agentPty).toBeDefined();
      agentPty.simulateExit(0);

      const response = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as {
        workers: Array<{ id: string; type: string; activityState: string }>;
      };

      // After PTY exit, the activity state should reflect the terminated state
      const agentWorker = data.workers.find((w) => w.type === 'agent');
      expect(agentWorker).toBeDefined();
      // ActivityDetector is disposed on exit, so getWorkerActivityState returns undefined
      // which mapWorkers converts to 'unknown'
      expect(agentWorker!.activityState).toBeDefined();
    });
  });

  // ===========================================================================
  // send_session_message
  // ===========================================================================

  describe('send_session_message', () => {
    it('should return error when target session does not exist', async () => {
      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: 'non-existent',
        content: 'hello',
        fromSessionId: 'test-sender',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toBe('Session non-existent not found');
    });

    it('should return error when explicit worker does not exist in target session', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        toWorkerId: 'non-existent-worker',
        content: 'hello',
        fromSessionId: 'test-sender',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain(`Worker non-existent-worker not found in session ${session.id}`);
    });

    it('should return error when explicit toWorkerId targets a git-diff worker', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Find the git-diff worker created by default
      const gitDiffWorker = session.workers.find((w) => w.type === 'git-diff');
      expect(gitDiffWorker).toBeDefined();

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        toWorkerId: gitDiffWorker!.id,
        content: 'hello',
        fromSessionId: 'test-sender',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('requires a PTY-backed worker (agent/terminal)');
    });

    it('should return error when session has no agent workers', async () => {
      // Create a session (which creates an agent worker and a git-diff worker by default)
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Delete the default agent worker so only the git-diff worker remains
      const agentWorker = session.workers.find((w) => w.type === 'agent');
      expect(agentWorker).toBeDefined();
      await sessionManager.deleteWorker(session.id, agentWorker!.id);

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: 'hello',
        fromSessionId: 'test-sender',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toBe(`Session ${session.id} has no agent workers`);
    });

    it('should return error when multiple agent workers exist without explicit toWorkerId', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Add a second agent worker
      await sessionManager.createWorker(session.id, {
        type: 'agent',
        agentId: 'claude-code-builtin',
      });

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: 'hello',
        fromSessionId: 'test-sender',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('has multiple agent workers');
      expect(data.error).toContain('Specify toWorkerId explicitly');
      expect(data.error).toContain('Use get_session_status to discover available workers');
    });

    it('should auto-resolve single agent worker when toWorkerId is omitted', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const senderSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/sender-path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: 'task completed successfully',
        fromSessionId: senderSession.id,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { messageId: string; path: string };
      expect(data.messageId).toBeDefined();
      expect(data.path).toBeDefined();
    });

    it('should write message file content to disk', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const senderSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/sender-path',
        agentId: 'claude-code',
      });

      const messageContent = JSON.stringify({ status: 'completed', summary: 'All tests pass' });

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: messageContent,
        fromSessionId: senderSession.id,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { messageId: string; path: string };

      // Verify file exists and has correct content
      const fileContent = vol.readFileSync(data.path, 'utf-8');
      expect(fileContent).toBe(messageContent);
    });

    it('should send PTY notification with internal:message format', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const senderSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/sender-path',
        agentId: 'claude-code',
      });

      // The target agent worker's PTY is the first instance created
      const mockPty = ptyFactory.instances[0];
      expect(mockPty).toBeDefined();

      await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: 'check this out',
        fromSessionId: senderSession.id,
      }, nextId++);

      // Verify PTY received the inbound:message notification
      const allWritten = mockPty.writtenData.join('');
      expect(allWritten).toContain('[internal:message]');
      expect(allWritten).toContain('source=session');
      expect(allWritten).toContain(`from=${senderSession.id}`);
      expect(allWritten).toContain('intent=triage');
    });

    it('should split notification text and Enter keystroke into separate writes with delay', async () => {
      jest.useFakeTimers();
      try {
        const session = await sessionManager.createSession({
          type: 'quick',
          locationPath: '/test/path',
          agentId: 'claude-code',
        });
        const senderSession = await sessionManager.createSession({
          type: 'quick',
          locationPath: '/test/sender-path',
          agentId: 'claude-code',
        });

        const mockPty = ptyFactory.instances[0];
        expect(mockPty).toBeDefined();

        // Clear any writes from session creation
        mockPty.writtenData.length = 0;

        await callTool(app, mcpSessionId, 'send_session_message', {
          toSessionId: session.id,
          content: 'split test',
          fromSessionId: senderSession.id,
        }, nextId++);

        // Before the timer fires, notification text + reply instructions should be written
        expect(mockPty.writtenData).toHaveLength(2);
        expect(mockPty.writtenData[0]).toContain('[internal:message]');
        expect(mockPty.writtenData[0]).not.toContain('\r');
        // The notification text should NOT end with \n (no trailing newline)
        expect(mockPty.writtenData[0].endsWith('\n')).toBe(false);
        expect(mockPty.writtenData[1]).toContain('[Reply Instructions]');
        expect(mockPty.writtenData[1]).toContain(senderSession.id);

        // Advance past the 150ms delay
        jest.advanceTimersByTime(150);

        // Now the Enter keystroke should have been sent as a third write
        expect(mockPty.writtenData).toHaveLength(3);
        expect(mockPty.writtenData[2]).toBe('\r');
      } finally {
        jest.useRealTimers();
      }
    });

    it('should include reply instructions in PTY notification', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const senderSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/sender-path',
        agentId: 'claude-code',
      });

      const mockPty = ptyFactory.instances[0];
      expect(mockPty).toBeDefined();

      await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: 'need your help',
        fromSessionId: senderSession.id,
      }, nextId++);

      // With login shell sentinel: writtenData[0] = agent command,
      // [1] = notification, [2] = reply instructions.
      const replyInstructions = mockPty.writtenData[2];
      expect(replyInstructions).toContain('[Reply Instructions]');
      expect(replyInstructions).toContain(`toSessionId: "${senderSession.id}"`);
      expect(replyInstructions).toContain('AGENT_CONSOLE_SESSION_ID');
    });

    it('should include sender session title in notification summary', async () => {
      // Create sender session with a title
      const senderSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/sender-path',
        agentId: 'claude-code',
        title: 'Backend Auth Task',
      });

      // Create target session
      const targetSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/target-path',
        agentId: 'claude-code',
      });

      await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: targetSession.id,
        content: 'auth fix is done',
        fromSessionId: senderSession.id,
      }, nextId++);

      // Check all PTY instances for the notification containing the sender's title
      const allPtyWrites = ptyFactory.instances
        .map((p) => p.writtenData.join(''))
        .join('|||');
      expect(allPtyWrites).toContain('Backend Auth Task');
    });

    it('should succeed with explicit toWorkerId targeting', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const senderSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/sender-path',
        agentId: 'claude-code',
      });

      const agentWorker = session.workers.find((w) => w.type === 'agent');
      expect(agentWorker).toBeDefined();

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        toWorkerId: agentWorker!.id,
        content: 'explicit target message',
        fromSessionId: senderSession.id,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { messageId: string; path: string };
      expect(data.messageId).toContain(senderSession.id);
      expect(data.path).toBeDefined();

      // Verify file content
      const fileContent = vol.readFileSync(data.path, 'utf-8');
      expect(fileContent).toBe('explicit target message');
    });

    it('should return error when message content exceeds size limit', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const senderSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/sender-path',
        agentId: 'claude-code',
      });

      const oversizedContent = 'x'.repeat(64 * 1024 + 1);

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: oversizedContent,
        fromSessionId: senderSession.id,
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Message content too large');
    });

    it('should resolve target path via SessionManager (uses persisted slug, not display name)', async () => {
      // Register a repository. SessionManager resolves the session's data
      // path via repositoryLookup.getRepositorySlug -> RepositoryManager's
      // deriveRepositorySlug-backed derivation (Issue #1300), NOT the
      // repository's display name. Pin the mocked derivation to 'test-repo'
      // so this test can assert the resolved path independent of what the
      // derivation itself returns (that behavior is covered by
      // git.test.ts's deriveRepositorySlug suite and
      // repository-manager.test.ts's getRepositorySlug suite). Send a
      // message to a worktree session and verify the message file path
      // lands under the repository scope dir, not the `_quick/` fallback
      // that the previous implementation would have produced.
      mockGit.deriveRepositorySlug.mockImplementation(() => Promise.resolve('test-repo'));
      await registerTestRepo('repo-1', 'test-repo', '/test/repo');

      const targetSession = await sessionManager.createSession({
        type: 'worktree',
        repositoryId: 'repo-1',
        worktreeId: 'wt-1',
        locationPath: '/test/repo',
        agentId: 'claude-code',
      });
      const senderSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/sender-path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: targetSession.id,
        content: 'hello worktree',
        fromSessionId: senderSession.id,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { messageId: string; path: string };
      // Path must be rooted under the repository scope, not _quick.
      expect(data.path).toContain(`${TEST_CONFIG_DIR}/repositories/test-repo/messages/`);
      expect(data.path).not.toContain(`${TEST_CONFIG_DIR}/_quick/`);
    });

    // Regression test for Issue #690 — non-existent fromSessionId rejected.
    // Before the defense-in-depth fix, the server accepted any string and the
    // resulting message recorded a session id that the receiver could not reply to.
    it('should return error when fromSessionId does not reference an existing session', async () => {
      const targetSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: targetSession.id,
        content: 'this should be rejected',
        // Plausible-looking but unknown sender id (the bug observed in production
        // recorded ids that passed the regex validator but did not exist).
        fromSessionId: 'e8094e4c-8de0-43ce-8c41-6b82b9e7ed31',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Sender session');
      expect(data.error).toContain('e8094e4c-8de0-43ce-8c41-6b82b9e7ed31');
      expect(data.error).toContain('not found');

      // No PTY notification should have been delivered — the message must not
      // be persisted at all when the sender id is invalid.
      const allPtyWrites = ptyFactory.instances
        .map((p) => p.writtenData.join(''))
        .join('|||');
      expect(allPtyWrites).not.toContain('[internal:message]');
      expect(allPtyWrites).not.toContain('e8094e4c-8de0-43ce-8c41-6b82b9e7ed31');
    });

    it('should return validation error when fromSessionId is omitted', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: 'no sender info',
        // fromSessionId is intentionally omitted
      }, nextId++);

      // The MCP SDK validates parameters via zod schema and returns a JSON-RPC error
      // when required parameters are missing
      if (response.error) {
        // JSON-RPC level error
        expect(response.error).toBeDefined();
      } else {
        // Or the tool handler catches it and returns isError
        expect(response.result?.isError).toBe(true);
      }
    });
  });

  describe('send_session_message: embedded-agent target (Issue #1260 PR-2)', () => {
    // Polarity requirement (self-pass, see Issue #1260 PR-2 AC): against the
    // pre-fix implementation (isPtyBackedWorker-only gate), the first test
    // below fails at `expect(response.result?.isError).toBeUndefined()`
    // because the tool rejects with 'cannot receive inbound messages:
    // requires a PTY-backed worker (agent/terminal)' -- verified manually by
    // stashing the production diff and re-running this file (see PR body).

    it('should succeed with explicit toWorkerId targeting a deactivated embedded-agent worker (activates + delivers the same notification template as the PTY branch)', async () => {
      const session = await sessionManager.createSession(
        { type: 'quick', locationPath: '/test/path', agentId: 'claude-code' },
        // createdBy is required for embedded-agent activation to mint an MCP
        // caller identity (runActivation's Step 3) -- see
        // EmbeddedAgentWorkerService's "has no createdBy" guard.
        { createdBy: 'test-user-id' },
      );
      const embeddedWorker = await sessionManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: TEST_EMBEDDED_AGENT_DEF.id,
      });
      expect(embeddedWorker).toBeDefined();

      const senderSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/sender-path',
        agentId: 'claude-code',
      });

      expect(fakeEmbeddedSpawn.captured.length).toBe(0);

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        toWorkerId: embeddedWorker!.id,
        content: 'task done',
        fromSessionId: senderSession.id,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      // Activated as a side effect of delivery (activate-on-delivery, Ruling B).
      expect(fakeEmbeddedSpawn.captured.length).toBe(1);

      const userMessageWrite = fakeEmbeddedSpawn.stdinWrites
        .map((w) => JSON.parse(w) as { type: string; text?: string })
        .find((c) => c.type === 'user-message');
      expect(userMessageWrite).toBeDefined();
      // Same notification template the PTY branch writes: internal:message
      // tag, sender, message file path, and reply instructions.
      expect(userMessageWrite!.text).toContain('[internal:message]');
      expect(userMessageWrite!.text).toContain('source=session');
      expect(userMessageWrite!.text).toContain(`from=${senderSession.id}`);
      expect(userMessageWrite!.text).toContain('intent=triage');
      expect(userMessageWrite!.text).toContain('[Reply Instructions]');
      expect(userMessageWrite!.text).toContain(`toSessionId: "${senderSession.id}"`);

      const data = parseToolResult(response) as { messageId: string; path: string };
      expect(userMessageWrite!.text).toContain(data.path);

      // Issue #1351: the PERSISTED event carries a `notification` marker
      // distinguishing this system-originated send from a real user/API
      // message, with summary matching what stdin's text already asserted.
      const history = await sessionManager.getWorkerOutputHistory(session.id, embeddedWorker!.id, 0);
      expect(history).not.toBeNull();
      const persistedUserMessage = (history!.data as string)
        .split('\n')
        .filter((line: string) => line.length > 0)
        .map((line: string) => JSON.parse(line) as { type: string; notification?: { kind: string; summary?: string } })
        .find((event) => event.type === 'user-message');
      expect(persistedUserMessage?.notification).toEqual({
        kind: 'internal-message',
        summary: `Message from session ${senderSession.title ?? senderSession.id}`,
      });

      const deactivatePromise = sessionManager.deactivateEmbeddedAgentWorker(session.id, embeddedWorker!.id);
      fakeEmbeddedSpawn.simulateExit(0);
      await deactivatePromise;
    });

    it('should fail with a classified message when the embedded-agent target is mid-turn (TURN_IN_PROGRESS)', async () => {
      const session = await sessionManager.createSession(
        { type: 'quick', locationPath: '/test/path', agentId: 'claude-code' },
        // createdBy is required for embedded-agent activation to mint an MCP
        // caller identity (runActivation's Step 3) -- see
        // EmbeddedAgentWorkerService's "has no createdBy" guard.
        { createdBy: 'test-user-id' },
      );
      const embeddedWorker = await sessionManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: TEST_EMBEDDED_AGENT_DEF.id,
      });
      const senderSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/sender-path',
        agentId: 'claude-code',
      });

      await sessionManager.activateEmbeddedAgentWorker(session.id, embeddedWorker!.id);
      // Admit a turn that never resolves idle, so the second delivery below
      // hits TURN_IN_PROGRESS without a second activation attempt.
      const first = await sessionManager.sendEmbeddedAgentUserMessage(session.id, embeddedWorker!.id, 'busy');
      expect(first.ok).toBe(true);
      expect(fakeEmbeddedSpawn.captured.length).toBe(1);

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        toWorkerId: embeddedWorker!.id,
        content: 'please respond',
        fromSessionId: senderSession.id,
      }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('turn in progress');
      // No re-activation attempted (already activated).
      expect(fakeEmbeddedSpawn.captured.length).toBe(1);

      // Teardown: clear the turn so afterEach's deactivate isn't rejected.
      fakeEmbeddedSpawn.pushLine({ v: 1, type: 'state', state: 'idle' });
    });

    it('should fail with the marker message verbatim when embedded-agent activation fails for an enumerable reason (deleted definition)', async () => {
      const session = await sessionManager.createSession(
        { type: 'quick', locationPath: '/test/path', agentId: 'claude-code' },
        // createdBy is required for embedded-agent activation to mint an MCP
        // caller identity (runActivation's Step 3) -- see
        // EmbeddedAgentWorkerService's "has no createdBy" guard.
        { createdBy: 'test-user-id' },
      );
      const embeddedWorker = await sessionManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: TEST_EMBEDDED_AGENT_DEF.id,
      });
      const senderSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/sender-path',
        agentId: 'claude-code',
      });

      // Simulate the definition being deleted between worker-creation and
      // delivery -- runActivation throws EmbeddedAgentActivationError.
      embeddedAgentDefsById.delete(TEST_EMBEDDED_AGENT_DEF.id);

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        toWorkerId: embeddedWorker!.id,
        content: 'hello',
        fromSessionId: senderSession.id,
      }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('Embedded agent definition not found');
      expect(fakeEmbeddedSpawn.captured.length).toBe(0); // never reached the spawn step
    });

    it('should fail with the generic fallback message (not the raw error) when embedded-agent activation fails for a non-marker reason', async () => {
      const session = await sessionManager.createSession(
        { type: 'quick', locationPath: '/test/path', agentId: 'claude-code' },
        // createdBy is required for embedded-agent activation to mint an MCP
        // caller identity (runActivation's Step 3) -- see
        // EmbeddedAgentWorkerService's "has no createdBy" guard.
        { createdBy: 'test-user-id' },
      );
      const embeddedWorker = await sessionManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: TEST_EMBEDDED_AGENT_DEF.id,
      });
      const senderSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/sender-path',
        agentId: 'claude-code',
      });

      fakeEmbeddedSpawn.throwOnNextSpawn = new Error(
        'ENOENT: unstructured internal detail nobody should see client-side',
      );

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        toWorkerId: embeddedWorker!.id,
        content: 'hello',
        fromSessionId: senderSession.id,
      }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).not.toContain('ENOENT');
      expect(data.error).toContain('Embedded-agent activation failed');
    });

    // Regression: the pre-existing terminal-agent send_session_message tests
    // in the parent `describe('send_session_message', ...)` block above are
    // UNCHANGED by this PR (no assertion in them was modified) -- their
    // continued passing is the byte-identical-PTY-branch AC requirement.
  });

  // ===========================================================================
  // delegate_to_worktree
  // ===========================================================================

  describe('delegate_to_worktree', () => {
    /**
     * Helper to initialize a RepositoryManager with optional pre-seeded repositories.
     * Repositories must have their paths present in memfs to be loaded.
     * Updates the outer `repositoryManager` and re-mounts the MCP app.
     */
    async function setupDelegateRepoManager(repos: Array<{
      id: string;
      name: string;
      path: string;
      defaultAgentId?: string | null;
    }> = []): Promise<void> {
      const db = getDatabase();
      const sqliteRepoRepo = new SqliteRepositoryRepository(db);
      for (const repo of repos) {
        await sqliteRepoRepo.save({
          ...repo,
          createdAt: new Date().toISOString(),
          clonedSourceRepoPath: null,
        });
      }
      repositoryManager = await RepositoryManager.create({
        jobQueue: testJobQueue,
        repository: sqliteRepoRepo,
      });
      await remountMcpApp();
    }

    /**
     * Standard setup for delegate_to_worktree tests that need a working repository.
     * Sets up memfs with repo and config dirs, git mocks, and RepositoryManager.
     *
     * @param worktreeBranch - Branch name that the created worktree will report
     * @param options.defaultAgentId - Optional default agent ID for the repository
     * @returns The worktree path that createWorktree will produce
     */
    async function setupDelegateEnvironment(
      worktreeBranch: string = 'feat/test-branch',
      options?: { defaultAgentId?: string | null },
    ): Promise<string> {
      // The orgRepo extracted from the mock remote URL (git@github.com:owner/repo.git)
      const orgRepo = 'owner/repo';
      // The worktree path follows the pattern: AGENT_CONSOLE_HOME/repositories/<orgRepo>/worktrees/wt-001-xxxx
      // but we need to match what worktreeService actually produces.
      // We use a known pattern for the index store directory.
      const repoWorktreeDir = `${TEST_CONFIG_DIR}/repositories/${orgRepo}/worktrees`;

      // Setup memfs with config dir and repo path
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      // Configure git mocks for worktree operations.
      // The `git worktree add` invocation itself is captured by the
      // `runAsUserImpl` stub injected on the WorktreeService at the
      // top-level `beforeEach`; the captured path then feeds `listWorktrees`
      // below so the orchestration sees the newly-created worktree.
      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');
      mockGit.getDefaultBranch.mockImplementation(async () => 'main');

      mockGit.listWorktrees.mockImplementation(async () => {
        const captured = mcpRunAsUserCapture.capturedWorktreePath;
        if (captured) {
          return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${captured}\nHEAD def456\nbranch refs/heads/${worktreeBranch}\n`;
        }
        return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n`;
      });

      // Setup RepositoryManager with the test repository
      await setupDelegateRepoManager([{
        id: 'test-repo',
        name: 'test',
        path: TEST_REPO_PATH,
        defaultAgentId: options?.defaultAgentId,
      }]);

      return repoWorktreeDir;
    }

    /**
     * Find a PTY spawn call whose command arguments contain the given substring.
     * Returns undefined if no matching call is found.
     */
    function findSpawnCallByCommand(commandSubstring: string): unknown[] | undefined {
      const calls = ptyFactory.spawn.mock.calls as unknown as Array<[string, string[], unknown]>;
      const spawnMatch = calls.find((call) => {
        const cmd = call[1]?.join(' ') ?? '';
        return cmd.includes(commandSubstring);
      });
      if (spawnMatch) return spawnMatch;
      const ptyMatch = ptyFactory.instances.find((pty) =>
        pty.writtenData.some((d) => d.includes(commandSubstring)),
      );
      if (ptyMatch) {
        const idx = ptyFactory.instances.indexOf(ptyMatch);
        return calls[idx];
      }
      return undefined;
    }

    it('should return error when repository not found', async () => {
      // Initialize RepositoryManager with no repositories
      await setupDelegateRepoManager();

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'non-existent-repo',
        prompt: 'Implement feature X',
        ...(await createValidDelegateParent()),
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Repository not found');
    });

    it('should return error when agent not found', async () => {
      // The repository path must exist in memfs for RepositoryManager.initialize() to load it
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        '/test/repo/.git/HEAD': 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      await setupDelegateRepoManager([{
        id: 'test-repo',
        name: 'test',
        path: '/test/repo',
      }]);

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Do something',
        agentId: 'non-existent-agent',
        ...(await createValidDelegateParent()),
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Agent not found');
    });

    it('should successfully create worktree, session, and start agent worker', async () => {
      await setupDelegateEnvironment('feat/my-feature');


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Implement feature X',
        branch: 'feat/my-feature',
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as {
        sessionId: string;
        workerId: string;
        worktreePath: string;
        branch: string;
      };

      // Verify result contains all expected fields
      expect(data.sessionId).toBeDefined();
      expect(data.sessionId.length).toBeGreaterThan(0);
      expect(data.workerId).toBeDefined();
      expect(data.workerId.length).toBeGreaterThan(0);
      expect(data.worktreePath).toBeDefined();
      expect(data.worktreePath.length).toBeGreaterThan(0);
      expect(data.branch).toBe('feat/my-feature');

      // Verify the session exists via list_sessions
      const listResponse = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const listData = parseToolResult(listResponse) as {
        sessions: Array<{
          id: string;
          type: string;
          worktreeId?: string;
          workers: Array<{ id: string; type: string }>;
        }>;
      };

      expect(listData.sessions.length).toBeGreaterThanOrEqual(1);
      const delegatedSession = listData.sessions.find((s) => s.id === data.sessionId);
      expect(delegatedSession).toBeDefined();
      expect(delegatedSession!.type).toBe('worktree');
      expect(delegatedSession!.worktreeId).toBe('feat/my-feature');

      // Verify the session has an agent worker
      const agentWorker = delegatedSession!.workers.find((w) => w.type === 'agent');
      expect(agentWorker).toBeDefined();
      expect(agentWorker!.id).toBe(data.workerId);
    });

    it('should auto-generate branch name from prompt when branch param is omitted', async () => {
      mockSuggestSessionMetadata.mockImplementation(async () => ({
        branch: 'feat/auto-generated-branch',
        title: 'Auto-Generated Title',
      }));

      await setupDelegateEnvironment('feat/auto-generated-branch');


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Implement automatic branch generation',
        // branch is intentionally omitted
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as {
        branch: string;
      };

      // The branch should come from suggestSessionMetadata
      expect(data.branch).toBe('feat/auto-generated-branch');

      // Verify suggestSessionMetadata was called
      expect(mockSuggestSessionMetadata).toHaveBeenCalled();
    });

    it('should use explicit branch name when provided', async () => {
      await setupDelegateEnvironment('my-explicit-branch');


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Do some work',
        branch: 'my-explicit-branch',
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { branch: string };
      expect(data.branch).toBe('my-explicit-branch');

      // suggestSessionMetadata should NOT have been called when branch is explicitly provided
      expect(mockSuggestSessionMetadata).not.toHaveBeenCalled();
    });

    it('should pass custom title through to the created session', async () => {
      await setupDelegateEnvironment('feat/titled-task');


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Add dark mode support',
        branch: 'feat/titled-task',
        title: 'Dark Mode Feature',
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { sessionId: string };

      // Verify the session has the custom title
      const statusResponse = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: data.sessionId,
      }, nextId++);
      const statusData = parseToolResult(statusResponse) as { title?: string };

      expect(statusData.title).toBe('Dark Mode Feature');
    });

    it('should call fetchRemote by default when useRemote is omitted', async () => {
      await setupDelegateEnvironment('feat/remote-branch');

      // fetchRemote is already mocked by mock-git-helper (resolves successfully)

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Work on remote-based feature',
        branch: 'feat/remote-branch',
        // useRemote is intentionally omitted — should default to true
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      // Verify fetchRemote was called (the baseBranch defaults to 'main').
      // The 3rd arg is `requestUsername` — null here because the parent
      // session created by createValidDelegateParent() has a createdBy
      // that does not resolve in userRepository (Issue #912 / #1293).
      expect(mockGit.fetchRemote).toHaveBeenCalledWith('main', TEST_REPO_PATH, null);
    });

    it('should skip fetchRemote when useRemote is explicitly false', async () => {
      await setupDelegateEnvironment('feat/local-branch');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Work on local-only feature',
        branch: 'feat/local-branch',
        useRemote: false,
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      // Verify fetchRemote was NOT called
      expect(mockGit.fetchRemote).not.toHaveBeenCalled();
    });

    it('should return error when worktree creation fails', async () => {
      // Setup environment but make `git worktree add` fail. The runAsUser
      // stub returns a non-zero exit (with the same stderr the real git
      // would emit), which the WorktreeService surfaces via GitError.
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');
      mockGit.getDefaultBranch.mockImplementation(async () => 'main');

      mcpRunAsUserCapture.responseOverride = {
        stdout: '',
        stderr: 'fatal: branch already exists',
        exitCode: 128,
        timedOut: false,
      };

      await setupDelegateRepoManager([{
        id: 'test-repo',
        name: 'test',
        path: TEST_REPO_PATH,
      }]);

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Try to create duplicate worktree',
        branch: 'existing-branch',
        ...(await createValidDelegateParent()),
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Worktree creation failed');
    });

    it('should find worktree via DB even when git does not report it (orphaned)', async () => {
      // Setup environment with worktree creation succeeding but git listWorktrees
      // not returning it. With DB-based tracking, the worktree is still found as
      // an orphaned entry because createWorktree saves a record to the DB.
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');
      mockGit.getDefaultBranch.mockImplementation(async () => 'main');

      mockGit.createWorktree.mockImplementation(async () => {
        // Success - worktree is "created" on disk
      });
      mockGit.listWorktrees.mockImplementation(async () => {
        // Only return the main worktree; the created worktree is NOT in git output
        return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n`;
      });

      await setupDelegateRepoManager([{
        id: 'test-repo',
        name: 'test',
        path: TEST_REPO_PATH,
      }]);

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test orphaned worktree lookup via DB',
        branch: 'feat/ghost-worktree',
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as {
        sessionId: string;
        worktreePath: string;
      };
      expect(data.sessionId).toBeDefined();
      expect(data.worktreePath).toBeDefined();
    });

    it('should rollback worktree when session is deleted before delegation completes', async () => {
      await setupDelegateEnvironment('feat/deleted-session');

      // Create the valid parent session BEFORE installing the createSession
      // override below -- otherwise the override would also delete the
      // parent session created by createValidDelegateParent(), and the
      // delegate call would fail at the S3(a) parent-lookup check instead
      // of reaching the race condition this test actually exercises.
      const parent = await createValidDelegateParent();

      // Intercept createSession: after it creates the session, immediately delete it
      // to simulate a concurrent deletion race condition
      const originalCreateSession = sessionManager.createSession.bind(sessionManager);
      sessionManager.createSession = async (...args: Parameters<typeof sessionManager.createSession>) => {
        const session = await originalCreateSession(...args);
        // Delete the session immediately to simulate race condition
        await sessionManager.deleteSession(session.id);
        return session;
      };

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test session deleted during delegation',
        branch: 'feat/deleted-session',
        ...parent,
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Session was deleted before delegation could complete');

      // Verify removeWorktree was called for rollback
      expect(mockGit.removeWorktree).toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Agent selection priority: agentId > repo.defaultAgentId > CLAUDE_CODE
    // -----------------------------------------------------------------------

    it('should use repository defaultAgentId when agentId is not provided', async () => {
      const registered = await agentManager.registerAgent({
        name: 'Repo Default Agent',
        commandTemplate: 'repo-default-agent {{prompt}}',
      });

      await setupDelegateEnvironment('feat/repo-default', {
        defaultAgentId: registered.id,
      });


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test repo default agent selection',
        branch: 'feat/repo-default',
        // agentId is intentionally omitted
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      expect(findSpawnCallByCommand('repo-default-agent')).toBeDefined();
    });

    it('should fall back to claude-code-builtin when agentId is not provided and repository has no defaultAgentId', async () => {
      await setupDelegateEnvironment('feat/no-default');


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test fallback to claude-code-builtin',
        branch: 'feat/no-default',
        // agentId is intentionally omitted
        ...(await createValidDelegateParent()),
      }, nextId++);

      // Success proves claude-code-builtin was used (the only registered agent)
      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { sessionId: string };
      expect(data.sessionId).toBeDefined();
    });

    it('should use explicit agentId even when repository has defaultAgentId', async () => {
      const repoDefault = await agentManager.registerAgent({
        name: 'Repo Default Agent',
        commandTemplate: 'repo-default-agent {{prompt}}',
      });
      const explicitAgent = await agentManager.registerAgent({
        name: 'Explicit Agent',
        commandTemplate: 'explicit-agent {{prompt}}',
      });

      await setupDelegateEnvironment('feat/explicit-override', {
        defaultAgentId: repoDefault.id,
      });


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test explicit agentId overrides repo default',
        branch: 'feat/explicit-override',
        agentId: explicitAgent.id,
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      expect(findSpawnCallByCommand('explicit-agent')).toBeDefined();
      expect(findSpawnCallByCommand('repo-default-agent')).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // model / reasoningEffort parameters (Issue #1541)
    // -----------------------------------------------------------------------

    it('accepts model/reasoningEffort for a capable agent and forwards them into the spawned PTY command', async () => {
      const capableAgent = await agentManager.registerAgent({
        name: 'Capable Agent',
        commandTemplate: 'capable-agent {{model:+--model}}{{effort:+--effort}}{{prompt}}',
      });

      await setupDelegateEnvironment('feat/model-effort-ok', {
        defaultAgentId: capableAgent.id,
      });

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test model/reasoningEffort forwarding',
        branch: 'feat/model-effort-ok',
        agentId: capableAgent.id,
        model: 'claude-opus-4-6',
        reasoningEffort: 'high',
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      expect(findSpawnCallByCommand("--model 'claude-opus-4-6'")).toBeDefined();
      expect(findSpawnCallByCommand("--effort 'high'")).toBeDefined();
    });

    it('rejects model for an agent whose template has no {{model...}} placeholder', async () => {
      const incapableAgent = await agentManager.registerAgent({
        name: 'Incapable Agent',
        commandTemplate: 'incapable-agent {{prompt}}',
      });

      await setupDelegateEnvironment('feat/model-rejected', {
        defaultAgentId: incapableAgent.id,
      });

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test model rejection',
        branch: 'feat/model-rejected',
        agentId: incapableAgent.id,
        model: 'claude-opus-4-6',
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('model');
    });

    it('rejects reasoningEffort for an agent whose template has no {{effort...}} placeholder', async () => {
      const incapableAgent = await agentManager.registerAgent({
        name: 'Incapable Agent 2',
        commandTemplate: 'incapable-agent-2 {{prompt}}',
      });

      await setupDelegateEnvironment('feat/effort-rejected', {
        defaultAgentId: incapableAgent.id,
      });

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test reasoningEffort rejection',
        branch: 'feat/effort-rejected',
        agentId: incapableAgent.id,
        reasoningEffort: 'high',
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('reasoningEffort');
    });

    it('should return error when repository defaultAgentId references a deleted agent', async () => {
      // Register an agent, then set it as the repository default
      const tempAgent = await agentManager.registerAgent({
        name: 'Soon Deleted Agent',
        commandTemplate: 'soon-deleted {{prompt}}',
      });

      await setupDelegateEnvironment('feat/deleted-default', {
        defaultAgentId: tempAgent.id,
      });

      // Delete the agent. The DB cascades ON DELETE SET NULL for default_agent_id,
      // but RepositoryManager's in-memory cache still holds the stale defaultAgentId.
      await agentManager.unregisterAgent(tempAgent.id);

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test deleted default agent',
        branch: 'feat/deleted-default',
        // agentId is intentionally omitted so the stale defaultAgentId is used
        ...(await createValidDelegateParent()),
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Agent not found');
    });

    // -----------------------------------------------------------------------
    // Agent name resolution (agentName parameter)
    // -----------------------------------------------------------------------

    it('should resolve agentName to agentId', async () => {
      await agentManager.registerAgent({
        name: 'My Custom Agent',
        commandTemplate: 'my-custom-agent {{prompt}}',
      });

      await setupDelegateEnvironment('feat/agent-name-test');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test agentName resolution',
        branch: 'feat/agent-name-test',
        agentName: 'My Custom Agent',
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      expect(findSpawnCallByCommand('my-custom-agent')).toBeDefined();
    });

    it('should return error when agentName matches no agent', async () => {
      await setupDelegateEnvironment('feat/no-match');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test non-existent agentName',
        branch: 'feat/no-match',
        agentName: 'Non-Existent Agent',
        ...(await createValidDelegateParent()),
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('No agent found with name: Non-Existent Agent');
    });

    it('should return error when agentName matches multiple agents', async () => {
      await agentManager.registerAgent({
        name: 'Ambiguous Agent',
        commandTemplate: 'ambiguous-1 {{prompt}}',
      });
      await agentManager.registerAgent({
        name: 'Ambiguous Agent',
        commandTemplate: 'ambiguous-2 {{prompt}}',
      });

      await setupDelegateEnvironment('feat/ambiguous');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test ambiguous agentName',
        branch: 'feat/ambiguous',
        agentName: 'Ambiguous Agent',
        ...(await createValidDelegateParent()),
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Multiple agents match name "Ambiguous Agent"');
      expect(data.error).toContain('Use agentId to specify');
    });

    it('should use agentId when both agentId and agentName are provided', async () => {
      const agentById = await agentManager.registerAgent({
        name: 'Agent By Id',
        commandTemplate: 'agent-by-id {{prompt}}',
      });
      await agentManager.registerAgent({
        name: 'Agent By Name',
        commandTemplate: 'agent-by-name {{prompt}}',
      });

      await setupDelegateEnvironment('feat/both-params');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test agentId takes precedence over agentName',
        branch: 'feat/both-params',
        agentId: agentById.id,
        agentName: 'Agent By Name',
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      expect(findSpawnCallByCommand('agent-by-id')).toBeDefined();
      expect(findSpawnCallByCommand('agent-by-name')).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // EmbeddedAgent selection (Issue #1161): agentId/agentName resolves
    // against EmbeddedAgentManager as a fallback when there is no
    // AgentManager (terminal) match. Short-term facade fix; the structural
    // unification of both registries is tracked by Issue #1160.
    // -----------------------------------------------------------------------

    it('should create an embedded-agent initial worker when agentId matches an embedded agent', async () => {
      await setupDelegateEnvironment('feat/embedded-by-id');

      // Issue #1260 PR-1: `delegate_to_worktree` now eagerly activates an
      // embedded-agent initial worker, which requires the created session to
      // have a `createdBy` (to mint the worker's MCP caller identity). A
      // parent session provides that via the standard delegate inheritance
      // path (see "should inherit createdBy from parent session" above).
      const parentSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: TEST_REPO_PATH,
      }, { createdBy: 'parent-user-embedded-by-id' });

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test embedded agent selection by id',
        branch: 'feat/embedded-by-id',
        agentId: TEST_EMBEDDED_AGENT_DEF.id,
        parentSessionId: parentSession.id,
        parentWorkerId: firstAgentWorkerId(parentSession),
        skipMessageCallbackPrompt: true,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { sessionId: string; workerId: string };

      const session = sessionManager.getSession(data.sessionId);
      expect(session).toBeDefined();
      const worker = session!.workers.find((w) => w.id === data.workerId);
      expect(worker).toBeDefined();
      expect(worker!.type).toBe('embedded-agent');
      if (worker!.type === 'embedded-agent') {
        expect(worker!.embeddedAgentId).toBe(TEST_EMBEDDED_AGENT_DEF.id);
        // Auto-activated by the delegate path itself (Issue #1260 Gap 1).
        expect(worker!.activated).toBe(true);
      }
      expect(fakeEmbeddedSpawn.captured.length).toBe(1);
    });

    it('should create an embedded-agent initial worker when agentName matches an embedded agent', async () => {
      await setupDelegateEnvironment('feat/embedded-by-name');

      const parentSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: TEST_REPO_PATH,
      }, { createdBy: 'parent-user-embedded-by-name' });

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test embedded agent selection by name',
        branch: 'feat/embedded-by-name',
        agentName: TEST_EMBEDDED_AGENT_DEF.name,
        parentSessionId: parentSession.id,
        parentWorkerId: firstAgentWorkerId(parentSession),
        skipMessageCallbackPrompt: true,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { sessionId: string; workerId: string };

      const session = sessionManager.getSession(data.sessionId);
      expect(session).toBeDefined();
      const worker = session!.workers.find((w) => w.id === data.workerId);
      expect(worker).toBeDefined();
      expect(worker!.type).toBe('embedded-agent');
      if (worker!.type === 'embedded-agent') {
        expect(worker!.embeddedAgentId).toBe(TEST_EMBEDDED_AGENT_DEF.id);
        expect(worker!.activated).toBe(true);
      }
      expect(fakeEmbeddedSpawn.captured.length).toBe(1);
    });

    // -----------------------------------------------------------------------
    // embedded-agent model / reasoningEffort / contextWindowTokens parameters
    // (Issue #1554)
    // -----------------------------------------------------------------------

    it('accepts model/reasoningEffort/contextWindowTokens for an embedded agent and forwards them to the persisted worker', async () => {
      await setupDelegateEnvironment('feat/embedded-model-params');

      const parentSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: TEST_REPO_PATH,
      }, { createdBy: 'parent-user-embedded-model-params' });

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test embedded-agent model/reasoningEffort/contextWindowTokens forwarding',
        branch: 'feat/embedded-model-params',
        agentId: TEST_EMBEDDED_AGENT_DEF.id,
        model: 'qwen3:14b',
        reasoningEffort: 'high',
        contextWindowTokens: 32000,
        parentSessionId: parentSession.id,
        parentWorkerId: firstAgentWorkerId(parentSession),
        skipMessageCallbackPrompt: true,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { sessionId: string; workerId: string };

      // model/reasoningEffort/contextWindowTokens are not part of the public
      // Worker/EmbeddedAgentWorker wire shape -- verify the persisted
      // representation instead (mirrors session-manager.test.ts's pattern).
      const persisted = await sessionManager.getSessionRepository().findById(data.sessionId);
      const persistedWorker = persisted!.workers.find((w: PersistedWorker) => w.id === data.workerId);
      expect(persistedWorker).toBeDefined();
      expect(persistedWorker && persistedWorker.type === 'embedded-agent' ? persistedWorker.model : undefined).toBe('qwen3:14b');
      expect(persistedWorker && persistedWorker.type === 'embedded-agent' ? persistedWorker.reasoningEffort : undefined).toBe('high');
      expect(persistedWorker && persistedWorker.type === 'embedded-agent' ? persistedWorker.contextWindowTokens : undefined).toBe(32000);
    });

    it('rejects contextWindowTokens without an accompanying model override for an embedded agent (agent-surface.md Ruling 4)', async () => {
      await setupDelegateEnvironment('feat/embedded-cw-rejected');

      const parentSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: TEST_REPO_PATH,
      }, { createdBy: 'parent-user-embedded-cw-rejected' });

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test contextWindowTokens rejection without model',
        branch: 'feat/embedded-cw-rejected',
        agentId: TEST_EMBEDDED_AGENT_DEF.id,
        contextWindowTokens: 32000,
        parentSessionId: parentSession.id,
        parentWorkerId: firstAgentWorkerId(parentSession),
        skipMessageCallbackPrompt: true,
      }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('contextWindowTokens');
    });

    it('should return error when agentName matches both a terminal agent and an embedded agent', async () => {
      const sharedName = 'Shared Cross-Registry Name';
      const terminalAgent = await agentManager.registerAgent({
        name: sharedName,
        commandTemplate: 'shared-name-terminal {{prompt}}',
      });
      const embeddedDef: EmbeddedAgentDefinition = {
        id: 'def-shared-name',
        name: sharedName,
        engine: 'openai-api',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
        isBuiltIn: false,
        createdBy: 'user-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      embeddedAgentDefsById.set(embeddedDef.id, embeddedDef);

      await setupDelegateEnvironment('feat/cross-registry-ambiguous');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test cross-registry ambiguous agentName',
        branch: 'feat/cross-registry-ambiguous',
        agentName: sharedName,
        ...(await createValidDelegateParent()),
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain(`Multiple agents match name "${sharedName}"`);
      expect(data.error).toContain('Use agentId to specify');
      // Sanity: both registries' matches are named in the error message.
      expect(data.error).toContain(`(${terminalAgent.id})`);
      expect(data.error).toContain(`(${embeddedDef.id})`);
    });

    // -----------------------------------------------------------------------
    // Message callback prompt (parentSessionId / parentWorkerId)
    // -----------------------------------------------------------------------

    /**
     * Extract the delivered prompt for the PTY spawn call that matches the
     * given session ID. After Issue #851, the prompt was embedded directly
     * into the spawn command via shellEscape (single-quoted literal),
     * instead of being indirected through env.__AGENT_PROMPT__. After Issue
     * #1234, the injected command no longer embeds the prompt at all --
     * `activateAgentWorkerPty` writes it to a file and injects a bounded
     * `claude "$(cat '<path>')"` command instead (avoids truncation when the
     * injected line exceeds the tty's canonical-mode input buffer). This
     * helper extracts the file path from the injected command and looks up
     * the content captured by the `fakeRunAsUserAlwaysSuccess` seam above.
     */
    function getAgentPromptForSession(sessionId: string): string {
      const calls = ptyFactory.spawn.mock.calls as unknown as Array<[string, string[], PtySpawnOptions]>;
      const callIndex = calls.findIndex((call) =>
        call[2]?.env?.AGENT_CONSOLE_SESSION_ID === sessionId,
      );
      expect(callIndex).toBeGreaterThanOrEqual(0);
      const pty = ptyFactory.instances[callIndex];
      expect(pty).toBeDefined();
      const commandWithCR = pty.writtenData.find((d) => d.endsWith('\r'));
      expect(commandWithCR).toBeDefined();
      const command = commandWithCR!.slice(0, -1);
      const fileMatch = command.match(/\$\(cat '((?:[^']|'\\'')*)'\)/);
      if (fileMatch) {
        const filePath = fileMatch[1].replace(/'\\''/g, "'");
        const content = capturedPromptFileWrites.get(filePath);
        expect(content).toBeDefined();
        return content!;
      }
      // Fallback for templates that still embed the prompt inline (no
      // {{prompt}}-bearing promptFilePath write occurred).
      return extractPromptFromSpawnCommand(command);
    }

    it('should append callback instructions to prompt when parent IDs are provided', async () => {
      await setupDelegateEnvironment('feat/callback-test');

      const parent = await createValidDelegateParent();

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Implement callback feature',
        branch: 'feat/callback-test',
        parentSessionId: parent.parentSessionId,
        parentWorkerId: parent.parentWorkerId,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { sessionId: string };
      const agentPrompt = getAgentPromptForSession(data.sessionId);

      // Should contain both the original prompt and callback instructions
      expect(agentPrompt).toContain('Implement callback feature');
      expect(agentPrompt).toContain(`toSessionId: "${parent.parentSessionId}"`);
      expect(agentPrompt).toContain(`toWorkerId: "${parent.parentWorkerId}"`);
      expect(agentPrompt).toContain('[Message Callback Instructions]');

      // Verify structure includes separator and all required fields
      expect(agentPrompt).toContain('\n---\n');
      expect(agentPrompt).toContain('Task completion');
      expect(agentPrompt).toContain('send_session_message');
      expect(agentPrompt).toContain('fromSessionId: Use your AGENT_CONSOLE_SESSION_ID environment variable');
      expect(agentPrompt).toContain('You have a parent session');

      // Verify PR merge notification instructions
      expect(agentPrompt).toContain('PR merged');
      expect(agentPrompt).toContain('[inbound:pr:merged]');

      // Verify consultation instructions
      expect(agentPrompt).toContain('Questions or concerns');
      expect(agentPrompt).toContain('wait for a response');

      // Verify numbered list structure
      expect(agentPrompt).toMatch(/1\.\s+\*\*Task completion\*\*/);
      expect(agentPrompt).toMatch(/2\.\s+\*\*PR merged\*\*/);
      expect(agentPrompt).toMatch(/3\.\s+\*\*Questions or concerns\*\*/);

      // Verify section order: PR merged instructions come before wait-for-response instruction
      const prMergedIndex = agentPrompt.indexOf('[inbound:pr:merged]');
      const waitForResponseIndex = agentPrompt.indexOf('wait for a response');
      expect(prMergedIndex).toBeGreaterThan(-1);
      expect(waitForResponseIndex).toBeGreaterThan(-1);
      expect(prMergedIndex).toBeLessThan(waitForResponseIndex);

      // Verify the old monolithic prompt text is replaced (not present alongside new structure)
      // The old single-paragraph text directed the agent "to the requesting session" — the new
      // three-section structure uses "report your results back." without that suffix.
      expect(agentPrompt).not.toContain('you MUST report your results back to the requesting session');
    });

    it('should NOT append callback instructions when skipMessageCallbackPrompt is true', async () => {
      await setupDelegateEnvironment('feat/skip-callback');

      const parent = await createValidDelegateParent();

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Implement feature without callback',
        branch: 'feat/skip-callback',
        parentSessionId: parent.parentSessionId,
        parentWorkerId: parent.parentWorkerId,
        skipMessageCallbackPrompt: true,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { sessionId: string };
      const agentPrompt = getAgentPromptForSession(data.sessionId);

      expect(agentPrompt).toContain('Implement feature without callback');
      expect(agentPrompt).not.toContain('[Message Callback Instructions]');
      expect(agentPrompt).not.toContain('toSessionId');
      expect(agentPrompt).not.toContain('toWorkerId');
    });

    // -----------------------------------------------------------------------
    // Issue #1293 T1: parentSessionId/parentWorkerId are now schema-required
    // (S1), and the old runtime XOR guard is deleted (S2) -- an invalid
    // combination is unrepresentable at the schema layer instead of being
    // caught by a handler-level check. These three tests replace the old
    // "returns a custom XOR error" / "silently succeeds without parent IDs"
    // tests, whose premises (reaching the handler with a partial or absent
    // pair) are no longer reachable.
    //
    // Polarity note: the two "only one id provided" cases below assert on
    // the SDK's own schema-validation wording ("Invalid arguments for tool
    // delegate_to_worktree" / naming the specific missing field), NOT just
    // `isError: true`. A bare `isError: true` check does not discriminate
    // this fix from the OLD runtime XOR guard, which also produced
    // `isError: true` (with a different, custom message) for exactly this
    // "one id present, one missing" shape -- verified empirically by
    // running these two tests against the pre-fix production code, where
    // a bare `isError` assertion passed for the wrong reason. Only the
    // "both omitted" case was reachable-but-successful pre-fix (the XOR
    // guard is satisfied when both are absent), so it alone needed no
    // wording assertion to fail pre-fix correctly.
    it('should reject the call when only parentSessionId is provided (parentWorkerId missing) -- schema-required (Issue #1293 T1)', async () => {
      await setupDelegateEnvironment('feat/partial-caller');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test partial parent IDs',
        branch: 'feat/partial-caller',
        parentSessionId: 'caller-session-123',
        // parentWorkerId is intentionally omitted -- now a schema violation
      }, nextId++);

      // The SDK's schema-rejection text is a plain string, not the tool's
      // usual `{"error": "..."}` JSON payload -- parseToolResult() would
      // throw JSON.parse on it, so read the raw content text directly.
      expect(response.result?.isError).toBe(true);
      const message = response.result?.content?.[0]?.text ?? '';
      expect(message).toContain('Invalid arguments for tool delegate_to_worktree');
      expect(message).toContain('parentWorkerId');
    });

    it('should reject the call when only parentWorkerId is provided (parentSessionId missing) -- schema-required (Issue #1293 T1)', async () => {
      await setupDelegateEnvironment('feat/partial-worker');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test partial parent IDs',
        branch: 'feat/partial-worker',
        // parentSessionId is intentionally omitted -- now a schema violation
        parentWorkerId: 'caller-worker-456',
      }, nextId++);

      expect(response.result?.isError).toBe(true);
      const message = response.result?.content?.[0]?.text ?? '';
      expect(message).toContain('Invalid arguments for tool delegate_to_worktree');
      expect(message).toContain('parentSessionId');
    });

    it('should reject the call when both parentSessionId and parentWorkerId are omitted -- schema-required (Issue #1293 T1)', async () => {
      await setupDelegateEnvironment('feat/no-caller');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Normal delegation without caller IDs',
        branch: 'feat/no-caller',
        // parentSessionId and parentWorkerId are both intentionally omitted
      }, nextId++);

      if (response.error) {
        expect(response.error).toBeDefined();
      } else {
        expect(response.result?.isError).toBe(true);
      }
    });

    it('should inherit createdBy from parent session', async () => {
      await setupDelegateEnvironment('feat/inherit-created-by');


      // Create a parent session with a known createdBy
      const parentSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: TEST_REPO_PATH,
      }, { createdBy: 'parent-user-abc' });

      // Delegate with parentSessionId referencing the parent
      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test createdBy inheritance',
        branch: 'feat/inherit-created-by',
        parentSessionId: parentSession.id,
        parentWorkerId: firstAgentWorkerId(parentSession),
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { sessionId: string };

      // Verify the child session inherited createdBy from the parent
      const childSession = sessionManager.getSession(data.sessionId);
      expect(childSession).toBeDefined();
      expect(childSession!.createdBy).toBe('parent-user-abc');
    });

    it('errors (S3a) naming the id when parentSessionId does not resolve to any session (Issue #1293 T2)', async () => {
      await setupDelegateEnvironment('feat/stale-parent');

      const createWorktreeSpy = jest.spyOn(worktreeService, 'createWorktree');

      // Before Issue #1293, a stale/fabricated parentSessionId silently
      // degraded to a null-owned, dead-agent session -- the incident this
      // Issue closes. It must now error naming the id, with zero worktree
      // side effect (the check runs before createWorktree is reached).
      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test stale parentSessionId',
        branch: 'feat/stale-parent',
        parentSessionId: 'fabricated-parent-session-id',
        parentWorkerId: 'parent-worker-id',
      }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('fabricated-parent-session-id');
      expect(data.error).toContain('Parent session not found');
      expect(createWorktreeSpy).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // Issue #1293 S3b (Architect ruling, bundled per CodeRabbit finding on
    // PR #1302): parentWorkerId must resolve against the PARENT session's
    // own workers (never a global lookup) and must name a worker capable of
    // receiving send_session_message. Validation is UNCONDITIONAL --
    // skipMessageCallbackPrompt does not exempt it, because the id is
    // stored on the child session and exported as
    // AGENT_CONSOLE_PARENT_WORKER_ID regardless of the prompt append, and
    // an unresolvable id is embedded verbatim into the delegated agent's
    // standing callback instructions (buildMessageCallbackPrompt) when the
    // prompt IS appended.
    // -------------------------------------------------------------------------
    it('errors naming the id when parentWorkerId does not resolve to any worker in the parent session (Issue #1293 T2b)', async () => {
      await setupDelegateEnvironment('feat/stale-worker');

      const parentSession = await sessionManager.createSession(
        { type: 'quick', locationPath: TEST_REPO_PATH },
        { createdBy: 'parent-user-stale-worker' },
      );
      const createWorktreeSpy = jest.spyOn(worktreeService, 'createWorktree');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test stale parentWorkerId',
        branch: 'feat/stale-worker',
        parentSessionId: parentSession.id,
        parentWorkerId: 'fabricated-worker-id-not-in-session',
      }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('fabricated-worker-id-not-in-session');
      expect(data.error).toContain(parentSession.id);
      expect(data.error).toContain('Parent worker not found');
      expect(createWorktreeSpy).not.toHaveBeenCalled();
    });

    it('errors naming the type when parentWorkerId names a worker that cannot receive session messages (Issue #1293 T2b)', async () => {
      await setupDelegateEnvironment('feat/wrong-worker-type');

      const parentSession = await sessionManager.createSession(
        { type: 'quick', locationPath: TEST_REPO_PATH },
        { createdBy: 'parent-user-wrong-worker-type' },
      );
      // Every quick session also gets a git-diff worker, which cannot
      // receive send_session_message (canReceiveSessionMessages is
      // agent/embedded-agent only).
      const gitDiffWorker = parentSession.workers.find((w) => w.type === 'git-diff');
      expect(gitDiffWorker).toBeDefined();
      const createWorktreeSpy = jest.spyOn(worktreeService, 'createWorktree');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test wrong-type parentWorkerId',
        branch: 'feat/wrong-worker-type',
        parentSessionId: parentSession.id,
        parentWorkerId: gitDiffWorker!.id,
      }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain(gitDiffWorker!.id);
      expect(data.error).toContain('cannot receive session messages');
      expect(data.error).toContain('git-diff');
      expect(createWorktreeSpy).not.toHaveBeenCalled();
    });

    it('delegates successfully when parentWorkerId names a real agent worker on the parent session (Issue #1293 T3 extension)', async () => {
      await setupDelegateEnvironment('feat/valid-own-worker');

      // The self-referential case every legitimate caller exercises: a
      // worker passing its OWN session/worker ids (AGENT_CONSOLE_SESSION_ID
      // / AGENT_CONSOLE_WORKER_ID) as the delegate's parent.
      const parent = await createValidDelegateParent();

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test valid own-worker delegation',
        branch: 'feat/valid-own-worker',
        parentSessionId: parent.parentSessionId,
        parentWorkerId: parent.parentWorkerId,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { sessionId: string };
      expect(data.sessionId).toBeDefined();
    });

    // Invariant-preservation, NOT new-mechanism: this does not flip against
    // pre-fix code (pre-fix had no parentWorkerId validation at all, so it
    // passed then and passes now too). `canReceiveSessionMessages` already
    // accepts `embedded-agent` by its own definition (worker.ts:47), so
    // nothing here can fail today. Its job is prospective: it is the test
    // that would fail if `canReceiveSessionMessages` were ever narrowed to
    // agent-only, or if the S3b guard were rewritten to hardcode
    // `type === 'agent'` instead of consuming the shared predicate --
    // either mistake would break embedded-agent delegation silently while
    // every OTHER test in this file (which all use an 'agent'-type parent
    // worker) kept passing.
    it('delegates successfully when parentWorkerId names an embedded-agent worker on the parent session (Issue #1293, canReceiveSessionMessages accept-side coverage)', async () => {
      await setupDelegateEnvironment('feat/embedded-parent-worker');

      const parentSession = await sessionManager.createSession(
        { type: 'quick', locationPath: TEST_REPO_PATH },
        { createdBy: 'parent-user-embedded-parent-worker' },
      );
      const embeddedParentWorker = await sessionManager.createWorker(parentSession.id, {
        type: 'embedded-agent',
        embeddedAgentId: TEST_EMBEDDED_AGENT_DEF.id,
      });
      expect(embeddedParentWorker).not.toBeNull();
      expect(embeddedParentWorker!.type).toBe('embedded-agent');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test embedded-agent parent worker delegation',
        branch: 'feat/embedded-parent-worker',
        parentSessionId: parentSession.id,
        parentWorkerId: embeddedParentWorker!.id,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { sessionId: string };
      expect(data.sessionId).toBeDefined();
    });

    // -------------------------------------------------------------------------
    // Issue #844: OS username plumbing through delegate_to_worktree
    // -------------------------------------------------------------------------
    //
    // delegate_to_worktree must resolve the parent session's createdBy (a
    // users.id UUID) to its OS `username` via `userRepository.findById` and
    // pass that username down to `worktreeService.createWorktree` as the
    // `requestUsername` parameter. `runAsUser` then either elevates (multi-user
    // mode) or bypasses elevation (AUTH_MODE=none / null username).
    //
    // The tests below spy on `worktreeService.createWorktree` to capture the
    // exact `requestUsername` argument the MCP path passes through, covering:
    //   1. Resolved username path (parent user exists in userRepository)
    //   2. Parent exists but createdBy is null/undefined -> S3(b) error (Issue #1293)
    //   3. Parent createdBy is a UUID that does not resolve -> null
    //
    // A fourth case existed here previously ("no parentSessionId -> null");
    // it is now unreachable (parentSessionId is schema-required, Issue #1293
    // S1) and is covered instead by the "Issue #1293 T1" schema-rejection
    // tests above.
    describe('Issue #844: OS username plumbing', () => {
      /**
       * Spy on `worktreeService.createWorktree` and return the spy so tests
       * can read the captured arguments. The wrapped implementation delegates
       * to the real method so the rest of the orchestration still runs.
       */
      function spyCreateWorktree(): ReturnType<typeof jest.spyOn> {
        return jest.spyOn(worktreeService, 'createWorktree');
      }

      it('plumbs resolved OS username when parent createdBy resolves to a registered user', async () => {
        await setupDelegateEnvironment('feat/username-resolved');

        // Seed userRepository with an OS user; upsertByOsUid returns the
        // assigned UUID which we then thread through as the parent session's
        // createdBy. This mirrors the production wiring where authentication
        // assigns the same UUID and stores it on `sessions.created_by`.
        const aliceOsUid = 9001;
        const alice = await userRepository.upsertByOsUid(aliceOsUid, 'alice', '/home/alice');

        const parentSession = await sessionManager.createSession({
          type: 'quick',
          locationPath: TEST_REPO_PATH,
        }, { createdBy: alice.id });

        const createWorktreeSpy = spyCreateWorktree();

        const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
          repositoryId: 'test-repo',
          prompt: 'Test username plumbing',
          branch: 'feat/username-resolved',
          parentSessionId: parentSession.id,
          parentWorkerId: firstAgentWorkerId(parentSession),
        }, nextId++);

        expect(response.result?.isError).toBeUndefined();

        // createWorktree(repoPath, branch, repositoryId, baseBranch?, requestUsername?)
        expect(createWorktreeSpy).toHaveBeenCalledTimes(1);
        const callArgs = createWorktreeSpy.mock.calls[0] as unknown[];
        expect(callArgs[4]).toBe('alice');
      });

      it('errors (S3b) instead of resolving requestUsername when parent session has no createdBy (legacy)', async () => {
        await setupDelegateEnvironment('feat/legacy-parent');

        // Create a parent session WITHOUT createdBy - legacy / pre-multi-user
        // sessions saved before `sessions.created_by` was populated. Before
        // Issue #1293, this silently produced a null requestUsername and a
        // dead, ownerless delegated session (the incident this Issue
        // closes); now it must error before ever reaching createWorktree.
        const parentSession = await sessionManager.createSession({
          type: 'quick',
          locationPath: TEST_REPO_PATH,
        });

        const createWorktreeSpy = spyCreateWorktree();

        const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
          repositoryId: 'test-repo',
          prompt: 'Delegation from a legacy parent',
          branch: 'feat/legacy-parent',
          parentSessionId: parentSession.id,
          parentWorkerId: 'parent-worker-id',
        }, nextId++);

        expect(response.result?.isError).toBe(true);
        const data = parseToolResult(response) as { error: string };
        expect(data.error).toContain(parentSession.id);
        expect(data.error).toContain('no createdBy');

        expect(createWorktreeSpy).not.toHaveBeenCalled();
      });

      it('passes null requestUsername when parent createdBy UUID does not resolve to a user', async () => {
        await setupDelegateEnvironment('feat/orphan-uuid');

        // Parent has a createdBy that does not correspond to any
        // userRepository entry. This is the orphan case — the foreign-key-
        // less DB layout permits a session whose createdBy was deleted from
        // (or never inserted into) the users table.
        const parentSession = await sessionManager.createSession({
          type: 'quick',
          locationPath: TEST_REPO_PATH,
        }, { createdBy: 'orphan-uuid-not-in-users-table' });

        const createWorktreeSpy = spyCreateWorktree();

        const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
          repositoryId: 'test-repo',
          prompt: 'Delegation from an orphan parent',
          branch: 'feat/orphan-uuid',
          parentSessionId: parentSession.id,
          parentWorkerId: firstAgentWorkerId(parentSession),
        }, nextId++);

        expect(response.result?.isError).toBeUndefined();

        expect(createWorktreeSpy).toHaveBeenCalledTimes(1);
        const callArgs = createWorktreeSpy.mock.calls[0] as unknown[];
        expect(callArgs[4]).toBeNull();
      });
    });

    // -------------------------------------------------------------------------
    // Issue #918: SSH_AUTH_SOCK fallback for delegated sessions
    // -------------------------------------------------------------------------
    //
    // When `delegate_to_worktree` resolves a parent's `createdBy` to a real
    // user with a non-empty `homeDir`, the handler must populate
    // `SessionCreationContext.sshAuthSockFallback` with the Linux 1Password
    // socket convention path `${homeDir}/.1password/agent.sock`. The value
    // then propagates through `createWorktreeWithSession` ->
    // `sessionManager.createSession` -> internal session -> PTY spawn.
    //
    // The tests below spy on `sessionManager.createSession` to capture the
    // `context` argument and assert the `sshAuthSockFallback` field.
    describe('Issue #918: sshAuthSockFallback propagation', () => {
      function spyCreateSession(): ReturnType<typeof jest.spyOn> {
        return jest.spyOn(sessionManager, 'createSession');
      }

      it('populates sshAuthSockFallback from parent user homeDir when createdBy resolves', async () => {
        await setupDelegateEnvironment('feat/ssh-fallback');

        const aliceOsUid = 9201;
        const alice = await userRepository.upsertByOsUid(aliceOsUid, 'alice918', '/home/alice918');

        const parentSession = await sessionManager.createSession({
          type: 'quick',
          locationPath: TEST_REPO_PATH,
        }, { createdBy: alice.id });

        const spy = spyCreateSession();

        const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
          repositoryId: 'test-repo',
          prompt: 'Test SSH_AUTH_SOCK fallback propagation',
          branch: 'feat/ssh-fallback',
          parentSessionId: parentSession.id,
          parentWorkerId: firstAgentWorkerId(parentSession),
        }, nextId++);

        expect(response.result?.isError).toBeUndefined();

        // The delegated session creation is the last call; the parent was
        // created BEFORE the spy was installed.
        const delegateCall = spy.mock.calls[spy.mock.calls.length - 1] as unknown[];
        const context = delegateCall[1] as { sshAuthSockFallback?: string } | undefined;
        expect(context?.sshAuthSockFallback).toBe('/home/alice918/.1password/agent.sock');
      });

      it('errors (S3b) instead of creating a session when parent has no createdBy (legacy session)', async () => {
        await setupDelegateEnvironment('feat/ssh-legacy');

        // Legacy parent: no createdBy. Before Issue #1293 this proceeded
        // with sshAuthSockFallback left undefined; now S3(b) rejects the
        // call before createSession is ever reached.
        const parentSession = await sessionManager.createSession({
          type: 'quick',
          locationPath: TEST_REPO_PATH,
        });

        const spy = spyCreateSession();

        const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
          repositoryId: 'test-repo',
          prompt: 'Delegation from a legacy parent',
          branch: 'feat/ssh-legacy',
          parentSessionId: parentSession.id,
          parentWorkerId: 'parent-worker-id',
        }, nextId++);

        expect(response.result?.isError).toBe(true);
        expect(spy).not.toHaveBeenCalled();
      });

      it('does NOT populate sshAuthSockFallback when parent createdBy UUID does not resolve', async () => {
        await setupDelegateEnvironment('feat/ssh-orphan');

        const parentSession = await sessionManager.createSession({
          type: 'quick',
          locationPath: TEST_REPO_PATH,
        }, { createdBy: 'orphan-uuid-not-in-users-table' });

        const spy = spyCreateSession();

        const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
          repositoryId: 'test-repo',
          prompt: 'Delegation from orphan parent',
          branch: 'feat/ssh-orphan',
          parentSessionId: parentSession.id,
          parentWorkerId: firstAgentWorkerId(parentSession),
        }, nextId++);

        expect(response.result?.isError).toBeUndefined();

        expect(spy).toHaveBeenCalled();
        const lastCall = spy.mock.calls[spy.mock.calls.length - 1] as unknown[];
        const context = lastCall[1] as { sshAuthSockFallback?: string } | undefined;
        expect(context?.sshAuthSockFallback).toBeUndefined();
      });
    });

    // -------------------------------------------------------------------------
    // Issue #876: suggestSessionMetadata receives resolved OS username
    // -------------------------------------------------------------------------
    //
    // Sibling of Issue #844: the same parent-createdBy -> OS-username
    // resolution must also be threaded into `suggestSessionMetadata` so the
    // headless `claude -p ...` invocation it performs runs as the requesting
    // user in multi-user mode (otherwise it runs as the server process user,
    // which has no per-user Claude auth, and silently falls back to
    // `task-<timestamp>` branch names). The tests below assert the argument
    // shape `suggestSessionMetadata` is called with, covering:
    //   1. Resolved username -> passed through; LLM-suggested branch is used.
    //   2. Orphan parent createdBy -> requestUser is null; suggestion failure
    //      falls back to `task-<timestamp>`.
    //
    // A third case existed here previously ("no parentSessionId -> requestUser
    // is null"); it is now unreachable (parentSessionId is schema-required,
    // Issue #1293 S1) and is covered instead by the "Issue #1293 T1"
    // schema-rejection tests in the delegate_to_worktree block above.
    describe('Issue #876: suggestSessionMetadata receives resolved OS username', () => {
      // Read the captured `requestUser` argument from the first
      // suggestion call (typed via the top-of-file mock parameter).
      function readSuggestRequestUser(): string | null {
        const calls = mockSuggestSessionMetadata.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        return calls[0][0].requestUser;
      }

      it('passes resolved OS username to suggestSessionMetadata when parent createdBy resolves to a registered user', async () => {
        // Seed userRepository with an OS user; upsertByOsUid assigns a UUID
        // that we thread through as the parent session's createdBy. Use a
        // distinct uid/username from the #844 block to avoid any cross-test
        // collisions on the in-memory database.
        const aliceOsUid = 9101;
        const alice = await userRepository.upsertByOsUid(aliceOsUid, 'alice876', '/home/alice876');

        const parentSession = await sessionManager.createSession({
          type: 'quick',
          locationPath: TEST_REPO_PATH,
        }, { createdBy: alice.id });

        mockSuggestSessionMetadata.mockImplementationOnce(async () => ({
          branch: 'fix/diff-worker-elevation',
          title: 'Diff worker elevation',
        }));

        await setupDelegateEnvironment('fix/diff-worker-elevation');

        const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
          repositoryId: 'test-repo',
          prompt: 'Fix diff worker elevation',
          // branch intentionally omitted -> exercises the suggestion path
          parentSessionId: parentSession.id,
          parentWorkerId: firstAgentWorkerId(parentSession),
        }, nextId++);

        expect(response.result?.isError).toBeUndefined();

        // The suggestion call must have received the resolved username, not null.
        expect(readSuggestRequestUser()).toBe('alice876');

        const data = parseToolResult(response) as { branch: string };
        expect(data.branch).toBe('fix/diff-worker-elevation');
      });

      it('passes null requestUser to suggestSessionMetadata when parent createdBy UUID does not resolve to a user', async () => {
        // Parent has a createdBy that does not correspond to any
        // userRepository entry (orphan UUID, mirrors the #844 orphan case).
        const parentSession = await sessionManager.createSession({
          type: 'quick',
          locationPath: TEST_REPO_PATH,
        }, { createdBy: 'orphan-uuid-not-in-users-table' });

        // Empty `branch` triggers the production fallback path
        // (`suggestion.error || !suggestion.branch`).
        mockSuggestSessionMetadata.mockImplementationOnce(async () => ({
          branch: '',
          title: '',
        }));

        // Freeze `Date.now` so the `task-<timestamp>` fallback name is
        // deterministic and the listWorktrees mock can match it.
        const originalDateNow = Date.now;
        Date.now = () => 876000;
        await setupDelegateEnvironment('task-876000');

        try {
          const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
            repositoryId: 'test-repo',
            prompt: 'Delegation from an orphan parent',
            // branch intentionally omitted -> exercises the suggestion path
            parentSessionId: parentSession.id,
            parentWorkerId: firstAgentWorkerId(parentSession),
          }, nextId++);

          expect(response.result?.isError).toBeUndefined();
          const data = parseToolResult(response) as { branch: string };
          expect(data.branch).toBe('task-876000');
          // The suggestion call must have received null, not a forged username.
          expect(readSuggestRequestUser()).toBeNull();
        } finally {
          Date.now = originalDateNow;
        }
      });
    });

    it('should accept optional templateVars parameter and create session successfully', async () => {
      await setupDelegateEnvironment('feat/template-vars');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test with template variables',
        branch: 'feat/template-vars',
        templateVars: { model: 'gpt-4' },
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as {
        sessionId: string;
        workerId: string;
        worktreePath: string;
        branch: string;
      };

      // Verify result contains all expected fields
      expect(data.sessionId).toBeDefined();
      expect(data.sessionId.length).toBeGreaterThan(0);
      expect(data.workerId).toBeDefined();
      expect(data.worktreePath).toBeDefined();
      expect(data.branch).toBe('feat/template-vars');

      // Verify the session exists via list_sessions
      const listResponse = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const listData = parseToolResult(listResponse) as {
        sessions: Array<{
          id: string;
          type: string;
        }>;
      };

      const delegatedSession = listData.sessions.find((s) => s.id === data.sessionId);
      expect(delegatedSession).toBeDefined();
    });

    it("should describe the templateVars parameter's optional-argument form ({{model:+--model}}) in the tool schema (Issue #1281)", async () => {
      const listRes = await app.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Mcp-Session-Id': mcpSessionId,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: nextId++ }),
      });
      expect(listRes.status).toBe(200);

      const listBody = (await listRes.json()) as {
        result?: {
          tools?: Array<{
            name: string;
            inputSchema?: { properties?: Record<string, { description?: string }> };
          }>;
        };
      };
      const delegateTool = listBody.result?.tools?.find((t) => t.name === 'delegate_to_worktree');
      const templateVarsDescription = delegateTool?.inputSchema?.properties?.templateVars?.description;

      expect(templateVarsDescription).toContain('{{model:+--model}}');
      expect(templateVarsDescription).toContain('--model');
    });
  });

  // ===========================================================================
  // Parent session metadata persistence through MCP
  // ===========================================================================

  describe('parent session metadata persistence', () => {
    /**
     * Reuse the delegate environment setup from the delegate_to_worktree block.
     */
    async function setupParentMetadataEnvironment(
      worktreeBranch: string = 'feat/parent-meta-test',
    ): Promise<void> {
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');
      mockGit.getDefaultBranch.mockImplementation(async () => 'main');

      let capturedWorktreePath = '';
      mockGit.createWorktree.mockImplementation(async (...args: unknown[]) => {
        capturedWorktreePath = args[0] as string;
      });

      mockGit.listWorktrees.mockImplementation(async () => {
        if (capturedWorktreePath) {
          return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${capturedWorktreePath}\nHEAD def456\nbranch refs/heads/${worktreeBranch}\n`;
        }
        return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n`;
      });

      const db = getDatabase();
      const sqliteRepoRepo = new SqliteRepositoryRepository(db);
      await sqliteRepoRepo.save({
        id: 'test-repo',
        name: 'test',
        path: TEST_REPO_PATH,
        createdAt: new Date().toISOString(),
        clonedSourceRepoPath: null,
      });
      repositoryManager = await RepositoryManager.create({
        jobQueue: testJobQueue,
        repository: sqliteRepoRepo,
      });
      await remountMcpApp();
    }

    it('should persist parentSessionId and parentWorkerId when delegate_to_worktree is called with them', async () => {
      await setupParentMetadataEnvironment('feat/persist-parent');

      const parent = await createValidDelegateParent();

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test parent metadata persistence',
        branch: 'feat/persist-parent',
        parentSessionId: parent.parentSessionId,
        parentWorkerId: parent.parentWorkerId,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { sessionId: string };

      // Verify via get_session_status that parentSessionId/parentWorkerId are returned
      const statusResponse = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: data.sessionId,
      }, nextId++);
      const statusData = parseToolResult(statusResponse) as {
        parentSessionId?: string;
        parentWorkerId?: string;
      };

      expect(statusData.parentSessionId).toBe(parent.parentSessionId);
      expect(statusData.parentWorkerId).toBe(parent.parentWorkerId);
    });

    it('should return parentSessionId and parentWorkerId in list_sessions response', async () => {
      await setupParentMetadataEnvironment('feat/list-parent');

      const parent = await createValidDelegateParent();

      const delegateResponse = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test parent metadata in list_sessions',
        branch: 'feat/list-parent',
        parentSessionId: parent.parentSessionId,
        parentWorkerId: parent.parentWorkerId,
      }, nextId++);

      expect(delegateResponse.result?.isError).toBeUndefined();

      const delegateData = parseToolResult(delegateResponse) as { sessionId: string };

      // Verify via list_sessions that parentSessionId/parentWorkerId appear
      const listResponse = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const listData = parseToolResult(listResponse) as {
        sessions: Array<{
          id: string;
          parentSessionId?: string;
          parentWorkerId?: string;
        }>;
      };

      const delegatedSession = listData.sessions.find((s) => s.id === delegateData.sessionId);
      expect(delegatedSession).toBeDefined();
      expect(delegatedSession!.parentSessionId).toBe(parent.parentSessionId);
      expect(delegatedSession!.parentWorkerId).toBe(parent.parentWorkerId);
    });

    // Issue #1293: a "not provided" variant existed here previously; it is
    // now unreachable (parentSessionId/parentWorkerId are schema-required)
    // and is covered instead by the "Issue #1293 T1" schema-rejection tests
    // in the delegate_to_worktree block above.
  });

  // ===========================================================================
  // E2E env var injection via delegate_to_worktree
  // ===========================================================================

  describe('delegate_to_worktree env var injection', () => {
    /**
     * Helper to set up the delegate environment for env var tests.
     * Same pattern as the delegate_to_worktree describe block above.
     */
    async function setupDelegateEnvironmentForEnv(): Promise<void> {
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');
      mockGit.getDefaultBranch.mockImplementation(async () => 'main');

      let capturedWorktreePath = '';
      mockGit.createWorktree.mockImplementation(async (...args: unknown[]) => {
        capturedWorktreePath = args[0] as string;
      });

      mockGit.listWorktrees.mockImplementation(async () => {
        if (capturedWorktreePath) {
          return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${capturedWorktreePath}\nHEAD def456\nbranch refs/heads/feat/env-test\n`;
        }
        return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n`;
      });

      const db = getDatabase();
      const sqliteRepoRepo = new SqliteRepositoryRepository(db);
      await sqliteRepoRepo.save({
        id: 'test-repo',
        name: 'test',
        path: TEST_REPO_PATH,
        createdAt: new Date().toISOString(),
        clonedSourceRepoPath: null,
      });
      repositoryManager = await RepositoryManager.create({
        jobQueue: testJobQueue,
        repository: sqliteRepoRepo,
      });
      await remountMcpApp();
    }

    it('should spawn agent worker PTY with AGENT_CONSOLE env vars', async () => {
      await setupDelegateEnvironmentForEnv();


      // Record how many PTY instances existed before this call
      const ptyCountBefore = ptyFactory.instances.length;

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test env var injection',
        branch: 'feat/env-test',
        ...(await createValidDelegateParent()),
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as {
        sessionId: string;
        workerId: string;
      };

      // The delegate_to_worktree creates a session which spawns an agent worker PTY.
      // createSession also creates a git-diff worker, but that doesn't spawn a PTY.
      // So we should have at least one new PTY instance.
      expect(ptyFactory.instances.length).toBeGreaterThan(ptyCountBefore);

      // Find the PTY spawn call for the agent worker (the last one created by delegate)
      // The spawn calls include the env in the options parameter
      const calls = ptyFactory.spawn.mock.calls as unknown as Array<[string, string[], PtySpawnOptions]>;

      // Find the spawn call that includes AGENT_CONSOLE_SESSION_ID matching our session
      const matchingCall = calls.find((call) =>
        call[2]?.env?.AGENT_CONSOLE_SESSION_ID === data.sessionId,
      );
      expect(matchingCall).toBeDefined();

      const env = matchingCall![2].env!;
      expect(env.AGENT_CONSOLE_REPOSITORY_ID).toBe('test-repo');
      expect(env.AGENT_CONSOLE_BASE_URL).toMatch(/^http:\/\/localhost:\d+$/);
      expect(env.AGENT_CONSOLE_SESSION_ID).toBe(data.sessionId);
      expect(env.AGENT_CONSOLE_WORKER_ID).toBe(data.workerId);
    });
  });

  // ===========================================================================
  // close_session
  // ===========================================================================

  describe('close_session', () => {
    it('should close an existing session', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'close_session', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as { sessionId: string; deleted: boolean };

      expect(response.result?.isError).toBeUndefined();
      expect(data.sessionId).toBe(session.id);
      expect(data.deleted).toBe(true);

      // Verify session is actually gone
      expect(sessionManager.getSession(session.id)).toBeUndefined();
    });

    it('should return error for non-existent session', async () => {
      const response = await callTool(app, mcpSessionId, 'close_session', {
        sessionId: 'non-existent',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Session not found');
    });
  });

  // ===========================================================================
  // remove_worktree
  // ===========================================================================

  describe('remove_worktree', () => {
    // Paths under the repositories dir (TEST_CONFIG_DIR/repositories/) so
    // validateWorktreePath's boundary check passes.
    const REPOS_DIR = `${TEST_CONFIG_DIR}/repositories`;
    const WT_REPO_PATH = `${REPOS_DIR}/test-repo`;
    const WT_WORKTREE_PATH = `${REPOS_DIR}/test-repo/worktrees/wt-1`;

    /**
     * Helper to set up a RepositoryManager with a test repository,
     * insert worktree records for path validation, and re-mount the MCP app.
     */
    async function setupForDeletion(opts: {
      repoId?: string;
      repoPath?: string;
      worktreePaths?: string[];
    } = {}): Promise<void> {
      const repoId = opts.repoId ?? 'test-repo';
      const repoPath = opts.repoPath ?? WT_REPO_PATH;
      const worktreePaths = opts.worktreePaths ?? [WT_WORKTREE_PATH];

      // Worktree paths get a `.keep` marker so the directory exists on
      // memfs — `WorktreeService.removeWorktree` stats the worktree path
      // and would otherwise route to the orphan-recovery branch, bypassing
      // the mocked `git worktree remove`.
      const fsEntries: Record<string, string> = {
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${repoPath}/.git/HEAD`]: 'ref: refs/heads/main',
      };
      for (const wtPath of worktreePaths) {
        fsEntries[`${wtPath}/.keep`] = '';
      }
      setupMemfs(fsEntries);
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      const db = getDatabase();

      // Register repository. Name uses slug-safe characters only (no spaces)
      // because SessionManager uses the name as the data-scope slug.
      const sqliteRepoRepo = new SqliteRepositoryRepository(db);
      await sqliteRepoRepo.save({
        id: repoId,
        name: 'test-repo',
        path: repoPath,
        createdAt: new Date().toISOString(),
        clonedSourceRepoPath: null,
      });
      repositoryManager = await RepositoryManager.create({
        jobQueue: testJobQueue,
        repository: sqliteRepoRepo,
      });

      // Insert worktree records so isWorktreeOf returns true
      const worktreeRepo = new SqliteWorktreeRepository(db);
      for (let i = 0; i < worktreePaths.length; i++) {
        await worktreeRepo.save({
          id: `wt-${i}`,
          repositoryId: repoId,
          path: worktreePaths[i],
          indexNumber: i + 1,
          createdAt: new Date().toISOString(),
        });
      }

      // No callback wiring needed — SessionManager was constructed with
      // repositoryLookup/repositoryEnvLookup that route through
      // repositoryManager for slug/name/path.
      await remountMcpApp();
    }

    it('should return error for non-existent session', async () => {
      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: 'non-existent',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Session not found');
    });

    it('should return error for non-worktree session', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('not a worktree session');
    });

    it('should return error when repository is not found', async () => {
      // After Stage 2 of session-data-path refactor, worktree session creation
      // fails fast with RepositoryNotFoundError if the repository is unknown.
      // See docs/design/session-data-path.md §6.
      await expect(
        sessionManager.createSession({
          type: 'worktree',
          locationPath: WT_WORKTREE_PATH,
          repositoryId: 'non-existent-repo',
          worktreeId: 'feature-branch',
          agentId: 'claude-code',
        }),
      ).rejects.toThrow('Repository not found');
    });

    it('should return error for main worktree session', async () => {
      await setupForDeletion();

      // locationPath === repo.path makes isMainWorktree true
      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: WT_REPO_PATH,
        repositoryId: 'test-repo',
        worktreeId: 'main',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Cannot remove the main worktree');
    });

    it('should return error when deletion is already in progress', async () => {
      await setupForDeletion();

      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: WT_WORKTREE_PATH,
        repositoryId: 'test-repo',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      _getDeletionsInProgress().add(WT_WORKTREE_PATH);

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('already in progress');

      _getDeletionsInProgress().delete(WT_WORKTREE_PATH);
    });

    it('should successfully remove worktree and delete session', async () => {
      await setupForDeletion();

      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: WT_WORKTREE_PATH,
        repositoryId: 'test-repo',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      mockGit.removeWorktree.mockImplementation(async () => {});

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as {
        sessionId: string;
        worktreePath: string;
        removed: boolean;
      };

      expect(response.result?.isError).toBeUndefined();
      expect(data.sessionId).toBe(session.id);
      expect(data.worktreePath).toBe(WT_WORKTREE_PATH);
      expect(data.removed).toBe(true);

      // Session should be deleted by deleteWorktree
      expect(sessionManager.getSession(session.id)).toBeUndefined();
    });

    it('should preserve session when worktree removal fails', async () => {
      await setupForDeletion();

      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: WT_WORKTREE_PATH,
        repositoryId: 'test-repo',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      mockGit.removeWorktree.mockImplementation(async () => {
        throw new Error('Worktree has uncommitted changes');
      });

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
      }, nextId++);

      expect(response.result?.isError).toBe(true);

      // Session should be preserved for retry
      expect(sessionManager.getSession(session.id)).toBeDefined();
    });

    it('should block deletion when branch has an open PR', async () => {
      await setupForDeletion();

      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: WT_WORKTREE_PATH,
        repositoryId: 'test-repo',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      mockFindOpenPullRequest.mockImplementation(async () => ({
        number: 123,
        title: 'Add new feature',
      }));

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('WARNING: Cannot remove worktree.');
      expect(data.error).toContain('open PR #123');
      expect(data.error).toContain('Merge or close the PR first, then retry.');

      // Session should be preserved
      expect(sessionManager.getSession(session.id)).toBeDefined();
    });

    it('should allow deletion with force=true even when branch has an open PR', async () => {
      await setupForDeletion();

      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: WT_WORKTREE_PATH,
        repositoryId: 'test-repo',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      mockFindOpenPullRequest.mockImplementation(async () => ({
        number: 456,
        title: 'Important PR',
      }));

      mockGit.removeWorktree.mockImplementation(async () => {});

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
        force: true,
      }, nextId++);
      const data = parseToolResult(response) as {
        sessionId: string;
        removed: boolean;
      };

      expect(response.result?.isError).toBeUndefined();
      expect(data.removed).toBe(true);
      expect(mockFindOpenPullRequest).not.toHaveBeenCalled();
    });

    it('should block deletion when PR check fails (fail-closed)', async () => {
      await setupForDeletion();

      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: WT_WORKTREE_PATH,
        repositoryId: 'test-repo',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      mockFindOpenPullRequest.mockImplementation(async () => {
        throw new Error('gh: command not found');
      });

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Failed to check for open PRs');

      // Session should be preserved
      expect(sessionManager.getSession(session.id)).toBeDefined();
    });

    // -----------------------------------------------------------------------
    // Issue #885: authentication / elevation for gh CLI
    // -----------------------------------------------------------------------
    //
    // remove_worktree must resolve the session's `createdBy` (a users.id
    // UUID) to its OS `username` via `userRepository.findById` and pass
    // that through to `deleteWorktree` as `requestUsername`, which then
    // forwards it to the injected `findOpenPullRequest` (the gh CLI
    // open-PR check). Mirrors the resolution pattern already covered for
    // `run_process` (Issue #879) and `delegate_to_worktree` (Issue #844).
    // The MCP caller-auth binding (whether the MCP caller owns
    // `sessionId`) is deferred to #878.
    describe('authentication / elevation (Issue #885)', () => {
      it('plumbs resolved OS username when session createdBy resolves to a registered user', async () => {
        await setupForDeletion();
        const alice = await userRepository.upsertByOsUid(9201, 'alice', '/home/alice');
        const session = await sessionManager.createSession(
          {
            type: 'worktree',
            locationPath: WT_WORKTREE_PATH,
            repositoryId: 'test-repo',
            worktreeId: 'feature-branch',
            agentId: 'claude-code',
          },
          { createdBy: alice.id },
        );

        mockGit.removeWorktree.mockImplementation(async () => {});

        const response = await callTool(app, mcpSessionId, 'remove_worktree', {
          sessionId: session.id,
        }, nextId++);

        expect(response.result?.isError).toBeUndefined();
        // findOpenPullRequest is the gh-CLI call that receives the
        // resolved username via deleteWorktree's requestUsername plumbing.
        expect(mockFindOpenPullRequest).toHaveBeenCalledTimes(1);
        const [, , requestUsername] = mockFindOpenPullRequest.mock.calls[0];
        expect(requestUsername).toBe('alice');
      });

      it('passes null requestUsername when session has no createdBy (legacy)', async () => {
        await setupForDeletion();
        // createSession without context omits createdBy entirely.
        const session = await sessionManager.createSession({
          type: 'worktree',
          locationPath: WT_WORKTREE_PATH,
          repositoryId: 'test-repo',
          worktreeId: 'feature-branch',
          agentId: 'claude-code',
        });

        mockGit.removeWorktree.mockImplementation(async () => {});

        const response = await callTool(app, mcpSessionId, 'remove_worktree', {
          sessionId: session.id,
        }, nextId++);

        expect(response.result?.isError).toBeUndefined();
        expect(mockFindOpenPullRequest).toHaveBeenCalledTimes(1);
        const [, , requestUsername] = mockFindOpenPullRequest.mock.calls[0];
        expect(requestUsername).toBeNull();
      });

      it('passes null requestUsername when session createdBy UUID does not resolve to a user', async () => {
        await setupForDeletion();
        const session = await sessionManager.createSession(
          {
            type: 'worktree',
            locationPath: WT_WORKTREE_PATH,
            repositoryId: 'test-repo',
            worktreeId: 'feature-branch',
            agentId: 'claude-code',
          },
          { createdBy: 'orphan-uuid-not-in-users-table' },
        );

        mockGit.removeWorktree.mockImplementation(async () => {});

        const response = await callTool(app, mcpSessionId, 'remove_worktree', {
          sessionId: session.id,
        }, nextId++);

        expect(response.result?.isError).toBeUndefined();
        expect(mockFindOpenPullRequest).toHaveBeenCalledTimes(1);
        const [, , requestUsername] = mockFindOpenPullRequest.mock.calls[0];
        expect(requestUsername).toBeNull();
      });
    });
  });

  // ===========================================================================
  // Timer tools (create_timer, list_timers, delete_timer)
  // ===========================================================================

  describe('timer tools', () => {
    // Helper: create a session with an agent worker and return both IDs
    async function createSessionWithWorker(): Promise<{ sessionId: string; workerId: string }> {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;
      return { sessionId: session.id, workerId };
    }

    describe('create_timer', () => {
      it('should create a timer and return timer details', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        const response = await callTool(app, mcpSessionId, 'create_timer', {
          sessionId,
          workerId,
          intervalSeconds: 60,
          action: 'Check CI status',
        }, nextId++);

        const data = parseToolResult(response) as {
          timerId: string;
          sessionId: string;
          workerId: string;
          intervalSeconds: number;
          action: string;
        };

        expect(response.result?.isError).toBeUndefined();
        expect(data.timerId).toBeDefined();
        expect(typeof data.timerId).toBe('string');
        expect(data.sessionId).toBe(sessionId);
        expect(data.workerId).toBe(workerId);
        expect(data.intervalSeconds).toBe(60);
        expect(data.action).toBe('Check CI status');
      });

      it('should return error for non-existent session', async () => {
        const response = await callTool(app, mcpSessionId, 'create_timer', {
          sessionId: 'non-existent-session',
          workerId: 'some-worker',
          intervalSeconds: 60,
          action: 'Check CI status',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('Session non-existent-session not found');
      });

      it('should return error for non-existent worker', async () => {
        const { sessionId } = await createSessionWithWorker();

        const response = await callTool(app, mcpSessionId, 'create_timer', {
          sessionId,
          workerId: 'non-existent-worker',
          intervalSeconds: 60,
          action: 'Check CI status',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('Worker non-existent-worker not found');
      });

      it('should return error when interval is below minimum', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        const response = await callTool(app, mcpSessionId, 'create_timer', {
          sessionId,
          workerId,
          intervalSeconds: 5,
          action: 'Too frequent',
        }, nextId++);

        // The zod schema enforces min(10), so this may be caught at validation level
        // or by the TimerManager. Either way it should be an error.
        if (response.error) {
          expect(response.error).toBeDefined();
        } else {
          expect(response.result?.isError).toBe(true);
        }
      });

      it('should return error when workerId targets a git-diff worker', async () => {
        const session = await sessionManager.createSession({
          type: 'quick',
          locationPath: '/test/path',
          agentId: 'claude-code',
        });

        // Find the git-diff worker created by default (not PTY-backed)
        const gitDiffWorker = session.workers.find((w) => w.type === 'git-diff');
        expect(gitDiffWorker).toBeDefined();

        const response = await callTool(app, mcpSessionId, 'create_timer', {
          sessionId: session.id,
          workerId: gitDiffWorker!.id,
          intervalSeconds: 60,
          action: 'Check CI status',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('does not support PTY notifications');
        expect(data.error).toContain('requires a PTY-backed worker (agent/terminal)');
      });
    });

    describe('list_timers', () => {
      it('should return empty array when no timers exist', async () => {
        const response = await callTool(app, mcpSessionId, 'list_timers', {}, nextId++);
        const data = parseToolResult(response) as { timers: unknown[] };

        expect(response.result?.isError).toBeUndefined();
        expect(data.timers).toEqual([]);
      });

      it('should list created timers', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        // Create two timers
        await callTool(app, mcpSessionId, 'create_timer', {
          sessionId, workerId, intervalSeconds: 60, action: 'Action A',
        }, nextId++);
        await callTool(app, mcpSessionId, 'create_timer', {
          sessionId, workerId, intervalSeconds: 120, action: 'Action B',
        }, nextId++);

        const response = await callTool(app, mcpSessionId, 'list_timers', {}, nextId++);
        const data = parseToolResult(response) as {
          timers: Array<{ sessionId: string; action: string }>;
        };

        expect(response.result?.isError).toBeUndefined();
        expect(data.timers).toHaveLength(2);
      });

      it('should filter timers by sessionId', async () => {
        const s1 = await createSessionWithWorker();
        const s2 = await createSessionWithWorker();

        await callTool(app, mcpSessionId, 'create_timer', {
          sessionId: s1.sessionId, workerId: s1.workerId, intervalSeconds: 60, action: 'Session 1 timer',
        }, nextId++);
        await callTool(app, mcpSessionId, 'create_timer', {
          sessionId: s2.sessionId, workerId: s2.workerId, intervalSeconds: 60, action: 'Session 2 timer',
        }, nextId++);

        // Filter by session 1
        const response = await callTool(app, mcpSessionId, 'list_timers', {
          sessionId: s1.sessionId,
        }, nextId++);
        const data = parseToolResult(response) as {
          timers: Array<{ sessionId: string; action: string }>;
        };

        expect(response.result?.isError).toBeUndefined();
        expect(data.timers).toHaveLength(1);
        expect(data.timers[0].sessionId).toBe(s1.sessionId);
        expect(data.timers[0].action).toBe('Session 1 timer');
      });
    });

    describe('delete_timer', () => {
      it('should delete an existing timer', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        // Create a timer
        const createResponse = await callTool(app, mcpSessionId, 'create_timer', {
          sessionId, workerId, intervalSeconds: 60, action: 'To be deleted',
        }, nextId++);
        const created = parseToolResult(createResponse) as { timerId: string };

        // Delete it
        const deleteResponse = await callTool(app, mcpSessionId, 'delete_timer', {
          timerId: created.timerId,
        }, nextId++);
        const data = parseToolResult(deleteResponse) as { deleted: boolean };

        expect(deleteResponse.result?.isError).toBeUndefined();
        expect(data.deleted).toBe(true);

        // Verify it no longer appears in list
        const listResponse = await callTool(app, mcpSessionId, 'list_timers', {}, nextId++);
        const listData = parseToolResult(listResponse) as { timers: unknown[] };
        expect(listData.timers).toHaveLength(0);
      });

      it('should return error for non-existent timer', async () => {
        const response = await callTool(app, mcpSessionId, 'delete_timer', {
          timerId: 'non-existent-timer-id',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('Timer not found');
      });
    });
  });

  // ===========================================================================
  // Conditional wakeup tools (create_conditional_wakeup)
  // ===========================================================================

  describe('conditional wakeup tools', () => {
    describe('create_conditional_wakeup', () => {
      it('should return error when workerId targets a git-diff worker', async () => {
        const session = await sessionManager.createSession({
          type: 'quick',
          locationPath: '/test/path',
          agentId: 'claude-code',
        });

        // Find the git-diff worker created by default (not PTY-backed)
        const gitDiffWorker = session.workers.find((w) => w.type === 'git-diff');
        expect(gitDiffWorker).toBeDefined();

        const response = await callTool(app, mcpSessionId, 'create_conditional_wakeup', {
          sessionId: session.id,
          workerId: gitDiffWorker!.id,
          intervalSeconds: 60,
          conditionScript: 'true',
          onTrueMessage: 'Condition met',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('does not support PTY notifications');
        expect(data.error).toContain('requires a PTY-backed worker (agent/terminal)');
      });
    });
  });

  // ===========================================================================
  // Interactive process tools (run_process, write_process_response, kill_process, list_processes)
  // ===========================================================================

  describe('interactive process tools', () => {
    async function createSessionWithWorker(): Promise<{ sessionId: string; workerId: string }> {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;
      return { sessionId: session.id, workerId };
    }

    afterEach(() => {
      conditionalWakeupManager.disposeAll();
      interactiveProcessManager.disposeAll();
    });

    describe('run_process', () => {
      it('should start a process and return process details', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        const response = await callTool(app, mcpSessionId, 'run_process', {
          command: 'echo hello',
          sessionId,
          workerId,
        }, nextId++);

        const data = parseToolResult(response) as {
          processId: string;
          sessionId: string;
          workerId: string;
          command: string;
        };

        expect(response.result?.isError).toBeUndefined();
        expect(data.processId).toBeDefined();
        expect(typeof data.processId).toBe('string');
        expect(data.sessionId).toBe(sessionId);
        expect(data.workerId).toBe(workerId);
        expect(data.command).toBe('echo hello');
      });

      it('should pass cwd to the spawned process when provided', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();
        const tmpDir = await import('os').then((os) => os.tmpdir());

        const response = await callTool(app, mcpSessionId, 'run_process', {
          command: 'pwd',
          sessionId,
          workerId,
          cwd: tmpDir,
        }, nextId++);

        const data = parseToolResult(response) as {
          processId: string;
          command: string;
        };

        expect(response.result?.isError).toBeUndefined();
        expect(data.processId).toBeDefined();
        expect(data.command).toBe('pwd');
      });

      it('should return error for non-existent session', async () => {
        const response = await callTool(app, mcpSessionId, 'run_process', {
          command: 'echo hello',
          sessionId: 'non-existent-session',
          workerId: 'some-worker',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('Session non-existent-session not found');
      });

      it('should return error for non-existent worker', async () => {
        const { sessionId } = await createSessionWithWorker();

        const response = await callTool(app, mcpSessionId, 'run_process', {
          command: 'echo hello',
          sessionId,
          workerId: 'non-existent-worker',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('Worker non-existent-worker not found');
      });

      it('should default outputMode to "pty" when omitted', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        const response = await callTool(app, mcpSessionId, 'run_process', {
          command: 'echo hello',
          sessionId,
          workerId,
        }, nextId++);

        const data = parseToolResult(response) as { outputMode: string };

        expect(response.result?.isError).toBeUndefined();
        expect(data.outputMode).toBe('pty');
      });

      it('should accept and propagate outputMode "pty"', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        const response = await callTool(app, mcpSessionId, 'run_process', {
          command: 'echo hello',
          sessionId,
          workerId,
          outputMode: 'pty',
        }, nextId++);

        const data = parseToolResult(response) as { outputMode: string };

        expect(response.result?.isError).toBeUndefined();
        expect(data.outputMode).toBe('pty');
      });

      it('should accept and propagate outputMode "message"', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        const response = await callTool(app, mcpSessionId, 'run_process', {
          command: 'echo hello',
          sessionId,
          workerId,
          outputMode: 'message',
        }, nextId++);

        const data = parseToolResult(response) as { outputMode: string };

        expect(response.result?.isError).toBeUndefined();
        expect(data.outputMode).toBe('message');
      });

      it('should reject invalid outputMode values via zod enum validation', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        const response = await callTool(app, mcpSessionId, 'run_process', {
          command: 'echo hello',
          sessionId,
          workerId,
          outputMode: 'invalid-mode',
        }, nextId++);

        // MCP returns either a JSON-RPC error or an isError result with a
        // schema violation message. Either path signals failure.
        if (response.error) {
          expect(response.error).toBeDefined();
        } else {
          expect(response.result?.isError).toBe(true);
        }
      });

      // -----------------------------------------------------------------------
      // Issue #879: authentication / elevation
      // -----------------------------------------------------------------------
      //
      // run_process must resolve the session's `createdBy` (a users.id UUID)
      // to its OS `username` via `userRepository.findById` and pass that
      // through to `interactiveProcessManager.runProcess` as `requestUser`.
      // Mirrors the resolution pattern already covered for
      // `delegate_to_worktree` (Issue #844 / #876 blocks above), this time
      // capturing the argument via a `jest.spyOn` of the manager's
      // `runProcess` method.
      describe('authentication / elevation', () => {
        async function createSessionWithWorkerForUser(
          createdBy: string | undefined,
        ): Promise<{ sessionId: string; workerId: string }> {
          const session = await sessionManager.createSession(
            {
              type: 'quick',
              locationPath: '/test/path',
              agentId: 'claude-code',
            },
            createdBy === undefined ? undefined : { createdBy },
          );
          return { sessionId: session.id, workerId: session.workers[0].id };
        }

        it('plumbs resolved OS username when session createdBy resolves to a registered user', async () => {
          const alice = await userRepository.upsertByOsUid(9101, 'alice', '/home/alice');
          const { sessionId, workerId } = await createSessionWithWorkerForUser(alice.id);

          const runProcessSpy = jest.spyOn(
            interactiveProcessManager,
            'runProcess',
          );

          const response = await callTool(app, mcpSessionId, 'run_process', {
            command: 'echo hi',
            sessionId,
            workerId,
          }, nextId++);

          expect(response.result?.isError).toBeUndefined();
          expect(runProcessSpy).toHaveBeenCalledTimes(1);
          const params = runProcessSpy.mock.calls[0][0] as {
            requestUser?: string | null;
          };
          expect(params.requestUser).toBe('alice');

          runProcessSpy.mockRestore();
        });

        it('passes null requestUser when session has no createdBy (legacy)', async () => {
          const { sessionId, workerId } =
            await createSessionWithWorkerForUser(undefined);

          const runProcessSpy = jest.spyOn(
            interactiveProcessManager,
            'runProcess',
          );

          const response = await callTool(app, mcpSessionId, 'run_process', {
            command: 'echo hi',
            sessionId,
            workerId,
          }, nextId++);

          expect(response.result?.isError).toBeUndefined();
          expect(runProcessSpy).toHaveBeenCalledTimes(1);
          const params = runProcessSpy.mock.calls[0][0] as {
            requestUser?: string | null;
          };
          expect(params.requestUser).toBeNull();

          runProcessSpy.mockRestore();
        });

        it('passes null requestUser when session createdBy UUID does not resolve to a user', async () => {
          // Orphan / pre-multi-user createdBy that does not match any
          // userRepository entry. The MCP path must log a warning and fall
          // back to null rather than aborting the spawn.
          const { sessionId, workerId } = await createSessionWithWorkerForUser(
            'orphan-uuid-not-in-users-table',
          );

          const runProcessSpy = jest.spyOn(
            interactiveProcessManager,
            'runProcess',
          );

          const response = await callTool(app, mcpSessionId, 'run_process', {
            command: 'echo hi',
            sessionId,
            workerId,
          }, nextId++);

          expect(response.result?.isError).toBeUndefined();
          expect(runProcessSpy).toHaveBeenCalledTimes(1);
          const params = runProcessSpy.mock.calls[0][0] as {
            requestUser?: string | null;
          };
          expect(params.requestUser).toBeNull();

          runProcessSpy.mockRestore();
        });
      });

      it('should return error when workerId targets a git-diff worker', async () => {
        const session = await sessionManager.createSession({
          type: 'quick',
          locationPath: '/test/path',
          agentId: 'claude-code',
        });

        // Find the git-diff worker created by default (not PTY-backed)
        const gitDiffWorker = session.workers.find((w) => w.type === 'git-diff');
        expect(gitDiffWorker).toBeDefined();

        const response = await callTool(app, mcpSessionId, 'run_process', {
          command: 'echo hello',
          sessionId: session.id,
          workerId: gitDiffWorker!.id,
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('does not support PTY notifications');
        expect(data.error).toContain('requires a PTY-backed worker (agent/terminal)');
      });
    });

    describe('list_processes', () => {
      it('should return empty array when no processes exist', async () => {
        const response = await callTool(app, mcpSessionId, 'list_processes', {}, nextId++);
        const data = parseToolResult(response) as { processes: unknown[] };

        expect(response.result?.isError).toBeUndefined();
        expect(data.processes).toEqual([]);
      });

      it('should list running processes', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        await callTool(app, mcpSessionId, 'run_process', {
          command: 'sleep 60',
          sessionId,
          workerId,
        }, nextId++);

        const response = await callTool(app, mcpSessionId, 'list_processes', {}, nextId++);
        const data = parseToolResult(response) as {
          processes: Array<{ sessionId: string; command: string }>;
        };

        expect(response.result?.isError).toBeUndefined();
        expect(data.processes).toHaveLength(1);
        expect(data.processes[0].command).toBe('sleep 60');
      });
    });

    describe('kill_process', () => {
      it('should kill a running process', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        const createResponse = await callTool(app, mcpSessionId, 'run_process', {
          command: 'sleep 60',
          sessionId,
          workerId,
        }, nextId++);
        const created = parseToolResult(createResponse) as { processId: string };

        const killResponse = await callTool(app, mcpSessionId, 'kill_process', {
          processId: created.processId,
        }, nextId++);
        const data = parseToolResult(killResponse) as { killed: boolean };

        expect(killResponse.result?.isError).toBeUndefined();
        expect(data.killed).toBe(true);

        // Verify it no longer appears in list as running
        const listResponse = await callTool(app, mcpSessionId, 'list_processes', {}, nextId++);
        const listData = parseToolResult(listResponse) as { processes: unknown[] };
        expect(listData.processes).toHaveLength(0);
      });

      it('should return error for non-existent process', async () => {
        const response = await callTool(app, mcpSessionId, 'kill_process', {
          processId: 'non-existent-process-id',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('Process not found');
      });
    });

    describe('write_process_response', () => {
      it('should return error for non-existent process', async () => {
        const response = await callTool(app, mcpSessionId, 'write_process_response', {
          processId: 'non-existent-process-id',
          content: 'hello',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('Process not found');
      });
    });
  });

  // ===========================================================================
  // MCP protocol validation
  // ===========================================================================

  describe('MCP protocol validation', () => {
    it('should return error when delegate_to_worktree is called without repositoryId', async () => {
      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        // repositoryId is missing
        prompt: 'Do something',
      }, nextId++);

      // The MCP SDK validates parameters via zod schema and returns a JSON-RPC error
      // when required parameters are missing
      if (response.error) {
        // JSON-RPC level error
        expect(response.error).toBeDefined();
      } else {
        // Or the tool handler catches it and returns isError
        expect(response.result?.isError).toBe(true);
      }
    });

    it('should return error when get_session_status is called without sessionId', async () => {
      const response = await callTool(app, mcpSessionId, 'get_session_status', {
        // sessionId is missing
      }, nextId++);

      // The MCP SDK validates parameters via zod schema
      if (response.error) {
        expect(response.error).toBeDefined();
      } else {
        expect(response.result?.isError).toBe(true);
      }
    });
  });

  // ===========================================================================
  // restart_all_agents
  // ===========================================================================

  describe('restart_all_agents', () => {
    it('should restart all agent workers and return summary', async () => {
      // Create a session with an agent worker
      await sessionManager.createSession({
        type: 'quick',
        locationPath: TEST_REPO_PATH,
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'restart_all_agents', {}, nextId++);
      const data = parseToolResult(response) as {
        restarted: number;
        failed: number;
        skipped: number;
        results: unknown[];
      };

      expect(response.result?.isError).toBeUndefined();
      expect(data.restarted).toBe(1);
      expect(data.failed).toBe(0);
      expect(data.skipped).toBe(0);
      expect(data.results).toHaveLength(1);
    });

    it('should return empty results when no sessions exist', async () => {
      const response = await callTool(app, mcpSessionId, 'restart_all_agents', {}, nextId++);
      const data = parseToolResult(response) as {
        restarted: number;
        failed: number;
        skipped: number;
        results: unknown[];
      };

      expect(response.result?.isError).toBeUndefined();
      expect(data.restarted).toBe(0);
      expect(data.failed).toBe(0);
      expect(data.skipped).toBe(0);
      expect(data.results).toHaveLength(0);
    });
  });

  // ===========================================================================
  // delete_html_artifact: registration in this createMcpApp wiring (Issue #1371)
  //
  // Full behavior coverage (ownership resolution, authz, delete semantics)
  // lives in the dedicated __tests__/delete-html-artifact.test.ts, mirroring
  // create-html-artifact.test.ts's own split. This is only a wiring check:
  // the tool the artifactRepository-consuming block above requires is
  // actually registered by createMcpApp and exposes the expected params.
  // ===========================================================================

  describe('delete_html_artifact: registration (mcp-server.ts wiring)', () => {
    it('is registered by createMcpApp with artifactId and sessionId parameters', async () => {
      const listRes = await app.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Mcp-Session-Id': mcpSessionId,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: nextId++ }),
      });
      expect(listRes.status).toBe(200);

      const listBody = (await listRes.json()) as {
        result?: {
          tools?: Array<{
            name: string;
            inputSchema?: { properties?: Record<string, unknown> };
          }>;
        };
      };
      const deleteTool = listBody.result?.tools?.find((t) => t.name === 'delete_html_artifact');

      expect(deleteTool).toBeDefined();
      expect(deleteTool?.inputSchema?.properties?.artifactId).toBeDefined();
      expect(deleteTool?.inputSchema?.properties?.sessionId).toBeDefined();
    });
  });

  // ===========================================================================
  // create_bookmark / delete_bookmark: realtime refresh broadcast wiring
  // (mcp-server.ts wiring, this createMcpApp instance)
  //
  // Full behavior coverage (validation, ownership resolution, authz) lives
  // in the dedicated __tests__/create-bookmark.test.ts and
  // delete-bookmark.test.ts, mirroring the artifact tools' own split above.
  // This block exists so a change to mcp-server.ts's broadcastToApp call
  // sites is caught by THIS file too (its own sibling-test coverage), not
  // only by the dedicated per-tool files -- bookmarks are DB-only (no disk
  // writes), so they exercise cleanly against this file's memfs-based
  // AGENT_CONSOLE_HOME without needing the real-disk override the artifact
  // tools require.
  // ===========================================================================

  describe('create_bookmark / delete_bookmark: broadcast wiring (mcp-server.ts)', () => {
    it('create_bookmark emits exactly one bookmark-created trigger after a successful create', async () => {
      const owner = await userRepository.upsertByOsUid(9001, 'bookmark-broadcast-owner', '/home/bookmark-broadcast-owner');
      const session = await sessionManager.createSession(
        { type: 'quick', locationPath: '/test/path' },
        { createdBy: owner.id },
      );

      const mockBroadcastToApp = mock(() => {});
      await remountMcpApp({ broadcastToApp: mockBroadcastToApp });

      const response = await callTool(
        app,
        mcpSessionId,
        'create_bookmark',
        { url: 'https://example.com', sessionId: session.id },
        nextId++,
      );
      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { id: string };

      expect(mockBroadcastToApp).toHaveBeenCalledTimes(1);
      expect(mockBroadcastToApp).toHaveBeenCalledWith({ type: 'bookmark-created', sessionId: session.id, bookmarkId: data.id });
    });

    it('delete_bookmark emits exactly one bookmark-deleted trigger after a successful delete', async () => {
      const owner = await userRepository.upsertByOsUid(9002, 'bookmark-broadcast-owner-2', '/home/bookmark-broadcast-owner-2');
      const session = await sessionManager.createSession(
        { type: 'quick', locationPath: '/test/path' },
        { createdBy: owner.id },
      );
      const created = await bookmarkRepository.create({
        id: 'bookmark-broadcast-wiring-1',
        userId: owner.id,
        url: 'https://example.com',
        title: null,
        sourceSessionId: session.id,
        origin: 'agent',
      });

      const mockBroadcastToApp = mock(() => {});
      await remountMcpApp({ broadcastToApp: mockBroadcastToApp });

      const response = await callTool(
        app,
        mcpSessionId,
        'delete_bookmark',
        { bookmarkId: created.id, sessionId: session.id },
        nextId++,
      );
      expect(response.result?.isError).toBeUndefined();

      expect(mockBroadcastToApp).toHaveBeenCalledTimes(1);
      expect(mockBroadcastToApp).toHaveBeenCalledWith({ type: 'bookmark-deleted', sessionId: session.id, bookmarkId: created.id });
    });
  });

  // ===========================================================================
  // MCP caller identity wiring (docs/design/embedded-agent-worker.md phase 1)
  // ===========================================================================

  describe('MCP caller identity wiring (docs/design/embedded-agent-worker.md phase 1)', () => {
    const OWNER_ID = 'owner-uuid';

    /** Create a quick session with a known createdBy; returns session + agent worker id. */
    async function createSessionForOwner(
      createdBy: string,
    ): Promise<{ sessionId: string; workerId: string }> {
      const session = await sessionManager.createSession(
        { type: 'quick', locationPath: '/test/dir', agentId: 'claude-code' },
        { createdBy },
      );
      return { sessionId: session.id, workerId: session.workers[0].id };
    }

    const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

    it('enforce + no token rejects create_conditional_wakeup (Issue #1269: rejected at the transport gate, before the tool -- and its checkCallerOwnsSession call -- is ever reached)', async () => {
      const { sessionId, workerId } = await createSessionForOwner(OWNER_ID);
      const registry = new McpTokenRegistry();
      await remountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });

      const response = await callToolExpectTransportRejection(app, mcpSessionId, 'create_conditional_wakeup', {
        sessionId,
        workerId,
        intervalSeconds: 60,
        conditionScript: 'true',
        onTrueMessage: 'x',
      }, nextId++);

      expect(response.status).toBe(401);
      expect(response.error).toContain('MCP authentication required');
      expect(response.error).toContain('AGENT_CONSOLE_MCP_AUTH=enforce');
    });

    it('enforce + valid matching token succeeds', async () => {
      const { sessionId, workerId } = await createSessionForOwner(OWNER_ID);
      const registry = new McpTokenRegistry();
      const token = registry.mint({ sessionId, workerId, userId: OWNER_ID });
      await remountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });

      const response = await callTool(app, mcpSessionId, 'create_conditional_wakeup', {
        sessionId,
        workerId,
        intervalSeconds: 60,
        conditionScript: 'true',
        onTrueMessage: 'x',
      }, nextId++, bearer(token));
      const data = parseToolResult(response) as { wakeupId?: string };

      expect(response.result?.isError).toBeUndefined();
      expect(data.wakeupId).toBeDefined();
    });

    it('enforce + unknown token rejects (unverified token is tokenless, rejected at the transport gate)', async () => {
      const { sessionId, workerId } = await createSessionForOwner(OWNER_ID);
      const registry = new McpTokenRegistry();
      await remountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });

      const response = await callToolExpectTransportRejection(app, mcpSessionId, 'create_conditional_wakeup', {
        sessionId,
        workerId,
        intervalSeconds: 60,
        conditionScript: 'true',
        onTrueMessage: 'x',
      }, nextId++, bearer('unknown-token-not-in-registry'));

      expect(response.status).toBe(401);
      expect(response.error).toContain('MCP authentication required');
    });

    it('off + mismatched token rejects (presented-but-mismatched is always an error)', async () => {
      const { sessionId, workerId } = await createSessionForOwner(OWNER_ID);
      const registry = new McpTokenRegistry();
      const token = registry.mint({ sessionId, workerId, userId: 'someone-else' });
      await remountMcpApp({ mcpAuthMode: 'off', mcpTokenRegistry: registry });

      const response = await callTool(app, mcpSessionId, 'create_conditional_wakeup', {
        sessionId,
        workerId,
        intervalSeconds: 60,
        conditionScript: 'true',
        onTrueMessage: 'x',
      }, nextId++, bearer(token));
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('identity mismatch');
    });

    it('warn + mismatched token rejects', async () => {
      const { sessionId, workerId } = await createSessionForOwner(OWNER_ID);
      const registry = new McpTokenRegistry();
      const token = registry.mint({ sessionId, workerId, userId: 'someone-else' });
      await remountMcpApp({ mcpAuthMode: 'warn', mcpTokenRegistry: registry });

      const response = await callTool(app, mcpSessionId, 'create_conditional_wakeup', {
        sessionId,
        workerId,
        intervalSeconds: 60,
        conditionScript: 'true',
        onTrueMessage: 'x',
      }, nextId++, bearer(token));
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('identity mismatch');
    });

    it('warn + no token succeeds (single-user compatibility guarantee)', async () => {
      const { sessionId, workerId } = await createSessionForOwner(OWNER_ID);
      await remountMcpApp({ mcpAuthMode: 'warn', mcpTokenRegistry: new McpTokenRegistry() });

      const response = await callTool(app, mcpSessionId, 'create_conditional_wakeup', {
        sessionId,
        workerId,
        intervalSeconds: 60,
        conditionScript: 'true',
        onTrueMessage: 'x',
      }, nextId++);
      const data = parseToolResult(response) as { wakeupId?: string };

      expect(response.result?.isError).toBeUndefined();
      expect(data.wakeupId).toBeDefined();
    });

    it('run_process: enforce + no token rejects (at the transport gate)', async () => {
      const { sessionId, workerId } = await createSessionForOwner(OWNER_ID);
      await remountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: new McpTokenRegistry() });

      const response = await callToolExpectTransportRejection(app, mcpSessionId, 'run_process', {
        command: 'echo hi',
        sessionId,
        workerId,
      }, nextId++);

      expect(response.status).toBe(401);
      expect(response.error).toContain('MCP authentication required');
    });

    it('remove_worktree: enforce + no token rejects (at the transport gate)', async () => {
      await registerTestRepo();
      const session = await sessionManager.createSession(
        {
          type: 'worktree',
          locationPath: '/test/repo/worktrees/wt-auth',
          repositoryId: 'repo-1',
          worktreeId: 'wt-auth',
          agentId: 'claude-code',
        },
        { createdBy: OWNER_ID },
      );
      await remountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: new McpTokenRegistry() });

      const response = await callToolExpectTransportRejection(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
      }, nextId++);

      expect(response.status).toBe(401);
      expect(response.error).toContain('MCP authentication required');
    });

    it('send_session_message: enforce + no token rejects (at the transport gate)', async () => {
      const target = await createSessionForOwner(OWNER_ID);
      const sender = await createSessionForOwner(OWNER_ID);
      await remountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: new McpTokenRegistry() });

      const response = await callToolExpectTransportRejection(app, mcpSessionId, 'send_session_message', {
        toSessionId: target.sessionId,
        content: 'hello',
        fromSessionId: sender.sessionId,
      }, nextId++);

      expect(response.status).toBe(401);
      expect(response.error).toContain('MCP authentication required');
    });

    it('send_session_message: mismatched token rejects (fromSessionId owned by another user)', async () => {
      const target = await createSessionForOwner(OWNER_ID);
      const sender = await createSessionForOwner('owner-a');
      const registry = new McpTokenRegistry();
      const token = registry.mint({
        sessionId: sender.sessionId,
        workerId: sender.workerId,
        userId: 'someone-else',
      });
      await remountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: target.sessionId,
        content: 'hello',
        fromSessionId: sender.sessionId,
      }, nextId++, bearer(token));
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('identity mismatch');
    });

    it('delegate_to_worktree: enforce + no token without parentSessionId rejects (at the transport gate)', async () => {
      await registerTestRepo();
      await remountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: new McpTokenRegistry() });

      const response = await callToolExpectTransportRejection(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'repo-1',
        prompt: 'Do something',
      }, nextId++);

      expect(response.status).toBe(401);
      expect(response.error).toContain('MCP authentication required');
    });

    it('delegate_to_worktree: enforce + matching token + parentSessionId proceeds past auth', async () => {
      const parent = await createSessionForOwner(OWNER_ID);
      await registerTestRepo();
      const registry = new McpTokenRegistry();
      const token = registry.mint({
        sessionId: parent.sessionId,
        workerId: parent.workerId,
        userId: OWNER_ID,
      });
      await remountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'repo-1',
        prompt: 'Do something',
        parentSessionId: parent.sessionId,
        parentWorkerId: parent.workerId,
      }, nextId++, bearer(token));
      const data = parseToolResult(response) as { error?: string };

      // The call may still fail downstream (the full delegate environment is
      // not set up here), but it must NOT fail at the auth gate.
      expect(data.error ?? '').not.toContain('MCP authentication required');
      expect(data.error ?? '').not.toContain('identity mismatch');
    });
  });

  // ===========================================================================
  // Transport-level MCP authN gate (Issue #1269)
  //
  // Ruling 1: one middleware in front of `mcpApp`, applied to EVERY /mcp
  // request before any tool dispatch. Unlike the "MCP caller identity
  // wiring" tests above (which exercise the 5 tools that already called
  // `checkCallerOwnsSession` pre-#1269), these tests specifically exercise
  // tools that were structurally UNREACHABLE by any auth mechanism before
  // this gate existed -- `list_sessions` (read) and `close_session`
  // (mutating) are two of the 17 tools the Issue enumerated as ungated.
  // ===========================================================================

  describe('Transport-level MCP authN gate (Issue #1269)', () => {
    it('enforce + no token rejects a previously-ungated read-only tool (list_sessions)', async () => {
      await remountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: new McpTokenRegistry() });

      const response = await callToolExpectTransportRejection(app, mcpSessionId, 'list_sessions', {}, nextId++);

      expect(response.status).toBe(401);
      expect(response.error).toContain('MCP authentication required');
      expect(response.error).toContain('AGENT_CONSOLE_MCP_AUTH=enforce');
    });

    it('enforce + no token rejects a previously-ungated MUTATING tool (close_session)', async () => {
      const session = await sessionManager.createSession(
        { type: 'quick', locationPath: '/test/dir', agentId: 'claude-code' },
        { createdBy: 'owner-uuid-close' },
      );
      const sessionId = session.id;
      await remountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: new McpTokenRegistry() });

      const response = await callToolExpectTransportRejection(app, mcpSessionId, 'close_session', {
        sessionId,
      }, nextId++);

      expect(response.status).toBe(401);
      expect(response.error).toContain('MCP authentication required');
    });

    it('warn + no token still allows a previously-ungated tool (list_sessions) -- regression: today\'s default behavior preserved', async () => {
      await remountMcpApp({ mcpAuthMode: 'warn', mcpTokenRegistry: new McpTokenRegistry() });

      const response = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const data = parseToolResult(response) as { sessions: unknown[] };

      expect(response.result?.isError).toBeUndefined();
      expect(data.sessions).toBeDefined();
    });

    it('off + no token allows a previously-ungated tool (list_sessions) -- proceeds silently', async () => {
      await remountMcpApp({ mcpAuthMode: 'off', mcpTokenRegistry: new McpTokenRegistry() });

      const response = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const data = parseToolResult(response) as { sessions: unknown[] };

      expect(response.result?.isError).toBeUndefined();
      expect(data.sessions).toBeDefined();
    });

    // No-localhost-exception guard. This test's purpose is to make a future
    // "but the request came from localhost" patch fail: the transport gate
    // resolves the caller ONLY from the Authorization bearer token; it has
    // no source-address / forwarded-header input to key a bypass off of.
    // Spoofing a loopback-shaped signal upstream must have zero effect.
    it('enforce + no token rejects even when the request claims a loopback origin via X-Forwarded-For (no localhost bypass exists)', async () => {
      await remountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: new McpTokenRegistry() });

      const response = await callToolExpectTransportRejection(
        app,
        mcpSessionId,
        'list_sessions',
        {},
        nextId++,
        { 'X-Forwarded-For': '127.0.0.1' },
      );

      expect(response.status).toBe(401);
      expect(response.error).toContain('MCP authentication required');
    });

    // Real client flow (AC: "MCP handshake under enforce"). A broken
    // handshake silences every agent, so this traverses initialize ->
    // notifications/initialized -> tools/list -> tools/call, all with the
    // SAME real bearer token presented from the very first request, through
    // the real `createMcpApp(...)`-produced Hono app via `app.request()`.
    it('MCP handshake under enforce: a token presented from the FIRST request (initialize) completes end-to-end through tools/list and tools/call', async () => {
      const registry = new McpTokenRegistry();
      const token = registry.mint({
        sessionId: 'handshake-session',
        workerId: 'handshake-worker',
        userId: 'handshake-user',
      });
      const agentDirectory = new AgentDirectory({ terminal: agentManager, embedded: testEmbeddedAgentManagerStub });
      const mcpApp = createMcpApp({
        sessionManager,
        repositoryManager,
        agentManager,
        agentDirectory,
        timerManager,
        conditionalWakeupManager,
        interactiveProcessManager,
        worktreeService,
        annotationService,
        interSessionMessageService: new InterSessionMessageService(),
        suggestSessionMetadata: mockSuggestSessionMetadata,
        createWorktreeWithSession,
        deleteWorktree,
        userRepository,
        artifactRepository,
        bookmarkRepository,
        broadcastToApp: () => {},
        findOpenPullRequest: mockFindOpenPullRequest,
        fetchPullRequestUrl: mockFetchPullRequestUrl,
        mcpAuthMode: 'enforce',
        mcpTokenRegistry: registry,
      });
      const handshakeApp = new Hono();
      handshakeApp.route('', mcpApp);
      const authHeaders = { Authorization: `Bearer ${token}` };

      // 1. initialize -- WITH the token from the first request.
      const initRes = await handshakeApp.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          ...authHeaders,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
          id: 1,
        }),
      });
      expect(initRes.status).toBe(200);
      const handshakeSessionId = initRes.headers.get('mcp-session-id') ?? '';

      // 2. notifications/initialized -- WITH the token.
      const initializedRes = await handshakeApp.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Mcp-Session-Id': handshakeSessionId,
          ...authHeaders,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      // Notifications return 202 Accepted (no JSON-RPC response body expected);
      // the load-bearing assertion is that this request was NOT rejected (401).
      expect(initializedRes.status).not.toBe(401);

      // 3. tools/list -- WITH the token.
      const listRes = await handshakeApp.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Mcp-Session-Id': handshakeSessionId,
          ...authHeaders,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { result?: { tools?: Array<{ name: string }> } };
      expect(listBody.result?.tools?.some((t) => t.name === 'list_sessions')).toBe(true);

      // 4. tools/call (list_sessions) -- WITH the token.
      const callRes = await handshakeApp.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Mcp-Session-Id': handshakeSessionId,
          ...authHeaders,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'list_sessions', arguments: {} },
          id: 3,
        }),
      });
      expect(callRes.status).toBe(200);
      const callBody = (await callRes.json()) as {
        result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
      };
      expect(callBody.result?.isError).toBeUndefined();
    });

    // Single-user regression (AC): a full tokenless call sequence succeeds
    // under the effective `warn` default (AUTH_MODE=none resolves
    // AGENT_CONSOLE_MCP_AUTH to `warn` via resolveMcpAuthMode) -- no token
    // required anywhere in the flow, matching today's behavior exactly.
    it('single-user regression: a full tokenless call sequence succeeds under the default warn mode (no mcpAuthMode override, mirrors AUTH_MODE=none)', async () => {
      await remountMcpApp(); // no authOpts: mcpAuthMode defaults via resolveMcpAuthMode(undefined, serverConfig.AUTH_MODE)

      const listResponse = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      expect(listResponse.result?.isError).toBeUndefined();

      const agentsResponse = await callTool(app, mcpSessionId, 'list_agents', {}, nextId++);
      expect(agentsResponse.result?.isError).toBeUndefined();
    });
  });
});
