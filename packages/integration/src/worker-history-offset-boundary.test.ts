/**
 * Cross-Package Boundary Test: worker `history` message carries absolute
 * startOffset + epoch end-to-end (Issue #959, terminal-history-paging.md §3).
 *
 * Exercises the real server path the worker WS route uses to answer
 * `request-history` — SessionManager.getWorkerOutputHistory backed by the real
 * WorkerOutputFileManager (not a spy) — and asserts:
 *   - the result carries absolute `startOffset` and `epoch`, and
 *   - those fields survive JSON serialization (the worker WS wire is plain
 *     JSON, validated by type-membership rather than valibot), matching the
 *     `WorkerServerMessage` 'history' shape the client parses.
 *
 * Unit tests on either side (routes-history mocks getWorkerOutputHistory;
 * worker-output-file tests stop at the manager) do not cross this boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';
import type { WorkerServerMessage } from '@agent-console/shared';
import { WORKER_SERVER_MESSAGE_TYPES } from '@agent-console/shared';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();

describe('Client-Server Boundary: worker history startOffset + epoch', () => {
  let sessionManager: SessionManager;
  let jobQueue: JobQueue;

  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    await initializeDatabase(':memory:');

    jobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(jobQueue, new WorkerOutputFileManager());

    ptyFactory.reset();
    resetGitMocks();

    const db = getDatabase();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue,
      agentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      annotationService: new AnnotationService(),
    });
  });

  afterEach(async () => {
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  it('getWorkerOutputHistory result carries startOffset + epoch and survives the JSON wire', async () => {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });
    const workerId = session.workers.find((w) => w.type === 'agent')!.id;

    // Emit real PTY output so there is a live window to read back.
    ptyFactory.instances[0].simulateData('boundary history payload\n');

    // Initial-load read (fromOffset 0) — the exact call the WS route makes.
    const result = await sessionManager.getWorkerOutputHistory(
      session.id,
      workerId,
      0,
      5000,
    );
    expect(result).not.toBeNull();
    expect(typeof result!.startOffset).toBe('number');
    expect(typeof result!.epoch).toBe('number');
    expect(result!.epoch).toBeGreaterThan(0);
    // startOffset is the absolute start of the returned window.
    expect(result!.startOffset).toBe(result!.offset - Buffer.byteLength(result!.data, 'utf-8'));

    // The epoch tagging the history must match the worker's in-memory epoch
    // used to tag live `output` messages — otherwise the client would spuriously
    // detect a generation mismatch.
    expect(result!.epoch).toBe(sessionManager.getWorkerEpoch(session.id, workerId));

    // Build the wire message exactly as the route does and round-trip it.
    const historyMsg: WorkerServerMessage = {
      type: 'history',
      data: result!.data,
      offset: result!.offset,
      startOffset: result!.startOffset,
      epoch: result!.epoch,
    };
    const parsed = JSON.parse(JSON.stringify(historyMsg)) as Extract<WorkerServerMessage, { type: 'history' }>;
    expect(parsed.type in WORKER_SERVER_MESSAGE_TYPES).toBe(true);
    expect(parsed.startOffset).toBe(result!.startOffset);
    expect(parsed.epoch).toBe(result!.epoch);
    expect(parsed.data).toContain('boundary history payload');
  });

  it('output-truncated is no longer part of the worker server protocol', async () => {
    // Regression guard for §3.2 removal: the retired message type must not
    // reappear in the wire enum (ordinal 6 stays reserved).
    expect('output-truncated' in WORKER_SERVER_MESSAGE_TYPES).toBe(false);
  });
});
