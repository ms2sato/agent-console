/**
 * Ownership checks for `write_review_annotations` / `clear_review_annotations`
 * (Issue #1486).
 *
 * Before this fix, these two MCP tools accepted a caller-claimed `sessionId`
 * with no ownership verification at all -- the only two tools missing the
 * `checkCallerOwnsSession` gate that the other 13 session-claiming tools in
 * `mcp-server.ts` already have. In multi-user mode this let any MCP caller
 * rewrite or erase another user's git-diff review annotations.
 *
 * Drives the REAL `createMcpApp` handler chain via `callTool` (real MCP
 * JSON-RPC transport, mirrors `create-bookmark.test.ts` / `delete-bookmark.test.ts`'s
 * pattern), backed by a real `AnnotationService` instance (kept across
 * `mountMcpApp` remounts within a test, so pre-seeded annotation state
 * survives switching `mcpAuthMode`).
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
import { AgentManager } from '../../services/agent-manager.js';
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

const TEST_CONFIG_DIR = '/test/config-1486-review-annotations';
const TEST_REPO_PATH = '/test/repo-1486-review-annotations';
const TEST_REPO_ID = 'repo-1486-review-annotations';

const VALID_ANNOTATIONS = [
  { file: 'src/foo.ts', startLine: 1, endLine: 2, reason: 'needs review' },
];
const VALID_SUMMARY = {
  totalFiles: 1,
  reviewFiles: 1,
  mechanicalFiles: 0,
  confidence: 'medium' as const,
};

/**
 * Call an MCP tool expecting a TRANSPORT-level rejection (Issue #1269): a
 * caller with no verified identity under `AGENT_CONSOLE_MCP_AUTH=enforce`
 * never reaches the tool body at all -- `createMcpAuthMiddleware` rejects
 * the request with an HTTP 401 and a plain `{ error: string }` body before
 * `transport.handleRequest` (and therefore `checkCallerOwnsSession`) ever
 * runs. Same pattern as `mcp-server.test.ts`'s identical helper; duplicated
 * locally rather than shared because this is the only other consumer today.
 */
