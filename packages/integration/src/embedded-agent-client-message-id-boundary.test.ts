/**
 * Cross-Package Boundary Test: embedded-agent `clientMessageId` correlation
 * round-trip.
 *
 * An earlier fix made the client's `sendUserMessage` wait for the server's
 * `user-message` echo before resolving, but the echo wasn't correlated to a
 * specific send -- with the same worker open in two tabs, either tab's
 * pending promise could be resolved by the OTHER tab's echo. This fix adds a
 * client-generated `clientMessageId` that flows client -> server ->
 * persisted-event, so the client can strictly match its own echo.
 *
 * This test exercises the REAL chain end to end:
 *   - SessionManager.sendEmbeddedAgentUserMessage(..., clientMessageId) (the
 *     real pass-through wrapper routes.ts calls, backed by the real
 *     EmbeddedAgentWorkerService, not a spy)
 *   - the appended server event lands in the persisted output file
 *   - the persisted bytes are read back via the same byte-offset history
 *     machinery the WS route uses (SessionManager.getWorkerOutputHistory)
 *   - each NDJSON line is parsed with the client's REAL parser
 *     (EmbeddedAgentStreamEventSchema, per architect pre-directive #3)
 *   - the parsed `user-message` event's `clientMessageId` matches the value
 *     passed in, verbatim
 *
 * This is the wire-boundary test pre-pr-completeness.md Question 10 requires:
 * valibot's default strip-unknown-fields behavior means a missed schema edit
 * (TS type updated but the strictObject schema left stale) would silently
 * drop the field with no compile/runtime error anywhere else in the stack.
 * Unit tests on either side (routes-embedded-agent.test.ts stops at the WS
 * dispatch layer; embedded-agent-worker-service's own suite stops at the
 * service API) do not cross this specific boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';

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
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '@agent-console/server/src/services/privilege-elevation';

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
  const subprocess = { pid: 8888, exited, stdin, stdout, stderr, kill: () => {} };
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

describe('Client-Server Boundary: embedded-agent clientMessageId round trip', () => {
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

  it('a clientMessageId supplied to sendEmbeddedAgentUserMessage survives the full server -> persisted-file -> parse round trip verbatim', async () => {
    const userRepository = new SqliteUserRepository(getDatabase());
    const owner = await userRepository.upsertByOsUid(13579, 'owner', '/home/owner');

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

    const result = await sessionManager.sendEmbeddedAgentUserMessage(
      session.id,
      workerId,
      'hello from tab B',
      'tab-b-client-message-id',
    );
    expect(result.ok).toBe(true);

    // The stdin command sent to the loop must NOT carry clientMessageId (loop
    // protocol is unchanged) -- correlation is strictly client<->server.
    await waitFor(() => fake.stdinWrites.length >= 2);
    const stdinCommand = JSON.parse(fake.stdinWrites[1]);
    expect(stdinCommand.type).toBe('user-message');
    expect(stdinCommand.text).toBe('hello from tab B');
    expect(stdinCommand).not.toHaveProperty('clientMessageId');

    // Read back the persisted history (the exact call the WS route makes for
    // a fresh client connection) and parse it with the client's REAL parser.
    await waitFor(async () => {
      const hist = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
      return !!hist && hist.data.includes('user-message');
    });
    const history = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
    expect(history).not.toBeNull();

    const { events, parseFailures } = parseReplayLines(history!.data);
    expect(parseFailures).toEqual([]);

    const userMessageEvent = events.find((e) => e.type === 'user-message');
    expect(userMessageEvent).toBeDefined();
    expect(userMessageEvent).toMatchObject({
      type: 'user-message',
      text: 'hello from tab B',
      clientMessageId: 'tab-b-client-message-id',
    });
  });
});
