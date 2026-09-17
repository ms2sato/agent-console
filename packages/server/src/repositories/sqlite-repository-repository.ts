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

    return rows.map((row) => toRepository(row, byRepositoryId.get(row.id) ?? []));
  }

  async findById(id: string): Promise<Repository | null> {
    const row = await this.db
      .selectFrom('repositories')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst();

    if (!row) return null;
    const orchestratorSessionIds = await this.listOrchestratorSessionIds(id);
    return toRepository(row, orchestratorSessionIds);
  }

  async findByPath(path: string): Promise<Repository | null> {
    const row = await this.db
      .selectFrom('repositories')
      .where('path', '=', path)
      .selectAll()
      .executeTakeFirst();

    if (!row) return null;
    const orchestratorSessionIds = await this.listOrchestratorSessionIds(row.id);
    return toRepository(row, orchestratorSessionIds);
  }

  async save(repository: Repository): Promise<void> {
    const now = new Date().toISOString();
    // Deliberately does NOT touch `repository_orchestrator_sessions`:
    // designations are managed only through `addOrchestratorSession` /
    // `removeOrchestratorSession`, never as a side effect of a general save.
    await this.db
      .insertInto('repositories')
      .values({
        id: repository.id,
        name: repository.name,
        path: repository.path,
        created_at: repository.createdAt,
        updated_at: now,
        setup_command: repository.setupCommand ?? null,
        cleanup_command: repository.cleanupCommand ?? null,
        env_vars: repository.envVars ?? null,
        description: repository.description ?? null,
        default_agent_id: repository.defaultAgentId ?? null,
        issue_trigger_labels: repository.issueTriggerLabels ?? null,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          name: repository.name,
          path: repository.path,
          setup_command: repository.setupCommand ?? null,
          cleanup_command: repository.cleanupCommand ?? null,
          env_vars: repository.envVars ?? null,
          description: repository.description ?? null,
          default_agent_id: repository.defaultAgentId ?? null,
          issue_trigger_labels: repository.issueTriggerLabels ?? null,
          // Note: created_at is intentionally NOT updated (should never change after insert)
          updated_at: now,
        })
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
}
