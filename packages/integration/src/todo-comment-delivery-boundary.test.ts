/**
 * Cross-Package Boundary Test: a human's comment on an agent-created TODO item
 * is delivered to the creating embedded-agent worker; nothing else is.
 *
 * Drives the REAL `/api/todos/:id/comments` route (production layering:
 * appContext -> authMiddleware -> route) against a real SessionManager backed
 * by the real EmbeddedAgentWorkerService and the real SqliteTodoRepository. A
 * fake `spawnAsUserFn` stands in for the loop subprocess and records every
 * stdin frame; each frame is parsed with the REAL `EmbeddedAgentCommandSchema`
 * and identified by its `[internal:todo-comment]` tag. Delivery is
 * fire-and-forget, so the tests poll for the frame with a bounded wait, and
 * "no frame" cases wait a settling period before asserting absence (with the
 * positive case in the same file as the control that the instrument can see).
 *
 * The agent half uses the REAL `/mcp` app (`createMcpApp`, enforce mode) with
 * the bearer token the real activation minted for the worker (read from its
 * `init` command): `comment_todo` and an instructed `adopt_todo`. The move
 * path ends at the REAL `GET /api/todos/:id`, strictly parsed by the client's
 * `fetchTodoDetail`.
 * Recorded proxies: the loop subprocess is a fake that records stdin, and the
 * routes are driven with `app.request` rather than a socket.
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
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';
import { createMcpApp } from '@agent-console/server/src/mcp/mcp-server';
import { initializeMcp, callTool, parseToolResult } from '@agent-console/server/src/mcp/__tests__/mcp-protocol-test-helpers';
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
import { createEmptyEmbeddedAgentSurface, createFetchBridge } from './test-utils';
import { fetchTodoDetail } from '@agent-console/client/src/lib/api';
import { todos } from '@agent-console/server/src/routes/todos';
import { authMiddleware } from '@agent-console/server/src/middleware/auth';
import { onApiError } from '@agent-console/server/src/lib/error-handler';
import type { AppBindings, AppContext } from '@agent-console/server/src/app-context';
import { defaultRepositoryLookup, defaultRepositoryEnvLookup } from '@agent-console/server/src/__tests__/utils/repository-lookup-mock';
import type { SpawnAsUserFn, SpawnAsUserOpts } from '@agent-console/server/src/services/privilege-elevation';
import { toSpawnAsUserResult, type FakeFileSink, type FakeSubprocess } from '@agent-console/server/src/__tests__/utils/fake-spawn-as-user';

import { EmbeddedAgentCommandSchema, type AuthUser, type EmbeddedAgentCommand } from '@agent-console/shared';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();

function makeFakeSpawn(): {
  fn: SpawnAsUserFn;
  captured: SpawnAsUserOpts[];
  stdinWrites: string[];
  /** Stdin writes of each spawn, in spawn order (one entry per activated worker). */
  perSpawn: string[][];
} {
  const captured: SpawnAsUserOpts[] = [];
  const stdinWrites: string[] = [];
  const perSpawn: string[][] = [];
  const stdout = new ReadableStream<Uint8Array>({ start() {} });
  const stderr = new ReadableStream<Uint8Array>({ start() {} });
  const exited = new Promise<number>(() => {
    // Never resolves: these tests never deactivate the worker.
  });
  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    const writes: string[] = [];
    perSpawn.push(writes);
    const stdin: FakeFileSink = {
      write: (chunk: string | Uint8Array) => {
        const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        stdinWrites.push(text);
        writes.push(text);
        return 0;
      },
      end: () => 0,
      flush: () => 0,
    };
    const subprocess: FakeSubprocess = { pid: 9999, exited, stdin, stdout, stderr, kill: () => {} };
    return toSpawnAsUserResult({ subprocess, stdin, elevated: false });
  };
  return { fn, captured, stdinWrites, perSpawn };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Parse every recorded stdin frame with the REAL command schema. */
function parseFrames(stdinWrites: string[]): EmbeddedAgentCommand[] {
  return stdinWrites
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.trim() !== '')
    .map((line) => v.parse(EmbeddedAgentCommandSchema, JSON.parse(line)));
}

function userModeFor(user: AuthUser): UserMode {
  return {
    authenticate: () => user,
    login: async () => null,
    spawnPty: () => {
      throw new Error('spawnPty not implemented in this test');
    },
  };
}

