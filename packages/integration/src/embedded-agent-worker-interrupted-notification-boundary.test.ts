/**
 * Client-Server Boundary Test: `deliverWorkerNotification`, embedded-agent
 * target for the `internal-worker-interrupted` kind (the interrupted-turn parent notification feature).
 *
 * Modeled closely on `conditional-wakeup-boundary.test.ts`'s
 * "Client-Server Boundary: deliverWorkerNotification, embedded-agent target
 * for a conditional-wakeup notification" describe block: same memfs /
 * fake-spawn setup, same real `SessionManager` -> `EmbeddedAgentWorkerService`
 * -> persisted-file chain, with a fake loop subprocess standing in for the
 * child process itself (the delivery/persistence machinery under test is
 * entirely server-side of that boundary).
 *
 * This test is NOT about re-exercising Site 1 / Site 2 detection (the
 * e2e-native test owns that) -- it calls
 * `SessionManager.deliverWorkerNotification` directly with the
 * `internal-worker-interrupted` params shape a real Site 1/Site 2 call
 * would compose, and asserts the delivery + persistence + schema-validation
 * chain for the NEW wire kind. On `main` before the `PTY_NOTIFICATION_KINDS`
 * addition, this fails on the unknown kind at the `v.safeParse` assertion
 * below -- that is this test's polarity.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';
import { EmbeddedAgentServerEventSchema, type EmbeddedAgentServerEvent } from '@agent-console/shared';

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
import { defaultRepositoryLookup, defaultRepositoryEnvLookup } from '@agent-console/server/src/__tests__/utils/repository-lookup-mock';
import type { SpawnAsUserFn, SpawnAsUserOpts } from '@agent-console/server/src/services/privilege-elevation';
import { toSpawnAsUserResult, type FakeFileSink, type FakeSubprocess } from '@agent-console/server/src/__tests__/utils/fake-spawn-as-user';

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
    // Never resolves — this test never deactivates the worker.
  });
  const stdin: FakeFileSink = {
    write: (chunk: string | Uint8Array) => {
      stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return 0;
    },
    end: () => {
      return 0;
    },
    flush: () => 0,
  };
  const subprocess: FakeSubprocess = { pid: 8889, exited, stdin, stdout, stderr, kill: () => {} };
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

describe('Client-Server Boundary: deliverWorkerNotification, embedded-agent target for an interrupted-turn parent notification', () => {
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
      spawnAsUserFn: fake.fn,
    });
  });

  afterEach(async () => {
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  it('an internal-worker-interrupted notification delivered via the seam activates the worker and persists a schema-valid user-message row', async () => {
    const userRepository = new SqliteUserRepository(getDatabase());
    const owner = await userRepository.upsertByOsUid(97532, 'interrupted-owner', '/home/interrupted-owner');

    const definition = await embeddedAgentManager.createEmbeddedAgent(
      { engine: 'openai-api', name: 'Local model', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );
    // Session P: the delegating parent that receives the notification.
    const parentSession = await sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path' },
      { createdBy: owner.id },
    );
    const parentWorker = await sessionManager.createWorker(parentSession.id, {
      type: 'embedded-agent',
      embeddedAgentId: definition.id,
    });
    expect(parentWorker).not.toBeNull();
    const parentWorkerId = parentWorker!.id;

    const summary =
      'Embedded worker child-w (session child-s): turn turn-1 was interrupted (exit, unexpected) and will not complete';

    // Deactivated (dormant) -- deliverWorkerNotification must activate on
    // delivery, mirroring a real Site 1/Site 2 call against a parent worker
    // with no live subprocess.
    expect(fake.captured.length).toBe(0);
    const result = await sessionManager.deliverWorkerNotification(parentSession.id, parentWorkerId, {
      kind: 'internal-worker-interrupted',
      tag: 'internal:worker-interrupted',
      fields: {
        sessionId: 'child-s',
        workerId: 'child-w',
        turnId: 'turn-1',
        cause: 'exit',
        exitReason: 'unexpected',
        exitCode: '1',
        summary,
        hint: 'Re-send your instruction with send_session_message, or restart the worker; do not wait for a reply to the interrupted turn',
      },
      intent: 'triage',
    });
    expect(result).toEqual({ ok: true });
    expect(fake.captured.length).toBe(1);

    await waitFor(async () => {
      const hist = await sessionManager.getWorkerOutputHistory(parentSession.id, parentWorkerId, 0);
      return !!hist && hist.data.includes('user-message');
    });
    const history = await sessionManager.getWorkerOutputHistory(parentSession.id, parentWorkerId, 0);
    expect(history).not.toBeNull();

    const lines = (history!.data as string).split('\n').filter((line) => line.length > 0);
    const userMessageLine = lines.map((line) => JSON.parse(line) as unknown).find(
      (parsed) => (parsed as { type?: string }).type === 'user-message',
    );
    expect(userMessageLine).toBeDefined();

    // The real point of this test: the NEW wire kind must validate against
    // the real EmbeddedAgentServerEventSchema. On `main` before the
    // `PTY_NOTIFICATION_KINDS` addition, `v.picklist` rejects the unknown
    // kind and this `safeParse` fails -- that is this test's polarity.
    const parsed = v.safeParse(EmbeddedAgentServerEventSchema, userMessageLine);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const event = parsed.output as EmbeddedAgentServerEvent;
    expect(event.type).toBe('user-message');
    if (event.type !== 'user-message') return;
    expect(event.notification).toEqual({ kind: 'internal-worker-interrupted', summary });
    expect(event.text).toContain('[internal:worker-interrupted]');
    expect(event.text).toContain('turnId=turn-1');
    expect(event.text).toContain('cause=exit');
  });
});
