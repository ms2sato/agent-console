import type { Kysely } from 'kysely';
import type { AuthUser, UserPreferences } from '@agent-console/shared';
import type { UserRepository } from './user-repository.js';
import type { Database } from '../database/schema.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('sqlite-user-repository');

export class SqliteUserRepository implements UserRepository {
  constructor(private db: Kysely<Database>) {}

  async upsertByOsUid(osUid: number, username: string, homeDir: string): Promise<AuthUser> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Atomic upsert: INSERT ... ON CONFLICT (os_uid) WHERE os_uid IS NOT NULL DO UPDATE
    // The WHERE clause is required to match the partial unique index on os_uid.
    // Eliminates TOCTOU race condition from the previous check-then-insert pattern.
    const row = await this.db
      .insertInto('users')
      .values({
        id,
        os_uid: osUid,
        username,
        home_dir: homeDir,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column('os_uid')
          .where('os_uid', 'is not', null)
          .doUpdateSet({
            username,
            home_dir: homeDir,
            updated_at: now,
          })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    // If the returned id matches what we generated, it was an insert
    if (row.id === id) {
      logger.info({ userId: row.id, osUid, username }, 'Created new user record');
    } else {
      logger.info({ userId: row.id, osUid, username }, 'Updated user record via upsert');
    }

    return {
      id: row.id,
      username: row.username,
      homeDir: row.home_dir,
    };
  }

  async findById(id: string): Promise<AuthUser | null> {
    const row = await this.db
      .selectFrom('users')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst();

    if (!row) return null;

    return {
      id: row.id,
      username: row.username,
      homeDir: row.home_dir,
    };
  }

  async getPreferences(id: string): Promise<UserPreferences | null> {
    const row = await this.db
      .selectFrom('users')
      .where('id', '=', id)
      .select(['disable_claude_ai_connectors'])
      .executeTakeFirst();

    if (!row) return null;

    return {
      disableClaudeAiConnectors: Boolean(row.disable_claude_ai_connectors),
    };
  }

  async setPreferences(id: string, preferences: UserPreferences): Promise<boolean> {
    const result = await this.db
      .updateTable('users')
      .set({
        disable_claude_ai_connectors: preferences.disableClaudeAiConnectors ? 1 : 0,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .executeTakeFirst();

    return result.numUpdatedRows > 0n;
  }
}