async function callToolExpectTransportRejection(
  app: Hono,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  id: number,
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

describe('review annotations ownership (write_review_annotations / clear_review_annotations, Issue #1486)', () => {
  const ptyFactory = createMockPtyFactory();
  let app: Hono;
  let sessionManager: SessionManager;
  let repositoryManager: RepositoryManager;
  let agentManager: AgentManager;
  let userRepository: SqliteUserRepository;
  let artifactRepository: SqliteArtifactRepository;
  let bookmarkRepository: SqliteBookmarkRepository;
  let annotationService: AnnotationService;
  let testJobQueue: JobQueue;
  let mcpSessionId: string;
  let nextId: number;
  let worktreeService: WorktreeService;
  let agentDirectory: AgentDirectory;

  async function mountMcpApp(authOpts?: {
    mcpAuthMode?: McpAuthMode;
    mcpTokenRegistry?: McpTokenRegistry;
  }): Promise<void> {
    const mcpApp = createMcpApp({
      sessionManager,
      repositoryManager,
      agentManager,
      agentDirectory,
      timerManager: new TimerManager(() => {}),
      conditionalWakeupManager: new ConditionalWakeupManager(() => {}),
      interactiveProcessManager: new InteractiveProcessManager(() => {}, () => {}),
      worktreeService,
      // Reused across remounts (never re-created here) so pre-seeded
      // annotation state survives switching mcpAuthMode mid-test.
      annotationService,
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
      mcpAuthMode: authOpts?.mcpAuthMode,
      mcpTokenRegistry: authOpts?.mcpTokenRegistry,
    });
    app = new Hono();
    app.route('', mcpApp);

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
    setupMemfs({
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      // The data root must exist before any session-data writer runs: the
      // trusted-root walker verifies it and never creates it (production
      // creates it at boot; session-data-path.md section 2).
      [TEST_CONFIG_DIR]: null,
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
    const embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
    userRepository = new SqliteUserRepository(db);
    artifactRepository = new SqliteArtifactRepository(db);
    bookmarkRepository = new SqliteBookmarkRepository(db);
    annotationService = new AnnotationService();

    const sessionRepository = new JsonSessionRepository(`${process.env.AGENT_CONSOLE_HOME}/sessions.json`);
    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      embeddedAgentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      annotationService,
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

    await mountMcpApp({ mcpAuthMode: 'off' });
    nextId = 10;
  });

  afterEach(async () => {
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  /** Create an owned session and return its git-diff worker (not the agent worker). */
  async function createOwnedSession(
    osUid: number,
    username: string,
  ): Promise<{ sessionId: string; userId: string; workerId: string }> {
    const owner = await userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH },
      { createdBy: owner.id },
    );
    return {
      sessionId: session.id,
      userId: owner.id,
      workerId: session.workers.find((w) => w.type === 'git-diff')!.id,
    };
  }

  async function createOwnerlessSession(): Promise<{ sessionId: string; workerId: string }> {
    const session = await sessionManager.createSession({ type: 'quick', locationPath: TEST_REPO_PATH });
    return { sessionId: session.id, workerId: session.workers.find((w) => w.type === 'git-diff')!.id };
  }

  // =========================================================================
  // write_review_annotations
  // =========================================================================

  describe('write_review_annotations', () => {
    it('(a) succeeds when the caller owns the target session', async () => {
      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });

      const { sessionId, userId, workerId } = await createOwnedSession(7001, 'review-owner-a');
      const token = registry.mint({ sessionId, workerId, userId });

      const response = await callTool(
        app,
        mcpSessionId,
        'write_review_annotations',
        { workerId, sessionId, annotations: VALID_ANNOTATIONS, summary: VALID_SUMMARY },
        nextId++,
        { Authorization: `Bearer ${token}` },
      );

      expect(response.result?.isError).toBeUndefined();
      const stored = annotationService.getAnnotations(workerId);
      expect(stored?.annotations).toEqual(VALID_ANNOTATIONS);
    });

    it(
      '(b) rejects a verified caller whose identity belongs to a DIFFERENT session with "identity mismatch", ' +
        'and no annotations are written',
      async () => {
        const registry = new McpTokenRegistry();
        await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });

        const { sessionId: sessionAId, userId: userAId, workerId: workerAId } = await createOwnedSession(7002, 'review-owner-b-a');
        const { sessionId: sessionBId, workerId: workerBId } = await createOwnedSession(7003, 'review-owner-b-b');

        const token = registry.mint({ sessionId: sessionAId, workerId: workerAId, userId: userAId });

        const response = await callTool(
          app,
          mcpSessionId,
          'write_review_annotations',
          { workerId: workerBId, sessionId: sessionBId, annotations: VALID_ANNOTATIONS, summary: VALID_SUMMARY },
          nextId++,
          { Authorization: `Bearer ${token}` },
        );

        expect(response.result?.isError).toBe(true);
        const data = parseToolResult(response) as { error: string };
        expect(data.error).toContain('identity mismatch');

        expect(annotationService.getAnnotations(workerBId)).toBeNull();
      },
    );

    it('(c) rejects with a loud error when the target session has no createdBy (ownerless/legacy)', async () => {
      const { sessionId, workerId } = await createOwnerlessSession();

      const response = await callTool(
        app,
        mcpSessionId,
        'write_review_annotations',
        { workerId, sessionId, annotations: VALID_ANNOTATIONS, summary: VALID_SUMMARY },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('ownerless');

      expect(annotationService.getAnnotations(workerId)).toBeNull();
    });

    it('(d) tokenless caller: rejected under enforce ("authentication required"), succeeds under off', async () => {
      const { sessionId, workerId } = await createOwnedSession(7004, 'review-owner-d');

      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });

      const enforced = await callToolExpectTransportRejection(
        app,
        mcpSessionId,
        'write_review_annotations',
        { workerId, sessionId, annotations: VALID_ANNOTATIONS, summary: VALID_SUMMARY },
        nextId++,
      );
      expect(enforced.status).toBe(401);
      expect(enforced.error).toContain('authentication required');
      expect(annotationService.getAnnotations(workerId)).toBeNull();

      await mountMcpApp({ mcpAuthMode: 'off' });
      const response = await callTool(
        app,
        mcpSessionId,
        'write_review_annotations',
        { workerId, sessionId, annotations: VALID_ANNOTATIONS, summary: VALID_SUMMARY },
        nextId++,
      );
      expect(response.result?.isError).toBeUndefined();
      expect(annotationService.getAnnotations(workerId)?.annotations).toEqual(VALID_ANNOTATIONS);
    });
  });

  // =========================================================================
  // clear_review_annotations
  // =========================================================================

  describe('clear_review_annotations', () => {
    it('(a) succeeds when the caller owns the target session', async () => {
      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });

      const { sessionId, userId, workerId } = await createOwnedSession(7005, 'review-clear-owner-a');
      annotationService.setAnnotations(workerId, { annotations: VALID_ANNOTATIONS, summary: VALID_SUMMARY }, { sessionId });
      const token = registry.mint({ sessionId, workerId, userId });

      const response = await callTool(
        app,
        mcpSessionId,
        'clear_review_annotations',
        { workerId, sessionId },
        nextId++,
        { Authorization: `Bearer ${token}` },
      );

      expect(response.result?.isError).toBeUndefined();
      expect(annotationService.getAnnotations(workerId)).toBeNull();
    });

    it(
      '(b) rejects a verified caller whose identity belongs to a DIFFERENT session with "identity mismatch", ' +
        'and the annotations survive untouched',
      async () => {
        const registry = new McpTokenRegistry();
        await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });

        const { sessionId: sessionAId, userId: userAId, workerId: workerAId } = await createOwnedSession(7006, 'review-clear-owner-b-a');
        const { sessionId: sessionBId, workerId: workerBId } = await createOwnedSession(7007, 'review-clear-owner-b-b');
        annotationService.setAnnotations(workerBId, { annotations: VALID_ANNOTATIONS, summary: VALID_SUMMARY }, { sessionId: sessionBId });

        const token = registry.mint({ sessionId: sessionAId, workerId: workerAId, userId: userAId });

        const response = await callTool(
          app,
          mcpSessionId,
          'clear_review_annotations',
          { workerId: workerBId, sessionId: sessionBId },
          nextId++,
          { Authorization: `Bearer ${token}` },
        );

        expect(response.result?.isError).toBe(true);
        const data = parseToolResult(response) as { error: string };
        expect(data.error).toContain('identity mismatch');

        expect(annotationService.getAnnotations(workerBId)).not.toBeNull();
        expect(annotationService.getAnnotations(workerBId)?.annotations).toEqual(VALID_ANNOTATIONS);
      },
    );

    it('(c) rejects with a loud error when the target session has no createdBy (ownerless/legacy)', async () => {
      const { sessionId, workerId } = await createOwnerlessSession();
      annotationService.setAnnotations(workerId, { annotations: VALID_ANNOTATIONS, summary: VALID_SUMMARY }, { sessionId });

      const response = await callTool(
        app,
        mcpSessionId,
        'clear_review_annotations',
        { workerId, sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('ownerless');

      expect(annotationService.getAnnotations(workerId)).not.toBeNull();
    });

    it('(d) tokenless caller: rejected under enforce ("authentication required"), succeeds under off', async () => {
      const { sessionId, workerId } = await createOwnedSession(7008, 'review-clear-owner-d');
      annotationService.setAnnotations(workerId, { annotations: VALID_ANNOTATIONS, summary: VALID_SUMMARY }, { sessionId });

      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });

      const enforced = await callToolExpectTransportRejection(
        app,
        mcpSessionId,
        'clear_review_annotations',
        { workerId, sessionId },
        nextId++,
      );
      expect(enforced.status).toBe(401);
      expect(enforced.error).toContain('authentication required');
      expect(annotationService.getAnnotations(workerId)).not.toBeNull();

      await mountMcpApp({ mcpAuthMode: 'off' });
      const response = await callTool(
        app,
        mcpSessionId,
        'clear_review_annotations',
        { workerId, sessionId },
        nextId++,
      );
      expect(response.result?.isError).toBeUndefined();
      expect(annotationService.getAnnotations(workerId)).toBeNull();
    });
  });
});
