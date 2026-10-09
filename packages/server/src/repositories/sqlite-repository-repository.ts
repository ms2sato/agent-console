import type { Kysely } from 'kysely';
import type { Repository } from '@agent-console/shared';
import type { RepositoryRepository, RepositoryUpdates } from './repository-repository.js';
import type { Database } from '../database/schema.js';
import { createLogger } from '../lib/logger.js';
import { toRepository, toRepositoryInsertRow } from '../database/mappers.js';
import { conflictUpdateSet } from './conflict-update-set.js';

const logger = createLogger('sqlite-repository-repository');

export class SqliteRepositoryRepository implements RepositoryRepository {
  constructor(private db: Kysely<Database>) {}

  async findAll(): Promise<Repository[]> {
    const rows = await this.db.selectFrom('repositories').selectAll().execute();
    const designationRows = await this.db
      .selectFrom('repository_orchestrator_sessions')
      .select(['repository_id', 'session_id'])
      .orderBy('created_at', 'asc')
      .orderBy('session_id', 'asc')
      .execute();

    // Group in memory rather than one query per repository -- one query
    // over `repositories`, one over `repository_orchestrator_sessions`.
    const byRepositoryId = new Map<string, string[]>();
    for (const designation of designationRows) {
      const list = byRepositoryId.get(designation.repository_id);
      if (list) {
        list.push(designation.session_id);
      } else {
        byRepositoryId.set(designation.repository_id, [designation.session_id]);
      }
    }

    const sharedAccountUsernameById = await this.resolveSharedAccountUsernames(
      rows.map((row) => row.shared_account_user_id)
    );

    return rows.map((row) =>
      toRepository(
        row,
        byRepositoryId.get(row.id) ?? [],
        row.shared_account_user_id ? sharedAccountUsernameById.get(row.shared_account_user_id) ?? null : null
      )
    );
  }

  async findById(id: string): Promise<Repository | null> {
    const row = await this.db
      .selectFrom('repositories')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst();

    if (!row) return null;
    const orchestratorSessionIds = await this.listOrchestratorSessionIds(id);
    const sharedAccountUsername = await this.resolveSharedAccountUsername(row.shared_account_user_id);
    return toRepository(row, orchestratorSessionIds, sharedAccountUsername);
  }

  async findByPath(path: string): Promise<Repository | null> {
    const row = await this.db
      .selectFrom('repositories')
      .where('path', '=', path)
      .selectAll()
      .executeTakeFirst();

    if (!row) return null;
    const orchestratorSessionIds = await this.listOrchestratorSessionIds(row.id);
    const sharedAccountUsername = await this.resolveSharedAccountUsername(row.shared_account_user_id);
    return toRepository(row, orchestratorSessionIds, sharedAccountUsername);
  }

  /**
   * Resolve a single bound shared account's username, or null when `userId`
   * is null (unbound). Skips the query entirely in the common unbound case.
   */
  private async resolveSharedAccountUsername(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const row = await this.db
      .selectFrom('users')
      .select('username')
      .where('id', '=', userId)
      .executeTakeFirst();
    return row?.username ?? null;
  }

  /**
   * Resolve a batch of bound shared-account ids to usernames in a single
   * query, avoiding N+1 lookups across `findAll()`'s result set. Skips the
   * query entirely when there are zero bound rows.
   */
  private async resolveSharedAccountUsernames(
    userIds: Array<string | null>
  ): Promise<Map<string, string>> {
    const distinctIds = Array.from(new Set(userIds.filter((id): id is string => id !== null)));
    if (distinctIds.length === 0) return new Map();

    const rows = await this.db
      .selectFrom('users')
      .select(['id', 'username'])
      .where('id', 'in', distinctIds)
      .execute();

    return new Map(rows.map((row) => [row.id, row.username]));
  }

  async save(repository: Repository): Promise<void> {
    // Deliberately does NOT touch `repository_orchestrator_sessions`:
    // designations are managed only through `addOrchestratorSession` /
    // `removeOrchestratorSession`, never as a side effect of a general save.
    const row = toRepositoryInsertRow(repository);

    await this.db
      .insertInto('repositories')
      .values(row)
      .onConflict((oc) =>
        oc.column('id').doUpdateSet(
          conflictUpdateSet(row, ['id', 'created_at', 'shared_account_user_id'] as const)
        )
      )
      .execute();

    logger.debug({ repositoryId: repository.id }, 'Repository saved');
  }

  async update(id: string, updates: RepositoryUpdates): Promise<Repository | null> {
    const now = new Date().toISOString();

    // Build update object with only provided fields.
    // Empty strings are normalized to null for database storage.
    const updateData: Record<string, unknown> = {
      updated_at: now,
    };

    const fieldMap: Array<[keyof RepositoryUpdates, string]> = [
      ['setupCommand', 'setup_command'],
      ['cleanupCommand', 'cleanup_command'],
      ['envVars', 'env_vars'],
      ['description', 'description'],
      ['defaultAgentId', 'default_agent_id'],
      ['issueTriggerLabels', 'issue_trigger_labels'],
      ['sharedAccountUserId', 'shared_account_user_id'],
    ];

    for (const [domainKey, dbColumn] of fieldMap) {
      if (updates[domainKey] !== undefined) {
        updateData[dbColumn] = updates[domainKey] === '' ? null : updates[domainKey];
      }
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

  async addOrchestratorSession(
    id: string,
    sessionId: string
  ): Promise<{ added: boolean; repository: Repository | null }> {
    // Check with findById first: `repository_id` carries a real FK, so an
    // insert against an unknown repository would throw a raw FK error
    // instead of the caller's expected `repository: null` shape.
    const existing = await this.findById(id);
    if (!existing) {
      return { added: false, repository: null };
    }

    const result = await this.db
      .insertInto('repository_orchestrator_sessions')
      .values({ repository_id: id, session_id: sessionId })
      .onConflict((oc) => oc.columns(['repository_id', 'session_id']).doNothing())
      .execute();

    const added = (result[0]?.numInsertedOrUpdatedRows ?? 0n) > 0n;
    logger.debug({ repositoryId: id, sessionId, added }, 'Orchestrator session designation add attempted');
    return { added, repository: await this.findById(id) };
  }

  async removeOrchestratorSession(
    id: string,
    sessionId: string
  ): Promise<{ removed: boolean; repository: Repository | null }> {
    const result = await this.db
      .deleteFrom('repository_orchestrator_sessions')
      .where('repository_id', '=', id)
      .where('session_id', '=', sessionId)
      .execute();

    const removed = (result[0]?.numDeletedRows ?? 0n) > 0n;
    logger.debug({ repositoryId: id, sessionId, removed }, 'Orchestrator session designation remove attempted');
    return { removed, repository: await this.findById(id) };
  }

  async listOrchestratorSessionIds(id: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('repository_orchestrator_sessions')
      .select('session_id')
      .where('repository_id', '=', id)
      .orderBy('created_at', 'asc')
      .orderBy('session_id', 'asc')
      .execute();

    return rows.map((row) => row.session_id);
  }

  async getSharedAccountUserId(id: string): Promise<string | null | undefined> {
    const row = await this.db
      .selectFrom('repositories')
      .select('shared_account_user_id')
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) return undefined;
    return row.shared_account_user_id;
  }
}
