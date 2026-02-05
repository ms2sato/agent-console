import type { Kysely } from 'kysely';
import type { SessionRepository } from './session-repository.js';
import type { PersistedSession } from '../services/persistence-service.js';
import type { Database, Session } from '../database/schema.js';
import { createLogger } from '../lib/logger.js';
import {
  toSessionRow,
  toWorkerRow,
  toPersistedWorker,
  toPersistedSession,
  DataIntegrityError,
} from '../database/mappers.js';

const logger = createLogger('sqlite-session-repository');

export class SqliteSessionRepository implements SessionRepository {
  constructor(private db: Kysely<Database>) {}

  async findAll(): Promise<PersistedSession[]> {
    const sessions = await this.db
      .selectFrom('sessions')
      .selectAll()
      .execute();

    // Load workers for each session, skipping corrupted sessions
    const results: PersistedSession[] = [];
    for (const s of sessions) {
      try {
        results.push(await this.hydrate(s));
      } catch (error) {
        if (error instanceof DataIntegrityError) {
          logger.warn({ sessionId: s.id, err: error }, 'Skipping corrupted session');
          continue;
        }
        throw error;
      }
    }
    return results;
  }

  async findById(id: string): Promise<PersistedSession | null> {
    const session = await this.db
      .selectFrom('sessions')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst();

    return session ? this.hydrate(session) : null;
  }

  async findByServerPid(pid: number): Promise<PersistedSession[]> {
    const sessions = await this.db
      .selectFrom('sessions')
      .where('server_pid', '=', pid)
      .selectAll()
      .execute();

    return Promise.all(sessions.map((s) => this.hydrate(s)));
  }

  async save(session: PersistedSession): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      // Upsert session
      const sessionRow = toSessionRow(session);

      await trx
        .insertInto('sessions')
        .values(sessionRow)
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            type: sessionRow.type,
            location_path: sessionRow.location_path,
            server_pid: sessionRow.server_pid,
            // Note: created_at is intentionally NOT updated (should never change after insert)
            updated_at: sessionRow.updated_at,
            initial_prompt: sessionRow.initial_prompt,
            title: sessionRow.title,
            repository_id: sessionRow.repository_id,
            worktree_id: sessionRow.worktree_id,
          })
        )
        .execute();

      // Upsert workers (preserves created_at, updates other fields)
      for (const worker of session.workers) {
        const workerRow = toWorkerRow(worker, session.id);
        await trx
          .insertInto('workers')
          .values(workerRow)
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              session_id: workerRow.session_id,
              type: workerRow.type,
              name: workerRow.name,
              // Note: created_at is intentionally NOT updated (should never change after insert)
              updated_at: workerRow.updated_at,
              pid: workerRow.pid,
              agent_id: workerRow.agent_id,
              base_commit: workerRow.base_commit,
            })
          )
          .execute();
      }

      // Delete orphaned workers (workers no longer in the session)
      const currentWorkerIds = session.workers.map((w) => w.id);
      if (currentWorkerIds.length > 0) {
        await trx
          .deleteFrom('workers')
          .where('session_id', '=', session.id)
          .where('id', 'not in', currentWorkerIds)
          .execute();
      } else {
        // If no workers, delete all workers for this session
        await trx.deleteFrom('workers').where('session_id', '=', session.id).execute();
      }
    });

    logger.debug({ sessionId: session.id }, 'Session saved');
  }

  async saveAll(sessions: PersistedSession[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      // Delete all sessions and workers (cascade will handle workers)
      await trx.deleteFrom('sessions').execute();

      // Insert all sessions and workers
      for (const session of sessions) {
        const sessionRow = toSessionRow(session);
        await trx.insertInto('sessions').values(sessionRow).execute();

        for (const worker of session.workers) {
          await trx.insertInto('workers').values(toWorkerRow(worker, session.id)).execute();
        }
      }
    });

    logger.debug({ count: sessions.length }, 'All sessions saved');
  }

  async delete(id: string): Promise<void> {
    // Workers are deleted automatically via CASCADE
    await this.db.deleteFrom('sessions').where('id', '=', id).execute();
    logger.debug({ sessionId: id }, 'Session deleted');
  }

  async update(id: string, updates: Partial<PersistedSession>): Promise<boolean> {
    const now = new Date().toISOString();

    // Build update object from provided fields
    const updateValues: Record<string, unknown> = {
      updated_at: now,
    };

    // Map PersistedSession fields to database column names
    if (updates.serverPid !== undefined) {
      updateValues.server_pid = updates.serverPid ?? null;
    }
    if (updates.title !== undefined) {
      updateValues.title = updates.title ?? null;
    }
    if (updates.initialPrompt !== undefined) {
      updateValues.initial_prompt = updates.initialPrompt ?? null;
    }
    if (updates.locationPath !== undefined) {
      updateValues.location_path = updates.locationPath;
    }
    // worktreeId is only valid for worktree sessions
    if ('worktreeId' in updates && updates.worktreeId !== undefined) {
      updateValues.worktree_id = updates.worktreeId;
    }

    const result = await this.db
      .updateTable('sessions')
      .set(updateValues)
      .where('id', '=', id)
      .executeTakeFirst();

    const updated = result.numUpdatedRows > 0n;
    if (updated) {
      logger.debug({ sessionId: id, updates: Object.keys(updateValues) }, 'Session updated');
    }
    return updated;
  }

  async findPaused(): Promise<PersistedSession[]> {
    const sessions = await this.db
      .selectFrom('sessions')
      .where('server_pid', 'is', null)
      .selectAll()
      .execute();

    // Load workers for each session, skipping corrupted sessions
    const results: PersistedSession[] = [];
    for (const s of sessions) {
      try {
        results.push(await this.hydrate(s));
      } catch (error) {
        if (error instanceof DataIntegrityError) {
          logger.warn({ sessionId: s.id, err: error }, 'Skipping corrupted paused session');
          continue;
        }
        throw error;
      }
    }
    return results;
  }

  // ========== Private Helper Methods ==========

  private async hydrate(session: Session): Promise<PersistedSession> {
    const workers = await this.db
      .selectFrom('workers')
      .where('session_id', '=', session.id)
      .selectAll()
      .execute();

    const persistedWorkers = workers.map((w) => toPersistedWorker(w));

    return toPersistedSession(session, persistedWorkers);
  }
}