describe('Boundary: a comment on an agent-created TODO item reaches the creating embedded-agent worker', () => {
  let sessionManager: SessionManager;
  let embeddedAgentManager: EmbeddedAgentManager;
  let jobQueue: JobQueue;
  let fake: ReturnType<typeof makeFakeSpawn>;
  let todoRepository: SqliteTodoRepository;
  let app: Hono<AppBindings>;
  let mcpApp: Hono;
  let mcpSessionId: string;
  let resolver: AuthUser;
  let otherOwner: AuthUser;

  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    await initializeDatabase(':memory:');

    jobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(jobQueue, new WorkerOutputFileManager());

    ptyFactory.reset();
    resetGitMocks();
    fake = makeFakeSpawn();

    const db = getDatabase();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    const mcpTokenRegistry = new McpTokenRegistry();

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue,
      agentManager,
      embeddedAgentManager,
      annotationService: new AnnotationService(),
      mcpTokenRegistry,
      repositoryLookup: defaultRepositoryLookup,
      repositoryEnvLookup: defaultRepositoryEnvLookup,
      spawnAsUserFn: fake.fn,
    });

    todoRepository = new SqliteTodoRepository(db);
    const userRepository = new SqliteUserRepository(db);
    const row = await userRepository.upsertByOsUid(11223, 'resolver', '/home/resolver');
    resolver = { id: row.id, username: row.username, homeDir: row.homeDir };
    const otherRow = await userRepository.upsertByOsUid(11224, 'other-owner', '/home/other-owner');
    otherOwner = { id: otherRow.id, username: otherRow.username, homeDir: otherRow.homeDir };

    const partialContext: Partial<AppContext> = {
      todoRepository,
      sessionManager,
      userRepository,
      userMode: userModeFor(resolver),
      broadcastToApp: () => {},
    };
    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', partialContext as AppContext);
      await next();
    });
    app.use('*', authMiddleware);
    app.onError(onApiError);
    app.route('/api/todos', todos);

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
        mcpAuthMode: 'enforce',
        mcpTokenRegistry,
      }),
    );
    const handshakeToken = mcpTokenRegistry.mint({
      sessionId: 'test-harness-handshake-session',
      workerId: 'test-harness-handshake-worker',
      userId: 'test-harness-handshake-user',
    });
    mcpSessionId = await initializeMcp(mcpApp, { Authorization: `Bearer ${handshakeToken}` });
  });

  afterEach(async () => {
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  async function createEmbeddedWorker(ownerId: string = resolver.id): Promise<{ sessionId: string; workerId: string }> {
    const definition = await embeddedAgentManager.createEmbeddedAgent(
      { engine: 'openai-api', name: 'Local model', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      resolver.id,
    );
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path' },
      { createdBy: ownerId },
    );
    const worker = await sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: definition.id,
    });
    expect(worker).not.toBeNull();
    return { sessionId: session.id, workerId: worker!.id };
  }

  async function seedAgentItem(sessionId: string, workerId: string, scope: 'session' | 'global' = 'session') {
    return todoRepository.create({
      id: crypto.randomUUID(),
      kind: scope === 'global' ? 'action' : 'question',
      scope,
      title: 'Which database?',
      body: '',
      sessionId,
      createdBy: { workerId },
      assigneeUserId: null,
    });
  }

  async function commentViaRoute(id: string, text: string): Promise<Response> {
    return app.request(`/api/todos/${id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  }

  /** The token the real activation minted for the spawn at `index`, read from its `init` command. */
  function tokenOfSpawn(index: number): string {
    const init = JSON.parse(fake.perSpawn[index]![0]!) as { mcp: { token: string } };
    expect(init.mcp.token).toBeTruthy();
    return init.mcp.token;
  }

  function commentFrames(): Array<Extract<EmbeddedAgentCommand, { type: 'user-message' }>> {
    return parseFrames(fake.stdinWrites).filter(
      (f): f is Extract<EmbeddedAgentCommand, { type: 'user-message' }> =>
        f.type === 'user-message' && f.text.includes('[internal:todo-comment]'),
    );
  }

  const settle = () => new Promise((r) => setTimeout(r, 30));

  // Polarity measured: removing the `deliverTodoComment` call from the route fails this test.
  it('an active worker receives exactly one internal-todo-comment frame that the real command schema parses', async () => {
    const { sessionId, workerId } = await createEmbeddedWorker();
    await sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
    expect(fake.captured.length).toBe(1);
    const item = await seedAgentItem(sessionId, workerId);

    const res = await commentViaRoute(item.id, 'not that one, the staging database');
    expect(res.status).toBe(200);

    await waitFor(() => commentFrames().length >= 1);
    await settle();
    const frames = commentFrames();
    expect(frames.length).toBe(1);
    expect(frames[0].text).toContain('[internal:todo-comment]');
    expect(frames[0].text).toContain(`todoId=${item.id}`);
    expect(frames[0].text).toContain('author=resolver');
    expect(frames[0].text).toContain('Which database?');
    expect(frames[0].text).toContain('not that one, the staging database');
    expect((await todoRepository.findById(item.id))!.status).toBe('open');
  });

  // Reach (measured): this test does NOT catch removing the creator gate from `deliverTodoComment`
  // (without it the seam is asked for an undefined worker, finds none, and delivers nothing either);
  // that gate is pinned by the helper's and the route's own tests. Removing the route's delivery call
  // fails the control half of this test.
  it('a human-created item delivers no frame (control: the agent-created item above does)', async () => {
    const { sessionId, workerId } = await createEmbeddedWorker();
    await sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
    const humanItem = await todoRepository.create({
      id: crypto.randomUUID(),
      kind: 'question',
      scope: 'session',
      title: 'By a human',
      body: '',
      sessionId,
      createdBy: { userId: resolver.id },
      assigneeUserId: null,
    });
    const agentItem = await seedAgentItem(sessionId, workerId);

    expect((await commentViaRoute(humanItem.id, 'hello')).status).toBe(200);
    await settle();
    expect(commentFrames()).toEqual([]);

    expect((await commentViaRoute(agentItem.id, 'hello again')).status).toBe(200);
    await waitFor(() => commentFrames().length >= 1);
    expect(commentFrames().length).toBe(1);
  });

  it("an agent's own comment through the real /mcp comment_todo delivers no frame to anyone (control: a human comment does)", async () => {
    const { sessionId, workerId } = await createEmbeddedWorker();
    await sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
    const item = await seedAgentItem(sessionId, workerId);

    const response = await callTool(mcpApp, mcpSessionId, 'comment_todo', { id: item.id, text: 'checking the staging one' }, 60, {
      Authorization: `Bearer ${tokenOfSpawn(0)}`,
    });
    expect(response.result?.isError).toBeUndefined();
    const stored = parseToolResult(response) as { todo: { commentCount: number }; activities: Array<{ actor: unknown }> };
    expect(stored.todo.commentCount).toBe(1);
    expect(stored.activities[0]!.actor).toEqual({ workerId });
    await settle();
    expect(commentFrames()).toEqual([]);

    expect((await commentViaRoute(item.id, 'human reply')).status).toBe(200);
    await waitFor(() => commentFrames().length >= 1);
    expect(commentFrames().length).toBe(1);
  });

  it("a move on a human's instruction: adopt_todo with a statement (real /mcp) of another user's item, then GET /api/todos/:id shows the moved activity, strictly parsed by fetchTodoDetail", async () => {
    const a = await createEmbeddedWorker(otherOwner.id);
    await sessionManager.activateEmbeddedAgentWorker(a.sessionId, a.workerId);
    const b = await createEmbeddedWorker(resolver.id);
    await sessionManager.activateEmbeddedAgentWorker(b.sessionId, b.workerId);
    const item = await seedAgentItem(a.sessionId, a.workerId, 'global');
    const headers = { Authorization: `Bearer ${tokenOfSpawn(1)}` };

    const refused = await callTool(mcpApp, mcpSessionId, 'adopt_todo', { id: item.id }, 61, headers);
    expect(refused.result?.isError).toBe(true);
    expect((parseToolResult(refused) as { error: string }).error).toContain('Pass `statement`');

    const adopt = await callTool(
      mcpApp,
      mcpSessionId,
      'adopt_todo',
      { id: item.id, statement: 'yes, you take this one', statedBy: 'other-owner' },
      62,
      headers,
    );
    expect(adopt.result?.isError).toBeUndefined();

    const bridge = createFetchBridge(app);
    try {
      const detail = await fetchTodoDetail(item.id);

      expect(detail.todo).toMatchObject({ sessionId: b.sessionId, createdBy: { workerId: b.workerId }, commentCount: 0 });
      expect(detail.activities).toHaveLength(1);
      expect(detail.activities[0]).toMatchObject({
        kind: 'moved',
        actor: { workerId: b.workerId },
        fromSessionId: a.sessionId,
        toSessionId: b.sessionId,
        statement: 'yes, you take this one',
        attributedUserId: otherOwner.id,
      });
    } finally {
      bridge.restore();
    }
  });
});
