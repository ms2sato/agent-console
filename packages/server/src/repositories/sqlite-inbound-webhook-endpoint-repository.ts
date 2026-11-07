import type { Kysely } from 'kysely';
import type {
  CreateInboundWebhookEndpointParams,
  InboundWebhookEndpointRepository,
  InboundWebhookEndpointView,
  InboundWebhookEndpointWithSecret,
  UpdateInboundWebhookEndpointParams,
} from './webhook-endpoint-repository.js';
import type { Database, InboundWebhookEndpointRow } from '../database/schema.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('sqlite-inbound-webhook-endpoint-repository');

/** Every column except the two secrets: the ordinary reads never select them. */
const VIEW_COLUMNS = [
  'id',
  'label',
  'repository_id',
  'instruction_text',
  'previous_secret_expires_at',
  'created_at',
  'updated_at',
] as const;

type ViewRow = Pick<InboundWebhookEndpointRow, (typeof VIEW_COLUMNS)[number]>;

function toView(row: ViewRow): InboundWebhookEndpointView {
  return {
    id: row.id,
    label: row.label,
    repositoryId: row.repository_id,
    instructionText: row.instruction_text,
    previousSecretExpiresAt: row.previous_secret_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWithSecret(row: InboundWebhookEndpointRow): InboundWebhookEndpointWithSecret {
  return { ...toView(row), secret: row.secret, previousSecret: row.previous_secret };
}

export class SqliteInboundWebhookEndpointRepository implements InboundWebhookEndpointRepository {
  constructor(private db: Kysely<Database>) {}

  async list(): Promise<InboundWebhookEndpointView[]> {
    const rows = await this.db
      .selectFrom('inbound_webhook_endpoints')
      .select(VIEW_COLUMNS)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map(toView);
  }

  async findById(id: string): Promise<InboundWebhookEndpointView | null> {
    const row = await this.db
      .selectFrom('inbound_webhook_endpoints')
      .select(VIEW_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toView(row) : null;
  }

  async findWithSecretById(id: string): Promise<InboundWebhookEndpointWithSecret | null> {
    const row = await this.db
      .selectFrom('inbound_webhook_endpoints')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toWithSecret(row) : null;
  }

  async create(params: CreateInboundWebhookEndpointParams): Promise<InboundWebhookEndpointWithSecret> {
    const row = await this.db
      .insertInto('inbound_webhook_endpoints')
      .values({
        id: params.id,
        label: params.label,
        repository_id: params.repositoryId,
        instruction_text: params.instructionText,
        secret: params.secret,
        previous_secret: null,
        previous_secret_expires_at: null,
        created_at: params.now,
        updated_at: params.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    logger.debug({ endpointId: params.id, repositoryId: params.repositoryId }, 'Inbound webhook endpoint created');
    return toWithSecret(row);
  }

  async update(
    id: string,
    updates: UpdateInboundWebhookEndpointParams,
    now: string,
  ): Promise<InboundWebhookEndpointView | null> {
    const row = await this.db
      .updateTable('inbound_webhook_endpoints')
      .set({
        updated_at: now,
        ...(updates.label !== undefined ? { label: updates.label } : {}),
        ...(updates.instructionText !== undefined ? { instruction_text: updates.instructionText } : {}),
      })
      .where('id', '=', id)
      .returning(VIEW_COLUMNS)
      .executeTakeFirst();

    if (!row) return null;
    logger.debug({ endpointId: id }, 'Inbound webhook endpoint updated');
    return toView(row);
  }

  async rotateSecret(
    id: string,
    newSecret: string,
    previousSecretExpiresAt: string,
    now: string,
  ): Promise<InboundWebhookEndpointWithSecret | null> {
    // One statement: SQLite evaluates every right-hand side against the row as it was before the update,
    // so `previous_secret = secret` captures the outgoing secret while `secret` is replaced.
    const row = await this.db
      .updateTable('inbound_webhook_endpoints')
      .set((eb) => ({
        previous_secret: eb.ref('secret'),
        previous_secret_expires_at: previousSecretExpiresAt,
        secret: newSecret,
        updated_at: now,
      }))
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!row) return null;
    logger.debug({ endpointId: id }, 'Inbound webhook endpoint secret rotated');
    return toWithSecret(row);
  }

  async clearPreviousSecret(id: string, now: string): Promise<InboundWebhookEndpointView | null> {
    const row = await this.db
      .updateTable('inbound_webhook_endpoints')
      .set({ previous_secret: null, previous_secret_expires_at: null, updated_at: now })
      .where('id', '=', id)
      .returning(VIEW_COLUMNS)
      .executeTakeFirst();

    if (!row) return null;
    logger.debug({ endpointId: id }, 'Inbound webhook endpoint previous secret cleared');
    return toView(row);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('inbound_webhook_endpoints').where('id', '=', id).execute();
    const deleted = (result[0]?.numDeletedRows ?? 0n) > 0n;
    if (deleted) {
      logger.debug({ endpointId: id }, 'Inbound webhook endpoint deleted');
    }
    return deleted;
  }
}
