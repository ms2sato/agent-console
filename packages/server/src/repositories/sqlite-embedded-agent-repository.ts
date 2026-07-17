import type { Kysely } from 'kysely';
import type { EmbeddedAgentDefinition } from '@agent-console/shared';
import type { EmbeddedAgentRepository } from './embedded-agent-repository.js';
import type { Database } from '../database/schema.js';
import { createLogger } from '../lib/logger.js';
import { toEmbeddedAgentRow, toEmbeddedAgentDefinition } from '../database/mappers.js';

const logger = createLogger('sqlite-embedded-agent-repository');

export class SqliteEmbeddedAgentRepository implements EmbeddedAgentRepository {
  constructor(private db: Kysely<Database>) {}

  async findAll(): Promise<EmbeddedAgentDefinition[]> {
    const rows = await this.db.selectFrom('embedded_agents').selectAll().execute();
    return rows.map((row) => toEmbeddedAgentDefinition(row));
  }

  async findById(id: string): Promise<EmbeddedAgentDefinition | null> {
    const row = await this.db
      .selectFrom('embedded_agents')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst();

    return row ? toEmbeddedAgentDefinition(row) : null;
  }

  async save(def: EmbeddedAgentDefinition): Promise<void> {
    const row = toEmbeddedAgentRow(def);

    await this.db
      .insertInto('embedded_agents')
      .values(row)
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          name: row.name,
          description: row.description,
          provider_base_url: row.provider_base_url,
          provider_model: row.provider_model,
          provider_api_key_ref: row.provider_api_key_ref,
          system_prompt: row.system_prompt,
          max_tool_iterations: row.max_tool_iterations,
          enabled_tools: row.enabled_tools,
          instructions: row.instructions,
          context_window_tokens: row.context_window_tokens,
          handoff_soft_ratio: row.handoff_soft_ratio,
          handoff_hard_ratio: row.handoff_hard_ratio,
          handoff_auto: row.handoff_auto,
          // Note: created_at and created_by are intentionally NOT updated
          // (they must never change after the initial insert).
          updated_at: row.updated_at,
        })
      )
      .execute();

    logger.debug({ embeddedAgentId: def.id }, 'Embedded agent saved');
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('embedded_agents').where('id', '=', id).execute();
    logger.debug({ embeddedAgentId: id }, 'Embedded agent deleted');
  }
}
