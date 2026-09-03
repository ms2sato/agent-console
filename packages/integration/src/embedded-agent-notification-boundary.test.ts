/**
 * Cross-Package Boundary Test: embedded-agent internal-notification `notification`
 * field round trip.
 *
 * A structured internal notification delivered to an embedded-agent worker via
 * SessionManager.sendEmbeddedAgentSystemNotification is persisted as a
 * `user-message` server event carrying an optional `notification: { kind,
 * summary? }` marker, so the client can render it distinctly from a real
 * human/API-caller message. This test exercises the REAL chain end to end:
 *   - SessionManager.sendEmbeddedAgentSystemNotification(...) (the real
 *     pass-through wrapper mcp-server.ts calls, backed by the real
 *     EmbeddedAgentWorkerService, not a spy)
 *   - the appended server event lands in the persisted output file with the
 *     `notification` field intact
 *   - the persisted bytes are read back via the same byte-offset history
 *     machinery the WS route uses (SessionManager.getWorkerOutputHistory)
 *   - each NDJSON line is parsed with the client's REAL parser
 *     (EmbeddedAgentStreamEventSchema)
 *   - the parsed `user-message` event's `notification` field matches what
 *     was composed, verbatim -- including the summary-less case, where the
 *     field must be `{ kind }` with NO `summary` key present at all
 *
 * This is the wire-boundary test pre-pr-completeness.md Question 10 requires:
 * valibot's default strip-unknown-fields behavior means a missed schema edit
 * (TS type updated but the strictObject schema left stale) would silently
 * drop the field with no compile/runtime error anywhere else in the stack.
 * Unit tests on either side (embedded-agent-worker-service's own suite stops
 * at the service API; the schema's own unit tests never touch a real
 * persisted file) do not cross this specific boundary.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
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
import { SingleUserMode } from '@agent-console/server/src/services/user-mode';
import { AgentManager } from '@agent-console/server/src/services/agent-manager';
import { SqliteAgentRepository } from '@agent-console/server/src/repositories/sqlite-agent-repository';
import { EmbeddedAgentManager } from '@agent-console/server/src/services/embedded-agent-manager';
import { SqliteEmbeddedAgentRepository } from '@agent-console/server/src/repositories/sqlite-embedded-agent-repository';
import { SqliteUserRepository } from '@agent-console/server/src/repositories/sqlite-user-repository';
import { SqliteArtifactRepository } from '@agent-console/server/src/repositories/sqlite-artifact-repository';
import { SqliteBookmarkRepository } from '@agent-console/server/src/repositories/sqlite-bookmark-repository';
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { AgentDirectory } from '@agent-console/server/src/services/agent-directory';
import { TimerManager } from '@agent-console/server/src/services/timer-manager';
import { ConditionalWakeupManager } from '@agent-console/server/src/services/conditional-wakeup-manager';
import { InteractiveProcessManager } from '@agent-console/server/src/services/interactive-process-manager';
import { InterSessionMessageService } from '@agent-console/server/src/services/inter-session-message-service';
import { WorktreeService } from '@agent-console/server/src/services/worktree-service';
import { RepositoryManager } from '@agent-console/server/src/services/repository-manager';
import { createMcpApp } from '@agent-console/server/src/mcp/mcp-server';
import { createWorktreeWithSession } from '@agent-console/server/src/services/worktree-creation-service';
import { deleteWorktree } from '@agent-console/server/src/services/worktree-deletion-service';
import type { SuggestSessionMetadataFn } from '@agent-console/server/src/services/session-metadata-suggester';
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';
import { defaultRepositoryLookup, defaultRepositoryEnvLookup } from '@agent-console/server/src/__tests__/utils/repository-lookup-mock';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '@agent-console/server/src/services/privilege-elevation';
import { createEmptyEmbeddedAgentSurface } from './test-utils';

import { EmbeddedAgentStreamEventSchema, type EmbeddedAgentStreamEvent } from '@agent-console/shared';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService. */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

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
    // Never resolves — this test never deactivates the worker.
  });
  const stdin: FakeFileSink = {
    write: (chunk) => {
      stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return 0;
    },
    end: () => {},
    flush: () => 0,
  };
  const subprocess = { pid: 9999, exited, stdin, stdout, stderr, kill: () => {} };
  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    return { subprocess, stdin, elevated: false } as unknown as SpawnAsUserResult;
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

