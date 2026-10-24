import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql, type Kysely } from 'kysely';
import { SqliteDeferredWorkerNotificationRepository } from '../sqlite-deferred-worker-notification-repository.js';
import { SqliteSessionRepository } from '../sqlite-session-repository.js';
import type { NewDeferredWorkerNotification } from '../deferred-worker-notification-repository.js';
import { createDatabaseForTest } from '../../database/connection.js';
import type { Database } from '../../database/schema.js';
import {
  buildPersistedQuickSession,
  buildPersistedTerminalWorker,
  buildPersistedAgentWorker,
} from '../../__tests__/utils/build-test-data.js';

const SESSION = 'session-1';
const SENDER = 'session-sender';
const W1 = 'worker-1';
const W2 = 'worker-2';
const CAP = 100;

function row(over: Partial<NewDeferredWorkerNotification> & { id: string }): NewDeferredWorkerNotification {
  return {
    sessionId: SESSION,
    workerId: W1,
    kind: 'internal-message',
    sourceId: null,
    paramsJson: '{"kind":"internal-message"}',
    replyToSessionId: null,
    createdAt: '2026-10-24T00:00:00.000Z',
    ...over,
  };
}

// Reach (measured by mutation; "fails" = test names that fail):
//  - evictions skipped -> the three `cap` cases; evict newest-first -> the same three.
//  - eviction tie-break back to `id` -> 'breaks a created_at tie by insertion order when choosing the row
//    to drop', 'the 101st insert evicts the earliest-inserted among rows that all share one created_at'.
//  - list tie-break back to `id` -> 'orders by created_at, then by insertion order (not by id)...' plus
//    those two cap cases (they read the result through listBySession).
//  - worker FK cascade removed -> 'cascades when the worker row is deleted'; SET NULL removed ->
//    'sets reply_to_session_id NULL...'. The session-level cascade is shadowed at row level by the worker
//    cascade (workers cascade from the session), so it is pinned by migration-v55.test.ts's DDL case.
describe('SqliteDeferredWorkerNotificationRepository', () => {
  let db: Kysely<Database>;
  let repo: SqliteDeferredWorkerNotificationRepository;
  let sessions: SqliteSessionRepository;

  async function saveSession(workerIds: string[] = [W1, W2]): Promise<void> {
    await sessions.save(
      buildPersistedQuickSession({
        id: SESSION,
        workers: workerIds.map((id) => buildPersistedTerminalWorker({ id, name: id })),
      }),
    );
  }

  beforeEach(async () => {
    db = await createDatabaseForTest();
    repo = new SqliteDeferredWorkerNotificationRepository(db);
    sessions = new SqliteSessionRepository(db);
    await saveSession();
    await sessions.save(
      buildPersistedQuickSession({ id: SENDER, workers: [buildPersistedTerminalWorker({ id: 'sender-w', name: 'sender-w' })] }),
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('PRAGMA foreign_keys reads 1 (positive control for the cascade tests below)', async () => {
    const result = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(db);
    expect(result.rows[0]?.foreign_keys).toBe(1);
  });

  describe('insert / listBySession', () => {
    it('round-trips every column', async () => {
      await repo.insert(
        row({ id: 'a', sourceId: '/data/messages/m1.md', replyToSessionId: SENDER, kind: 'internal-message' }),
        CAP,
      );
      expect(await repo.listBySession(SESSION)).toEqual([
        {
          id: 'a',
          sessionId: SESSION,
          workerId: W1,
          kind: 'internal-message',
          sourceId: '/data/messages/m1.md',
          paramsJson: '{"kind":"internal-message"}',
          replyToSessionId: SENDER,
          createdAt: '2026-10-24T00:00:00.000Z',
        },
      ]);
    });

    it('orders by created_at, then by insertion order (not by id) when created_at is equal', async () => {
      await repo.insert(row({ id: 'c', createdAt: '2026-10-24T00:00:02.000Z' }), CAP);
      await repo.insert(row({ id: 'z', createdAt: '2026-10-24T00:00:01.000Z' }), CAP);
      await repo.insert(row({ id: 'b', createdAt: '2026-10-24T00:00:01.000Z' }), CAP);
      await repo.insert(row({ id: 'a', createdAt: '2026-10-24T00:00:01.000Z' }), CAP);

      // ids z, b, a are in the OPPOSITE order of their insertion's id order
      expect((await repo.listBySession(SESSION)).map((r) => r.id)).toEqual(['z', 'b', 'a', 'c']);
    });

    it('scopes listBySession and countBySession to the session', async () => {
      await repo.insert(row({ id: 'mine' }), CAP);
      expect(await repo.countBySession(SESSION)).toBe(1);
      expect(await repo.countBySession(SENDER)).toBe(0);
      expect(await repo.listBySession(SENDER)).toEqual([]);
    });

    it('persists two internal-process rows sharing one source_id (no coalescing, no upsert)', async () => {
      await repo.insert(row({ id: 'p1', kind: 'internal-process', sourceId: 'proc-1' }), CAP);
      await repo.insert(row({ id: 'p2', kind: 'internal-process', sourceId: 'proc-1' }), CAP);
      expect((await repo.listBySession(SESSION)).map((r) => r.id)).toEqual(['p1', 'p2']);
    });

    it('rejects a duplicate id rather than replacing the row', async () => {
      await repo.insert(row({ id: 'dup', paramsJson: '{"n":1}' }), CAP);
      await expect(repo.insert(row({ id: 'dup', paramsJson: '{"n":2}' }), CAP)).rejects.toThrow();
      expect((await repo.listBySession(SESSION))[0]?.paramsJson).toBe('{"n":1}');
    });
  });

  describe('CHECK constraints', () => {
    it('rejects created_at without the trailing Z shape', async () => {
      await expect(repo.insert(row({ id: 'x', createdAt: '2026-10-24 00:00:00' }), CAP)).rejects.toThrow(
        /CHECK constraint failed/,
      );
      expect(await repo.countBySession(SESSION)).toBe(0);
    });

    it('rejects params_json that is not valid JSON', async () => {
      await expect(repo.insert(row({ id: 'x', paramsJson: '{not json' }), CAP)).rejects.toThrow(
        /CHECK constraint failed/,
      );
    });
  });

  describe('cap', () => {
    it('keeps exactly 100 rows, then the 101st insert deletes the oldest (by created_at, then arrival)', async () => {
      for (let i = 0; i < CAP; i++) {
        await repo.insert(
          row({ id: `r${String(i).padStart(3, '0')}`, createdAt: `2026-10-24T00:00:${String(i % 60).padStart(2, '0')}.${String(Math.floor(i / 60)).padStart(3, '0')}Z` }),
          CAP,
        );
      }
      expect(await repo.countBySession(SESSION)).toBe(CAP);
      const before = await repo.listBySession(SESSION);

      await repo.insert(row({ id: 'newest', createdAt: '2026-10-24T01:00:00.000Z' }), CAP);

      const after = await repo.listBySession(SESSION);
      expect(after).toHaveLength(CAP);
      expect(after.map((r) => r.id)).not.toContain(before[0]!.id);
      expect(after.map((r) => r.id)).toContain(before[1]!.id);
      expect(after[after.length - 1]!.id).toBe('newest');
    });

    it('breaks a created_at tie by insertion order when choosing the row to drop: the earliest-inserted goes, even with the largest id', async () => {
      await repo.insert(row({ id: 'z' }), 2);
      await repo.insert(row({ id: 'm' }), 2);
      await repo.insert(row({ id: 'a' }), 2);
      expect((await repo.listBySession(SESSION)).map((r) => r.id)).toEqual(['m', 'a']);
    });

    it('the 101st insert evicts the earliest-inserted among rows that all share one created_at', async () => {
      // Descending ids: insertion order is the reverse of id order.
      for (let i = 0; i < CAP; i++) {
        await repo.insert(row({ id: `r${String(CAP - i).padStart(3, '0')}` }), CAP);
      }
      await repo.insert(row({ id: 'r000' }), CAP);

      const ids = (await repo.listBySession(SESSION)).map((r) => r.id);
      expect(ids).toHaveLength(CAP);
      expect(ids).not.toContain('r100'); // the first one inserted
      expect(ids[0]).toBe('r099');
      expect(ids[ids.length - 1]).toBe('r000');
    });

    it('counts per session: another session at the cap does not evict this one', async () => {
      await repo.insert(row({ id: 'other-1', sessionId: SENDER, workerId: 'sender-w' }), 1);
      await repo.insert(row({ id: 'a' }), 1);
      await repo.insert(row({ id: 'b', createdAt: '2026-10-24T00:00:01.000Z' }), 1);
      expect((await repo.listBySession(SESSION)).map((r) => r.id)).toEqual(['b']);
      expect((await repo.listBySession(SENDER)).map((r) => r.id)).toEqual(['other-1']);
    });

    it('is atomic with the insert: a failing insert drops nothing', async () => {
      await repo.insert(row({ id: 'keep' }), 1);
      await expect(repo.insert(row({ id: 'bad', createdAt: 'nope' }), 1)).rejects.toThrow();
      expect((await repo.listBySession(SESSION)).map((r) => r.id)).toEqual(['keep']);
    });
  });

  describe('deleteByIds', () => {
    it('deletes only the named rows and returns the count; an empty list is a no-op', async () => {
      await repo.insert(row({ id: 'a' }), CAP);
      await repo.insert(row({ id: 'b' }), CAP);
      await repo.insert(row({ id: 'c' }), CAP);

      expect(await repo.deleteByIds([])).toBe(0);
      expect(await repo.deleteByIds(['a', 'c', 'missing'])).toBe(2);
      expect((await repo.listBySession(SESSION)).map((r) => r.id)).toEqual(['b']);
    });
  });

  describe('foreign keys', () => {
    it('rejects a row for a non-existent session or worker', async () => {
      await expect(repo.insert(row({ id: 'x', sessionId: 'ghost' }), CAP)).rejects.toThrow('FOREIGN KEY constraint failed');
      await expect(repo.insert(row({ id: 'y', workerId: 'ghost' }), CAP)).rejects.toThrow('FOREIGN KEY constraint failed');
    });

    it('cascades when the session is deleted', async () => {
      await repo.insert(row({ id: 'a' }), CAP);
      await db.deleteFrom('sessions').where('id', '=', SESSION).execute();
      expect(await db.selectFrom('deferred_worker_notifications').selectAll().execute()).toHaveLength(0);
    });

    it('cascades when the worker row is deleted, leaving the other worker rows', async () => {
      await repo.insert(row({ id: 'w1', workerId: W1 }), CAP);
      await repo.insert(row({ id: 'w2', workerId: W2 }), CAP);
      await db.deleteFrom('workers').where('id', '=', W1).execute();
      expect((await repo.listBySession(SESSION)).map((r) => r.id)).toEqual(['w2']);
    });

    it('keeps rows when the session is saved again with the same worker (restart shape, even with a changed worker type)', async () => {
      await repo.insert(row({ id: 'a', workerId: W1 }), CAP);

      await sessions.save(
        buildPersistedQuickSession({
          id: SESSION,
          workers: [
            buildPersistedAgentWorker({ id: W1, name: 'restarted' }),
            buildPersistedTerminalWorker({ id: W2, name: W2 }),
          ],
        }),
      );

      expect((await repo.listBySession(SESSION)).map((r) => r.id)).toEqual(['a']);
    });

    it('sets reply_to_session_id NULL when the sender session is deleted, keeping the row', async () => {
      await repo.insert(row({ id: 'a', replyToSessionId: SENDER }), CAP);
      await db.deleteFrom('sessions').where('id', '=', SENDER).execute();

      const rows = await repo.listBySession(SESSION);
      expect(rows.map((r) => r.id)).toEqual(['a']);
      expect(rows[0]!.replyToSessionId).toBeNull();
    });
  });
});
