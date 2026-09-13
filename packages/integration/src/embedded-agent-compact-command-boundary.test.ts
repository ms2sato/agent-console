/**
 * Cross-Package Boundary Test: `/compact` console-slash-command interception.
 *
 * Q10 wire-boundary test for the `EmbeddedAgentCommandSchema` `compact`
 * variant (#1572): a REAL `openai-api` embedded-agent worker's composer send
 * -- driven through the REAL WebSocket `embedded-user-message` client-message
 * path (client message -> `setupWebSocketRoutes`'s real `onMessage` handler
 * -> `EmbeddedAgentWorkerService`), not a direct service call -- must reach
 * the subprocess as the WIRE command `{ v: 1, type: 'compact' }`, parsed
 * through the REAL `EmbeddedAgentCommandSchema`, while the PERSISTED
 * transcript still shows the literal `/compact` text the user typed.
 *
 * Architect ruling (#1584): the original version of this test called
 * `EmbeddedAgentWorkerService.sendUserMessage(...)` directly, which skips the
 * actual cross-package boundary a client composer send goes through -- the WS
 * route handler's own parsing/validation of the raw client JSON
 * (`WsClientMessageSchema`) never ran. This version drives the same scenario
 * through `setupWebSocketRoutes`'s real `onMessage` callback instead, using
 * the same captured-handler-factory technique
 * `packages/server/src/websocket/__tests__/routes-embedded-agent.test.ts`
 * uses to exercise the real route handler without a live TCP/WebSocket
 * connection: `upgradeWebSocket` is replaced with a function that captures
 * the handler factory Hono would otherwise hand to the underlying `ws`
 * implementation, and that captured factory is invoked with a mock
 * `sessionId`/`workerId` context to get real `onOpen`/`onMessage` callbacks
 * wired against the real `SessionManager` / `EmbeddedAgentWorkerService`
 * instances below. No other test anywhere in this repository opens a literal
 * `ws://` socket against a real `Bun.serve` instance for this route; this is
 * the established "exercise the real WS route handler" pattern for it.
 *
 * Setup/teardown pattern is modeled closely on the sibling
 * `embedded-agent-compaction-boundary.test.ts` and on
 * `routes-embedded-agent.test.ts`: real `SessionManager` + `EmbeddedAgentManager`
 * wired against a real in-memory SQLite DB and real repositories, with a fake
 * `SpawnAsUserFn` standing in for the subprocess so the test can read what
 * was written to its stdin and feed synthetic NDJSON back as its stdout.
 *
 * The `claude-sdk` control worker (item 4) is what makes assertion (2)
 * meaningful: without it, "the openai-api worker got a compact command"
 * could not be told apart from "every worker gets a compact command" --
 * claude-sdk's own `/compact` table entry is `engine`-handled, so it must
 * see the ordinary `user-message` forwarding path instead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';

import { setupMemfs, cleanupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createMockPtyFactory } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { resetGitMocks } from '@agent-console/server/src/__tests__/utils/mock-git-helper';
import { initializeDatabase, closeDatabase, getDatabase } from '@agent-console/server/src/database/connection';
import { JobQueue } from '@agent-console/server/src/jobs/job-queue';
import { registerJobHandlers } from '@agent-console/server/src/jobs/handlers';
import { WorkerOutputFileManager } from '@agent-console/server/src/lib/worker-output-file';
import { SessionManager } from '@agent-console/server/src/services/session-manager';
import { RepositoryManager } from '@agent-console/server/src/services/repository-manager';
import { SqliteRepositoryRepository } from '@agent-console/server/src/repositories/sqlite-repository-repository';
import { NotificationManager } from '@agent-console/server/src/services/notifications/notification-manager';
import { SlackHandler } from '@agent-console/server/src/services/notifications/slack-handler';
import { RepositorySlackIntegrationService } from '@agent-console/server/src/services/notifications/repository-slack-integration-service';
import { SingleUserMode } from '@agent-console/server/src/services/user-mode';
import { AgentManager } from '@agent-console/server/src/services/agent-manager';
import { SqliteAgentRepository } from '@agent-console/server/src/repositories/sqlite-agent-repository';
import { EmbeddedAgentManager, CLAUDE_SDK_AGENT_ID } from '@agent-console/server/src/services/embedded-agent-manager';
import { SqliteEmbeddedAgentRepository } from '@agent-console/server/src/repositories/sqlite-embedded-agent-repository';
import { SqliteUserRepository } from '@agent-console/server/src/repositories/sqlite-user-repository';
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';
import { defaultRepositoryLookup, defaultRepositoryEnvLookup } from '@agent-console/server/src/__tests__/utils/repository-lookup-mock';
import { setupWebSocketRoutes } from '@agent-console/server/src/websocket/routes';
import type { AppContext } from '@agent-console/server/src/app-context';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '@agent-console/server/src/services/privilege-elevation';

import { EmbeddedAgentCommandSchema, EmbeddedAgentStreamEventSchema, type EmbeddedAgentStreamEvent } from '@agent-console/shared';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService. */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

