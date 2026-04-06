import type { Kysely } from 'kysely';
import type { MessageTemplate } from '@agent-console/shared';
import type { MessageTemplateRepository } from './message-template-repository.js';
import type { Database } from '../database/schema.js';
import { toMessageTemplate } from '../database/mappers.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('sqlite-message-template-repository');

export class SqliteMessageTemplateRepository implements MessageTemplateRepository {
  constructor(private db: Kysely<Database>) {}

  async findAll(): Promise<MessageTemplate[]> {
    const rows = await this.db
      .selectFrom('message_templates')
      .selectAll()
      .orderBy('sort_order', 'asc')
      .execute();
    return rows.map(toMessageTemplate);
  }

  async findById(id: string): Promise<MessageTemplate | null> {
    const row = await this.db
      .selectFrom('message_templates')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst();
    return row ? toMessageTemplate(row) : null;
  }

  async create(id: string, title: string, content: string, sortOrder: number): Promise<MessageTemplate> {
    const now = new Date().toISOString();
    await this.db
      .insertInto('message_templates')
      .values({
        id,
        title,
        content,
        sort_order: sortOrder,
        created_at: now,
        updated_at: now,
      })
      .execute();

    logger.debug({ templateId: id }, 'Message template created');

    // findById will always succeed immediately after insert
    return (await this.findById(id))!;
  }

  async update(id: string, updates: { title?: string; content?: string }): Promise<MessageTemplate | null> {
    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = { updated_at: now };

    if (updates.title !== undefined) {
      updateData.title = updates.title;
    }
    if (updates.content !== undefined) {
      updateData.content = updates.content;
    }

    const result = await this.db
      .updateTable('message_templates')
      .set(updateData)
      .where('id', '=', id)
      .execute();

    if (result[0]?.numUpdatedRows === 0n) {
      return null;
    }

    logger.debug({ templateId: id }, 'Message template updated');
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('message_templates')
      .where('id', '=', id)
      .execute();

    const deleted = (result[0]?.numDeletedRows ?? 0n) > 0n;
    if (deleted) {
      logger.debug({ templateId: id }, 'Message template deleted');
    }
    return deleted;
  }

  async reorder(orderedIds: string[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await trx
          .updateTable('message_templates')
          .set({ sort_order: i, updated_at: new Date().toISOString() })
          .where('id', '=', orderedIds[i])
          .execute();
      }
    });

    logger.debug({ count: orderedIds.length }, 'Message templates reordered');
  }
}
