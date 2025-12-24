import type { Kysely } from 'kysely';
import type { Repository } from '@agent-console/shared';
import type { RepositoryRepository } from './repository-repository.js';
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
    await this.db
      .insertInto('repositories')
      .values({
        id: repository.id,
        name: repository.name,
        path: repository.path,
        registered_at: repository.registeredAt,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          name: repository.name,
          path: repository.path,
          registered_at: repository.registeredAt,
        })
      )
      .execute();

    logger.debug({ repositoryId: repository.id }, 'Repository saved');
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('repositories').where('id', '=', id).execute();
    logger.debug({ repositoryId: id }, 'Repository deleted');
  }
}
