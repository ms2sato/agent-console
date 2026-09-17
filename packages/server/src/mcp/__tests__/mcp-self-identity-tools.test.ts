/**
 * `resolveSelfIdentity` wiring, exercised end to end across the TEN MCP
 * tools (thirteen zod fields) whose self-identity arguments are not
 * `delegate_to_worktree`'s pair or `set_agent_parameters`' (Issue #1696).
 * `delegate_to_worktree`'s own omitted-pair coverage lives in
 * `mcp-server.test.ts`, next to "should inherit createdBy from parent
 * session" -- that call site is also the only one that inherits
 * `createdBy`, which needs `setupDelegateEnvironment`'s worktree-creation
 * harness this file does not carry.
 *
 * `set_agent_parameters` established the own-worker-refusal precedent this
 * module generalises and already has thorough case (a)/(b)/(c)-shaped
 * coverage in its own dedicated file (`set-agent-parameters.test.ts`,
 * "Optional ids, defaulting to the caller's own identity" +
 * "refuses a SIBLING worker..."); duplicating it here would just be a
 * second copy of the same three assertions against the same tool, so this
 * table covers the other ten tools (three session+worker pairs across
 * `create_timer` / `create_conditional_wakeup` / `run_process`, the
 * remaining seven session-only) and leaves `set_agent_parameters` where it
 * already lives.
 *
 * Drives the REAL `createMcpApp` handler chain via `callTool` (real MCP
 * JSON-RPC transport), against a real `SessionManager`, a real
 * `SqliteSessionRepository`-backed session store (`set_orchestrator_session`
 * / `clear_orchestrator_session` need real rows for the
 * `repository_orchestrator_sessions` FK, same rationale as
 * `orchestrator-session-designation.test.ts`), and the real per-tool
 * managers (`TimerManager` / `ConditionalWakeupManager` /
 * `InteractiveProcessManager`) so a positive assertion reads the
 * AUTHORITATIVE store, never just the tool's JSON response.
 *
 * `AGENT_CONSOLE_HOME` points at a REAL directory under `os.tmpdir()`, not
 * a memfs-only path: `SqliteArtifactRepository.create` writes artifact
 * bytes via `lib/artifact-storage.ts`'s `Bun.write` / `Bun.file`, which
 * bypass the process-global `mock.module('fs/promises')` interception
 * (mirrors `create-html-artifact.test.ts` / `delete-html-artifact.test.ts`'s
 * file header). `send_session_message`'s message files, by contrast, ARE
 * written through the mocked `fs/promises` (`InterSessionMessageService`
 * uses `fs/promises` directly, not `Bun.write`), so they land in the memfs
 * volume at the same path string -- both mechanisms coexist under one
 * `AGENT_CONSOLE_HOME` value without conflict.
 *
 * ---------------------------------------------------------------------
 * Table design
 *
 * One row per tool. Each row's `createCaller()` builds the caller's own
 * session (and, for pair tools, worker) plus any prerequisite (a bookmark /
 * artifact to delete, a pre-existing designation to clear). `buildArgs()`
 * supplies the tool's non-identity arguments. `createMismatchTarget()`
 * builds the case-(b) target: for a SESSION-ONLY tool, a DIFFERENT session
 * id owned by the SAME user as the caller (not the caller's own token
 * session) -- the case that distinguishes `resolveSelfIdentity` from
 * `checkCallerOwnsSession` alone, since ownership-only reasoning would
 * accept it (same owner). For a PAIR tool, the session id stays the
 * caller's own (case 2, a no-op restatement) and only the worker id
 * mismatches -- a sibling worker in the SAME session, mirroring
 * `set-agent-parameters.test.ts`'s "refuses a SIBLING worker" test, which
 * is the shape `checkCallerOwnsSession` (session-scoped) cannot see at all.
 *
 * Three generated tests per row:
 *   (a) token + argument(s) omitted -> resolves to the caller's own
 *       identity; no error; the effect happened.
 *   (b) token + the case-(b) mismatch supplied -> refused with a message
 *       containing "can only act as your own" AND both the token's own
 *       value and the supplied mismatch value; the effect did NOT happen.
 *   (c) no token (mode 'off', the harness default) + the caller's own
 *       ids SUPPLIED explicitly -> succeeds unchanged (terminal-caller
 *       compatibility, case 4 of the contract).
 *
 * ---------------------------------------------------------------------
 * Mutation reach (measured, not predicted -- workflow.md "A check's
 * existence is not its detection power"). Each mutation was applied
 * directly to `mcp-server.ts`, this file's suite was run in isolation via
 * `bun test src/mcp/__tests__/mcp-self-identity-tools.test.ts` from
 * `packages/server`, the failing tests were recorded below verbatim, and
 * the mutation was reverted -- confirmed via `git diff
 * packages/server/src/mcp/mcp-server.ts` showing no residual changes
 * (only the pre-existing #1696 diff already in the working tree).
 *
 * - M1 (bypass `delete_bookmark`'s `resolveSelfIdentity` call, replacing it
 *   with `const sessionId = requestedSessionId ?? getMcpCallerIdentity()?.sessionId
 *   ?? ''` -- i.e. the ORIGINAL pre-#1696 defaulting shape, with no own-pair
 *   refusal): fails exactly the `delete_bookmark` row's case (b) test --
 *   "delete_bookmark > case (b): ... -> refused, no effect". With the
 *   bypass, a supplied sibling (same-owner) session id is silently
 *   accepted, `checkCallerOwnsSession` also accepts it (same owner), the
 *   caller's own bookmark is looked up by id and its owner matches, so the
 *   delete SUCCEEDS -- `isError` is `undefined` where the test expects
 *   `true`, and the bookmark the mismatch case expected to survive is
 *   deleted instead. Cases (a) and (c) are unaffected (both already resolve
 *   to the caller's own id, which the bypass also produces). All nine
 *   other rows are unaffected, confirming the row-level isolation the
 *   table depends on.
 * - M2 (drop `.optional()` from `create_timer`'s `sessionId` schema field,
 *   making it `z.string().describe(...)` again -- required): fails exactly
 *   the `create_timer` row's case (a) test -- "create_timer > case (a):
 *   ...". With `sessionId` required again, case (a)'s call (which omits
 *   both `sessionId` and `workerId` deliberately, to exercise the
 *   caller's-own-identity default) is rejected by the MCP SDK's own zod
 *   validation before the handler ever runs ("Invalid arguments for tool
 *   create_timer"), so `isError` is `true` where the test expects
 *   `undefined`. Case (b) still supplies `sessionId` explicitly (it is
 *   part of the identity args for a pair-tool mismatch) and is unaffected;
 *   case (c) also supplies it explicitly and is unaffected. All nine other
 *   rows are unaffected.
 * ---------------------------------------------------------------------
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { vol } from 'memfs';
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
import { AgentManager } from '../../services/agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { SqliteSessionRepository } from '../../repositories/sqlite-session-repository.js';
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
import { McpTokenRegistry } from '../mcp-auth.js';
import { AgentDirectory } from '../../services/agent-directory.js';
import { createWorktreeWithSession } from '../../services/worktree-creation-service.js';
import { deleteWorktree } from '../../services/worktree-deletion-service.js';
import { initializeMcp, callTool, parseToolResult } from './mcp-protocol-test-helpers.js';

const TEST_CONFIG_DIR_PREFIX = 'agent-console-self-identity-tools-test-';
const TEST_REPO_PATH = '/test/repo-1696-self-identity';
const TEST_REPO_ID = 'repo-1696-self-identity';

/** Ids returned by a row's `createCaller()`; rows may stash extra fields (e.g. a target session id). */
interface CallerIds {
  sessionId: string;
  workerId: string;
  userId: string;
  [extra: string]: unknown;
}

