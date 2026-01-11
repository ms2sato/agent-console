import { describe, expect, it, mock } from 'bun:test';
import type { ServiceParser } from '../inbound/service-parser.js';
import type { InboundEventHandler } from '../inbound/handlers.js';

const mockCreateInboundEventNotification = mock(async () => ({}));

mock.module('../../repositories/inbound-event-notification-repository.js', () => ({
  createInboundEventNotification: mockCreateInboundEventNotification,
}));

describe('createInboundEventJobHandler', () => {
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

    expect(mockCreateInboundEventNotification).toHaveBeenCalledTimes(1);
  });
});
