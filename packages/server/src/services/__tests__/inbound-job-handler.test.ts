import { describe, expect, it, mock, beforeEach, afterAll } from 'bun:test';
import type { ServiceParser } from '../inbound/service-parser.js';
import type { InboundEventHandler } from '../inbound/handlers.js';
import type { InboundEventNotification } from '../../database/schema.js';

// Mock functions with proper return types
const mockFindInboundEventNotification = mock<() => Promise<InboundEventNotification | null>>(
  async () => null
);
const mockCreatePendingNotification = mock(async () => ({}));
const mockMarkNotificationDelivered = mock(async () => {});

mock.module('../../repositories/inbound-event-notification-repository.js', () => ({
  findInboundEventNotification: mockFindInboundEventNotification,
  createPendingNotification: mockCreatePendingNotification,
  markNotificationDelivered: mockMarkNotificationDelivered,
  NOTIFICATION_STATUS: {
    PENDING: 'pending',
    DELIVERED: 'delivered',
  },
}));

describe('createInboundEventJobHandler', () => {
  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    mockFindInboundEventNotification.mockClear();
    mockCreatePendingNotification.mockClear();
    mockMarkNotificationDelivered.mockClear();
    // Default: no existing notification
    mockFindInboundEventNotification.mockImplementation(async () => null);
  });

  it('dispatches to handlers and records notifications', async () => {
    let importCounter = 0;
    const { createInboundEventJobHandler } = await import(
      `../inbound/job-handler.js?v=${++importCounter}`
    );

    const parser: ServiceParser = {
      serviceId: 'github',
      authenticate: async () => true,
      parse: async () => ({
        type: 'ci:completed',
        source: 'github',
        timestamp: '2024-01-01T00:00:00Z',
        metadata: { repositoryName: 'owner/repo' },
        payload: { ok: true },
        summary: 'CI success',
      }),
    };

    const handler: InboundEventHandler = {
      handlerId: 'test-handler',
      supportedEvents: ['ci:completed'],
      handle: async () => true,
    };

    const jobHandler = createInboundEventJobHandler({
      getServiceParser: () => parser,
      resolveTargets: async () => [{ sessionId: 'session-1' }],
      handlers: [handler],
    });

    await jobHandler({
      jobId: 'job-1',
      service: 'github',
      rawPayload: '{}',
      headers: {},
      receivedAt: '2024-01-01T00:00:00Z',
    });

    // Should check for existing, create pending, and mark delivered
    expect(mockFindInboundEventNotification).toHaveBeenCalledTimes(1);
    expect(mockCreatePendingNotification).toHaveBeenCalledTimes(1);
    expect(mockMarkNotificationDelivered).toHaveBeenCalledTimes(1);
  });

  it('skips handler when notification already delivered', async () => {
    let importCounter = 0;
    const { createInboundEventJobHandler } = await import(
      `../inbound/job-handler.js?v=${++importCounter}`
    );

    // Simulate existing delivered notification
    mockFindInboundEventNotification.mockImplementation(async () => ({
      id: 'existing-notification',
      job_id: 'job-1',
      session_id: 'session-1',
      worker_id: 'all',
      handler_id: 'test-handler',
      event_type: 'ci:completed',
      event_summary: 'CI success',
      status: 'delivered',
      created_at: '2024-01-01T00:00:00Z',
      notified_at: '2024-01-01T00:00:00Z',
    }));

    const handlerMock = mock(async () => true);
    const handler: InboundEventHandler = {
      handlerId: 'test-handler',
      supportedEvents: ['ci:completed'],
      handle: handlerMock,
    };

    const parser: ServiceParser = {
      serviceId: 'github',
      authenticate: async () => true,
      parse: async () => ({
        type: 'ci:completed',
        source: 'github',
        timestamp: '2024-01-01T00:00:00Z',
        metadata: { repositoryName: 'owner/repo' },
        payload: { ok: true },
        summary: 'CI success',
      }),
    };

    const jobHandler = createInboundEventJobHandler({
      getServiceParser: () => parser,
      resolveTargets: async () => [{ sessionId: 'session-1' }],
      handlers: [handler],
    });

    await jobHandler({
      jobId: 'job-1',
      service: 'github',
      rawPayload: '{}',
      headers: {},
      receivedAt: '2024-01-01T00:00:00Z',
    });

    // Should skip handler execution and not create new notification
    expect(handlerMock).not.toHaveBeenCalled();
    expect(mockCreatePendingNotification).not.toHaveBeenCalled();
    expect(mockMarkNotificationDelivered).not.toHaveBeenCalled();
  });

  it('marks pending notification as delivered without re-executing handler', async () => {
    let importCounter = 0;
    const { createInboundEventJobHandler } = await import(
      `../inbound/job-handler.js?v=${++importCounter}`
    );

    // Simulate existing pending notification (from previous failed attempt)
    mockFindInboundEventNotification.mockImplementation(async () => ({
      id: 'existing-notification',
      job_id: 'job-1',
      session_id: 'session-1',
      worker_id: 'all',
      handler_id: 'test-handler',
      event_type: 'ci:completed',
      event_summary: 'CI success',
      status: 'pending',
      created_at: '2024-01-01T00:00:00Z',
      notified_at: null,
    }));

    const handlerMock = mock(async () => true);
    const handler: InboundEventHandler = {
      handlerId: 'test-handler',
      supportedEvents: ['ci:completed'],
      handle: handlerMock,
    };

    const parser: ServiceParser = {
      serviceId: 'github',
      authenticate: async () => true,
      parse: async () => ({
        type: 'ci:completed',
        source: 'github',
        timestamp: '2024-01-01T00:00:00Z',
        metadata: { repositoryName: 'owner/repo' },
        payload: { ok: true },
        summary: 'CI success',
      }),
    };

    const jobHandler = createInboundEventJobHandler({
      getServiceParser: () => parser,
      resolveTargets: async () => [{ sessionId: 'session-1' }],
      handlers: [handler],
    });

    await jobHandler({
      jobId: 'job-1',
      service: 'github',
      rawPayload: '{}',
      headers: {},
      receivedAt: '2024-01-01T00:00:00Z',
    });

    // Should NOT re-execute handler but should mark as delivered
    expect(handlerMock).not.toHaveBeenCalled();
    expect(mockCreatePendingNotification).not.toHaveBeenCalled();
    expect(mockMarkNotificationDelivered).toHaveBeenCalledTimes(1);
  });

  it('marks notification as delivered even when handler returns false', async () => {
    let importCounter = 0;
    const { createInboundEventJobHandler } = await import(
      `../inbound/job-handler.js?v=${++importCounter}`
    );

    // Handler returns false (e.g., session not found, no action taken)
    const handlerMock = mock(async () => false);
    const handler: InboundEventHandler = {
      handlerId: 'test-handler',
      supportedEvents: ['ci:completed'],
      handle: handlerMock,
    };

    const parser: ServiceParser = {
      serviceId: 'github',
      authenticate: async () => true,
      parse: async () => ({
        type: 'ci:completed',
        source: 'github',
        timestamp: '2024-01-01T00:00:00Z',
        metadata: { repositoryName: 'owner/repo' },
        payload: { ok: true },
        summary: 'CI success',
      }),
    };

    const jobHandler = createInboundEventJobHandler({
      getServiceParser: () => parser,
      resolveTargets: async () => [{ sessionId: 'session-1' }],
      handlers: [handler],
    });

    await jobHandler({
      jobId: 'job-1',
      service: 'github',
      rawPayload: '{}',
      headers: {},
      receivedAt: '2024-01-01T00:00:00Z',
    });

    // Handler was called, returned false
    expect(handlerMock).toHaveBeenCalledTimes(1);
    // Notification should still be marked as delivered to prevent forever-pending state
    expect(mockCreatePendingNotification).toHaveBeenCalledTimes(1);
    expect(mockMarkNotificationDelivered).toHaveBeenCalledTimes(1);
  });
});
