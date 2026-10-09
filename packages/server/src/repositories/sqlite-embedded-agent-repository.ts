import type { Kysely } from 'kysely';
import type { EmbeddedAgentDefinition } from '@agent-console/shared';
import type { EmbeddedAgentRepository } from './embedded-agent-repository.js';
import type { Database } from '../database/schema.js';
import { createLogger } from '../lib/logger.js';
import { toEmbeddedAgentRow, toEmbeddedAgentDefinition, DataIntegrityError } from '../database/mappers.js';
import { conflictUpdateSet } from './conflict-update-set.js';

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
        oc.column('id').doUpdateSet(
          conflictUpdateSet(row, ['id', 'created_at', 'created_by'] as const)
        )
      )
      .execute();

    logger.debug({ embeddedAgentId: def.id }, 'Embedded agent saved');
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('embedded_agents').where('id', '=', id).execute();
    logger.debug({ embeddedAgentId: id }, 'Embedded agent deleted');
  }
}