/** One fake subprocess instance: its own stdin capture and controllable stdout. */
interface FakeSpawnInstance {
  captured: SpawnAsUserOpts;
  stdinWrites: string[];
  pushStdoutLine: (line: object) => void;
}

/**
 * Fake `spawnAsUser` that hands out a SEPARATE fake subprocess (separate
 * stdin capture, separate controllable stdout) per call -- this test
 * activates two independent workers (an openai-api subject and a claude-sdk
 * control) and must be able to tell their stdin writes apart.
 */
function makeMultiFakeSpawn(): { fn: SpawnAsUserFn; instances: FakeSpawnInstance[] } {
  const instances: FakeSpawnInstance[] = [];
  const fn: SpawnAsUserFn = (opts) => {
    const encoder = new TextEncoder();
    const stdinWrites: string[] = [];
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({ start() {} });
    const exited = new Promise<number>(() => {
      // Never resolves — this test never deactivates the workers.
    });
    const stdin: FakeFileSink = {
      write: (chunk) => {
        stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        return 0;
      },
      end: () => {},
      flush: () => 0,
    };
    const subprocess = { pid: 8900 + instances.length, exited, stdin, stdout, stderr, kill: () => {} };
    instances.push({
      captured: opts,
      stdinWrites,
      pushStdoutLine: (line: object) => {
        if (!stdoutController) throw new Error('stdout controller not initialized');
        stdoutController.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      },
    });
    return { subprocess, stdin, elevated: false } as unknown as SpawnAsUserResult;
  };
  return { fn, instances };
}

/** Parse every NDJSON line in `data` with the client's replay schema (the FULL union). */
function parseReplayLines(data: string): { events: EmbeddedAgentStreamEvent[]; parseFailures: string[] } {
  const events: EmbeddedAgentStreamEvent[] = [];
  const parseFailures: string[] = [];
  for (const line of data.split('\n')) {
    if (line.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      parseFailures.push(line);
      continue;
    }
    const parsed = v.safeParse(EmbeddedAgentStreamEventSchema, json);
    if (parsed.success) events.push(parsed.output);
    else parseFailures.push(line);
  }
  return { events, parseFailures };
}

// ---------------------------------------------------------------------------
// Real-WS-route-handler harness (mirrors
// packages/server/src/websocket/__tests__/routes-embedded-agent.test.ts):
// `upgradeWebSocket` is replaced with a function that captures the handler
// factory Hono would otherwise pass to the underlying `ws` transport, so this
// test can invoke the REAL `onOpen`/`onMessage` callbacks `setupWebSocketRoutes`
// builds -- the actual client-message -> route-handler -> service boundary --
// without opening a literal network socket.
// ---------------------------------------------------------------------------

type WebSocketHandlerFactory = (c: { req: { param: (name: string) => string } }) => {
  onOpen: (event: unknown, ws: WSContext) => void;
  onMessage: (event: { data: string | ArrayBuffer }, ws: WSContext) => void;
  onClose: (event: unknown, ws: WSContext) => void;
  onError: (event: Event, ws: WSContext) => void;
};

