/**
 * Cross-Package Boundary Test: the embedded-agent CLIENT-DISPLAY initial
 * `request-history` response across a real output-file rotation (#1506).
 *
 * Sibling of `embedded-agent-worker-history-boundary.test.ts` (#1021), which
 * proved the byte-offset/epoch history machinery round-trips NDJSON for an
 * embedded-agent worker but never rotates the output file (its content stays
 * well under any `fileMaxSize`). It is also the display-side counterpart of
 * `embedded-agent-restore-rotation-boundary.test.ts` (#1202), which proved
 * ROTATION-CROSSING RESTORE reconstructs whole through a real
 * `WorkerOutputFileManager` -- but that test calls the manager directly and
 * never reaches `WorkerLifecycleManager.getWorkerOutputHistory`'s routing, so
 * it cannot see the display-side defect #1506 fixes.
 *
 * This test drives the REAL `SessionManager.getWorkerOutputHistory` --
 * `WorkerLifecycleManager`'s `worker.type === 'embedded-agent'` routing branch
 * to `readHistoryForDisplay` -- with a REAL rotated `WorkerOutputFileManager`
 * injected via `SessionManager.create`'s `workerOutputFileManager` option,
 * and with `maxLines` supplied, exactly as `routes.ts`'s `request-history`
 * handler always does for a live WS connection. No React client is involved
 * (out of reach for this test suite); `embedded-agent-store.ts`'s consumption
 * of the response was audited by hand instead (#1506 PR body, R3) and found
 * to need no change, since it already keys off `startOffset !==
 * requestedFromOffset` rather than any assumption that `startOffset` cannot
 * precede `liveBaseOffset`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { setupMemfs, cleanupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createMockPtyFactory } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { resetGitMocks } from '@agent-console/server/src/__tests__/utils/mock-git-helper';
import { initializeDatabase, closeDatabase, getDatabase } from '@agent-console/server/src/database/connection';
import { JobQueue } from '@agent-console/server/src/jobs/job-queue';
import { registerJobHandlers } from '@agent-console/server/src/jobs/handlers';
import { WorkerOutputFileManager } from '@agent-console/server/src/lib/worker-output-file';
import { serverConfig } from '@agent-console/server/src/lib/server-config';
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
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';
import { defaultRepositoryLookup, defaultRepositoryEnvLookup } from '@agent-console/server/src/__tests__/utils/repository-lookup-mock';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();

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
  const stdin: FakeFileSink = { write: () => 0, end: () => {}, flush: () => 0 };
  const subprocess = { pid: 9998, exited, stdin, stdout: stdout.stream, stderr: stderr.stream, kill: () => {} };
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

const line = (event: unknown): string => `${JSON.stringify(event)}\n`;

describe('Client-Server Boundary: embedded-agent display history across a real rotation (#1506)', () => {
  let sessionManager: SessionManager;
  let embeddedAgentManager: EmbeddedAgentManager;
  let jobQueue: JobQueue;
  let fake: ReturnType<typeof makeFakeSpawn>;
  let fileManager: WorkerOutputFileManager;

  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    await initializeDatabase(':memory:');

    // A REAL WorkerOutputFileManager with a small fileMaxSize, so the fixture
    // below drives a genuine rotation (real gzip segments on the real memfs
    // filesystem) rather than a fixture too small to ever cut.
    fileManager = new WorkerOutputFileManager({
      flushThreshold: serverConfig.WORKER_OUTPUT_FLUSH_THRESHOLD,
      flushInterval: serverConfig.WORKER_OUTPUT_FLUSH_INTERVAL,
      fileMaxSize: 400,
      maxSegments: 0,
    });

    jobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(jobQueue, fileManager);

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
      mcpTokenRegistry: new McpTokenRegistry(),
      repositoryLookup: defaultRepositoryLookup,
      repositoryEnvLookup: defaultRepositoryEnvLookup,
      annotationService: new AnnotationService(),
      workerOutputFileManager: fileManager,
      // Test seam: fake the loop subprocess so this boundary test exercises
      // the real history-serving machinery without spawning a real `bun`
      // process (that shipping-path E2E is covered separately).
      spawnAsUserFn: fake.fn,
    });
  });

  afterEach(async () => {
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  it('a reconnecting client\'s initial display window includes pre-rotation content -- the shape #1506 reported', async () => {
    const userRepository = new SqliteUserRepository(getDatabase());
    const owner = await userRepository.upsertByOsUid(24681, 'owner', '/home/owner');

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

    // Early burst: the content a reconnecting client must still be able to
    // see. Flushed and force-cut past it by later traffic.
    //
    // LOOP-emitted event types only (`EmbeddedAgentEventSchema`, the strict
    // schema the service's own stdout-line reader validates against) --
    // `user-message` is SERVER-authored (`EmbeddedAgentServerEventSchema`,
    // reachable only via `sendEmbeddedAgentUserMessage`, never emitted by the
    // subprocess itself) and would be silently dropped if pushed here.
    fake.pushStdout(line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'PRE-ROTATION-MARKER' }));
    fake.pushStdout(line({ v: 1, type: 'state', state: 'idle' }));
    await waitFor(async () => {
      const hist = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
      return !!hist && hist.data.includes('PRE-ROTATION-MARKER');
    });
    // Force the early burst onto disk (not merely the in-memory pending
    // buffer, which readHistoryWithOffset/readHistoryForDisplay both already
    // see) so the LATER push's flush has a live file to cut.
    await fileManager.forceFlush(session.id, workerId);

    // Later traffic: large enough to push the marker out of the live window
    // once flushed (fileMaxSize: 400).
    fake.pushStdout(line({ v: 1, type: 'assistant-message', turnId: 't2', text: 'second question' }));
    fake.pushStdout(line({ v: 1, type: 'assistant-message', turnId: 't3', text: 'x'.repeat(600) }));
    fake.pushStdout(line({ v: 1, type: 'assistant-message', turnId: 't4', text: 'third question' }));
    fake.pushStdout(line({ v: 1, type: 'assistant-message', turnId: 't5', text: 'y'.repeat(600) }));
    await waitFor(async () => {
      const hist = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
      return !!hist && hist.data.includes('third question');
    });
    await fileManager.forceFlush(session.id, workerId);

    // PREMISE CONTROL: rotation genuinely happened, and the OLD initial-load
    // read (no maxLines -- readHistoryWithOffset's own initial-load branch,
    // unaffected by #1506) can no longer see the marker directly from the
    // live window. This is the exact server log shape #1506's own Issue
    // reproduction observed (`startOffset` past the client's requested 0).
    const liveOnly = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
    expect(liveOnly).not.toBeNull();
    expect(liveOnly!.startOffset).toBeGreaterThan(0);
    expect(liveOnly!.data).not.toContain('PRE-ROTATION-MARKER');

    // THE FIX: the same call shape routes.ts's request-history handler makes
    // for a live WS connection -- fromOffset 0, maxLines supplied.
    const display = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0, 8);
    expect(display).not.toBeNull();
    expect(display!.data).toContain('PRE-ROTATION-MARKER');
    expect(display!.data).toContain('third question');
  });
});

/**
 * Polarity, measured (workflow.md's TDD-for-bug-fixes discipline). Gating
 * `WorkerLifecycleManager.getWorkerOutputHistory`'s `worker.type ===
 * 'embedded-agent'` routing branch behind `if (false && ...)` -- so the call
 * falls through to the pre-#1506 `readLastNLines` path exactly as it did on
 * unmodified `main` -- makes this test fail on
 * `expect(display!.data).toContain('PRE-ROTATION-MARKER')`, received the
 * live-only tail (a lone `y`-repeat line) instead. Restoring the branch makes
 * it pass again. Measured 2026-08-30.
 */

