/**
 * Issue #2295: deletion of a session needing attention (unreadable or
 * orphaned) must still work, and must withdraw its recorded attention item.
 *
 * Uses `createTestContext` (real in-memory SQLite, real `SessionManager` /
 * `SessionDeletionService`) with `mock-fs-helper`'s memfs for the
 * filesystem side, the same pattern as
 * `repository-unregister-paused-session.test.ts`. A corrupted row is
 * inserted directly via `appContext.db` (bypassing the repository's
 * type-safe `save()`, which cannot represent an invalid worker), mirroring
 * `sqlite-session-repository.test.ts`'s "corrupted worker" fixture.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { sessionAttentionTodoId } from '@agent-console/shared';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { createTestContext, shutdownAppContext, type AppContext } from '../../app-context.js';

const TEST_CONFIG_DIR = '/test/config';
const LOCATION_PATH = '/test/location';
const KEEP_FILE = `${LOCATION_PATH}/keep.txt`;

describe('Session-needing-attention deletion (Issue #2295)', () => {
  let appContext: AppContext | null = null;

  beforeEach(() => {
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
      [KEEP_FILE]: 'keep me',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
  });

  afterEach(async () => {
    if (appContext) {
      await shutdownAppContext(appContext);
      appContext = null;
    }
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  /** Insert a minimal, otherwise-valid `sessions` row directly via `db`. */
  async function insertSessionRow(ctx: AppContext, id: string): Promise<void> {
    await ctx.db
      .insertInto('sessions')
      .values({
        id,
        type: 'quick',
        location_path: LOCATION_PATH,
        server_pid: null,
        initial_prompt: null,
        initial_prompt_delivered: null,
        title: null,
        repository_id: null,
        worktree_id: null,
        paused_at: null,
        parent_session_id: null,
        parent_worker_id: null,
        created_by: null,
        initiated_by: null,
        data_scope: null,
        data_scope_slug: null,
        orphaned_at: null,
        orphaned_reason: null,
      })
      .execute();
  }

  /** Insert a worker row that makes `hydrate()` throw `DataIntegrityError` (an agent worker with no `agent_id`). */
  async function insertCorruptWorkerRow(ctx: AppContext, sessionId: string, workerId: string): Promise<void> {
    await ctx.db
      .insertInto('workers')
      .values({
        id: workerId,
        session_id: sessionId,
        type: 'agent',
        name: 'Agent',
        pid: null,
        agent_id: null, // Missing required field for agent -> DataIntegrityError on hydrate.
        base_commit: null,
        embedded_agent_id: null,
        deliver_initial_prompt_on_activation: null,
        sdk_session_id: null,
        model: null,
        reasoning_effort: null,
        context_window_tokens: null,
      })
      .execute();
  }

  describe('P0c: PRAGMA foreign_keys and the workers.session_id FK cascade (baseline, independent of the fix)', () => {
    it('cascades a direct session-row delete to its corrupt worker row', async () => {
      appContext = await createTestContext();
      const sessionId = 'unreadable-session-p0c';
      const workerId = 'unreadable-worker-p0c';

      await insertSessionRow(appContext, sessionId);
      await insertCorruptWorkerRow(appContext, sessionId, workerId);

      const fkPragma = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(appContext.db);
      expect(fkPragma.rows[0]?.foreign_keys).toBe(1);

      // Direct raw delete of the session row (NOT through the service).
      await appContext.db.deleteFrom('sessions').where('id', '=', sessionId).execute();

      const sessionRow = await appContext.db
        .selectFrom('sessions')
        .where('id', '=', sessionId)
        .selectAll()
        .executeTakeFirst();
      expect(sessionRow).toBeUndefined();

      const workerRow = await appContext.db
        .selectFrom('workers')
        .where('id', '=', workerId)
        .selectAll()
        .executeTakeFirst();
      expect(workerRow).toBeUndefined();
    });
  });

  describe('T6: forceDeleteSession on an unreadable row', () => {
    it('T6a: resolves true, and the session row is gone', async () => {
      appContext = await createTestContext();
      const sessionId = 'unreadable-session-t6a';
      const workerId = 'unreadable-worker-t6a';

      await insertSessionRow(appContext, sessionId);
      await insertCorruptWorkerRow(appContext, sessionId, workerId);

      // Confirm findAll() skips it (the "unreadable" premise) before
      // asserting forceDeleteSession's own behavior.
      const all = await appContext.sessionRepository.findAll();
      expect(all.find((s) => s.id === sessionId)).toBeUndefined();

      await expect(appContext.sessionManager.forceDeleteSession(sessionId)).resolves.toBe(true);

      const row = await appContext.db
        .selectFrom('sessions')
        .where('id', '=', sessionId)
        .selectAll()
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });

    it('T6b: the corrupt worker row is also gone', async () => {
      appContext = await createTestContext();
      const sessionId = 'unreadable-session-t6b';
      const workerId = 'unreadable-worker-t6b';

      await insertSessionRow(appContext, sessionId);
      await insertCorruptWorkerRow(appContext, sessionId, workerId);

      await appContext.sessionManager.forceDeleteSession(sessionId);

      const workerRow = await appContext.db
        .selectFrom('workers')
        .where('id', '=', workerId)
        .selectAll()
        .executeTakeFirst();
      expect(workerRow).toBeUndefined();
    });

    it('T6c: the location_path directory and its file are untouched (no filesystem cleanup for an unreadable row)', async () => {
      appContext = await createTestContext();
      const sessionId = 'unreadable-session-t6c';
      const workerId = 'unreadable-worker-t6c';

      await insertSessionRow(appContext, sessionId);
      await insertCorruptWorkerRow(appContext, sessionId, workerId);

      await appContext.sessionManager.forceDeleteSession(sessionId);

      const fs = await import('fs');
      expect(fs.existsSync(LOCATION_PATH)).toBe(true);
      expect(fs.readFileSync(KEEP_FILE, 'utf-8')).toBe('keep me');
    });

    it('T6d: on a totally unknown id resolves false', async () => {
      appContext = await createTestContext();
      await expect(appContext.sessionManager.forceDeleteSession('no-such-session')).resolves.toBe(false);
    });

    it('T6e: propagates a non-DataIntegrityError rejection from findById', async () => {
      appContext = await createTestContext();
      const sessionId = 'session-with-other-error';

      const originalFindById = appContext.sessionRepository.findById.bind(appContext.sessionRepository);
      appContext.sessionRepository.findById = async (id: string) => {
        if (id === sessionId) throw new Error('boom: unrelated database error');
        return originalFindById(id);
      };

      await expect(appContext.sessionManager.forceDeleteSession(sessionId)).rejects.toThrow(
        'boom: unrelated database error',
      );
    });
  });

  describe('T5: deletion withdraws the open attention item', () => {
    it('withdraws the session own attention item on delete; a different global item is untouched', async () => {
      appContext = await createTestContext();
      const user = await appContext.userRepository.upsertByOsUid(1001, 'alice', '/home/alice');

      const sessionId = 'orphaned-session-t5';
      await appContext.sessionRepository.save({
        id: sessionId,
        type: 'quick',
        locationPath: LOCATION_PATH,
        createdAt: '2026-01-01T00:00:00.000Z',
        workers: [],
        serverPid: null,
        recoveryState: 'orphaned',
        orphanedAt: Date.now(),
        orphanedReason: 'manual-test',
      });

      const attentionTodo = await appContext.todoRepository.create({
        id: sessionAttentionTodoId(sessionId),
        kind: 'action',
        scope: 'global',
        title: 'Session needs attention: orphaned-session-t5',
        body: 'test body',
        sessionId,
        createdBy: { userId: user.id },
        assigneeUserId: null,
      });

      const unrelatedTodo = await appContext.todoRepository.create({
        id: 'some-other-global-item',
        kind: 'action',
        scope: 'global',
        title: 'Unrelated item',
        body: 'test body',
        sessionId: null,
        createdBy: { userId: user.id },
        assigneeUserId: null,
      });

      await appContext.sessionManager.forceDeleteSession(sessionId);

      const afterAttention = await appContext.todoRepository.findById(attentionTodo.id);
      expect(afterAttention?.status).toBe('withdrawn');

      const afterUnrelated = await appContext.todoRepository.findById(unrelatedTodo.id);
      expect(afterUnrelated?.status).toBe('open');
    });
  });
});
