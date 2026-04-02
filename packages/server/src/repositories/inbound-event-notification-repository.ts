import type { Kysely } from 'kysely';
import { createLogger } from '../lib/logger.js';
import type {
  Database,
  InboundEventNotification,
  NewInboundEventNotification,
} from '../database/schema.js';

const logger = createLogger('inbound-event-notification-repository');

/** Status constants for inbound event notifications */
export const NOTIFICATION_STATUS = {
  /** Handler is currently executing */
  PENDING: 'pending',
  /** Handler executed successfully */
  DELIVERED: 'delivered',
} as const;

export type NotificationStatus = (typeof NOTIFICATION_STATUS)[keyof typeof NOTIFICATION_STATUS];

export class InboundEventNotificationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Find an existing notification record for idempotency check.
   * Used to prevent duplicate handler execution on job retry.
   */
  async findInboundEventNotification(
    jobId: string,
    sessionId: string,
    workerId: string,
    handlerId: string
  ): Promise<InboundEventNotification | null> {
    const result = await this.db
      .selectFrom('inbound_event_notifications')
      .selectAll()
      .where('job_id', '=', jobId)
      .where('session_id', '=', sessionId)
      .where('worker_id', '=', workerId)
      .where('handler_id', '=', handlerId)
      .executeTakeFirst();

    return result ?? null;
  }

  /**
   * Create a pending notification record BEFORE handler execution.
   * This ensures idempotency: if handler succeeds but update fails,
   * the pending record prevents duplicate execution on retry.
   *
   * Uses INSERT OR IGNORE (onConflict doNothing) so concurrent calls
   * for the same delivery target are safe.
   */
  async createPendingNotification(
    notification: Omit<NewInboundEventNotification, 'status' | 'notified_at'>
  ): Promise<void> {
    await this.db
      .insertInto('inbound_event_notifications')
      .values({
        ...notification,
        status: NOTIFICATION_STATUS.PENDING,
        notified_at: null,
      })
      .onConflict((oc) =>
        oc.columns(['job_id', 'session_id', 'worker_id', 'handler_id']).doNothing()
      )
      .execute();

    logger.debug(
      { id: notification.id, sessionId: notification.session_id, handlerId: notification.handler_id },
      'Pending inbound event notification created'
    );
  }

  /**
   * Mark a notification as delivered AFTER handler succeeds.
   * Sets status to 'delivered' and records the notified_at timestamp.
   */
  async markNotificationDelivered(
    jobId: string,
    sessionId: string,
    workerId: string,
    handlerId: string
  ): Promise<void> {
    await this.db
      .updateTable('inbound_event_notifications')
      .set({
        status: NOTIFICATION_STATUS.DELIVERED,
        notified_at: new Date().toISOString(),
      })
      .where('job_id', '=', jobId)
      .where('session_id', '=', sessionId)
      .where('worker_id', '=', workerId)
      .where('handler_id', '=', handlerId)
      .execute();

    logger.debug(
      { jobId, sessionId, workerId, handlerId },
      'Inbound event notification marked as delivered'
    );
  }

  /**
   * Delete all notification records for a session.
   * Called when a session is deleted to clean up orphaned records.
   */
  async deleteNotificationsBySessionId(
    sessionId: string
  ): Promise<void> {
    const result = await this.db
      .deleteFrom('inbound_event_notifications')
      .where('session_id', '=', sessionId)
      .execute();

    const deletedCount = result[0]?.numDeletedRows ?? 0n;
    if (deletedCount > 0) {
      logger.debug(
        { sessionId, deletedCount: Number(deletedCount) },
        'Deleted inbound event notifications for session'
      );
    }
  }
}
