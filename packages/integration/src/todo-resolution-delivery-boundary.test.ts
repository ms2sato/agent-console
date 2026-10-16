/**
 * Cross-Package Boundary Test: resolving an agent-created TODO item notifies
 * the creating embedded-agent worker.
 *
 * Drives the REAL `/api/todos/:id/resolve` route (production layering:
 * appContext -> authMiddleware -> route) against a real SessionManager backed
 * by the real EmbeddedAgentWorkerService and the real SqliteTodoRepository. A
 * fake `spawnAsUserFn` stands in for the loop subprocess and records every
 * stdin frame; each frame is parsed with the REAL `EmbeddedAgentCommandSchema`.
 * The stdin command carries no `notification` marker (that lives on the
 * persisted event), so the frame is identified by its `[internal:todo-resolved]` tag.
 *
 * The delivery is fire-and-forget, so the tests poll for the frame with a
 * bounded wait.
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
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';
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
} {
  const captured: SpawnAsUserOpts[] = [];
  const stdinWrites: string[] = [];
  const stdout = new ReadableStream<Uint8Array>({ start() {} });
  const stderr = new ReadableStream<Uint8Array>({ start() {} });
  const exited = new Promise<number>(() => {
    // Never resolves: these tests never deactivate the worker.
  });
  const stdin: FakeFileSink = {
    write: (chunk: string | Uint8Array) => {
      stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return 0;
    },
    end: () => 0,
    flush: () => 0,
  };
  const subprocess: FakeSubprocess = { pid: 9999, exited, stdin, stdout, stderr, kill: () => {} };
  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    return toSpawnAsUserResult({ subprocess, stdin, elevated: false });
  };
  return { fn, captured, stdinWrites };
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

describe('Boundary: resolving an agent-created TODO notifies the creating embedded-agent worker', () => {
  let sessionManager: SessionManager;
  let embeddedAgentManager: EmbeddedAgentManager;
  let jobQueue: JobQueue;
  let fake: ReturnType<typeof makeFakeSpawn>;
  let todoRepository: SqliteTodoRepository;
  let app: Hono<AppBindings>;
  let resolver: AuthUser;

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

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue,
      agentManager,
      embeddedAgentManager,
      annotationService: new AnnotationService(),
      mcpTokenRegistry: new McpTokenRegistry(),
      repositoryLookup: defaultRepositoryLookup,
      repositoryEnvLookup: defaultRepositoryEnvLookup,
      spawnAsUserFn: fake.fn,
    });

    todoRepository = new SqliteTodoRepository(db);
    const userRepository = new SqliteUserRepository(db);
    const row = await userRepository.upsertByOsUid(11223, 'resolver', '/home/resolver');
    resolver = { id: row.id, username: row.username, homeDir: row.homeDir };

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
  });

  afterEach(async () => {
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  async function createEmbeddedWorker(): Promise<{ sessionId: string; workerId: string }> {
    const definition = await embeddedAgentManager.createEmbeddedAgent(
      { engine: 'openai-api', name: 'Local model', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      resolver.id,
    );
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path' },
      { createdBy: resolver.id },
    );
    const worker = await sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: definition.id,
    });
    expect(worker).not.toBeNull();
    return { sessionId: session.id, workerId: worker!.id };
  }

  async function seedAgentItem(sessionId: string, workerId: string) {
    return todoRepository.create({
      id: crypto.randomUUID(),
      kind: 'question',
      scope: 'session',
      title: 'Which database?',
      body: '',
      sessionId,
      createdBy: { workerId },
      assigneeUserId: null,
    });
  }

  async function resolveViaRoute(id: string, text: string): Promise<Response> {
    return app.request(`/api/todos/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  }

  function notificationFrames(): Array<Extract<EmbeddedAgentCommand, { type: 'user-message' }>> {
    return parseFrames(fake.stdinWrites).filter(
      (f): f is Extract<EmbeddedAgentCommand, { type: 'user-message' }> =>
        f.type === 'user-message' && f.text.includes('[internal:todo-resolved]'),
    );
  }

  it('an active worker receives one internal-todo-resolved frame that the real command schema parses', async () => {
    const { sessionId, workerId } = await createEmbeddedWorker();
    await sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
    expect(fake.captured.length).toBe(1);
    const item = await seedAgentItem(sessionId, workerId);

    const res = await resolveViaRoute(item.id, 'use sqlite');
    expect(res.status).toBe(200);

    await waitFor(() => notificationFrames().length >= 1);
    const frames = notificationFrames();
    expect(frames.length).toBe(1);
    expect(frames[0].text).toContain('[internal:todo-resolved]');
    expect(frames[0].text).toContain(`todoId=${item.id}`);
    expect(frames[0].text).toContain('Which database?');
    expect(frames[0].text).toContain('use sqlite');
  });

  it('a dormant worker is activated by the delivery and then receives the frame', async () => {
    const { sessionId, workerId } = await createEmbeddedWorker();
    expect(fake.captured.length).toBe(0);
    const item = await seedAgentItem(sessionId, workerId);

    const res = await resolveViaRoute(item.id, 'use sqlite');
    expect(res.status).toBe(200);

    await waitFor(() => notificationFrames().length >= 1);
    expect(fake.captured.length).toBe(1);
    const frames = notificationFrames();
    expect(frames.length).toBe(1);
    expect(frames[0].text).toContain('[internal:todo-resolved]');
    expect(frames[0].text).toContain('use sqlite');
  });
});