// ---------- MCP HTTP helpers (Issue #1574, mirrors mcp-server.test.ts / interactive-process-boundary.test.ts) ----------

async function initializeMcp(app: Hono, extraHeaders?: Record<string, string>): Promise<string> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...extraHeaders },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
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
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sessionId;
}

async function callTool(
  app: Hono,
  mcpSessionId: string,
  name: string,
  args: Record<string, unknown>,
  id: number,
  extraHeaders?: Record<string, string>,
): Promise<{ result?: { content: Array<{ type: string; text: string }>; isError?: boolean }; error?: unknown }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': mcpSessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id }),
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

describe('Client-Server Boundary: embedded-agent internal-notification `notification` field round trip', () => {
  let sessionManager: SessionManager;
  let embeddedAgentManager: EmbeddedAgentManager;
  let jobQueue: JobQueue;
  let fake: ReturnType<typeof makeFakeSpawn>;

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
      // Test seam: fake the loop subprocess so this boundary test exercises the
      // real send/append/persist machinery without spawning a real `bun`
      // process (that shipping-path E2E is covered separately).
      spawnAsUserFn: fake.fn,
    });
  });

  afterEach(async () => {
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  async function activateWorker(): Promise<{ sessionId: string; workerId: string; senderSessionId: string }> {
    const userRepository = new SqliteUserRepository(getDatabase());
    const owner = await userRepository.upsertByOsUid(24680, 'owner', '/home/owner');

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

    const senderSession = await sessionManager.createSession(
      { type: 'quick', locationPath: '/test/sender-path' },
      { createdBy: owner.id },
    );

    await sessionManager.activateEmbeddedAgentWorker(session.id, workerId);
    expect(fake.captured.length).toBe(1);

    return { sessionId: session.id, workerId, senderSessionId: senderSession.id };
  }

  it('a notification with a summary-carrying kind survives the full server -> persisted-file -> parse round trip, including the reply-instructions suffix', async () => {
    const { sessionId, workerId, senderSessionId } = await activateWorker();

    const result = await sessionManager.sendEmbeddedAgentSystemNotification(
      sessionId,
      workerId,
      {
        kind: 'internal-message',
        tag: 'internal:message',
        fields: {
          source: 'session',
          from: senderSessionId,
          summary: 'Message from session sender-title',
          path: '/test/messages/abc.json',
        },
        intent: 'triage',
      },
      { replyToSessionId: senderSessionId },
    );
    expect(result.ok).toBe(true);

    // The stdin command sent to the loop must NOT carry a `notification` key
    // (loop protocol is unchanged) -- only the persisted/broadcast event does.
    await waitFor(() => fake.stdinWrites.length >= 2);
    const stdinCommand = JSON.parse(fake.stdinWrites[1]);
    expect(stdinCommand.type).toBe('user-message');
    expect(stdinCommand).not.toHaveProperty('notification');
    expect(stdinCommand.text).toContain('[internal:message]');
    expect(stdinCommand.text).toContain('[Reply Instructions]');

    await waitFor(async () => {
      const hist = await sessionManager.getWorkerOutputHistory(sessionId, workerId, 0);
      return !!hist && hist.data.includes('user-message');
    });
    const history = await sessionManager.getWorkerOutputHistory(sessionId, workerId, 0);
    expect(history).not.toBeNull();

    const { events, parseFailures } = parseReplayLines(history!.data);
    expect(parseFailures).toEqual([]);

    const userMessageEvent = events.find((e) => e.type === 'user-message');
    expect(userMessageEvent).toBeDefined();
    expect(userMessageEvent).toMatchObject({
      type: 'user-message',
      notification: { kind: 'internal-message', summary: 'Message from session sender-title' },
    });
    // The reply-instructions suffix participates in the delivered/persisted
    // text but must never leak into the notification marker's fields.
    expect((userMessageEvent as { text: string }).text).toContain('[Reply Instructions]');
  });

  it('a notification with a summary-less kind persists `notification: { kind }` with NO `summary` key at all', async () => {
    const { sessionId, workerId } = await activateWorker();

    const result = await sessionManager.sendEmbeddedAgentSystemNotification(sessionId, workerId, {
      kind: 'internal-timer',
      tag: 'internal:timer',
      fields: { timerId: 'timer-1', action: 'fire', fireCount: '3' },
      intent: 'inform',
    });
    expect(result.ok).toBe(true);

    await waitFor(async () => {
      const hist = await sessionManager.getWorkerOutputHistory(sessionId, workerId, 0);
      return !!hist && hist.data.includes('user-message');
    });
    const history = await sessionManager.getWorkerOutputHistory(sessionId, workerId, 0);
    const { events, parseFailures } = parseReplayLines(history!.data);
    expect(parseFailures).toEqual([]);

    const userMessageEvent = events.find((e) => e.type === 'user-message') as
      | Extract<EmbeddedAgentStreamEvent, { type: 'user-message' }>
      | undefined;
    expect(userMessageEvent).toBeDefined();
    expect(userMessageEvent!.notification).toEqual({ kind: 'internal-timer' });
    expect('summary' in userMessageEvent!.notification!).toBe(false);
  });

  it('a plain human/API-caller message (sendEmbeddedAgentUserMessage) persists with NO `notification` key at all', async () => {
    const { sessionId, workerId } = await activateWorker();

    const result = await sessionManager.sendEmbeddedAgentUserMessage(sessionId, workerId, 'hello from a real user');
    expect(result.ok).toBe(true);

    await waitFor(async () => {
      const hist = await sessionManager.getWorkerOutputHistory(sessionId, workerId, 0);
      return !!hist && hist.data.includes('user-message');
    });
    const history = await sessionManager.getWorkerOutputHistory(sessionId, workerId, 0);
    const { events, parseFailures } = parseReplayLines(history!.data);
    expect(parseFailures).toEqual([]);

    const userMessageEvent = events.find((e) => e.type === 'user-message');
    expect(userMessageEvent).toBeDefined();
    expect(userMessageEvent).toMatchObject({ type: 'user-message', text: 'hello from a real user' });
    expect('notification' in (userMessageEvent as object)).toBe(false);
  });
});

