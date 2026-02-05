import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import { SqliteSessionRepository } from '../sqlite-session-repository.js';
import type { Database } from '../../database/schema.js';
import type {
  PersistedAgentWorker,
  PersistedTerminalWorker,
  PersistedGitDiffWorker,
  PersistedWorktreeSession,
  PersistedQuickSession,
} from '../../services/persistence-service.js';

const NOW_ISO8601 = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

describe('SqliteSessionRepository', () => {
  let bunDb: BunDatabase;
  let db: Kysely<Database>;
  let repository: SqliteSessionRepository;

  beforeEach(async () => {
    // Create in-memory database
    bunDb = new BunDatabase(':memory:');
    bunDb.exec('PRAGMA foreign_keys = ON;');

    db = new Kysely<Database>({
      dialect: new BunSqliteDialect({ database: bunDb }),
    });

    // Create tables manually (not using migration functions to avoid interference)
    await db.schema
      .createTable('sessions')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('type', 'text', (col) => col.notNull())
      .addColumn('location_path', 'text', (col) => col.notNull())
      .addColumn('server_pid', 'integer')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(NOW_ISO8601))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(NOW_ISO8601))
      .addColumn('initial_prompt', 'text')
      .addColumn('title', 'text')
      .addColumn('repository_id', 'text')
      .addColumn('worktree_id', 'text')
      .execute();

    await db.schema
      .createTable('workers')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('session_id', 'text', (col) =>
        col.notNull().references('sessions.id').onDelete('cascade')
      )
      .addColumn('type', 'text', (col) => col.notNull())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(NOW_ISO8601))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(NOW_ISO8601))
      .addColumn('pid', 'integer')
      .addColumn('agent_id', 'text')
      .addColumn('base_commit', 'text')
      .execute();

    repository = new SqliteSessionRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
    bunDb.close();
  });

  // ========== Helper Functions ==========

  function createQuickSession(overrides: Partial<PersistedQuickSession> = {}): PersistedQuickSession {
    return {
      id: overrides.id ?? 'test-session-id',
      type: 'quick',
      locationPath: '/test/path',
      serverPid: process.pid,
      createdAt: new Date().toISOString(),
      workers: [],
      ...overrides,
    };
  }

  function createWorktreeSession(
    overrides: Partial<PersistedWorktreeSession> = {}
  ): PersistedWorktreeSession {
    return {
      id: overrides.id ?? 'test-worktree-session-id',
      type: 'worktree',
      locationPath: '/test/worktree/path',
      repositoryId: 'test-repo-id',
      worktreeId: 'test-branch',
      serverPid: process.pid,
      createdAt: new Date().toISOString(),
      workers: [],
      ...overrides,
    };
  }

  function createAgentWorker(overrides: Partial<PersistedAgentWorker> = {}): PersistedAgentWorker {
    return {
      id: overrides.id ?? 'test-agent-worker-id',
      type: 'agent',
      name: 'Test Agent',
      agentId: 'claude-code-builtin',
      pid: 12345,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function createTerminalWorker(
    overrides: Partial<PersistedTerminalWorker> = {}
  ): PersistedTerminalWorker {
    return {
      id: overrides.id ?? 'test-terminal-worker-id',
      type: 'terminal',
      name: 'Test Terminal',
      pid: 54321,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function createGitDiffWorker(
    overrides: Partial<PersistedGitDiffWorker> = {}
  ): PersistedGitDiffWorker {
    return {
      id: overrides.id ?? 'test-git-diff-worker-id',
      type: 'git-diff',
      name: 'Git Diff',
      baseCommit: 'abc123def456',
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  // ========== Test Suites ==========

  describe('findAll', () => {
    it('should return empty array when no sessions exist', async () => {
      const sessions = await repository.findAll();
      expect(sessions).toEqual([]);
    });

    it('should return all sessions with their workers', async () => {
      const session1 = createQuickSession({ id: 'session-1' });
      const session2 = createWorktreeSession({ id: 'session-2' });

      await repository.save(session1);
      await repository.save(session2);

      const sessions = await repository.findAll();

      expect(sessions.length).toBe(2);
      expect(sessions.map((s) => s.id).sort()).toEqual(['session-1', 'session-2']);
    });

    it('should correctly hydrate worktree sessions', async () => {
      const worktreeSession = createWorktreeSession({
        id: 'worktree-session',
        repositoryId: 'repo-123',
        worktreeId: 'feature-branch',
        locationPath: '/projects/repo/worktrees/feature-branch',
        title: 'Feature Work',
        initialPrompt: 'Implement feature X',
      });

      await repository.save(worktreeSession);

      const sessions = await repository.findAll();

      expect(sessions.length).toBe(1);
      const retrieved = sessions[0];
      expect(retrieved.type).toBe('worktree');
      expect(retrieved.id).toBe('worktree-session');
      expect(retrieved.locationPath).toBe('/projects/repo/worktrees/feature-branch');
      expect(retrieved.title).toBe('Feature Work');
      expect(retrieved.initialPrompt).toBe('Implement feature X');

      if (retrieved.type === 'worktree') {
        expect(retrieved.repositoryId).toBe('repo-123');
        expect(retrieved.worktreeId).toBe('feature-branch');
      }
    });

    it('should correctly hydrate quick sessions', async () => {
      const quickSession = createQuickSession({
        id: 'quick-session',
        locationPath: '/home/user/project',
        title: 'Quick Task',
        initialPrompt: 'Fix bug',
      });

      await repository.save(quickSession);

      const sessions = await repository.findAll();

      expect(sessions.length).toBe(1);
      const retrieved = sessions[0];
      expect(retrieved.type).toBe('quick');
      expect(retrieved.id).toBe('quick-session');
      expect(retrieved.locationPath).toBe('/home/user/project');
      expect(retrieved.title).toBe('Quick Task');
      expect(retrieved.initialPrompt).toBe('Fix bug');
    });

    it('should return sessions with their workers', async () => {
      const sessionWithWorkers = createQuickSession({
        id: 'session-with-workers',
        workers: [
          createAgentWorker({ id: 'worker-1' }),
          createTerminalWorker({ id: 'worker-2' }),
        ],
      });

      await repository.save(sessionWithWorkers);

      const sessions = await repository.findAll();

      expect(sessions.length).toBe(1);
      expect(sessions[0].workers.length).toBe(2);
      expect(sessions[0].workers.map((w) => w.id).sort()).toEqual(['worker-1', 'worker-2']);
    });
  });

  describe('findById', () => {
    it('should return session if exists', async () => {
      const session = createWorktreeSession({
        id: 'find-me',
        repositoryId: 'repo-1',
        title: 'Find Me',
      });

      await repository.save(session);

      const found = await repository.findById('find-me');

      expect(found).not.toBeNull();
      expect(found?.id).toBe('find-me');
      expect(found?.title).toBe('Find Me');
      if (found?.type === 'worktree') {
        expect(found.repositoryId).toBe('repo-1');
      }
    });

    it('should return null if session not found', async () => {
      const session = createQuickSession({ id: 'existing-session' });
      await repository.save(session);

      const found = await repository.findById('non-existent');

      expect(found).toBeNull();
    });

    it('should return null when no sessions exist', async () => {
      const found = await repository.findById('any-id');
      expect(found).toBeNull();
    });

    it('should include workers in returned session', async () => {
      const session = createQuickSession({
        id: 'session-with-workers',
        workers: [
          createAgentWorker({ id: 'agent-1', name: 'Claude' }),
          createTerminalWorker({ id: 'terminal-1', name: 'Shell' }),
        ],
      });

      await repository.save(session);

      const found = await repository.findById('session-with-workers');

      expect(found).not.toBeNull();
      expect(found?.workers.length).toBe(2);
      expect(found?.workers.find((w) => w.id === 'agent-1')?.name).toBe('Claude');
      expect(found?.workers.find((w) => w.id === 'terminal-1')?.name).toBe('Shell');
    });
  });

  describe('findByServerPid', () => {
    it('should return sessions matching the given PID', async () => {
      const sessions = [
        createQuickSession({ id: 'session-1', serverPid: 1000 }),
        createQuickSession({ id: 'session-2', serverPid: 2000 }),
        createQuickSession({ id: 'session-3', serverPid: 1000 }),
        createWorktreeSession({ id: 'session-4', serverPid: 3000 }),
      ];

      for (const session of sessions) {
        await repository.save(session);
      }

      const found = await repository.findByServerPid(1000);

      expect(found.length).toBe(2);
      expect(found.map((s) => s.id).sort()).toEqual(['session-1', 'session-3']);
    });

    it('should return empty array if no sessions match', async () => {
      const sessions = [
        createQuickSession({ id: 'session-1', serverPid: 1000 }),
        createQuickSession({ id: 'session-2', serverPid: 2000 }),
      ];

      for (const session of sessions) {
        await repository.save(session);
      }

      const found = await repository.findByServerPid(9999);

      expect(found).toEqual([]);
    });

    it('should return empty array when no sessions exist', async () => {
      const found = await repository.findByServerPid(1000);
      expect(found).toEqual([]);
    });

    it('should include workers for matched sessions', async () => {
      const session = createQuickSession({
        id: 'session-with-workers',
        serverPid: 5000,
        workers: [createAgentWorker({ id: 'worker-1' })],
      });

      await repository.save(session);

      const found = await repository.findByServerPid(5000);

      expect(found.length).toBe(1);
      expect(found[0].workers.length).toBe(1);
      expect(found[0].workers[0].id).toBe('worker-1');
    });
  });

  describe('findPaused', () => {
    it('should return sessions with null serverPid', async () => {
      const sessions = [
        createQuickSession({ id: 'session-1', serverPid: 1000 }),
        createQuickSession({ id: 'session-2', serverPid: undefined }),
        createWorktreeSession({ id: 'session-3', serverPid: undefined }),
        createQuickSession({ id: 'session-4', serverPid: 2000 }),
      ];

      for (const session of sessions) {
        await repository.save(session);
      }

      const found = await repository.findPaused();

      expect(found.length).toBe(2);
      expect(found.map((s) => s.id).sort()).toEqual(['session-2', 'session-3']);
    });

    it('should return empty array if no paused sessions', async () => {
      const sessions = [
        createQuickSession({ id: 'session-1', serverPid: 1000 }),
        createQuickSession({ id: 'session-2', serverPid: 2000 }),
      ];

      for (const session of sessions) {
        await repository.save(session);
      }

      const found = await repository.findPaused();

      expect(found).toEqual([]);
    });

    it('should return empty array when no sessions exist', async () => {
      const found = await repository.findPaused();
      expect(found).toEqual([]);
    });

    it('should include workers for paused sessions', async () => {
      const session = createWorktreeSession({
        id: 'paused-session',
        serverPid: undefined,
        workers: [
          createAgentWorker({ id: 'worker-1' }),
          createTerminalWorker({ id: 'worker-2' }),
        ],
      });

      await repository.save(session);

      const found = await repository.findPaused();

      expect(found.length).toBe(1);
      expect(found[0].workers.length).toBe(2);
      expect(found[0].workers.map((w) => w.id).sort()).toEqual(['worker-1', 'worker-2']);
    });

    it('should correctly hydrate worktree session metadata', async () => {
      const session = createWorktreeSession({
        id: 'paused-worktree',
        serverPid: undefined,
        repositoryId: 'repo-123',
        worktreeId: 'feature-branch',
        title: 'Feature Work',
        initialPrompt: 'Implement feature X',
      });

      await repository.save(session);

      const found = await repository.findPaused();

      expect(found.length).toBe(1);
      expect(found[0].type).toBe('worktree');
      expect(found[0].title).toBe('Feature Work');
      expect(found[0].initialPrompt).toBe('Implement feature X');
      if (found[0].type === 'worktree') {
        expect(found[0].repositoryId).toBe('repo-123');
        expect(found[0].worktreeId).toBe('feature-branch');
      }
    });
  });

  describe('save', () => {
    it('should insert new session', async () => {
      const session = createQuickSession({ id: 'new-session', title: 'New Session' });

      await repository.save(session);

      const found = await repository.findById('new-session');
      expect(found).not.toBeNull();
      expect(found?.title).toBe('New Session');
    });

    it('should update existing session', async () => {
      const session = createQuickSession({ id: 'update-session', title: 'Original' });
      await repository.save(session);

      const updated = createQuickSession({ id: 'update-session', title: 'Updated' });
      await repository.save(updated);

      const found = await repository.findById('update-session');
      expect(found?.title).toBe('Updated');

      // Verify only one session exists
      const all = await repository.findAll();
      expect(all.length).toBe(1);
    });

    it('should preserve created_at and update updated_at on update', async () => {
      const originalCreatedAt = '2024-01-01T00:00:00.000Z';
      const session = createQuickSession({
        id: 'timestamp-test',
        title: 'Original',
        createdAt: originalCreatedAt,
      });
      await repository.save(session);

      // Get the original timestamps from database directly
      const originalRow = await db
        .selectFrom('sessions')
        .where('id', '=', 'timestamp-test')
        .select(['created_at', 'updated_at'])
        .executeTakeFirst();

      expect(originalRow?.created_at).toBe(originalCreatedAt);
      const originalUpdatedAt = originalRow?.updated_at;

      // Wait a bit to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update with a different createdAt (simulating real-world scenario where
      // the domain object might have different timestamp)
      const updated = createQuickSession({
        id: 'timestamp-test',
        title: 'Updated',
        createdAt: '2024-06-01T00:00:00.000Z', // Different createdAt
      });
      await repository.save(updated);

      // Get timestamps after update
      const updatedRow = await db
        .selectFrom('sessions')
        .where('id', '=', 'timestamp-test')
        .select(['created_at', 'updated_at'])
        .executeTakeFirst();

      // created_at should NOT change (this was the bug!)
      expect(updatedRow?.created_at).toBe(originalCreatedAt);

      // updated_at should change
      expect(updatedRow?.updated_at).not.toBe(originalUpdatedAt);
    });

    it('should preserve worker created_at and update updated_at on session update', async () => {
      const originalWorkerCreatedAt = '2024-01-01T00:00:00.000Z';
      const session = createQuickSession({
        id: 'worker-timestamp-test',
        workers: [
          createAgentWorker({
            id: 'worker-1',
            name: 'Original Worker',
            createdAt: originalWorkerCreatedAt,
          }),
        ],
      });
      await repository.save(session);

      // Get original worker timestamps from database directly
      const originalWorkerRow = await db
        .selectFrom('workers')
        .where('id', '=', 'worker-1')
        .select(['created_at', 'updated_at', 'name'])
        .executeTakeFirst();

      expect(originalWorkerRow?.created_at).toBe(originalWorkerCreatedAt);
      expect(originalWorkerRow?.name).toBe('Original Worker');
      const originalWorkerUpdatedAt = originalWorkerRow?.updated_at;

      // Wait a bit to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update session with modified worker (same ID, different data)
      const updated = createQuickSession({
        id: 'worker-timestamp-test',
        workers: [
          createAgentWorker({
            id: 'worker-1', // Same ID
            name: 'Updated Worker',
            createdAt: '2024-06-01T00:00:00.000Z', // Different createdAt (simulates domain object)
          }),
        ],
      });
      await repository.save(updated);

      // Get worker timestamps after update
      const updatedWorkerRow = await db
        .selectFrom('workers')
        .where('id', '=', 'worker-1')
        .select(['created_at', 'updated_at', 'name'])
        .executeTakeFirst();

      // Worker created_at should NOT change (this was the bug - delete-and-reinsert would lose it)
      expect(updatedWorkerRow?.created_at).toBe(originalWorkerCreatedAt);

      // Worker updated_at should change
      expect(updatedWorkerRow?.updated_at).not.toBe(originalWorkerUpdatedAt);

      // Worker name should be updated
      expect(updatedWorkerRow?.name).toBe('Updated Worker');
    });

    it('should use upsert strategy for workers (not delete-and-reinsert)', async () => {
      // This test verifies the upsert strategy by checking that created_at is preserved
      // even when the worker is "updated" through a session save
      const originalCreatedAt = '2024-01-01T00:00:00.000Z';
      const session = createQuickSession({
        id: 'upsert-test',
        workers: [
          createAgentWorker({
            id: 'worker-1',
            name: 'Original',
            pid: 1111,
            createdAt: originalCreatedAt,
          }),
        ],
      });
      await repository.save(session);

      // Get original created_at directly from database
      const originalRow = await db
        .selectFrom('workers')
        .where('id', '=', 'worker-1')
        .select(['created_at'])
        .executeTakeFirst();
      expect(originalRow?.created_at).toBe(originalCreatedAt);

      // Update session with same worker ID but different data
      const updated = createQuickSession({
        id: 'upsert-test',
        workers: [
          createAgentWorker({
            id: 'worker-1', // Same ID
            name: 'Updated',
            pid: 9999, // Different PID
          }),
        ],
      });
      await repository.save(updated);

      // Verify worker was upserted (not deleted and re-inserted)
      const updatedRow = await db
        .selectFrom('workers')
        .where('id', '=', 'worker-1')
        .select(['created_at', 'name', 'pid'])
        .executeTakeFirst();

      // If delete-and-reinsert, created_at would be NEW timestamp
      // If upsert, created_at would be ORIGINAL timestamp
      expect(updatedRow?.created_at).toBe(originalCreatedAt);
      expect(updatedRow?.name).toBe('Updated');
      expect(updatedRow?.pid).toBe(9999);
    });

    it('should delete all workers when session is updated to have no workers', async () => {
      // Create session with workers
      const session = createQuickSession({
        id: 'delete-all-workers-test',
        workers: [
          createAgentWorker({ id: 'worker-1' }),
          createTerminalWorker({ id: 'worker-2' }),
        ],
      });
      await repository.save(session);

      // Verify workers exist
      const beforeWorkers = await db
        .selectFrom('workers')
        .where('session_id', '=', 'delete-all-workers-test')
        .selectAll()
        .execute();
      expect(beforeWorkers.length).toBe(2);

      // Update to have no workers
      const updated = createQuickSession({
        id: 'delete-all-workers-test',
        workers: [], // Empty
      });
      await repository.save(updated);

      // Verify all workers deleted
      const afterWorkers = await db
        .selectFrom('workers')
        .where('session_id', '=', 'delete-all-workers-test')
        .selectAll()
        .execute();
      expect(afterWorkers.length).toBe(0);
    });

    it('should save session with workers', async () => {
      const session = createQuickSession({
        id: 'session-with-workers',
        workers: [
          createAgentWorker({ id: 'worker-1' }),
          createTerminalWorker({ id: 'worker-2' }),
          createGitDiffWorker({ id: 'worker-3' }),
        ],
      });

      await repository.save(session);

      const found = await repository.findById('session-with-workers');
      expect(found?.workers.length).toBe(3);
    });

    it('should replace workers on update (not append)', async () => {
      // Initial save with 2 workers
      const session = createQuickSession({
        id: 'worker-replace-test',
        workers: [
          createAgentWorker({ id: 'worker-1' }),
          createTerminalWorker({ id: 'worker-2' }),
        ],
      });
      await repository.save(session);

      // Update with different workers
      const updated = createQuickSession({
        id: 'worker-replace-test',
        workers: [createGitDiffWorker({ id: 'worker-3' })],
      });
      await repository.save(updated);

      const found = await repository.findById('worker-replace-test');

      // Should only have the new worker, not old ones
      expect(found?.workers.length).toBe(1);
      expect(found?.workers[0].id).toBe('worker-3');
      expect(found?.workers[0].type).toBe('git-diff');
    });

    it('should handle transaction atomically', async () => {
      // Save a valid session first
      const validSession = createQuickSession({
        id: 'valid-session',
        workers: [createAgentWorker({ id: 'valid-worker' })],
      });
      await repository.save(validSession);

      // Verify the initial state
      const before = await repository.findById('valid-session');
      expect(before?.workers.length).toBe(1);
      expect(before?.workers[0].id).toBe('valid-worker');

      // Now try to update with new workers - should succeed atomically
      const updateSession = createQuickSession({
        id: 'valid-session',
        workers: [
          createTerminalWorker({ id: 'terminal-1' }),
          createGitDiffWorker({ id: 'git-diff-1' }),
        ],
      });
      await repository.save(updateSession);

      // Verify all new workers are present
      const after = await repository.findById('valid-session');
      expect(after?.workers.length).toBe(2);
      expect(after?.workers.map((w) => w.id).sort()).toEqual(['git-diff-1', 'terminal-1']);
    });

    it('should preserve optional fields as undefined when null in database', async () => {
      const session = createQuickSession({
        id: 'minimal-session',
        title: undefined,
        initialPrompt: undefined,
      });

      await repository.save(session);

      const found = await repository.findById('minimal-session');
      expect(found?.title).toBeUndefined();
      expect(found?.initialPrompt).toBeUndefined();
    });
  });

  describe('saveAll', () => {
    it('should replace all sessions', async () => {
      // Save initial sessions
      await repository.save(createQuickSession({ id: 'old-1' }));
      await repository.save(createQuickSession({ id: 'old-2' }));

      // Replace with new sessions
      const newSessions = [
        createQuickSession({ id: 'new-1' }),
        createWorktreeSession({ id: 'new-2' }),
        createQuickSession({ id: 'new-3' }),
      ];

      await repository.saveAll(newSessions);

      const all = await repository.findAll();
      expect(all.length).toBe(3);
      expect(all.map((s) => s.id).sort()).toEqual(['new-1', 'new-2', 'new-3']);

      // Old sessions should be gone
      const old1 = await repository.findById('old-1');
      const old2 = await repository.findById('old-2');
      expect(old1).toBeNull();
      expect(old2).toBeNull();
    });

    it('should handle empty array', async () => {
      // Save initial sessions
      await repository.save(createQuickSession({ id: 'session-1' }));
      await repository.save(createQuickSession({ id: 'session-2' }));

      // Replace with empty array
      await repository.saveAll([]);

      const all = await repository.findAll();
      expect(all).toEqual([]);
    });

    it('should preserve all session types', async () => {
      const sessions = [
        createQuickSession({ id: 'quick-1' }),
        createWorktreeSession({ id: 'worktree-1', repositoryId: 'repo-a' }),
        createQuickSession({ id: 'quick-2' }),
        createWorktreeSession({ id: 'worktree-2', repositoryId: 'repo-b' }),
      ];

      await repository.saveAll(sessions);

      const all = await repository.findAll();
      expect(all.length).toBe(4);

      const quickSessions = all.filter((s) => s.type === 'quick');
      const worktreeSessions = all.filter((s) => s.type === 'worktree');

      expect(quickSessions.length).toBe(2);
      expect(worktreeSessions.length).toBe(2);
    });

    it('should save sessions with workers', async () => {
      const sessions = [
        createQuickSession({
          id: 'session-1',
          workers: [createAgentWorker({ id: 'worker-1' })],
        }),
        createQuickSession({
          id: 'session-2',
          workers: [
            createTerminalWorker({ id: 'worker-2' }),
            createGitDiffWorker({ id: 'worker-3' }),
          ],
        }),
      ];

      await repository.saveAll(sessions);

      const session1 = await repository.findById('session-1');
      const session2 = await repository.findById('session-2');

      expect(session1?.workers.length).toBe(1);
      expect(session2?.workers.length).toBe(2);
    });
  });

  describe('delete', () => {
    it('should remove session by id', async () => {
      const sessions = [
        createQuickSession({ id: 'session-1' }),
        createQuickSession({ id: 'session-2' }),
        createQuickSession({ id: 'session-3' }),
      ];

      for (const session of sessions) {
        await repository.save(session);
      }

      await repository.delete('session-2');

      const all = await repository.findAll();
      expect(all.length).toBe(2);
      expect(all.map((s) => s.id).sort()).toEqual(['session-1', 'session-3']);
    });

    it('should cascade delete workers', async () => {
      const session = createQuickSession({
        id: 'session-to-delete',
        workers: [
          createAgentWorker({ id: 'worker-1' }),
          createTerminalWorker({ id: 'worker-2' }),
        ],
      });

      await repository.save(session);

      // Verify workers exist before delete
      const before = await repository.findById('session-to-delete');
      expect(before?.workers.length).toBe(2);

      // Delete session
      await repository.delete('session-to-delete');

      // Verify session is deleted
      const found = await repository.findById('session-to-delete');
      expect(found).toBeNull();

      // Verify workers are also deleted via cascade (check directly in DB)
      const workers = await db.selectFrom('workers').selectAll().execute();
      expect(workers.length).toBe(0);
    });

    it('should not fail if session does not exist', async () => {
      await repository.save(createQuickSession({ id: 'existing' }));

      // Should not throw
      await expect(repository.delete('non-existent')).resolves.toBeUndefined();

      // Existing session should still be there
      const found = await repository.findById('existing');
      expect(found).not.toBeNull();
    });

    it('should not affect other sessions', async () => {
      const session1 = createQuickSession({
        id: 'session-1',
        title: 'Session One',
        workers: [createAgentWorker({ id: 'worker-1' })],
      });
      const session2 = createWorktreeSession({
        id: 'session-2',
        repositoryId: 'repo-1',
        workers: [createTerminalWorker({ id: 'worker-2' })],
      });

      await repository.save(session1);
      await repository.save(session2);

      await repository.delete('session-1');

      const remaining = await repository.findById('session-2');
      expect(remaining).not.toBeNull();
      expect(remaining?.type).toBe('worktree');
      if (remaining?.type === 'worktree') {
        expect(remaining.repositoryId).toBe('repo-1');
      }
      expect(remaining?.workers.length).toBe(1);
      expect(remaining?.workers[0].id).toBe('worker-2');
    });
  });

  describe('worker types', () => {
    it('should correctly save and retrieve agent workers', async () => {
      const agentWorker = createAgentWorker({
        id: 'agent-worker-test',
        name: 'Claude Agent',
        agentId: 'custom-agent-id',
        pid: 99999,
      });

      const session = createQuickSession({
        id: 'agent-worker-session',
        workers: [agentWorker],
      });

      await repository.save(session);

      const found = await repository.findById('agent-worker-session');
      expect(found?.workers.length).toBe(1);

      const worker = found?.workers[0];
      expect(worker?.type).toBe('agent');
      expect(worker?.id).toBe('agent-worker-test');
      expect(worker?.name).toBe('Claude Agent');

      if (worker?.type === 'agent') {
        expect(worker.agentId).toBe('custom-agent-id');
        expect(worker.pid).toBe(99999);
      }
    });

    it('should correctly save and retrieve terminal workers', async () => {
      const terminalWorker = createTerminalWorker({
        id: 'terminal-worker-test',
        name: 'Bash Terminal',
        pid: 88888,
      });

      const session = createQuickSession({
        id: 'terminal-worker-session',
        workers: [terminalWorker],
      });

      await repository.save(session);

      const found = await repository.findById('terminal-worker-session');
      expect(found?.workers.length).toBe(1);

      const worker = found?.workers[0];
      expect(worker?.type).toBe('terminal');
      expect(worker?.id).toBe('terminal-worker-test');
      expect(worker?.name).toBe('Bash Terminal');

      if (worker?.type === 'terminal') {
        expect(worker.pid).toBe(88888);
      }
    });

    it('should correctly save and retrieve git-diff workers', async () => {
      const gitDiffWorker = createGitDiffWorker({
        id: 'git-diff-worker-test',
        name: 'Diff Viewer',
        baseCommit: 'abcdef123456789',
      });

      const session = createQuickSession({
        id: 'git-diff-worker-session',
        workers: [gitDiffWorker],
      });

      await repository.save(session);

      const found = await repository.findById('git-diff-worker-session');
      expect(found?.workers.length).toBe(1);

      const worker = found?.workers[0];
      expect(worker?.type).toBe('git-diff');
      expect(worker?.id).toBe('git-diff-worker-test');
      expect(worker?.name).toBe('Diff Viewer');

      if (worker?.type === 'git-diff') {
        expect(worker.baseCommit).toBe('abcdef123456789');
      }
    });

    it('should handle workers with null pid', async () => {
      const agentWithNullPid = createAgentWorker({
        id: 'null-pid-agent',
        pid: null,
      });

      const terminalWithNullPid = createTerminalWorker({
        id: 'null-pid-terminal',
        pid: null,
      });

      const session = createQuickSession({
        id: 'null-pid-session',
        workers: [agentWithNullPid, terminalWithNullPid],
      });

      await repository.save(session);

      const found = await repository.findById('null-pid-session');
      expect(found?.workers.length).toBe(2);

      const agent = found?.workers.find((w) => w.id === 'null-pid-agent');
      const terminal = found?.workers.find((w) => w.id === 'null-pid-terminal');

      if (agent?.type === 'agent') {
        expect(agent.pid).toBeNull();
      }
      if (terminal?.type === 'terminal') {
        expect(terminal.pid).toBeNull();
      }
    });

    it('should handle mixed worker types in same session', async () => {
      const session = createQuickSession({
        id: 'mixed-workers-session',
        workers: [
          createAgentWorker({ id: 'agent-1', name: 'Agent' }),
          createTerminalWorker({ id: 'terminal-1', name: 'Terminal' }),
          createGitDiffWorker({ id: 'git-diff-1', name: 'Git Diff' }),
        ],
      });

      await repository.save(session);

      const found = await repository.findById('mixed-workers-session');
      expect(found?.workers.length).toBe(3);

      const types = found?.workers.map((w) => w.type).sort();
      expect(types).toEqual(['agent', 'git-diff', 'terminal']);
    });
  });

  describe('data integrity handling', () => {
    it('should skip corrupted sessions in findAll instead of failing', async () => {
      // Insert a corrupted session directly (worktree without repository_id)
      await db
        .insertInto('sessions')
        .values({
          id: 'corrupted-session',
          type: 'worktree',
          location_path: '/path',
          server_pid: null,
          created_at: new Date().toISOString(),
          initial_prompt: null,
          title: null,
          repository_id: null, // Missing required field for worktree!
          worktree_id: 'branch',
        })
        .execute();

      // Insert a valid quick session
      await db
        .insertInto('sessions')
        .values({
          id: 'valid-session',
          type: 'quick',
          location_path: '/path',
          server_pid: null,
          created_at: new Date().toISOString(),
          initial_prompt: null,
          title: null,
          repository_id: null,
          worktree_id: null,
        })
        .execute();

      // findAll should succeed, returning only the valid session
      const sessions = await repository.findAll();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('valid-session');
    });

    it('should skip sessions with corrupted workers in findAll', async () => {
      // Insert a valid session
      await db
        .insertInto('sessions')
        .values({
          id: 'session-with-corrupted-worker',
          type: 'quick',
          location_path: '/path',
          server_pid: null,
          created_at: new Date().toISOString(),
          initial_prompt: null,
          title: null,
          repository_id: null,
          worktree_id: null,
        })
        .execute();

      // Insert a corrupted worker (agent without agent_id)
      await db
        .insertInto('workers')
        .values({
          id: 'corrupted-worker',
          session_id: 'session-with-corrupted-worker',
          type: 'agent',
          name: 'Agent',
          created_at: new Date().toISOString(),
          pid: null,
          agent_id: null, // Missing required field for agent!
          base_commit: null,
        })
        .execute();

      // Insert another valid session
      await db
        .insertInto('sessions')
        .values({
          id: 'valid-session',
          type: 'quick',
          location_path: '/path2',
          server_pid: null,
          created_at: new Date().toISOString(),
          initial_prompt: null,
          title: null,
          repository_id: null,
          worktree_id: null,
        })
        .execute();

      // findAll should succeed, returning only the valid session
      const sessions = await repository.findAll();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('valid-session');
    });
  });

  describe('edge cases', () => {
    it('should handle session with empty workers array', async () => {
      const session = createQuickSession({
        id: 'no-workers',
        workers: [],
      });

      await repository.save(session);

      const found = await repository.findById('no-workers');
      expect(found?.workers).toEqual([]);
    });

    it('should handle sessions with special characters in paths', async () => {
      const session = createQuickSession({
        id: 'special-path-session',
        locationPath: '/path/with spaces/and-dashes/and_underscores',
      });

      await repository.save(session);

      const found = await repository.findById('special-path-session');
      expect(found?.locationPath).toBe('/path/with spaces/and-dashes/and_underscores');
    });

    it('should handle sessions with unicode in title', async () => {
      const session = createQuickSession({
        id: 'unicode-session',
        title: 'Session with unicode: Hello World',
      });

      await repository.save(session);

      const found = await repository.findById('unicode-session');
      expect(found?.title).toBe('Session with unicode: Hello World');
    });

    it('should handle long initial prompts', async () => {
      const longPrompt = 'A'.repeat(10000);
      const session = createQuickSession({
        id: 'long-prompt-session',
        initialPrompt: longPrompt,
      });

      await repository.save(session);

      const found = await repository.findById('long-prompt-session');
      expect(found?.initialPrompt).toBe(longPrompt);
    });

    it('should handle worktree session without optional fields', async () => {
      const session = createWorktreeSession({
        id: 'minimal-worktree',
        title: undefined,
        initialPrompt: undefined,
      });

      await repository.save(session);

      const found = await repository.findById('minimal-worktree');
      expect(found?.type).toBe('worktree');
      expect(found?.title).toBeUndefined();
      expect(found?.initialPrompt).toBeUndefined();
    });
  });
});
