import type { Kysely } from 'kysely';
import type { AuthUser } from '@agent-console/shared';
import type { UserRepository } from './user-repository.js';
import type { Database } from '../database/schema.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('sqlite-user-repository');

export class SqliteUserRepository implements UserRepository {
  constructor(private db: Kysely<Database>) {}

  async upsertByOsUid(osUid: number, username: string, homeDir: string): Promise<AuthUser> {
    // Check for existing user by os_uid
    const existing = await this.db
      .selectFrom('users')
      .where('os_uid', '=', osUid)
      .selectAll()
      .executeTakeFirst();

    if (existing) {
      // Update username and home_dir if changed
      if (existing.username !== username || existing.home_dir !== homeDir) {
        const now = new Date().toISOString();
        await this.db
          .updateTable('users')
          .set({
            username,
            home_dir: homeDir,
            updated_at: now,
          })
          .where('id', '=', existing.id)
          .execute();

        logger.info(
          { userId: existing.id, osUid, username },
          'Updated user record (username or home_dir changed)',
        );
      }

      return {
        id: existing.id,
        username,
        homeDir,
      };
    }

    // Create new user
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db
      .insertInto('users')
      .values({
        id,
        os_uid: osUid,
        username,
        home_dir: homeDir,
        created_at: now,
        updated_at: now,
      })
      .execute();

    logger.info({ userId: id, osUid, username }, 'Created new user record');

    return { id, username, homeDir };
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
}