describe('Client-Server Boundary: create_timer targeting an embedded-agent worker, via a real /mcp call authenticated with the worker\'s own MCP token (Issue #1574, R1/R2/R4)', () => {
  let sessionManager: SessionManager;
  let embeddedAgentManager: EmbeddedAgentManager;
  let jobQueue: JobQueue;
  let fake: ReturnType<typeof makeFakeSpawn>;
  let app: Hono;
  let mcpSessionId: string;
  let timerManager: TimerManager;
  let nextId: number;

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
      // Test seam: fake the loop subprocess (same rationale as the sibling
      // describe block above) so activation doesn't spawn a real `bun`.
      spawnAsUserFn: fake.fn,
    });

    // Real TimerManager wired to the real delivery seam -- mirrors
    // app-context.ts's timer-callback wiring (6.5) exactly, so this test
    // exercises the production callback shape rather than a
    // re-implementation of it.
    timerManager = new TimerManager((timer) => {
      void sessionManager.deliverWorkerNotification(timer.sessionId, timer.workerId, {
        kind: 'internal-timer',
        tag: 'internal:timer',
        fields: { timerId: timer.id, action: timer.action, fireCount: String(timer.fireCount) },
        intent: 'inform',
      });
    });

    const mcpApp = createMcpApp({
      sessionManager,
      repositoryManager: await RepositoryManager.create({ jobQueue }),
      agentManager,
      agentDirectory: new AgentDirectory({ terminal: agentManager, embedded: createEmptyEmbeddedAgentSurface() }),
      timerManager,
      conditionalWakeupManager: new ConditionalWakeupManager(() => {}),
      interactiveProcessManager: new InteractiveProcessManager(() => {}, () => {}),
      worktreeService: new WorktreeService({ db }),
      annotationService: new AnnotationService(),
      interSessionMessageService: new InterSessionMessageService(),
      suggestSessionMetadata: mock(
        async (): ReturnType<SuggestSessionMetadataFn> => Promise.resolve({ branch: 'feat/test', title: 'Test' })
      ) as SuggestSessionMetadataFn,
      createWorktreeWithSession,
      deleteWorktree,
      userRepository: new SqliteUserRepository(db),
      artifactRepository: new SqliteArtifactRepository(db),
      bookmarkRepository: new SqliteBookmarkRepository(db),
      broadcastToApp: () => {},
      findOpenPullRequest: mock(async () => null) as any,
      fetchPullRequestUrl: mock(async () => null) as any,
      // enforce mode makes the worker's-own-token assertion below load-bearing
      // (under 'warn'/'off' the call would succeed regardless of auth).
      mcpAuthMode: 'enforce',
      mcpTokenRegistry,
    });

    app = new Hono();
    app.route('', mcpApp);

    // Under enforce, the transport-level gate runs for EVERY /mcp request,
    // including the handshake itself -- mint a throwaway harness token
    // purely to get past that gate (mirrors mcp-server.test.ts's
    // remountMcpApp). This is unrelated to the worker's own token used by
    // the actual create_timer call below: mcpCallerStorage resolves the
    // caller fresh from the Authorization header on each request.
    const handshakeToken = mcpTokenRegistry.mint({
      sessionId: 'test-harness-handshake-session',
      workerId: 'test-harness-handshake-worker',
      userId: 'test-harness-handshake-user',
    });
    mcpSessionId = await initializeMcp(app, { Authorization: `Bearer ${handshakeToken}` });
    nextId = 100;
  });

  afterEach(async () => {
    timerManager.disposeAll();
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  it('a real /mcp create_timer call, authenticated with the worker\'s OWN minted MCP token, creates a timer targeting the embedded-agent worker', async () => {
    const userRepository = new SqliteUserRepository(getDatabase());
    const owner = await userRepository.upsertByOsUid(13579, 'owner2', '/home/owner2');

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

    // The worker's own minted MCP token is delivered to it via the init
    // command's `mcp.token` field (the same field the real subprocess reads
    // from its stdin to authenticate its OWN outbound MCP calls) -- extract
    // it here instead of minting a fresh one, so this call genuinely
    // authenticates AS the worker, not merely with SOME valid token.
    const initCommand = JSON.parse(fake.stdinWrites[0]) as { mcp: { token: string } };
    const workerOwnToken = initCommand.mcp.token;
    expect(workerOwnToken).toBeTruthy();

    const response = await callTool(app, mcpSessionId, 'create_timer', {
      sessionId: session.id,
      workerId,
      intervalSeconds: 60,
      action: 'Check CI status',
    }, nextId++, { Authorization: `Bearer ${workerOwnToken}` });

    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as { timerId: string; sessionId: string; workerId: string };
    expect(data.timerId).toBeDefined();
    expect(data.sessionId).toBe(session.id);
    expect(data.workerId).toBe(workerId);

    // Negative control: the SAME call with no Authorization header is
    // rejected at the transport gate under enforce mode -- this is what
    // makes the success above attributable to the worker's own token,
    // rather than to auth being a no-op in this harness. A raw `app.request`
    // call is used here (not the `callTool` helper) because the helper
    // asserts HTTP 200, which a transport-level rejection is not.
    const unauthenticatedRes = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': mcpSessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'create_timer',
          arguments: { sessionId: session.id, workerId, intervalSeconds: 60, action: 'unauthenticated attempt' },
        },
        id: nextId++,
      }),
    });
    expect(unauthenticatedRes.status).toBe(401);
  });
});
