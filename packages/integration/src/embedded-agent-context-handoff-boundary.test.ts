/**
 * Cross-Package Boundary Test: Context Handoff (Phase A) wire round trips.
 *
 * This is the Q10 wire-boundary test `docs/design/embedded-agent-worker.md`
 * "Context Handoff (Phase A)" > Testing > Integration explicitly requires,
 * extending the pattern established by
 * `embedded-agent-client-message-id-boundary.test.ts` to the two new pieces
 * Context Handoff (Phase A) added to the shared schemas:
 *
 *  1. The `context-usage` / `context-handoff` NDJSON stream events: loop
 *     stdout -> `EmbeddedAgentWorkerService`'s `KNOWN_EVENT_TYPES` +
 *     `EmbeddedAgentEventSchema` validation -> persisted append -> history
 *     replay -> the client's REAL `EmbeddedAgentStreamEventSchema` parser.
 *  2. `EmbeddedAgentDefinition.contextWindowTokens` / `handoff`: REST create
 *     -> SQLite round trip (`toEmbeddedAgentRow` / `toEmbeddedAgentDefinition`)
 *     -> the REAL `EmbeddedAgentDefinitionSchema` (the same schema backing
 *     the `embedded-agent-created` / `embedded-agent-updated` registry
 *     broadcast) -> PATCH-clear semantics.
 *
 * Per pre-pr-completeness.md Question 10: valibot's default strip-unknown-
 * fields behavior means a missed schema edit (TS type updated but the
 * strictObject schema left stale) would silently drop the field with no
 * compile/runtime error anywhere else in the stack. Unit tests on either
 * side of the wire (loop package, server service, client schema in
 * isolation) do not cross this specific boundary.
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

import {
  EmbeddedAgentStreamEventSchema,
  EmbeddedAgentDefinitionSchema,
  AppServerMessageSchema,
  type EmbeddedAgentStreamEvent,
} from '@agent-console/shared';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService. */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

/**
 * Fake `spawnAsUser` whose stdout is a controllable stream: unlike the
 * client-message-id boundary test's `makeFakeSpawn` (whose stdout never
 * emits), this test needs to simulate the loop asynchronously writing
 * `context-usage` / `context-handoff` NDJSON lines to stdout AFTER
 * activation. A `ReadableStream`'s `start(controller)` callback runs
 * synchronously at construction time, so capturing `controller` here lets
 * the test push bytes on demand while `EmbeddedAgentWorkerService`'s
 * `readStdout` loop (started fire-and-forget at activation) is already
 * awaiting `reader.read()`.
 */
function makeFakeSpawnWithControllableStdout(): {
  fn: SpawnAsUserFn;
  captured: SpawnAsUserOpts[];
  stdinWrites: string[];
  pushStdoutLine: (line: object) => void;
} {
  const captured: SpawnAsUserOpts[] = [];
  const stdinWrites: string[] = [];
  const encoder = new TextEncoder();
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
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
  const subprocess = { pid: 8889, exited, stdin, stdout, stderr, kill: () => {} };
  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    return { subprocess, stdin, elevated: false } as unknown as SpawnAsUserResult;
  };
  return {
    fn,
    captured,
    stdinWrites,
    pushStdoutLine: (line: object) => {
      if (!stdoutController) throw new Error('stdout controller not initialized');
      stdoutController.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
    },
  };
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

