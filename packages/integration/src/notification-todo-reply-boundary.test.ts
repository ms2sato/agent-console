/**
 * Cross-Package Boundary Test: an agent's reply on a Todo reaches the
 * notification center.
 *
 * The write half drives the REAL `/mcp` app (`createMcpApp`) with the real
 * `comment_todo` tool, which stores an agent comment on an item through the
 * real `SqliteTodoRepository`. The read half drives the REAL
 * `GET /api/notifications` route (production layering: appContext ->
 * authMiddleware -> route) backed by the real `NotificationService`, and parses
 * the raw JSON with the strict `NotificationsResponseSchema`, so a kind missing
 * from the wire schema's picklist rejects the whole response here.
 *
 * Recorded proxy: the MCP app runs without bearer-token enforcement (the
 * caller names its own session and worker, the way a terminal agent does); the
 * tool body, the repository and the feed are production code. Requests use
 * `app.request`, not a socket.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';
import { Hono } from 'hono';

import { setupMemfs, cleanupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createMockPtyFactory } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { resetGitMocks } from '@agent-console/server/src/__tests__/utils/mock-git-helper';
import { initializeDatabase, closeDatabase, getDatabase } from '@agent-console/server/src/database/connection';
import { JobQueue } from '@agent-console/server/src/jobs/job-queue';
import { registerJobHandlers } from '@agent-console/server/src/jobs/handlers';
import { WorkerOutputFileManager } from '@agent-console/server/src/lib/worker-output-file';
import { SessionManager } from '@agent-console/server/src/services/session-manager';
import { SingleUserMode, type UserMode } from '@agent-console/server/src/services/user-mode';
import { AgentManager } from '@agent-console/server/src/services/agent-manager';
import { SqliteAgentRepository } from '@agent-console/server/src/repositories/sqlite-agent-repository';
import { EmbeddedAgentManager } from '@agent-console/server/src/services/embedded-agent-manager';
import { SqliteEmbeddedAgentRepository } from '@agent-console/server/src/repositories/sqlite-embedded-agent-repository';
import { SqliteUserRepository } from '@agent-console/server/src/repositories/sqlite-user-repository';
import { SqliteTodoRepository } from '@agent-console/server/src/repositories/sqlite-todo-repository';
import { SqliteArtifactRepository } from '@agent-console/server/src/repositories/sqlite-artifact-repository';
import { SqliteBookmarkRepository } from '@agent-console/server/src/repositories/sqlite-bookmark-repository';
import { SqliteNotificationCursorRepository } from '@agent-console/server/src/repositories/sqlite-notification-cursor-repository';
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { NotificationService } from '@agent-console/server/src/services/notification-service';
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';
import { createMcpApp } from '@agent-console/server/src/mcp/mcp-server';
import { initializeMcp, callTool } from '@agent-console/server/src/mcp/__tests__/mcp-protocol-test-helpers';
import { AgentDirectory } from '@agent-console/server/src/services/agent-directory';
import { TimerManager } from '@agent-console/server/src/services/timer-manager';
import { ConditionalWakeupManager } from '@agent-console/server/src/services/conditional-wakeup-manager';
import { InteractiveProcessManager } from '@agent-console/server/src/services/interactive-process-manager';
import { InterSessionMessageService } from '@agent-console/server/src/services/inter-session-message-service';
import { WorktreeService } from '@agent-console/server/src/services/worktree-service';
import { RepositoryManager } from '@agent-console/server/src/services/repository-manager';
import { createWorktreeWithSession } from '@agent-console/server/src/services/worktree-creation-service';
import { deleteWorktree } from '@agent-console/server/src/services/worktree-deletion-service';
import type { SuggestSessionMetadataFn } from '@agent-console/server/src/services/session-metadata-suggester';
import { notifications } from '@agent-console/server/src/routes/notifications';
import { authMiddleware } from '@agent-console/server/src/middleware/auth';
import { onApiError } from '@agent-console/server/src/lib/error-handler';
import type { AppBindings, AppContext } from '@agent-console/server/src/app-context';
import { defaultRepositoryLookup, defaultRepositoryEnvLookup } from '@agent-console/server/src/__tests__/utils/repository-lookup-mock';
import { createEmptyEmbeddedAgentSurface } from './test-utils';

import { NotificationsResponseSchema, type AuthUser } from '@agent-console/shared';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();

function userModeFor(user: AuthUser): UserMode {
  return {
    authenticate: () => user,
    login: async () => null,
    spawnPty: () => {
      throw new Error('spawnPty not implemented in this test');
    },
  };
}

describe('Boundary: an agent reply on a Todo (real comment_todo) appears in GET /api/notifications', () => {
  let sessionManager: SessionManager;
  let jobQueue: JobQueue;
  let todoRepository: SqliteTodoRepository;
  let app: Hono<AppBindings>;
  let mcpApp: Hono;
  let mcpSessionId: string;
  let me: AuthUser;
  let other: AuthUser;
  let nextRpcId: number;

  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    await initializeDatabase(':memory:');
    nextRpcId = 100;

    jobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(jobQueue, new WorkerOutputFileManager());

    ptyFactory.reset();
    resetGitMocks();

    const db = getDatabase();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    const embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
    const userRepository = new SqliteUserRepository(db);
    const meRow = await userRepository.upsertByOsUid(11301, 'me-user', '/home/me-user');
    me = { id: meRow.id, username: meRow.username, homeDir: meRow.homeDir };
    const otherRow = await userRepository.upsertByOsUid(11302, 'other-user', '/home/other-user');
    other = { id: otherRow.id, username: otherRow.username, homeDir: otherRow.homeDir };

    todoRepository = new SqliteTodoRepository(db);
    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, me),
      pathExists: async () => true,
      sessionRepository: new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`),
      jobQueue,
      agentManager,
      embeddedAgentManager,
      annotationService: new AnnotationService(),
      mcpTokenRegistry: new McpTokenRegistry(),
      repositoryLookup: defaultRepositoryLookup,
      repositoryEnvLookup: defaultRepositoryEnvLookup,
    });

    const notificationService = new NotificationService({
      artifactRepository: new SqliteArtifactRepository(db),
      jobs: jobQueue,
      todoRepository,
      cursorRepository: new SqliteNotificationCursorRepository(db),
    });
    const partialContext: Partial<AppContext> = {
      notificationService,
      userMode: userModeFor(me),
      userRepository,
      broadcastToApp: () => {},
    };
    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', partialContext as AppContext);
      await next();
    });
    app.use('*', authMiddleware);
    app.onError(onApiError);
    app.route('/api/notifications', notifications);

    mcpApp = new Hono();
    mcpApp.route(
      '',
      createMcpApp({
        sessionManager,
        repositoryManager: await RepositoryManager.create({ jobQueue }),
        agentManager,
        agentDirectory: new AgentDirectory({ terminal: agentManager, embedded: createEmptyEmbeddedAgentSurface() }),
        timerManager: new TimerManager(() => {}),
        conditionalWakeupManager: new ConditionalWakeupManager(() => {}),
        interactiveProcessManager: new InteractiveProcessManager(() => {}, () => {}),
        worktreeService: new WorktreeService({ db }),
        annotationService: new AnnotationService(),
        interSessionMessageService: new InterSessionMessageService(),
        suggestSessionMetadata: (async () => ({ branch: 'feat/test', title: 'Test' })) as SuggestSessionMetadataFn,
        createWorktreeWithSession,
        deleteWorktree,
        userRepository,
        artifactRepository: new SqliteArtifactRepository(db),
        bookmarkRepository: new SqliteBookmarkRepository(db),
        todoRepository,
        broadcastToApp: () => {},
        findOpenPullRequest: async () => null,
        fetchPullRequestUrl: async () => null,
      }),
    );
    mcpSessionId = await initializeMcp(mcpApp);
  });

  afterEach(async () => {
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  async function createAgentSession(ownerId: string): Promise<{ sessionId: string; workerId: string }> {
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path' },
      { createdBy: ownerId },
    );
    return { sessionId: session.id, workerId: session.workers.find((w) => w.type === 'agent')!.id };
  }

  async function seedItem(
    from: { sessionId: string; workerId: string },
    title: string,
    owner: { createdBy: { userId: string } | { workerId: string }; assigneeUserId: string | null },
  ) {
    return todoRepository.create({
      id: crypto.randomUUID(),
      kind: 'question',
      scope: 'session',
      title,
      body: '',
      sessionId: from.sessionId,
      createdBy: owner.createdBy,
      assigneeUserId: owner.assigneeUserId,
    });
  }

  async function agentComments(from: { sessionId: string; workerId: string }, todoId: string, text: string) {
    const response = await callTool(
      mcpApp,
      mcpSessionId,
      'comment_todo',
      { id: todoId, text, sessionId: from.sessionId, workerId: from.workerId },
      nextRpcId++,
    );
    expect(response.result?.isError).toBeUndefined();
  }

  async function feed() {
    const res = await app.request('/api/notifications');
    expect(res.status).toBe(200);
    return v.parse(NotificationsResponseSchema, await res.json());
  }

  it("an agent's comment on an item the caller created, and one on an item assigned to the caller, each appear with the Reply-on title and /todos/:id link (control: an item of someone else does not)", async () => {
    const from = await createAgentSession(me.id);
    const created = await seedItem(from, 'Which database?', { createdBy: { userId: me.id }, assigneeUserId: null });
    const assigned = await seedItem(from, 'Pick a region', { createdBy: { workerId: from.workerId }, assigneeUserId: me.id });
    const theirs = await seedItem(from, 'Not for me', { createdBy: { userId: other.id }, assigneeUserId: other.id });

    await agentComments(from, created.id, 'the staging one');
    await agentComments(from, assigned.id, 'eu-west');
    await agentComments(from, theirs.id, 'unrelated');

    const parsed = await feed();

    const replies = parsed.items.filter((i) => i.kind === 'todo-agent-replied');
    expect(replies.map((i) => [i.title, i.link]).sort()).toEqual(
      [
        ['Reply on: Pick a region', `/todos/${assigned.id}`],
        ['Reply on: Which database?', `/todos/${created.id}`],
      ].sort(),
    );
    expect(parsed.unreadCount).toBe(2);
  });

  it("a human's comment on the caller's own item adds no entry", async () => {
    const from = await createAgentSession(me.id);
    const item = await seedItem(from, 'Which database?', { createdBy: { userId: me.id }, assigneeUserId: null });
    await todoRepository.addComment({ todoId: item.id, actor: { userId: me.id }, text: 'my own note' });

    expect((await feed()).items).toEqual([]);
  });
});
