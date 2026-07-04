/**
 * Cross-Package Boundary Test: the `request-history-range` → `history-range`
 * round trip over the worker WS handler path (Issue #959, terminal-history-paging.md §5).
 *
 * Exercises the real serving chain the worker WS route uses —
 * handleHistoryRangeRequest → SessionManager.getWorkerHistoryRange → the real
 * WorkerOutputFileManager (not a spy) — and asserts the emitted `history-range`
 * message carries the served bytes, absolute offsets, matching epoch, and the
 * echoed requestId, and that it survives the JSON wire the client parses.
 *
 * Unit tests on either side (history-range-handler mocks the manager;
 * worker-output-file range tests stop at the manager) do not cross this boundary.
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
import { handleHistoryRangeRequest } from '@agent-console/server/src/websocket/history-range-handler';
import type { WSContext } from 'hono/ws';
import type { WorkerServerMessage } from '@agent-console/shared';
import { WORKER_SERVER_MESSAGE_TYPES } from '@agent-console/shared';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();

function makeWs(): { ws: WSContext; sent: WorkerServerMessage[] } {
  const sent: WorkerServerMessage[] = [];
  const ws = {
    send: (data: string) => {
      // Round-trips through JSON exactly as the real socket does.
      sent.push(JSON.parse(data) as WorkerServerMessage);
    },
  } as unknown as WSContext;
  return { ws, sent };
}

describe('Client-Server Boundary: request-history-range → history-range', () => {
  let sessionManager: SessionManager;
  let jobQueue: JobQueue;
  const originalHome = process.env.AGENT_CONSOLE_HOME;

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
      annotationService: new AnnotationService(),
    });
  });

  afterEach(async () => {
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    process.env.AGENT_CONSOLE_HOME = originalHome;
  });

  async function newAgentWorker(): Promise<{ sessionId: string; workerId: string }> {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });
    const workerId = session.workers.find((w) => w.type === 'agent')!.id;
    return { sessionId: session.id, workerId };
  }

  it('serves the trailing range with absolute offsets, matching epoch, and the echoed requestId', async () => {
    const { sessionId, workerId } = await newAgentWorker();

    // Emit newline-free output so the served slice is exactly the last 100 bytes.
    ptyFactory.instances[0].simulateData('X'.repeat(500));
    const endOffset = await sessionManager.getCurrentOutputOffset(sessionId, workerId);
    expect(endOffset).toBeGreaterThanOrEqual(500);

    const { ws, sent } = makeWs();
    await handleHistoryRangeRequest(
      ws,
      sessionId,
      workerId,
      { type: 'request-history-range', requestId: 42, beforeOffset: endOffset, maxBytes: 100 },
      sessionManager,
    );

    expect(sent).toHaveLength(1);
    const msg = sent[0] as Extract<WorkerServerMessage, { type: 'history-range' }>;
    expect(msg.type).toBe('history-range');
    expect(msg.type in WORKER_SERVER_MESSAGE_TYPES).toBe(true);
    expect(msg.requestId).toBe(42);
    expect(msg.endOffset).toBe(endOffset);
    expect(msg.startOffset).toBe(endOffset - 100);
    expect(msg.data).toBe('X'.repeat(100));
    expect(msg.hasMore).toBe(true);
    // The range epoch matches the worker's in-memory epoch tagging live output.
    expect(msg.epoch).toBe(sessionManager.getWorkerEpoch(sessionId, workerId));
  });

  it('answers beforeOffset 0 with the unavailable-range shape (nothing before the start)', async () => {
    const { sessionId, workerId } = await newAgentWorker();
    ptyFactory.instances[0].simulateData('some output');

    const { ws, sent } = makeWs();
    await handleHistoryRangeRequest(
      ws,
      sessionId,
      workerId,
      { type: 'request-history-range', requestId: 5, beforeOffset: 0 },
      sessionManager,
    );

    const msg = sent[0] as Extract<WorkerServerMessage, { type: 'history-range' }>;
    expect(msg).toEqual({ type: 'history-range', requestId: 5, data: '', startOffset: 0, endOffset: 0, hasMore: false, epoch: expect.any(Number) });
  });

  it('serves two independent connections paging the same worker', async () => {
    const { sessionId, workerId } = await newAgentWorker();
    ptyFactory.instances[0].simulateData('Y'.repeat(300));
    const endOffset = await sessionManager.getCurrentOutputOffset(sessionId, workerId);

    const a = makeWs();
    const b = makeWs();
    await Promise.all([
      handleHistoryRangeRequest(a.ws, sessionId, workerId, { type: 'request-history-range', requestId: 1, beforeOffset: endOffset, maxBytes: 50 }, sessionManager),
      handleHistoryRangeRequest(b.ws, sessionId, workerId, { type: 'request-history-range', requestId: 2, beforeOffset: endOffset, maxBytes: 50 }, sessionManager),
    ]);

    const ma = a.sent[0] as Extract<WorkerServerMessage, { type: 'history-range' }>;
    const mb = b.sent[0] as Extract<WorkerServerMessage, { type: 'history-range' }>;
    expect(ma.requestId).toBe(1);
    expect(mb.requestId).toBe(2);
    expect(ma.data).toBe('Y'.repeat(50));
    expect(mb.data).toBe('Y'.repeat(50));
    expect(ma.endOffset).toBe(endOffset);
    expect(mb.endOffset).toBe(endOffset);
  });
});
