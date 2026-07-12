import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';

import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '../../services/privilege-elevation.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';

import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { JobQueue } from '../../jobs/job-queue.js';
import { registerJobHandlers } from '../../jobs/handlers.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import { createSessionRepository } from '../../repositories/index.js';
import { SqliteRepositoryRepository } from '../../repositories/sqlite-repository-repository.js';
import { SessionManager } from '../../services/session-manager.js';
import { RepositoryManager } from '../../services/repository-manager.js';
import { AgentManager } from '../../services/agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { EmbeddedAgentManager } from '../../services/embedded-agent-manager.js';
import { SqliteEmbeddedAgentRepository } from '../../repositories/sqlite-embedded-agent-repository.js';
import { NotificationManager } from '../../services/notifications/notification-manager.js';
import { SlackHandler } from '../../services/notifications/slack-handler.js';
import { RepositorySlackIntegrationService } from '../../services/notifications/repository-slack-integration-service.js';
import { SingleUserMode } from '../../services/user-mode.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { setupWebSocketRoutes } from '../routes.js';
import type { AppContext } from '../../app-context.js';

const TEST_CONFIG_DIR = '/test/config';

type WebSocketHandlerFactory = (c: { req: { param: (name: string) => string } }) => {
  onOpen: (event: unknown, ws: WSContext) => void;
  onMessage: (event: { data: string | ArrayBuffer }, ws: WSContext) => void;
  onClose: (event: unknown, ws: WSContext) => void;
  onError: (event: Event, ws: WSContext) => void;
};

function createMockWs(): WSContext & {
  sentMessages: string[];
  closeCalls: { code?: number; reason?: string }[];
} {
  const sentMessages: string[] = [];
  const closeCalls: { code?: number; reason?: string }[] = [];

  return {
    send: (data: string | ArrayBuffer) => {
      sentMessages.push(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer));
    },
    close: (code?: number, reason?: string) => {
      closeCalls.push({ code, reason });
    },
    readyState: 1, // OPEN
    sentMessages,
    closeCalls,
  } as unknown as WSContext & {
    sentMessages: string[];
    closeCalls: { code?: number; reason?: string }[];
  };
}

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService (write/end/flush). */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

/**
 * Fake spawnAsUser: never emits stdout/stderr on its own (the tests below
 * only exercise the WS routing layer's dispatch to
 * EmbeddedAgentWorkerService, not the loop's own event stream — that is the
 * service's own test suite's job per testing.md's unit/integration split).
 *
 * Exitable on demand via `simulateExit`, so afterEach can deactivate any
 * activated embedded-agent worker before resetting the environment, instead
 * of leaving the exit-observer's `subprocess.exited` await and the stdout /
 * stderr readers pending past the test's lifetime.
 */
