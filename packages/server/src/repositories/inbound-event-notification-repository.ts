import { getDatabase } from '../database/connection.js';
import { createLogger } from '../lib/logger.js';
import type {
  InboundEventNotification,
  NewInboundEventNotification,
} from '../database/schema.js';

const logger = createLogger('inbound-event-notification-repository');

export async function createInboundEventNotification(
  notification: NewInboundEventNotification
): Promise<InboundEventNotification> {
  const db = getDatabase();

  await db
    .insertInto('inbound_event_notifications')
    .values(notification)
    .execute();

  logger.debug(
    { id: notification.id, sessionId: notification.session_id, handlerId: notification.handler_id },
    'Inbound event notification recorded'
  );

  return notification;
}
