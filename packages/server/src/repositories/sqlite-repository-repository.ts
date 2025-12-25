import type { Kysely } from 'kysely';
import type { Repository } from '@agent-console/shared';
import type { RepositoryRepository, RepositoryUpdates } from './repository-repository.js';
import type { Database } from '../database/schema.js';
import { createLogger } from '../lib/logger.js';
import { toRepository } from '../database/mappers.js';

const logger = createLogger('sqlite-repository-repository');

export class SqliteRepositoryRepository implements RepositoryRepository {
  constructor(private db: Kysely<Database>) {}

  async findAll(): Promise<Repository[]> {
    const rows = await this.db.selectFrom('repositories').selectAll().execute();
    return rows.map((row) => toRepository(row));
  }

  async findById(id: string): Promise<Repository | null> {
    const row = await this.db
      .selectFrom('repositories')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst();

    return row ? toRepository(row) : null;
  }

  async findByPath(path: string): Promise<Repository | null> {
    const row = await this.db
      .selectFrom('repositories')
      .where('path', '=', path)
      .selectAll()
      .executeTakeFirst();

    return row ? toRepository(row) : null;
  }

  async save(repository: Repository): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insertInto('repositories')
      .values({
        id: repository.id,
        name: repository.name,
        path: repository.path,
        created_at: repository.createdAt,
        updated_at: now,
        setup_command: repository.setupCommand ?? null,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          name: repository.name,
          path: repository.path,
          setup_command: repository.setupCommand ?? null,
          // Note: created_at is intentionally NOT updated (should never change after insert)
          updated_at: now,
        })
      )
      .execute();

    logger.debug({ repositoryId: repository.id }, 'Repository saved');
  }

  async update(id: string, updates: RepositoryUpdates): Promise<Repository | null> {
    const now = new Date().toISOString();

    // Build update object with only provided fields
    const updateData: Record<string, unknown> = {
      updated_at: now,
    };

    if (updates.setupCommand !== undefined) {
      // Convert empty string to null for database storage
      updateData.setup_command = updates.setupCommand === '' ? null : updates.setupCommand;
    }

    const result = await this.db
      .updateTable('repositories')
      .set(updateData)
      .where('id', '=', id)
      .execute();

    if (result[0]?.numUpdatedRows === 0n) {
      return null;
    }

    logger.debug({ repositoryId: id }, 'Repository updated');
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('repositories').where('id', '=', id).execute();
    logger.debug({ repositoryId: id }, 'Repository deleted');
  }
}
