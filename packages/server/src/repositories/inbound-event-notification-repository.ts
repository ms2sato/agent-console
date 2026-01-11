import type { Kysely } from 'kysely';
import { getDatabase } from '../database/connection.js';
import { createLogger } from '../lib/logger.js';
import type {
  Database,
  InboundEventNotification,
  NewInboundEventNotification,
} from '../database/schema.js';

const logger = createLogger('inbound-event-notification-repository');

export async function createInboundEventNotification(
  notification: NewInboundEventNotification,
  dbOverride?: Kysely<Database>
): Promise<InboundEventNotification> {
  const db = dbOverride ?? getDatabase();

  await db
    .insertInto('inbound_event_notifications')
    .values(notification)
    .onConflict((oc) =>
      oc.columns(['job_id', 'session_id', 'worker_id', 'handler_id']).doNothing()
    )
    .execute();

  logger.debug(
    { id: notification.id, sessionId: notification.session_id, handlerId: notification.handler_id },
    'Inbound event notification recorded'
  );

  return notification;
}