function createMockWs(): WSContext & { sentMessages: string[] } {
  const sentMessages: string[] = [];
  return {
    send: (data: string | ArrayBuffer) => {
      sentMessages.push(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer));
    },
    close: () => {},
    readyState: 1, // OPEN
    sentMessages,
  } as unknown as WSContext & { sentMessages: string[] };
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('Client-Server Boundary: /compact console-slash-command interception (#1572)', () => {
  let sessionManager: SessionManager;
  let embeddedAgentManager: EmbeddedAgentManager;
  let jobQueue: JobQueue;
  let fake: ReturnType<typeof makeMultiFakeSpawn>;
  let capturedWorkerHandlerFactory: WebSocketHandlerFactory | null = null;

  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    await initializeDatabase(':memory:');

    jobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(jobQueue, new WorkerOutputFileManager());

    ptyFactory.reset();
    resetGitMocks();
    fake = makeMultiFakeSpawn();
    capturedWorkerHandlerFactory = null;

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
      mcpTokenRegistry: new McpTokenRegistry(),
      repositoryLookup: defaultRepositoryLookup,
      repositoryEnvLookup: defaultRepositoryEnvLookup,
      // Test seam: fake the loop subprocess so this boundary test exercises the
      // real activate/sendUserMessage/persist machinery without spawning a
      // real `bun` process (that shipping-path E2E is covered separately).
      spawnAsUserFn: fake.fn,
    });

    // setupWebSocketRoutes calls notificationManager.setSessionExistsCallback /
    // .onActivityChange / .onWorkerExit and repositoryManager.setLifecycleCallbacks
    // synchronously during setup, so both must be real instances (matching
    // routes-embedded-agent.test.ts), not stand-ins.
    const notificationManager = new NotificationManager(new SlackHandler(new RepositorySlackIntegrationService(db)));
    const repositoryManager = await RepositoryManager.create({ repository: new SqliteRepositoryRepository(db), jobQueue });
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
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

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

  it('a real /compact composer send, driven through the WS embedded-user-message route handler, writes the wire compact command (schema-validated), persists /compact as the transcript text, and does NOT intercept a claude-sdk control worker sent the same text', async () => {
    const userRepository = new SqliteUserRepository(getDatabase());
    const owner = await userRepository.upsertByOsUid(97531, 'compact-owner', '/home/compact-owner');

    const definition = await embeddedAgentManager.createEmbeddedAgent(
      { name: 'Local model', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path' },
      { createdBy: owner.id },
    );

    // --- Subject: openai-api worker, connected over the real WS route ---
    const subjectWorker = await sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: definition.id,
    });
    expect(subjectWorker).not.toBeNull();
    const subjectWorkerId = subjectWorker!.id;
    const { handlers: subjectHandlers } = openConnection(session.id, subjectWorkerId);
    await waitFor(() => fake.instances.length === 1);
    const subjectFake = fake.instances[0];
    const subjectInitWrites = subjectFake.stdinWrites.length;

    // --- Control: claude-sdk worker, same session, connected the same way ---
    const controlWorker = await sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: CLAUDE_SDK_AGENT_ID,
    });
    expect(controlWorker).not.toBeNull();
    const controlWorkerId = controlWorker!.id;
    const { handlers: controlHandlers } = openConnection(session.id, controlWorkerId);
    await waitFor(() => fake.instances.length === 2);
    const controlFake = fake.instances[1];
    const controlInitWrites = controlFake.stdinWrites.length;

    // 1 & 2: send '/compact' to the openai-api subject THROUGH THE REAL WS
    // onMessage HANDLER (the actual client-message shape a composer send
    // produces), and assert the WRITTEN wire command, parsed through the
    // REAL EmbeddedAgentCommandSchema.
    subjectHandlers.onMessage(
      { data: JSON.stringify({ type: 'embedded-user-message', text: '/compact', clientMessageId: 'cid-subject' }) },
      createMockWs(),
    );
    await waitFor(() => subjectFake.stdinWrites.length > subjectInitWrites);

    const subjectForwardedRaw = JSON.parse(subjectFake.stdinWrites[subjectInitWrites]);
    const parsedCommand = v.safeParse(EmbeddedAgentCommandSchema, subjectForwardedRaw);
    expect(parsedCommand.success).toBe(true);
    if (parsedCommand.success) {
      expect(parsedCommand.output).toEqual({ v: 1, type: 'compact' });
    }

    // 3: the PERSISTED transcript still has a user-message row with the
    // literal text '/compact' -- the interception changes only the WIRE
    // command, never what the user is shown they typed.
    const subjectHistory = await sessionManager.getWorkerOutputHistory(session.id, subjectWorkerId, 0);
    expect(subjectHistory).not.toBeNull();
    const { events: subjectEvents, parseFailures: subjectParseFailures } = parseReplayLines(subjectHistory!.data);
    expect(subjectParseFailures).toEqual([]);
    const subjectUserMessage = subjectEvents.find((e) => e.type === 'user-message');
    expect(subjectUserMessage).toMatchObject({ type: 'user-message', text: '/compact' });

    // 4: control -- the SAME text sent to a claude-sdk worker, through the
    // SAME real WS route handler, must NOT be intercepted; it reaches the
    // subprocess as an ordinary user-message wire command. Without this
    // control, (1)/(2) above could not be told apart from "every worker gets
    // a compact command".
    controlHandlers.onMessage(
      { data: JSON.stringify({ type: 'embedded-user-message', text: '/compact', clientMessageId: 'cid-control' }) },
      createMockWs(),
    );
    await waitFor(() => controlFake.stdinWrites.length > controlInitWrites);

    const controlForwardedRaw = JSON.parse(controlFake.stdinWrites[controlInitWrites]);
    const parsedControlCommand = v.safeParse(EmbeddedAgentCommandSchema, controlForwardedRaw);
    expect(parsedControlCommand.success).toBe(true);
    if (parsedControlCommand.success) {
      expect(parsedControlCommand.output).toMatchObject({ v: 1, type: 'user-message', text: '/compact' });
    }

    // Polarity (recorded, not re-run automatically): with `matchSlashCommand`
    // short-circuited to return `null` unconditionally inside
    // `resolveConsoleSlashCommandOverride` (embedded-agent-worker-service.ts),
    // assertion (2) above fails -- observed manually: `parsedCommand.output`
    // becomes `{ v: 1, type: 'user-message', id: ..., text: '/compact' }`
    // instead of `{ v: 1, type: 'compact' }`, so the
    // `toEqual({ v: 1, type: 'compact' })` assertion fails as expected.
    // Restored afterward; no source change remains from this check.
  });
});
