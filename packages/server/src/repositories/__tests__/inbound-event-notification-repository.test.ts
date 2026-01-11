import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { createInboundEventNotification } from '../inbound-event-notification-repository.js';

const BASE_NOTIFICATION = {
  job_id: 'job-1',
  session_id: 'session-1',
  worker_id: 'worker-1',
  handler_id: 'handler-1',
  event_type: 'ci:failed',
  event_summary: 'CI failed',
  notified_at: '2024-01-01T00:00:00Z',
} as const;

describe('createInboundEventNotification', () => {
  beforeEach(async () => {
    await initializeDatabase(':memory:');
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('deduplicates notifications for the same delivery target', async () => {
    await createInboundEventNotification({
      id: 'notification-1',
      ...BASE_NOTIFICATION,
    });

    await createInboundEventNotification({
      id: 'notification-2',
      ...BASE_NOTIFICATION,
    });

    const db = getDatabase();
    const rows = await db
      .selectFrom('inbound_event_notifications')
      .selectAll()
      .execute();

    expect(rows).toHaveLength(1);
  });
});
