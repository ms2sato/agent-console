import type { Kysely } from 'kysely';
import type { AgentDefinition } from '@agent-console/shared';
import type { AgentRepository } from './agent-repository.js';
import type { Database } from '../database/schema.js';
import { createLogger } from '../lib/logger.js';
import { toAgentRow, toAgentDefinition } from '../database/mappers.js';

const logger = createLogger('sqlite-agent-repository');

export class SqliteAgentRepository implements AgentRepository {
  constructor(private db: Kysely<Database>) {}

  async findAll(): Promise<AgentDefinition[]> {
    const rows = await this.db.selectFrom('agents').selectAll().execute();
    return rows.map((row) => toAgentDefinition(row));
  }

  async findById(id: string): Promise<AgentDefinition | null> {
    const row = await this.db
      .selectFrom('agents')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst();

    return row ? toAgentDefinition(row) : null;
  }

  async save(agent: AgentDefinition): Promise<void> {
    const row = toAgentRow(agent);

    await this.db
      .insertInto('agents')
      .values(row)
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          name: row.name,
          command_template: row.command_template,
          continue_template: row.continue_template,
          headless_template: row.headless_template,
          description: row.description,
          is_built_in: row.is_built_in,
          // Note: created_at is intentionally NOT updated (should never change after insert)
          updated_at: row.updated_at,
          activity_patterns: row.activity_patterns,
        })
      )
      .execute();

    logger.debug({ agentId: agent.id }, 'Agent saved');
  }

  async delete(id: string): Promise<void> {
    // Check if the agent is built-in before deleting
    const agent = await this.findById(id);
    if (!agent) {
      // Idempotent - deleting non-existent is OK
      return;
    }

    if (agent.isBuiltIn) {
      throw new Error('Cannot delete built-in agent');
    }

    await this.db.deleteFrom('agents').where('id', '=', id).execute();
    logger.debug({ agentId: id }, 'Agent deleted');
  }
}
