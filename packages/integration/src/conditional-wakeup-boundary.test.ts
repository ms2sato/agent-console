/**
 * Client-Server Boundary Test: ConditionalWakeup Types
 *
 * Tests that the ConditionalWakeupInfo type from @agent-console/shared
 * is properly exported and can be consumed across package boundaries.
 * This validates the cross-package contract for Issue #700.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { ConditionalWakeupInfo } from '@agent-console/shared';

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
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '@agent-console/server/src/services/privilege-elevation';

describe('Cross-Package Contract: ConditionalWakeup Types', () => {
  it('should export ConditionalWakeupInfo from shared package', async () => {
    // Import ConditionalWakeupInfo from shared package
    const sharedModule = await import('@agent-console/shared');

    // Verify the module loads successfully
    expect(sharedModule).toBeDefined();

    // Create a ConditionalWakeupInfo-compatible object to verify the contract
    const wakeupInfo: ConditionalWakeupInfo = {
      id: 'test-wakeup-123',
      sessionId: 'session-abc',
      workerId: 'worker-xyz',
      intervalSeconds: 30,
      conditionScript: 'exit 0',
      onTrueMessage: 'Condition met successfully!',
      timeoutSeconds: 600,
      onTimeoutMessage: 'Operation timed out',
      createdAt: '2026-04-27T00:00:00.000Z',
      lastCheckedAt: '2026-04-27T00:00:30.000Z',
      checkCount: 1,
      status: 'running' as const
    };

    // Verify structure matches expected interface
    expect(wakeupInfo.id).toBe('test-wakeup-123');
    expect(wakeupInfo.sessionId).toBe('session-abc');
    expect(wakeupInfo.workerId).toBe('worker-xyz');
    expect(wakeupInfo.intervalSeconds).toBe(30);
    expect(wakeupInfo.conditionScript).toBe('exit 0');
    expect(wakeupInfo.onTrueMessage).toBe('Condition met successfully!');
    expect(wakeupInfo.timeoutSeconds).toBe(600);
    expect(wakeupInfo.onTimeoutMessage).toBe('Operation timed out');
    expect(wakeupInfo.createdAt).toBe('2026-04-27T00:00:00.000Z');
    expect(wakeupInfo.lastCheckedAt).toBe('2026-04-27T00:00:30.000Z');
    expect(wakeupInfo.checkCount).toBe(1);
    expect(wakeupInfo.status).toBe('running');
  });

  it('should support all status values for ConditionalWakeupInfo', async () => {
    const statusValues: Array<'running' | 'completed_true' | 'completed_timeout' | 'cancelled'> = [
      'running',
      'completed_true',
      'completed_timeout',
      'cancelled'
    ];

    for (const status of statusValues) {
      const wakeupInfo: ConditionalWakeupInfo = {
        id: `test-${status}`,
        sessionId: 'session-test',
        workerId: 'worker-test',
        intervalSeconds: 30,
        conditionScript: 'echo test',
        onTrueMessage: 'Success',
        createdAt: '2026-04-27T00:00:00.000Z',
        checkCount: 0,
        status
      };

      expect(wakeupInfo.status).toBe(status);
    }
  });

  it('should support optional fields in ConditionalWakeupInfo', async () => {
    // Test minimal ConditionalWakeupInfo without optional fields
    const minimalWakeupInfo: ConditionalWakeupInfo = {
      id: 'minimal-test',
      sessionId: 'session-minimal',
      workerId: 'worker-minimal',
      intervalSeconds: 60,
      conditionScript: 'true',
      onTrueMessage: 'Done',
      createdAt: '2026-04-27T00:00:00.000Z',
      checkCount: 0,
      status: 'running' as const
    };

    // Optional fields should be undefined
    expect(minimalWakeupInfo.timeoutSeconds).toBeUndefined();
    expect(minimalWakeupInfo.onTimeoutMessage).toBeUndefined();
    expect(minimalWakeupInfo.lastCheckedAt).toBeUndefined();

    // Required fields should be present
    expect(minimalWakeupInfo.id).toBe('minimal-test');
    expect(minimalWakeupInfo.status).toBe('running');
  });
});

// ---------- Delivery-seam boundary: embedded-agent conditional-wakeup target (Issue #1574, R1) ----------

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

/**
 * Boundary test for `SessionManager.deliverWorkerNotification`'s embedded-
 * agent branch, specifically for the `internal-conditional-wakeup` kind
 * (the kind ConditionalWakeupManagerClass's callback in app-context.ts
 * composes). `embedded-agent-notification-boundary.test.ts` already covers
 * the `internal-message` and `internal-timer` kinds through the same seam
 * end-to-end; this is the conditional-wakeup sibling, exercising the REAL
 * SessionManager -> EmbeddedAgentWorkerService -> persisted-file chain
 * (a fake loop subprocess stands in for the child process itself, same
 * rationale as the sibling boundary test -- the delivery/persistence
 * machinery under test is entirely server-side of that boundary).
 */
describe('Client-Server Boundary: deliverWorkerNotification, embedded-agent target for a conditional-wakeup notification (Issue #1574, R1)', () => {
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

  it('an internal-conditional-wakeup notification delivered via the seam activates the worker and persists a user-message row with notification.kind === internal-conditional-wakeup', async () => {
    const userRepository = new SqliteUserRepository(getDatabase());
    const owner = await userRepository.upsertByOsUid(97531, 'wakeup-owner', '/home/wakeup-owner');

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

    // Deactivated (dormant) -- deliverWorkerNotification must activate on
    // delivery (R4), mirroring app-context.ts's real wakeup callback firing
    // against a worker that has no live subprocess.
    expect(fake.captured.length).toBe(0);
    const result = await sessionManager.deliverWorkerNotification(session.id, workerId, {
      kind: 'internal-conditional-wakeup',
      tag: 'internal:conditional-wakeup',
      fields: {
        wakeupId: 'wakeup-1',
        status: 'completed_true',
        checkCount: '3',
        message: 'PR #1574 is ready for merge',
      },
      intent: 'inform',
    });
    expect(result).toEqual({ ok: true });
    expect(fake.captured.length).toBe(1);

    await waitFor(async () => {
      const hist = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
      return !!hist && hist.data.includes('user-message');
    });
    const history = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
    expect(history).not.toBeNull();

    const userMessageLine = (history!.data as string)
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type: string; text?: string; notification?: { kind: string } })
      .find((event) => event.type === 'user-message');
    expect(userMessageLine).toBeDefined();
    expect(userMessageLine!.notification).toEqual({ kind: 'internal-conditional-wakeup' });
    expect(userMessageLine!.text).toContain('[internal:conditional-wakeup]');
    expect(userMessageLine!.text).toContain('wakeupId=wakeup-1');
    expect(userMessageLine!.text).toContain('message="PR #1574 is ready for merge"');
  });
});