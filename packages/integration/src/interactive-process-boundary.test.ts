/**
 * Cross-Package Boundary Test: Interactive Process MCP Tools
 *
 * Verifies that server MCP tool HTTP responses conform to the shared
 * InteractiveProcessInfo type contract. Catches field omissions, type
 * mismatches, or serialization issues (e.g., Date vs string) that
 * unit tests on either side cannot catch alone.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { setupMemfs, cleanupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createMockPtyFactory } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { mockProcess, resetProcessMock } from '@agent-console/server/src/__tests__/utils/mock-process-helper';
import { resetGitMocks } from '@agent-console/server/src/__tests__/utils/mock-git-helper';
import { initializeDatabase, closeDatabase, getDatabase } from '@agent-console/server/src/database/connection';
import { JobQueue } from '@agent-console/server/src/jobs/job-queue';
import { registerJobHandlers } from '@agent-console/server/src/jobs/handlers';
import { WorkerOutputFileManager } from '@agent-console/server/src/lib/worker-output-file';
import { SessionManager } from '@agent-console/server/src/services/session-manager';
import { SingleUserMode } from '@agent-console/server/src/services/user-mode';
import { AgentManager } from '@agent-console/server/src/services/agent-manager';
import { SqliteAgentRepository } from '@agent-console/server/src/repositories/sqlite-agent-repository';
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { AgentDirectory } from '@agent-console/server/src/services/agent-directory';
import { ConditionalWakeupManager } from '@agent-console/server/src/services/conditional-wakeup-manager';
import { SqliteUserRepository } from '@agent-console/server/src/repositories/sqlite-user-repository';
import { SqliteArtifactRepository } from '@agent-console/server/src/repositories/sqlite-artifact-repository';
import { SqliteBookmarkRepository } from '@agent-console/server/src/repositories/sqlite-bookmark-repository';
import { InteractiveProcessManager } from '@agent-console/server/src/services/interactive-process-manager';
import { InterSessionMessageService } from '@agent-console/server/src/services/inter-session-message-service';
import { TimerManager } from '@agent-console/server/src/services/timer-manager';
import { WorktreeService } from '@agent-console/server/src/services/worktree-service';
import { RepositoryManager } from '@agent-console/server/src/services/repository-manager';
import { createMcpApp } from '@agent-console/server/src/mcp/mcp-server';
import type { SuggestSessionMetadataFn } from '@agent-console/server/src/services/session-metadata-suggester';
import { createWorktreeWithSession } from '@agent-console/server/src/services/worktree-creation-service';
import { deleteWorktree } from '@agent-console/server/src/services/worktree-deletion-service';
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';
import { defaultRepositoryLookup, defaultRepositoryEnvLookup } from '@agent-console/server/src/__tests__/utils/repository-lookup-mock';
import { createEmptyEmbeddedAgentSurface } from './test-utils';
import { EmbeddedAgentManager } from '@agent-console/server/src/services/embedded-agent-manager';
import { SqliteEmbeddedAgentRepository } from '@agent-console/server/src/repositories/sqlite-embedded-agent-repository';
import { routeProcessContent } from '@agent-console/server/src/services/process-output-router';
import type { PtyNotificationParams } from '@agent-console/server/src/lib/pty-notification';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '@agent-console/server/src/services/privilege-elevation';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();

// ---------- MCP helpers (from mcp-server.test.ts) ----------

async function initializeMcp(app: Hono): Promise<string> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
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
  const sessionId = res.headers.get('mcp-session-id') ?? '';
  await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sessionId;
}

async function callTool(
  app: Hono,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  id: number,
): Promise<{ result?: { content: Array<{ type: string; text: string }>; isError?: boolean }; error?: unknown }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
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

function parseToolResult(response: Awaited<ReturnType<typeof callTool>>): unknown {
  const text = response.result?.content?.[0]?.text;
  if (!text) return undefined;
  return JSON.parse(text);
}

// ---------- Tests ----------

describe('Interactive Process MCP boundary: shared type contract', () => {
  let app: Hono;
  let mcpSessionId: string;
  let sessionManager: SessionManager;
  let interactiveProcessManager: InteractiveProcessManager;
  let testJobQueue: JobQueue;
  let nextId: number;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    await initializeDatabase(':memory:');

    testJobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());

    resetProcessMock();
    mockProcess.markAlive(process.pid);
    ptyFactory.reset();
    resetGitMocks();

    const db = getDatabase();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      repositoryLookup: defaultRepositoryLookup,
      repositoryEnvLookup: defaultRepositoryEnvLookup,
      annotationService: new AnnotationService(),
    });

    interactiveProcessManager = new InteractiveProcessManager(() => {}, () => {});

    const mcpApp = createMcpApp({
      sessionManager,
      repositoryManager: await RepositoryManager.create({ jobQueue: testJobQueue }),
      agentManager,
      agentDirectory: new AgentDirectory({ terminal: agentManager, embedded: createEmptyEmbeddedAgentSurface() }),
      timerManager: new TimerManager(() => {}),
      conditionalWakeupManager: new ConditionalWakeupManager(() => {}),
      interactiveProcessManager,
      worktreeService: new WorktreeService({ db }),
      annotationService: new AnnotationService(),
      interSessionMessageService: new InterSessionMessageService(),
      suggestSessionMetadata: mock(
        async (): ReturnType<SuggestSessionMetadataFn> =>
          Promise.resolve({ branch: 'feat/test', title: 'Test' })
      ) as SuggestSessionMetadataFn,
      createWorktreeWithSession,
      deleteWorktree,
      userRepository: new SqliteUserRepository(db),
      artifactRepository: new SqliteArtifactRepository(db),
      bookmarkRepository: new SqliteBookmarkRepository(db),
      broadcastToApp: () => {},
      findOpenPullRequest: mock(async () => null) as any,
      fetchPullRequestUrl: mock(async () => null) as any,
    });

    app = new Hono();
    app.route('', mcpApp);
    mcpSessionId = await initializeMcp(app);
    nextId = 10;
  });

  afterEach(async () => {
    interactiveProcessManager.disposeAll();
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  it('run_process response conforms to InteractiveProcessInfo contract', async () => {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });
    const sessionId = session.id;
    const workerId = session.workers[0].id;

    const response = await callTool(app, mcpSessionId, 'run_process', {
      command: 'sleep 30',
      sessionId,
      workerId,
    }, nextId++);

    expect(response.result?.isError).toBeUndefined();

    const data = parseToolResult(response) as Record<string, unknown>;
    // Verify every required field of InteractiveProcessInfo exists with correct type
    expect(typeof data.processId).toBe('string');
    expect((data.processId as string).length).toBeGreaterThan(0);
    expect(typeof data.sessionId).toBe('string');
    expect(data.sessionId).toBe(sessionId);
    expect(typeof data.workerId).toBe('string');
    expect(data.workerId).toBe(workerId);
    expect(typeof data.command).toBe('string');
    expect(data.command).toBe('sleep 30');
    // outputMode defaults to 'pty' when omitted (Issue #664)
    expect(data.outputMode).toBe('pty');
  });

  it('run_process accepts outputMode "message" and surfaces it in the response', async () => {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });

    const response = await callTool(app, mcpSessionId, 'run_process', {
      command: 'sleep 30',
      sessionId: session.id,
      workerId: session.workers[0].id,
      outputMode: 'message',
    }, nextId++);

    expect(response.result?.isError).toBeUndefined();

    const data = parseToolResult(response) as Record<string, unknown>;
    expect(data.outputMode).toBe('message');
  });

  it('run_process rejects an invalid outputMode value', async () => {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });

    const response = await callTool(app, mcpSessionId, 'run_process', {
      command: 'sleep 30',
      sessionId: session.id,
      workerId: session.workers[0].id,
      outputMode: 'invalid-mode',
    }, nextId++);

    // zod enum rejection surfaces as an MCP-level error, not as isError on a successful tool call
    expect(response.error ?? response.result?.isError).toBeTruthy();
  });

  it('list_processes returns items matching InteractiveProcessInfo shape', async () => {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });

    await callTool(app, mcpSessionId, 'run_process', {
      command: 'sleep 30',
      sessionId: session.id,
      workerId: session.workers[0].id,
    }, nextId++);

    const listResponse = await callTool(app, mcpSessionId, 'list_processes', {}, nextId++);
    expect(listResponse.result?.isError).toBeUndefined();

    const list = parseToolResult(listResponse) as { processes: Record<string, unknown>[] };
    expect(list.processes).toHaveLength(1);

    // Verify each item has ALL InteractiveProcessInfo fields with correct types
    const info = list.processes[0];
    expect(typeof info.id).toBe('string');
    expect(typeof info.sessionId).toBe('string');
    expect(typeof info.workerId).toBe('string');
    expect(typeof info.command).toBe('string');
    expect(info.status).toBe('running');
    if (typeof info.startedAt !== 'string') {
      throw new Error(`expected info.startedAt to be a string, got ${typeof info.startedAt}`);
    }
    // startedAt must be ISO date string (catches Date serialization issues)
    expect(new Date(info.startedAt).toISOString()).toBe(info.startedAt);
  });

  it('list_processes after kill shows process removed', async () => {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });

    const runResponse = await callTool(app, mcpSessionId, 'run_process', {
      command: 'sleep 30',
      sessionId: session.id,
      workerId: session.workers[0].id,
    }, nextId++);
    const { processId } = parseToolResult(runResponse) as { processId: string };

    const killResponse = await callTool(app, mcpSessionId, 'kill_process', { processId }, nextId++);
    const killData = parseToolResult(killResponse) as { killed: boolean };
    expect(killData.killed).toBe(true);

    // Killed processes are removed from the map
    const listResponse = await callTool(app, mcpSessionId, 'list_processes', {}, nextId++);
    const list = parseToolResult(listResponse) as { processes: unknown[] };
    expect(list.processes).toHaveLength(0);
  });
});

// ---------- embedded-agent target (Issue #1574 PR B) ----------

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService. */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