interface IdentityRow {
  tool: string;
  kind: 'session' | 'pair';
  /** The identity argument's name, when it differs from 'sessionId' (e.g. `fromSessionId`). Session-only tools only. */
  identityArgName?: string;
  createCaller(): Promise<CallerIds>;
  buildArgs(ids: CallerIds): Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Session-only tools: a DIFFERENT session id owned by the SAME user as
   * the caller. Pair tools: a sibling WORKER id in the caller's own
   * session (the session id itself stays the caller's own for case (b)).
   */
  createMismatchTarget(ids: CallerIds): Promise<string>;
  /** Positive assertion, read from the authoritative store (never just the tool's JSON response). */
  assertEffect(ids: CallerIds, data: unknown): Promise<void>;
  /** Negative assertion after a refused case-(b) call: neither the caller's own id nor the mismatch id took effect. */
  assertNoEffect(ids: CallerIds, mismatchId: string): Promise<void>;
}

describe('MCP self-identity resolution across eleven tool arguments (Issue #1696)', () => {
  const ptyFactory = createMockPtyFactory();
  let app: Hono;
  let sessionManager: SessionManager;
  let repositoryManager: RepositoryManager;
  let agentManager: AgentManager;
  let userRepository: SqliteUserRepository;
  let artifactRepository: SqliteArtifactRepository;
  let bookmarkRepository: SqliteBookmarkRepository;
  let worktreeService: WorktreeService;
  let agentDirectory: AgentDirectory;
  let timerManager: TimerManager;
  let conditionalWakeupManager: ConditionalWakeupManager;
  let interactiveProcessManager: InteractiveProcessManager;
  let interSessionMessageService: InterSessionMessageService;
  let testJobQueue: JobQueue;
  let mcpSessionId: string;
  let registry: McpTokenRegistry;
  let nextId: number;
  let osUidCounter = 30000;
  const originalAgentConsoleHome = process.env.AGENT_CONSOLE_HOME;
  /** Real (non-memfs) directory; see this file's header for why. */
  let testConfigDir: string | undefined;

  async function mountMcpApp(): Promise<void> {
    registry = new McpTokenRegistry();
    timerManager = new TimerManager(() => {});
    conditionalWakeupManager = new ConditionalWakeupManager(() => {});
    interactiveProcessManager = new InteractiveProcessManager(() => {}, () => {});
    interSessionMessageService = new InterSessionMessageService();
    const mcpApp = createMcpApp({
      sessionManager,
      repositoryManager,
      agentManager,
      agentDirectory,
      timerManager,
      conditionalWakeupManager,
      interactiveProcessManager,
      worktreeService,
      annotationService: new AnnotationService(),
      interSessionMessageService,
      suggestSessionMetadata: async () => ({ branch: 'unused', title: 'unused' }),
      createWorktreeWithSession,
      deleteWorktree,
      userRepository,
      artifactRepository,
      bookmarkRepository,
      broadcastToApp: () => {},
      findOpenPullRequest: async () => null,
      fetchPullRequestUrl: async () => null,
      mcpAuthMode: 'off',
      mcpTokenRegistry: registry,
    });
    app = new Hono();
    app.route('', mcpApp);
    mcpSessionId = await initializeMcp(app);
  }

  beforeEach(async () => {
    await closeDatabase();
    testConfigDir = path.join(os.tmpdir(), `${TEST_CONFIG_DIR_PREFIX}${randomUUID()}`);
    setupMemfs({
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
    });
    process.env.AGENT_CONSOLE_HOME = testConfigDir;

    await initializeDatabase(':memory:');
    testJobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());

    resetProcessMock();
    mockProcess.markAlive(process.pid);
    ptyFactory.reset();
    resetGitMocks();

    const db = getDatabase();
    agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    const embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
    userRepository = new SqliteUserRepository(db);
    artifactRepository = new SqliteArtifactRepository(db);
    bookmarkRepository = new SqliteBookmarkRepository(db);

    // Real DB-backed session repository: set_orchestrator_session /
    // clear_orchestrator_session need real rows for the
    // `repository_orchestrator_sessions.session_id` FK (migration v41),
    // same rationale as orchestrator-session-designation.test.ts.
    const sessionRepository = new SqliteSessionRepository(db);
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
    timerManager.disposeAll();
    conditionalWakeupManager.disposeAll();
    interactiveProcessManager.disposeAll();
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    if (testConfigDir) {
      Bun.spawnSync(['rm', '-rf', testConfigDir]);
      testConfigDir = undefined;
    }
    if (originalAgentConsoleHome !== undefined) {
      process.env.AGENT_CONSOLE_HOME = originalAgentConsoleHome;
    } else {
      delete process.env.AGENT_CONSOLE_HOME;
    }
  });

  function authHeader(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function nextOsUid(): number {
    return osUidCounter++;
  }

  /** The caller's own session (and, for pair tools, worker), owned by a fresh user. */
  async function createOwnedSession(
    kind: 'quick' | 'worktree',
    osUid: number,
    username: string,
    worktreeId?: string,
  ): Promise<CallerIds> {
    const owner = await userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const session =
      kind === 'quick'
        ? await sessionManager.createSession(
            { type: 'quick', locationPath: TEST_REPO_PATH, agentId: 'claude-code' },
            { createdBy: owner.id },
          )
        : await sessionManager.createSession(
            {
              type: 'worktree',
              locationPath: TEST_REPO_PATH,
              repositoryId: TEST_REPO_ID,
              worktreeId: worktreeId!,
              agentId: 'claude-code',
            },
            { createdBy: owner.id },
          );
    const agentWorker = session.workers.find((w) => w.type === 'agent')!;
    return { sessionId: session.id, workerId: agentWorker.id, userId: owner.id };
  }

  /** A SECOND session owned by the SAME user (case (b)'s "same-owner, different session" target). */
  async function createSiblingSession(userId: string, kind: 'quick' | 'worktree', worktreeId?: string): Promise<string> {
    const session =
      kind === 'quick'
        ? await sessionManager.createSession(
            { type: 'quick', locationPath: TEST_REPO_PATH, agentId: 'claude-code' },
            { createdBy: userId },
          )
        : await sessionManager.createSession(
            {
              type: 'worktree',
              locationPath: TEST_REPO_PATH,
              repositoryId: TEST_REPO_ID,
              worktreeId: worktreeId!,
              agentId: 'claude-code',
            },
            { createdBy: userId },
          );
    return session.id;
  }

  // ---------------------------------------------------------------------
  // The eleven rows
  // ---------------------------------------------------------------------

  const rows: IdentityRow[] = [
    {
      tool: 'set_orchestrator_session',
      kind: 'session',
      createCaller: () => createOwnedSession('worktree', nextOsUid(), 'orch-owner', `wt-${randomUUID()}`),
      buildArgs: () => ({}),
      createMismatchTarget: (ids) => createSiblingSession(ids.userId, 'worktree', `wt-${randomUUID()}`),
      assertEffect: async (ids) => {
        const repo = repositoryManager.getRepository(TEST_REPO_ID);
        expect(repo?.orchestratorSessionIds ?? []).toContain(ids.sessionId);
      },
      assertNoEffect: async (ids, mismatchId) => {
        const list = repositoryManager.getRepository(TEST_REPO_ID)?.orchestratorSessionIds ?? [];
        expect(list).not.toContain(mismatchId);
        expect(list).not.toContain(ids.sessionId);
      },
    },
    {
      tool: 'clear_orchestrator_session',
      kind: 'session',
      createCaller: async () => {
        const ids = await createOwnedSession('worktree', nextOsUid(), 'orch-clear-owner', `wt-${randomUUID()}`);
        await repositoryManager.addOrchestratorSession(TEST_REPO_ID, ids.sessionId);
        return ids;
      },
      buildArgs: () => ({}),
      createMismatchTarget: async (ids) => {
        const siblingId = await createSiblingSession(ids.userId, 'worktree', `wt-${randomUUID()}`);
        await repositoryManager.addOrchestratorSession(TEST_REPO_ID, siblingId);
        return siblingId;
      },
      assertEffect: async (ids) => {
        const list = repositoryManager.getRepository(TEST_REPO_ID)?.orchestratorSessionIds ?? [];
        expect(list).not.toContain(ids.sessionId);
      },
      assertNoEffect: async (ids, mismatchId) => {
        const list = repositoryManager.getRepository(TEST_REPO_ID)?.orchestratorSessionIds ?? [];
        // The refused call cleared neither the mismatch target nor the caller's own designation.
        expect(list).toContain(mismatchId);
        expect(list).toContain(ids.sessionId);
      },
    },
    {
      tool: 'send_session_message',
      kind: 'session',
      identityArgName: 'fromSessionId',
      createCaller: async () => {
        const sender = await createOwnedSession('quick', nextOsUid(), 'msg-sender');
        const target = await createOwnedSession('quick', nextOsUid(), 'msg-target');
        return { ...sender, targetSessionId: target.sessionId, targetWorkerId: target.workerId };
      },
      buildArgs: (ids) => ({ toSessionId: ids.targetSessionId as string, content: 'row-test message body' }),
      createMismatchTarget: (ids) => createSiblingSession(ids.userId, 'quick'),
      assertEffect: async (ids) => {
        const dir = path.join(
          sessionManager.getPathResolverForSessionId(ids.targetSessionId as string)!.getMessagesDir(),
          ids.targetSessionId as string,
          ids.targetWorkerId as string,
        );
        const files = vol.readdirSync(dir) as string[];
        expect(files.some((f) => f.includes(`-${ids.sessionId}-`))).toBe(true);
      },
      assertNoEffect: async (ids, mismatchId) => {
        const dir = path.join(
          sessionManager.getPathResolverForSessionId(ids.targetSessionId as string)!.getMessagesDir(),
          ids.targetSessionId as string,
          ids.targetWorkerId as string,
        );
        let files: string[] = [];
        try {
          files = vol.readdirSync(dir) as string[];
        } catch {
          files = [];
        }
        expect(files.some((f) => f.includes(`-${mismatchId}-`))).toBe(false);
        expect(files.some((f) => f.includes(`-${ids.sessionId}-`))).toBe(false);
      },
    },
    {
      tool: 'create_timer',
      kind: 'pair',
      createCaller: () => createOwnedSession('quick', nextOsUid(), 'timer-owner'),
      buildArgs: () => ({ intervalSeconds: 30, action: 'row-test tick' }),
      createMismatchTarget: async (ids) => {
        const sibling = await sessionManager.createWorker(ids.sessionId, { type: 'terminal' });
        return sibling!.id;
      },
      assertEffect: async (ids) => {
        expect(timerManager.listTimers(ids.sessionId).some((t) => t.workerId === ids.workerId)).toBe(true);
      },
      assertNoEffect: async (ids, mismatchWorkerId) => {
        const timers = timerManager.listTimers(ids.sessionId);
        expect(timers.length).toBe(0);
        expect(timers.some((t) => t.workerId === mismatchWorkerId)).toBe(false);
      },
    },
    {
      tool: 'create_conditional_wakeup',
      kind: 'pair',
      createCaller: () => createOwnedSession('quick', nextOsUid(), 'wakeup-owner'),
      buildArgs: () => ({ intervalSeconds: 30, conditionScript: 'true', onTrueMessage: 'row-test condition met' }),
      createMismatchTarget: async (ids) => {
        const sibling = await sessionManager.createWorker(ids.sessionId, { type: 'terminal' });
        return sibling!.id;
      },
      assertEffect: async (ids) => {
        expect(conditionalWakeupManager.listWakeups(ids.sessionId).some((w) => w.workerId === ids.workerId)).toBe(true);
      },
      assertNoEffect: async (ids, mismatchWorkerId) => {
        const wakeups = conditionalWakeupManager.listWakeups(ids.sessionId);
        expect(wakeups.length).toBe(0);
        expect(wakeups.some((w) => w.workerId === mismatchWorkerId)).toBe(false);
      },
    },
    {
      tool: 'run_process',
      kind: 'pair',
      createCaller: () => createOwnedSession('quick', nextOsUid(), 'process-owner'),
      buildArgs: () => ({ command: 'true' }),
      createMismatchTarget: async (ids) => {
        const sibling = await sessionManager.createWorker(ids.sessionId, { type: 'terminal' });
        return sibling!.id;
      },
      assertEffect: async (ids) => {
        expect(interactiveProcessManager.listProcesses(ids.sessionId).some((p) => p.workerId === ids.workerId)).toBe(true);
      },
      assertNoEffect: async (ids, mismatchWorkerId) => {
        const processes = interactiveProcessManager.listProcesses(ids.sessionId);
        expect(processes.length).toBe(0);
        expect(processes.some((p) => p.workerId === mismatchWorkerId)).toBe(false);
      },
    },
    {
      tool: 'create_html_artifact',
      kind: 'session',
      createCaller: () => createOwnedSession('quick', nextOsUid(), 'artifact-owner'),
      buildArgs: () => ({ content: '<html><body>row test</body></html>' }),
      createMismatchTarget: (ids) => createSiblingSession(ids.userId, 'quick'),
      assertEffect: async (ids, data) => {
        const { artifactId } = data as { artifactId: string };
        const rec = await artifactRepository.findById(artifactId);
        expect(rec).not.toBeNull();
        expect(rec!.sourceSessionId).toBe(ids.sessionId);
      },
      assertNoEffect: async (ids) => {
        expect(await artifactRepository.findByUserId(ids.userId)).toHaveLength(0);
      },
    },
    {
      tool: 'delete_html_artifact',
      kind: 'session',
      createCaller: async () => {
        const ids = await createOwnedSession('quick', nextOsUid(), 'artifact-deleter');
        const artifactId = randomUUID();
        await artifactRepository.create({
          id: artifactId,
          userId: ids.userId,
          title: 'to be deleted',
          content: '<html><body>row test delete</body></html>',
          sourceSessionId: ids.sessionId,
        });
        return { ...ids, artifactId };
      },
      buildArgs: (ids) => ({ artifactId: ids.artifactId as string }),
      createMismatchTarget: (ids) => createSiblingSession(ids.userId, 'quick'),
      assertEffect: async (ids) => {
        expect(await artifactRepository.findById(ids.artifactId as string)).toBeNull();
      },
      assertNoEffect: async (ids) => {
        expect(await artifactRepository.findById(ids.artifactId as string)).not.toBeNull();
      },
    },
    {
      tool: 'create_bookmark',
      kind: 'session',
      createCaller: () => createOwnedSession('quick', nextOsUid(), 'bookmark-owner'),
      buildArgs: () => ({ url: 'https://example.com/row-test' }),
      createMismatchTarget: (ids) => createSiblingSession(ids.userId, 'quick'),
      assertEffect: async (ids, data) => {
        const { id } = data as { id: string };
        const rec = await bookmarkRepository.findById(id);
        expect(rec).not.toBeNull();
        expect(rec!.sourceSessionId).toBe(ids.sessionId);
      },
      assertNoEffect: async (ids) => {
        expect(await bookmarkRepository.findByUserId(ids.userId)).toHaveLength(0);
      },
    },
    {
      tool: 'delete_bookmark',
      kind: 'session',
      createCaller: async () => {
        const ids = await createOwnedSession('quick', nextOsUid(), 'bookmark-deleter');
        const bookmarkId = randomUUID();
        await bookmarkRepository.create({
          id: bookmarkId,
          userId: ids.userId,
          url: 'https://example.com/to-delete',
          title: null,
          sourceSessionId: ids.sessionId,
          origin: 'agent',
        });
        return { ...ids, bookmarkId };
      },
      buildArgs: (ids) => ({ bookmarkId: ids.bookmarkId as string }),
      createMismatchTarget: (ids) => createSiblingSession(ids.userId, 'quick'),
      assertEffect: async (ids) => {
        expect(await bookmarkRepository.findById(ids.bookmarkId as string)).toBeNull();
      },
      assertNoEffect: async (ids) => {
        expect(await bookmarkRepository.findById(ids.bookmarkId as string)).not.toBeNull();
      },
    },
  ];

  // ---------------------------------------------------------------------
  // Generic three-case generator
  // ---------------------------------------------------------------------

  function registerIdentityRow(row: IdentityRow): void {
    const sessionArg = row.identityArgName ?? 'sessionId';

    describe(row.tool, () => {
      it('case (a): token present, identity argument(s) omitted -> resolves to the caller\'s own identity', async () => {
        const ids = await row.createCaller();
        const token = registry.mint({ sessionId: ids.sessionId, workerId: ids.workerId, userId: ids.userId });
        const args = await row.buildArgs(ids);

        const response = await callTool(app, mcpSessionId, row.tool, args, nextId++, authHeader(token));

        expect(response.result?.isError).toBeUndefined();
        await row.assertEffect(ids, parseToolResult(response));
      });

      it(
        'case (b): token present, a DIFFERENT same-owner ' +
          (row.kind === 'pair' ? 'worker' : 'session') +
          ' id supplied -> refused, no effect (the checkCallerOwnsSession-alone distinguisher)',
        async () => {
          const ids = await row.createCaller();
          const token = registry.mint({ sessionId: ids.sessionId, workerId: ids.workerId, userId: ids.userId });
          const mismatchId = await row.createMismatchTarget(ids);
          const args = await row.buildArgs(ids);
          const identityArgs =
            row.kind === 'pair' ? { sessionId: ids.sessionId, workerId: mismatchId } : { [sessionArg]: mismatchId };

          const response = await callTool(
            app,
            mcpSessionId,
            row.tool,
            { ...args, ...identityArgs },
            nextId++,
            authHeader(token),
          );

          expect(response.result?.isError).toBe(true);
          const data = parseToolResult(response) as { error: string };
          expect(data.error).toContain('can only act as your own');
          expect(data.error).toContain(row.kind === 'pair' ? ids.workerId : ids.sessionId);
          expect(data.error).toContain(mismatchId);

          await row.assertNoEffect(ids, mismatchId);
        },
      );

      it("case (c): no token (mode 'off'), the caller's own identity SUPPLIED -> succeeds unchanged", async () => {
        const ids = await row.createCaller();
        const args = await row.buildArgs(ids);
        const identityArgs =
          row.kind === 'pair' ? { sessionId: ids.sessionId, workerId: ids.workerId } : { [sessionArg]: ids.sessionId };

        const response = await callTool(app, mcpSessionId, row.tool, { ...args, ...identityArgs }, nextId++);

        expect(response.result?.isError).toBeUndefined();
        await row.assertEffect(ids, parseToolResult(response));
      });
    });
  }

  for (const row of rows) {
    registerIdentityRow(row);
  }
});