describe('Client-Server Boundary: Context Handoff (Phase A) wire round trips', () => {
  let sessionManager: SessionManager;
  let embeddedAgentManager: EmbeddedAgentManager;
  let jobQueue: JobQueue;
  let fake: ReturnType<typeof makeFakeSpawnWithControllableStdout>;

  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    await initializeDatabase(':memory:');

    jobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(jobQueue, new WorkerOutputFileManager());

    ptyFactory.reset();
    resetGitMocks();
    fake = makeFakeSpawnWithControllableStdout();

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
      // real activate/append/persist machinery without spawning a real `bun`
      // process (that shipping-path E2E is covered separately).
      spawnAsUserFn: fake.fn,
    });
  });

  afterEach(async () => {
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  it('context-usage and context-handoff NDJSON lines survive the full loop stdout -> persisted-file -> client-parse round trip', async () => {
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

    await sessionManager.activateEmbeddedAgentWorker(session.id, workerId);
    expect(fake.captured.length).toBe(1);

    // Simulate the loop emitting a context-usage reading followed by a
    // successful handoff's distillation marker (the two Context Handoff
    // (Phase A) event shapes) directly on the fake subprocess's stdout.
    fake.pushStdoutLine({ v: 1, type: 'context-usage', promptTokens: 1234, estimated: false });
    fake.pushStdoutLine({ v: 1, type: 'context-handoff', distillation: 'a distilled summary' });

    await waitFor(async () => {
      const hist = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
      return !!hist && hist.data.includes('context-handoff');
    });
    const history = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
    expect(history).not.toBeNull();

    const { events, parseFailures } = parseReplayLines(history!.data);
    expect(parseFailures).toEqual([]);

    const usageEvent = events.find((e) => e.type === 'context-usage');
    expect(usageEvent).toBeDefined();
    expect(usageEvent).toMatchObject({
      type: 'context-usage',
      promptTokens: 1234,
      estimated: false,
    });

    const handoffEvent = events.find((e) => e.type === 'context-handoff');
    expect(handoffEvent).toBeDefined();
    expect(handoffEvent).toMatchObject({
      type: 'context-handoff',
      distillation: 'a distilled summary',
    });
  });

  it('EmbeddedAgentDefinition.contextWindowTokens/handoff survive create, the SQLite round trip, the registry broadcast schema, and PATCH-clear', async () => {
    const userRepository = new SqliteUserRepository(getDatabase());
    const owner = await userRepository.upsertByOsUid(13570, 'owner2', '/home/owner2');

    const created = await embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Handoff-capable model',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
        contextWindowTokens: 128000,
        handoff: { softRatio: 0.8, hardRatio: 0.95 },
      },
      owner.id,
    );

    // Parse the in-memory create() return value through the REAL schema that
    // also backs the embedded-agent-created / embedded-agent-updated
    // registry broadcast payload.
    const parsedCreated = v.parse(EmbeddedAgentDefinitionSchema, created);
    expect(parsedCreated.contextWindowTokens).toBe(128000);
    expect(parsedCreated.handoff).toEqual({ softRatio: 0.8, hardRatio: 0.95 });

    // Extra rigor: parse through the wrapper schema backing the actual WS
    // broadcast envelope (embedded-agent-created), proving the field survives
    // that boundary too, not just the bare definition schema.
    const parsedBroadcast = v.parse(AppServerMessageSchema, {
      type: 'embedded-agent-created',
      embeddedAgent: created,
    });
    if (parsedBroadcast.type !== 'embedded-agent-created') {
      throw new Error(`expected embedded-agent-created, got ${parsedBroadcast.type}`);
    }
    expect(parsedBroadcast.embeddedAgent.contextWindowTokens).toBe(128000);
    expect(parsedBroadcast.embeddedAgent.handoff).toEqual({ softRatio: 0.8, hardRatio: 0.95 });

    // Prove the SQLite round trip (toEmbeddedAgentRow / toEmbeddedAgentDefinition)
    // also preserves the fields, not just the in-memory object create() returned.
    const fetched = embeddedAgentManager.getEmbeddedAgent(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.contextWindowTokens).toBe(128000);
    expect(fetched!.handoff).toEqual({ softRatio: 0.8, hardRatio: 0.95 });
    const parsedFetched = v.parse(EmbeddedAgentDefinitionSchema, fetched);
    expect(parsedFetched.contextWindowTokens).toBe(128000);
    expect(parsedFetched.handoff).toEqual({ softRatio: 0.8, hardRatio: 0.95 });

    // PATCH-clear: `handoff: null` clears to undefined, whole-object-replace
    // semantics independent of contextWindowTokens (which is left untouched).
    const updated = await embeddedAgentManager.updateEmbeddedAgent(created.id, { handoff: null });
    expect(updated).not.toBeNull();
    expect(updated!.handoff).toBeUndefined();
    expect(updated!.contextWindowTokens).toBe(128000);

    const parsedUpdated = v.parse(EmbeddedAgentDefinitionSchema, updated);
    expect(parsedUpdated.handoff).toBeUndefined();
    expect(parsedUpdated.contextWindowTokens).toBe(128000);
  });
});
