/**
 * Tests for session ownership (createdBy) tracking.
 *
 * Verifies that:
 * - createSession stores createdBy in the session
 * - createdBy is included in public session
 * - createdBy is persisted to the database
 * - createdBy is preserved through pause/resume cycle
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { AgentManager } from '../agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { SqliteSessionRepository } from '../../repositories/sqlite-session-repository.js';
import { SessionManager } from '../session-manager.js';
import { JobQueue } from '../../jobs/job-queue.js';
import { registerJobHandlers } from '../../jobs/handlers.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import { SingleUserMode } from '../user-mode.js';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory(30000);

describe('Session Ownership (createdBy)', () => {
  let sessionManager: SessionManager;
  let testJobQueue: JobQueue;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    await initializeDatabase(':memory:');

    const db = getDatabase();
    testJobQueue = new JobQueue(db, { concurrency: 1 });
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());

    resetProcessMock();
    mockProcess.markAlive(process.pid);

    ptyFactory.reset();

    const agentMgr = await AgentManager.create(new SqliteAgentRepository(db));
    const sessionRepository = new SqliteSessionRepository(db);

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager: agentMgr,
      repositoryLookup: { getRepositorySlug: () => 'test-repo' },
      repositoryEnvLookup: {
        getRepositoryInfo: () => ({ name: 'test-repo', path: '/test/repo' }),
        getWorktreeIndexNumber: async () => 0,
      },
    });
  });

  afterEach(async () => {
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    resetProcessMock();
  });

  it('should store createdBy when creating a session', async () => {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code-builtin',
    }, { createdBy: 'alice' });

    expect(session.createdBy).toBe('alice');
  });

  it('should include createdBy in public session returned by getSession', async () => {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code-builtin',
    }, { createdBy: 'bob' });

    const publicSession = sessionManager.getSession(session.id);
    expect(publicSession?.createdBy).toBe('bob');
  });

  it('should persist createdBy to the database', async () => {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code-builtin',
    }, { createdBy: 'charlie' });

    // Read directly from the database
    const db = getDatabase();
    const row = await db
      .selectFrom('sessions')
      .where('id', '=', session.id)
      .select('created_by')
      .executeTakeFirst();

    expect(row?.created_by).toBe('charlie');
  });

  it('should handle sessions without createdBy (backwards compatibility)', async () => {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code-builtin',
    });

    expect(session.createdBy).toBeUndefined();

    // Database should store null
    const db = getDatabase();
    const row = await db
      .selectFrom('sessions')
      .where('id', '=', session.id)
      .select('created_by')
      .executeTakeFirst();

    expect(row?.created_by).toBeNull();
  });

  it('should include createdBy in getAllSessions', async () => {
    await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code-builtin',
    }, { createdBy: 'alice' });

    const sessions = sessionManager.getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].createdBy).toBe('alice');
  });

  it('should store createdBy on worktree sessions', async () => {
    const session = await sessionManager.createSession({
      type: 'worktree',
      locationPath: '/test/worktree',
      repositoryId: 'repo-1',
      worktreeId: 'feature-branch',
      agentId: 'claude-code-builtin',
    }, { createdBy: 'dave' });

    expect(session.createdBy).toBe('dave');
    expect(session.type).toBe('worktree');
  });

  it('should allow child sessions to inherit createdBy from parent (MCP delegation pattern)', async () => {
    // Create parent session with createdBy
    const parentSession = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/parent',
      agentId: 'claude-code-builtin',
    }, { createdBy: 'operator' });

    // Simulate what MCP delegate_to_worktree does: look up parent's createdBy and pass to child
    const parentCreatedBy = sessionManager.getSession(parentSession.id)?.createdBy;

    const childSession = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/child',
      agentId: 'claude-code-builtin',
      parentSessionId: parentSession.id,
    }, { createdBy: parentCreatedBy });

    expect(childSession.createdBy).toBe('operator');
    expect(childSession.parentSessionId).toBe(parentSession.id);
  });

  it('should not inherit createdBy when parent has none (backwards compat)', async () => {
    // Create parent session without createdBy (legacy session)
    const parentSession = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/parent',
      agentId: 'claude-code-builtin',
    });

    // Simulate MCP delegation
    const parentCreatedBy = sessionManager.getSession(parentSession.id)?.createdBy;

    const childSession = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/child',
      agentId: 'claude-code-builtin',
      parentSessionId: parentSession.id,
    }, { createdBy: parentCreatedBy });

    expect(childSession.createdBy).toBeUndefined();
  });
});