function makeFakeSpawn(): {
  fn: SpawnAsUserFn;
  captured: SpawnAsUserOpts[];
  stdinWrites: string[];
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

  const stdin: FakeFileSink = {
    write: (chunk) => {
      stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return 0;
    },
    end: () => {},
    flush: () => 0,
  };

  const subprocess = {
    pid: 4321,
    exited,
    stdin,
    stdout,
    stderr,
    kill: () => {},
  };

  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    return { subprocess, stdin, elevated: false } as unknown as SpawnAsUserResult;
  };

  return { fn, captured, stdinWrites, simulateExit };
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('Worker WebSocket: embedded-agent branch', () => {
  const ptyFactory = createMockPtyFactory(10000);
  let testJobQueue: JobQueue | null = null;
  let sessionManager: SessionManager;
  let embeddedAgentManager: EmbeddedAgentManager;
  let capturedWorkerHandlerFactory: WebSocketHandlerFactory | null = null;
  let fake: ReturnType<typeof makeFakeSpawn>;
  // sessions.created_by has a FK to users(id) (migration v19) -- a real user
  // row is required before creating a session with createdBy set.
  let sessionOwnerUserId: string;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    ptyFactory.reset();
    capturedWorkerHandlerFactory = null;
    fake = makeFakeSpawn();

    resetProcessMock();
    await initializeDatabase(':memory:');

    const userRepository = new SqliteUserRepository(getDatabase());
    const owner = await userRepository.upsertByOsUid(1001, 'testuser', '/home/testuser');
    sessionOwnerUserId = owner.id;

    testJobQueue = new JobQueue(getDatabase());
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());
    const sessionRepository = await createSessionRepository();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(getDatabase()));
    embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(getDatabase()));
    const notificationManager = new NotificationManager(new SlackHandler(new RepositorySlackIntegrationService(getDatabase())));
    sessionManager = await SessionManager.create({
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      embeddedAgentManager,
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      repositoryLookup: { getRepositorySlug: () => 'test-repo' },
      repositoryEnvLookup: {
        getRepositoryInfo: () => ({ name: 'test-repo', path: '/test/repo' }),
        getWorktreeIndexNumber: async () => 0,
      },
      // Test seam: avoids spawning a real `bun` subprocess for the loop while
      // exercising the real EmbeddedAgentWorkerService activation/dispatch path.
      spawnAsUserFn: fake.fn,
    });
    const repositoryRepository = new SqliteRepositoryRepository(getDatabase());
    const repositoryManager = await RepositoryManager.create({ repository: repositoryRepository, jobQueue: testJobQueue });
    const userMode = new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' });

    const appContext = { sessionManager, notificationManager, agentManager, embeddedAgentManager, repositoryManager, userMode } as unknown as AppContext;

    const app = new Hono();
    const upgradeWebSocket = (handlerFactory: WebSocketHandlerFactory) => {
      capturedWorkerHandlerFactory = handlerFactory;
      return handlerFactory;
    };
    await setupWebSocketRoutes(app, upgradeWebSocket as unknown as Parameters<typeof setupWebSocketRoutes>[1], appContext);
  });

  afterEach(async () => {
    // Tear down any activated embedded-agent worker before resetting the
    // environment (mirrors embedded-agent-e2e.test.ts's afterEach): deactivate
    // writes `shutdown` then races the fake subprocess's `exited` against a
    // grace timeout, so simulating the exit right after issuing deactivate
    // resolves that race via the real exit path (not the multi-second
    // timeout) and lets the background stdout/stderr readers complete.
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

    if (testJobQueue) {
      await testJobQueue.stop();
      testJobQueue = null;
    }
    await closeDatabase();
    cleanupMemfs();
  });

  async function createEmbeddedAgentSession(): Promise<{ sessionId: string; workerId: string }> {
    const definition = await embeddedAgentManager.createEmbeddedAgent(
      { name: 'Local model', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      sessionOwnerUserId,
    );
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path' },
      { createdBy: sessionOwnerUserId },
    );
    const worker = await sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: definition.id,
    });
    return { sessionId: session.id, workerId: worker!.id };
  }

  function openConnection(sessionId: string, workerId: string) {
    const mockContext = {
      req: {
        param: (name: string) => {
          if (name === 'sessionId') return sessionId;
          if (name === 'workerId') return workerId;
          return '';
        },
      },
    };
    const handlers = capturedWorkerHandlerFactory!(mockContext);
    const mockWs = createMockWs();
    handlers.onOpen({}, mockWs);
    return { handlers, mockWs };
  }

  it('activates the loop on first connect and pushes the current activity state', async () => {
    const { sessionId, workerId } = await createEmbeddedAgentSession();
    const { mockWs } = openConnection(sessionId, workerId);

    await waitFor(() => fake.captured.length === 1);

    // Spawned once, no secrets in argv.
    expect(fake.captured[0].command).toContain('bun');
    expect(fake.stdinWrites.length).toBeGreaterThanOrEqual(1);
    const initCommand = JSON.parse(fake.stdinWrites[0]);
    expect(initCommand.type).toBe('init');

    // Current activity state ('idle', set at the end of activate()) is pushed
    // explicitly since this connection's callbacks attach AFTER activate()'s
    // own broadcast already fired.
    await waitFor(() => mockWs.sentMessages.some((m) => JSON.parse(m).type === 'activity'));
    const activityMsg = mockWs.sentMessages.map((m) => JSON.parse(m)).find((m) => m.type === 'activity');
    expect(activityMsg.state).toBe('idle');

    expect(mockWs.closeCalls.length).toBe(0);
  });

  it('surfaces activation failure as a WS error message WITHOUT closing the socket', async () => {
    // Session with no worker of this id up front: create a worker, then delete
    // the underlying definition so activation hits the dangling-definition path.
    const definition = await embeddedAgentManager.createEmbeddedAgent(
      { name: 'Local model', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      sessionOwnerUserId,
    );
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path' },
      { createdBy: sessionOwnerUserId },
    );
    const worker = await sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: definition.id,
    });
    await embeddedAgentManager.deleteEmbeddedAgent(definition.id);

    const { mockWs } = openConnection(session.id, worker!.id);

    await waitFor(() => mockWs.sentMessages.length > 0);

    const errorMsg = JSON.parse(mockWs.sentMessages[0]);
    expect(errorMsg.type).toBe('error');
    expect(errorMsg.code).toBe('ACTIVATION_FAILED');
    expect(typeof errorMsg.message).toBe('string');
    expect(errorMsg.message.length).toBeGreaterThan(0);

    // Critical: the socket must stay open (architect pre-directive #2).
    expect(mockWs.closeCalls.length).toBe(0);
    // No spawn should have happened.
    expect(fake.captured.length).toBe(0);
  });

  it('forwards embedded-user-message to the loop stdin', async () => {
    const { sessionId, workerId } = await createEmbeddedAgentSession();
    const { handlers, mockWs } = openConnection(sessionId, workerId);
    await waitFor(() => fake.captured.length === 1);

    handlers.onMessage({ data: JSON.stringify({ type: 'embedded-user-message', text: 'hello loop' }) }, mockWs);

    await waitFor(() => fake.stdinWrites.length >= 2);
    const userMessageCommand = JSON.parse(fake.stdinWrites[1]);
    expect(userMessageCommand.type).toBe('user-message');
    expect(userMessageCommand.text).toBe('hello loop');
    expect(mockWs.closeCalls.length).toBe(0);
  });

  it('rejects a malformed embedded-user-message (non-string text) with an error instead of silently dropping it', async () => {
    const { sessionId, workerId } = await createEmbeddedAgentSession();
    const { handlers, mockWs } = openConnection(sessionId, workerId);
    await waitFor(() => fake.captured.length === 1);
    mockWs.sentMessages.length = 0;

    handlers.onMessage({ data: JSON.stringify({ type: 'embedded-user-message', text: 42 }) }, mockWs);

    expect(mockWs.sentMessages.length).toBe(1);
    const errorMsg = JSON.parse(mockWs.sentMessages[0]);
    expect(errorMsg.type).toBe('error');
    expect(errorMsg.code).toBe('UNSUPPORTED_OPERATION');
    expect(mockWs.closeCalls.length).toBe(0);

    // Never reached the loop's stdin.
    expect(fake.stdinWrites.length).toBe(1); // only the init command
  });

  it('forwards embedded-cancel to the loop stdin', async () => {
    const { sessionId, workerId } = await createEmbeddedAgentSession();
    const { handlers, mockWs } = openConnection(sessionId, workerId);
    await waitFor(() => fake.captured.length === 1);

    handlers.onMessage({ data: JSON.stringify({ type: 'embedded-cancel' }) }, mockWs);

    await waitFor(() => fake.stdinWrites.length >= 2);
    const cancelCommand = JSON.parse(fake.stdinWrites[1]);
    expect(cancelCommand.type).toBe('cancel');
    expect(mockWs.closeCalls.length).toBe(0);
  });

  it('rejects input/resize with an error message and keeps the socket open', async () => {
    const { sessionId, workerId } = await createEmbeddedAgentSession();
    const { handlers, mockWs } = openConnection(sessionId, workerId);
    await waitFor(() => fake.captured.length === 1);
    mockWs.sentMessages.length = 0;

    handlers.onMessage({ data: JSON.stringify({ type: 'input', data: 'ls\n' }) }, mockWs);

    expect(mockWs.sentMessages.length).toBe(1);
    const errorMsg = JSON.parse(mockWs.sentMessages[0]);
    expect(errorMsg.type).toBe('error');
    expect(errorMsg.code).toBe('UNSUPPORTED_OPERATION');
    expect(mockWs.closeCalls.length).toBe(0);

    mockWs.sentMessages.length = 0;
    handlers.onMessage({ data: JSON.stringify({ type: 'resize', cols: 80, rows: 24 }) }, mockWs);

    expect(mockWs.sentMessages.length).toBe(1);
    const resizeErrorMsg = JSON.parse(mockWs.sentMessages[0]);
    expect(resizeErrorMsg.type).toBe('error');
    expect(resizeErrorMsg.code).toBe('UNSUPPORTED_OPERATION');
    expect(mockWs.closeCalls.length).toBe(0);

    // Neither should have reached the loop's stdin as a command.
    expect(fake.stdinWrites.length).toBe(1); // only the init command
  });

  it('rejects any other unmatched message type (e.g. "image") instead of falling through to PTY handling', async () => {
    // Regression guard: CodeRabbit MAJOR — an unmatched type used to fall
    // through past the embedded-agent branch to the generic PTY
    // handleWorkerMessage call. The branch must now be terminal for every
    // message type, matched or not.
    const { sessionId, workerId } = await createEmbeddedAgentSession();
    const { handlers, mockWs } = openConnection(sessionId, workerId);
    await waitFor(() => fake.captured.length === 1);
    mockWs.sentMessages.length = 0;

    handlers.onMessage({ data: JSON.stringify({ type: 'image', data: 'base64...' }) }, mockWs);

    expect(mockWs.sentMessages.length).toBe(1);
    const errorMsg = JSON.parse(mockWs.sentMessages[0]);
    expect(errorMsg.type).toBe('error');
    expect(errorMsg.code).toBe('UNSUPPORTED_OPERATION');
    expect(mockWs.closeCalls.length).toBe(0);

    // Never reached the loop's stdin as a command.
    expect(fake.stdinWrites.length).toBe(1); // only the init command
  });

  it('rejects a second embedded-user-message with TURN_IN_PROGRESS while a turn is active', async () => {
    const { sessionId, workerId } = await createEmbeddedAgentSession();
    const { handlers, mockWs } = openConnection(sessionId, workerId);
    await waitFor(() => fake.captured.length === 1);
    mockWs.sentMessages.length = 0;

    // sendUserMessage's admission is a SYNCHRONOUS check-and-set (before any
    // await), so two back-to-back onMessage calls reliably serialize: the
    // first sets turnActive=true before the second call's admission runs.
    handlers.onMessage({ data: JSON.stringify({ type: 'embedded-user-message', text: 'first' }) }, mockWs);
    handlers.onMessage({ data: JSON.stringify({ type: 'embedded-user-message', text: 'second' }) }, mockWs);

    await waitFor(() => mockWs.sentMessages.some((m) => JSON.parse(m).code === 'TURN_IN_PROGRESS'));
    const errorMsg = mockWs.sentMessages.map((m) => JSON.parse(m)).find((m) => m.code === 'TURN_IN_PROGRESS');
    expect(errorMsg.type).toBe('error');
    expect(errorMsg.message).toBe('turn in progress');
    expect(mockWs.closeCalls.length).toBe(0);

    // Only the first user-message should have reached the loop's stdin.
    await waitFor(() => fake.stdinWrites.length >= 2);
    expect(fake.stdinWrites.length).toBe(2); // init + first user-message
  });

  it('detaches callbacks on close without throwing (isStreamWorker widening)', async () => {
    const { sessionId, workerId } = await createEmbeddedAgentSession();
    const { handlers, mockWs } = openConnection(sessionId, workerId);
    await waitFor(() => fake.captured.length === 1);

    expect(() => handlers.onClose({}, mockWs)).not.toThrow();
  });
});
