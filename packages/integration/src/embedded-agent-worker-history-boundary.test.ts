/**
 * Cross-Package Boundary Test: embedded-agent worker reconnect + history
 * replay (Issue #1021, Phase 3 of the embedded-agent-worker umbrella #1004).
 *
 * Exercises the real server path the worker WS route (routes.ts's
 * `embedded-agent` branch) relies on to serve history: the byte-offset/epoch
 * history machinery (`SessionManager.getWorkerOutputHistory`, backed by the
 * real `WorkerOutputFileManager`, not a spy) is content-agnostic and already
 * proven for PTY workers (`worker-history-offset-boundary.test.ts`); this test
 * proves the same machinery round-trips NDJSON `EmbeddedAgentStreamEvent` bytes
 * for an embedded-agent worker:
 *
 *   - activate (real EmbeddedAgentWorkerService, fake spawnAsUserFn: no real
 *     subprocess — the loop's own event-generation logic is out of scope here,
 *     covered by packages/embedded-agent's own unit suite and the E2E test)
 *   - simulate the loop streaming a few structured events over stdout
 *   - read history from offset 0 ("connect"), parse every line with the client's
 *     REAL parser (`EmbeddedAgentStreamEventSchema`, the FULL union per architect
 *     pre-directive #3 — not the loop-only `EmbeddedAgentEventSchema`)
 *   - simulate more streaming (as if the loop kept going after a client
 *     "disconnected")
 *   - read history again from the offset recorded after the first read
 *     ("reconnect with offset") and assert ONLY the new tail bytes come back
 *   - assert the two reads' data concatenate to the full accumulated log
 *
 * Unit tests on either side (EmbeddedAgentWorkerService's own suite stops at
 * the service API; routes-embedded-agent.test.ts stops at the WS dispatch
 * layer without simulating stdout at all) do not cross this specific boundary.
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

interface ControllableStream {
  stream: ReadableStream<Uint8Array>;
  push: (s: string) => void;
}

function makeControllableStream(): ControllableStream {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const enc = new TextEncoder();
  return { stream, push: (s: string) => ctrl.enqueue(enc.encode(s)) };
}

function makeFakeSpawn(): {
  fn: SpawnAsUserFn;
  captured: SpawnAsUserOpts[];
  pushStdout: (s: string) => void;
} {
  const captured: SpawnAsUserOpts[] = [];
  const stdout = makeControllableStream();
  const stderr = makeControllableStream();
  const exited = new Promise<number>(() => {
    // Never resolves — this test never deactivates the worker.
  });
  const stdin: FakeFileSink = {
    write: () => 0,
    end: () => {},
    flush: () => 0,
  };
  const subprocess = { pid: 9999, exited, stdin, stdout: stdout.stream, stderr: stderr.stream, kill: () => {} };
  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    return { subprocess, stdin, elevated: false } as unknown as SpawnAsUserResult;
  };
  return { fn, captured, pushStdout: stdout.push };
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

describe('Client-Server Boundary: embedded-agent worker reconnect + history replay', () => {
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
      // Test seam: fake the loop subprocess so this boundary test exercises the
      // real history-serving machinery without spawning a real `bun` process
      // (that shipping-path E2E is covered separately).
      spawnAsUserFn: fake.fn,
    });
  });

  afterEach(async () => {
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  it('reconnecting with a cached offset returns only the tail, and both reads parse as valid EmbeddedAgentStreamEvent lines', async () => {
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

    // Simulate the loop streaming a user turn's worth of structured events.
    fake.pushStdout(`${JSON.stringify({ v: 1, type: 'ready' })}\n`);
    fake.pushStdout(`${JSON.stringify({ v: 1, type: 'state', state: 'active' })}\n`);
    fake.pushStdout(
      `${JSON.stringify({ v: 1, type: 'assistant-delta', turnId: 't1', text: 'Hello' })}\n`,
    );

    // "Connect": read history from offset 0 (the exact call the WS route makes
    // for a fresh client connection).
    await waitFor(async () => {
      const hist = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
      return !!hist && hist.data.includes('assistant-delta');
    });
    const firstRead = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
    expect(firstRead).not.toBeNull();
    const firstParsed = parseReplayLines(firstRead!.data);
    expect(firstParsed.parseFailures).toEqual([]);
    expect(firstParsed.events.map((e) => e.type)).toEqual(['ready', 'state', 'assistant-delta']);

    const cachedOffset = firstRead!.offset;

    // Simulate the client disconnecting (no server-side effect on the loop —
    // parity with PTY workers) and the loop continuing to stream.
    fake.pushStdout(
      `${JSON.stringify({ v: 1, type: 'assistant-message', turnId: 't1', text: 'Hello world' })}\n`,
    );
    fake.pushStdout(`${JSON.stringify({ v: 1, type: 'state', state: 'idle' })}\n`);

    // "Reconnect with offset": request history from the cached offset — the
    // exact call the WS route makes for request-history with fromOffset set.
    await waitFor(async () => {
      const hist = await sessionManager.getWorkerOutputHistory(session.id, workerId, cachedOffset);
      return !!hist && hist.data.includes('assistant-message');
    });
    const secondRead = await sessionManager.getWorkerOutputHistory(session.id, workerId, cachedOffset);
    expect(secondRead).not.toBeNull();

    // Only the tail bytes come back, not a re-send of the first read's data.
    expect(secondRead!.data).not.toContain('assistant-delta');
    expect(secondRead!.startOffset).toBe(cachedOffset);

    const secondParsed = parseReplayLines(secondRead!.data);
    expect(secondParsed.parseFailures).toEqual([]);
    expect(secondParsed.events.map((e) => e.type)).toEqual(['assistant-message', 'state']);

    // The two reads concatenate to the full accumulated log.
    const combined = firstRead!.data + secondRead!.data;
    const combinedParsed = parseReplayLines(combined);
    expect(combinedParsed.events.map((e) => e.type)).toEqual([
      'ready',
      'state',
      'assistant-delta',
      'assistant-message',
      'state',
    ]);

    // Same epoch across both reads (no restart happened mid-test).
    expect(secondRead!.epoch).toBe(firstRead!.epoch);
  });
});
