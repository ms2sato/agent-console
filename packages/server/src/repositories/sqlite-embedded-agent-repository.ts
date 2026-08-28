import type { Kysely } from 'kysely';
import type { EmbeddedAgentDefinition } from '@agent-console/shared';
import type { EmbeddedAgentRepository } from './embedded-agent-repository.js';
import type { Database } from '../database/schema.js';
import { createLogger } from '../lib/logger.js';
import { toEmbeddedAgentRow, toEmbeddedAgentDefinition, DataIntegrityError } from '../database/mappers.js';

const logger = createLogger('sqlite-embedded-agent-repository');

export class SqliteEmbeddedAgentRepository implements EmbeddedAgentRepository {
  constructor(private db: Kysely<Database>) {}

  async findAll(): Promise<EmbeddedAgentDefinition[]> {
    const rows = await this.db.selectFrom('embedded_agents').selectAll().execute();

    // Skip corrupted rows rather than letting one bad row fail the whole
    // call -- EmbeddedAgentManager.initialize() calls findAll() during
    // server startup, so a single corrupted row must not take down every
    // other healthy embedded-agent definition. Mirrors
    // SqliteSessionRepository.findAll()'s DataIntegrityError containment.
    const results: EmbeddedAgentDefinition[] = [];
    for (const row of rows) {
      try {
        results.push(toEmbeddedAgentDefinition(row));
      } catch (error) {
        if (error instanceof DataIntegrityError) {
          logger.warn({ embeddedAgentId: row.id, err: error }, 'Skipping corrupted embedded agent row');
          continue;
        }
        throw error;
      }
    }
    return results;
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
          // `engine` is included for consistency with the "upsert built-in
          // on every startup" pattern (EmbeddedAgentManager.initialize) --
          // in practice no caller ever flips a definition's engine post-
          // creation, so this is a no-op update in every real invocation.
          engine: row.engine,
          provider_base_url: row.provider_base_url,
          provider_model: row.provider_model,
          provider_api_key_ref: row.provider_api_key_ref,
          system_prompt: row.system_prompt,
          max_tool_iterations: row.max_tool_iterations,
          enabled_tools: row.enabled_tools,
          instructions: row.instructions,
          context_window_tokens: row.context_window_tokens,
          compaction_threshold: row.compaction_threshold,
          is_built_in: row.is_built_in,
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