/**
 * Fakes the embedded-agent worker's OWN loop subprocess (the `bun`/provider
 * process an EmbeddedAgentWorkerService activation spawns), mirroring
 * embedded-agent-notification-boundary.test.ts's helper of the same shape.
 * This is unrelated to the `run_process` command subprocess itself, which
 * this file's tests spawn for real via the default `spawnAsUser` -- exactly
 * as the PTY-worker describe block above already does (e.g. `sleep 30`).
 */
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
    // Never resolves — these tests never deactivate the worker.
  });
  const stdin: FakeFileSink = {
    write: (chunk) => {
      stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return 0;
    },
    end: () => {},
    flush: () => 0,
  };
  const subprocess = { pid: 8888, exited, stdin, stdout, stderr, kill: () => {} };
  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    return { subprocess, stdin, elevated: false } as unknown as SpawnAsUserResult;
  };
  return { fn, captured, stdinWrites };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Interactive Process MCP boundary: embedded-agent target', () => {
  let app: Hono;
  let mcpSessionId: string;
  let sessionManager: SessionManager;
  let embeddedAgentManager: EmbeddedAgentManager;
  let interactiveProcessManager: InteractiveProcessManager;
  let testJobQueue: JobQueue;
  let fake: ReturnType<typeof makeFakeSpawn>;
  let nextId: number;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    await initializeDatabase(':memory:');

    testJobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());

    resetProcessMock();
    mockProcess.markAlive(process.pid);
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
      jobQueue: testJobQueue,
      agentManager,
      embeddedAgentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      repositoryLookup: defaultRepositoryLookup,
      repositoryEnvLookup: defaultRepositoryEnvLookup,
      annotationService: new AnnotationService(),
      // Test seam: fake the embedded-agent loop subprocess (same DI PR A's
      // own integration tests use) so activation doesn't spawn a real `bun`
      // provider process.
      spawnAsUserFn: fake.fn,
    });

    const interSessionMessageService = new InterSessionMessageService();
    const processRouterDeps = {
      getResolver: (sessionId: string) => sessionManager.getPathResolverForSessionId(sessionId),
      deliverNotification: (sessionId: string, workerId: string, params: PtyNotificationParams) =>
        sessionManager.deliverWorkerNotification(sessionId, workerId, params),
      sendMessage: interSessionMessageService.sendMessage.bind(interSessionMessageService),
    };

    // Mirrors app-context.ts's 6.7 wiring exactly (stdout -> 'stdout'
    // direction, ptyMessageInjector = sessionManager, onResponse -> 'response'
    // direction unless outputMode is 'pty') so this test exercises the real
    // production callback shape, not a re-implementation of it.
    interactiveProcessManager = new InteractiveProcessManager(
      (process, output) => {
        void routeProcessContent(processRouterDeps, {
          process,
          content: output,
          direction: 'stdout',
        }).catch(() => {});
      },
      () => {},
      sessionManager,
      (process, content) => {
        if (process.outputMode === 'pty') {
          return;
        }
        return routeProcessContent(processRouterDeps, {
          process,
          content,
          direction: 'response',
        });
      },
    );

    const mcpApp = createMcpApp({
      sessionManager,
      repositoryManager: await RepositoryManager.create({ jobQueue: testJobQueue }),
      agentManager,
      agentDirectory: new AgentDirectory({ terminal: agentManager, embedded: createEmptyEmbeddedAgentSurface() }),
      timerManager: new TimerManager(() => {}),
      conditionalWakeupManager: new ConditionalWakeupManager(() => {}),
      interactiveProcessManager,
      worktreeService: new WorktreeService({ db }),
      annotationService: new AnnotationService(),
      interSessionMessageService,
      suggestSessionMetadata: mock(
        async (): ReturnType<SuggestSessionMetadataFn> =>
          Promise.resolve({ branch: 'feat/test', title: 'Test' })
      ) as SuggestSessionMetadataFn,
      createWorktreeWithSession,
      deleteWorktree,
      userRepository: new SqliteUserRepository(db),
      artifactRepository: new SqliteArtifactRepository(db),
      bookmarkRepository: new SqliteBookmarkRepository(db),
      broadcastToApp: () => {},
      findOpenPullRequest: mock(async () => null) as any,
      fetchPullRequestUrl: mock(async () => null) as any,
    });

    app = new Hono();
    app.route('', mcpApp);
    mcpSessionId = await initializeMcp(app);
    nextId = 200;
  });

  afterEach(async () => {
    interactiveProcessManager.disposeAll();
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  async function createActivatedEmbeddedWorker(
    osUid: number,
    username: string,
  ): Promise<{ sessionId: string; workerId: string }> {
    const userRepository = new SqliteUserRepository(getDatabase());
    const owner = await userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const definition = await embeddedAgentManager.createEmbeddedAgent(
      { name: 'Local model', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path' },
      { createdBy: owner.id },
    );
    const worker = await sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: definition.id,
    });
    expect(worker).not.toBeNull();
    const workerId = worker!.id;

    await sessionManager.activateEmbeddedAgentWorker(session.id, workerId);
    expect(fake.captured.length).toBe(1);

    return { sessionId: session.id, workerId };
  }

  it('run_process with outputMode "pty" against an embedded-agent worker delivers full stdout content as a turn on the worker\'s own loop', async () => {
    const { sessionId, workerId } = await createActivatedEmbeddedWorker(31001, 'proc-pty-owner');
    const stdinWritesBeforeRun = fake.stdinWrites.length;

    const response = await callTool(app, mcpSessionId, 'run_process', {
      command: 'echo notify-embedded-pty',
      sessionId,
      workerId,
      outputMode: 'pty',
    }, nextId++);

    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as { processId: string };
    expect(typeof data.processId).toBe('string');

    await waitFor(() => fake.stdinWrites.length > stdinWritesBeforeRun);
    const forwarded = JSON.parse(fake.stdinWrites[stdinWritesBeforeRun]) as { type: string; text: string };
    expect(forwarded.type).toBe('user-message');
    expect(forwarded.text).toContain('[internal:process]');
    expect(forwarded.text).toContain('notify-embedded-pty');
  });

  it('run_process with outputMode "message" against an embedded-agent worker writes a message file AND delivers only a brief notification to the worker\'s loop', async () => {
    const { sessionId, workerId } = await createActivatedEmbeddedWorker(31002, 'proc-message-owner');
    const stdinWritesBeforeRun = fake.stdinWrites.length;

    const response = await callTool(app, mcpSessionId, 'run_process', {
      command: 'echo notify-embedded-message',
      sessionId,
      workerId,
      outputMode: 'message',
    }, nextId++);

    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as { processId: string; outputMode: string };
    expect(data.outputMode).toBe('message');

    const resolver = sessionManager.getPathResolverForSessionId(sessionId);
    expect(resolver).not.toBeNull();
    const messageDir = join(resolver!.getMessagesDir(), sessionId, workerId);

    await waitFor(async () => {
      try {
        const files = await readdir(messageDir);
        return files.length > 0;
      } catch {
        return false;
      }
    });
    const files = await readdir(messageDir);
    expect(files.length).toBeGreaterThan(0);

    // The embedded worker's loop receives only the brief path/bytes summary
    // notification (the file path + byte count), not a re-embedding of the
    // full stdout content as a separate notification field.
    await waitFor(() => fake.stdinWrites.length > stdinWritesBeforeRun);
    const forwarded = JSON.parse(fake.stdinWrites[stdinWritesBeforeRun]) as { type: string; text: string };
    expect(forwarded.type).toBe('user-message');
    expect(forwarded.text).toContain('[internal:process]');
    expect(forwarded.text).toContain('[stdout via message]');
    expect(forwarded.text).toContain('bytes=');
  });

  it('write_process_response round trip succeeds for a process targeting an embedded-agent worker (regression guard -- keyed by processId, unrelated to worker kind)', async () => {
    const { sessionId, workerId } = await createActivatedEmbeddedWorker(31003, 'proc-response-owner');

    const runResponse = await callTool(app, mcpSessionId, 'run_process', {
      command: 'cat',
      sessionId,
      workerId,
    }, nextId++);
    expect(runResponse.result?.isError).toBeUndefined();
    const { processId } = parseToolResult(runResponse) as { processId: string };

    const writeResponse = await callTool(app, mcpSessionId, 'write_process_response', {
      processId,
      content: 'hello',
    }, nextId++);

    expect(writeResponse.result?.isError).toBeUndefined();
    const writeData = parseToolResult(writeResponse) as { written: boolean; processId: string };
    expect(writeData.written).toBe(true);
    expect(writeData.processId).toBe(processId);
  });
});
