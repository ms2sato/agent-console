import type { Kysely } from 'kysely';
import type { WorktreeRepository, WorktreeRecord } from './worktree-repository.js';
import type { Database, WorktreeRow } from '../database/schema.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('sqlite-worktree-repository');

/**
 * Convert a database worktree row (snake_case) to a domain record (camelCase).
 */
function toWorktreeRecord(row: WorktreeRow): WorktreeRecord {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    path: row.path,
    indexNumber: row.index_number,
    createdAt: row.created_at,
  };
}

export class SqliteWorktreeRepository implements WorktreeRepository {
  constructor(private db: Kysely<Database>) {}

  async findByRepositoryId(repositoryId: string): Promise<WorktreeRecord[]> {
    const rows = await this.db
      .selectFrom('worktrees')
      .where('repository_id', '=', repositoryId)
      .selectAll()
      .execute();

    return rows.map(toWorktreeRecord);
  }

  async findByPath(path: string): Promise<WorktreeRecord | null> {
    const row = await this.db
      .selectFrom('worktrees')
      .where('path', '=', path)
      .selectAll()
      .executeTakeFirst();

    return row ? toWorktreeRecord(row) : null;
  }

  async save(record: WorktreeRecord): Promise<void> {
    await this.db
      .insertInto('worktrees')
      .values({
        id: record.id,
        repository_id: record.repositoryId,
        path: record.path,
        index_number: record.indexNumber,
        created_at: record.createdAt,
      })
      .execute();

    logger.debug({ worktreeId: record.id, path: record.path }, 'Worktree saved');
  }

  async deleteByPath(path: string): Promise<void> {
    await this.db.deleteFrom('worktrees').where('path', '=', path).execute();
    logger.debug({ path }, 'Worktree deleted');
  }
}
