import { describe, expect, it, mock, beforeEach } from 'bun:test';
import type { ServiceParser } from '../inbound/service-parser.js';
import type { InboundEventHandler } from '../inbound/handlers.js';
import type { InboundEventNotification, NewInboundEventNotification } from '../../database/schema.js';
import { createInboundEventJobHandler } from '../inbound/job-handler.js';
import type { CICompletionChecker } from '../inbound/ci-completion-checker.js';

// Mock functions with proper return types
const mockFindInboundEventNotification = mock<() => Promise<InboundEventNotification | null>>(
  async () => null
);
const mockCreatePendingNotification = mock(
  async (_notification: Omit<NewInboundEventNotification, 'status' | 'notified_at'>): Promise<void> => {}
);
const mockMarkNotificationDelivered = mock(async () => {});
const notificationRepository = {
  findInboundEventNotification: mockFindInboundEventNotification,
  createPendingNotification: mockCreatePendingNotification,
  markNotificationDelivered: mockMarkNotificationDelivered,
};

describe('createInboundEventJobHandler', () => {
  beforeEach(() => {
    mockFindInboundEventNotification.mockClear();
    mockCreatePendingNotification.mockClear();
    mockMarkNotificationDelivered.mockClear();
    // Default: no existing notification
    mockFindInboundEventNotification.mockImplementation(async () => null);
  });

  it('dispatches to handlers and records notifications', async () => {
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
      notificationRepository,
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
      notificationRepository,
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
      notificationRepository,
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
      notificationRepository,
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

  it('ci:completed suppressed when not all workflows are done', async () => {
    const mockChecker = mock<CICompletionChecker>(async () => ({
      allCompleted: false,
      totalWorkflows: 3,
      successCount: 1,
      workflowNames: ['lint'],
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
        metadata: { repositoryName: 'owner/repo', commitSha: 'abc123' },
        payload: { ok: true },
        summary: 'CI success',
      }),
    };

    const jobHandler = createInboundEventJobHandler({
      getServiceParser: () => parser,
      resolveTargets: async () => [{ sessionId: 'session-1' }],
      handlers: [handler],
      notificationRepository,
      ciCompletionChecker: mockChecker,
    });

    await jobHandler({
      jobId: 'job-1',
      service: 'github',
      rawPayload: '{}',
      headers: {},
      receivedAt: '2024-01-01T00:00:00Z',
    });

    // Handler should NOT be called (event suppressed)
    expect(handlerMock).not.toHaveBeenCalled();
    // No notification records should be created
    expect(mockCreatePendingNotification).not.toHaveBeenCalled();
    expect(mockMarkNotificationDelivered).not.toHaveBeenCalled();
  });

  it('ci:completed proceeds when all workflows passed', async () => {
    const mockChecker = mock<CICompletionChecker>(async () => ({
      allCompleted: true,
      totalWorkflows: 3,
      successCount: 3,
      workflowNames: ['lint', 'test', 'build'],
    }));

    const handlerMock = mock<InboundEventHandler['handle']>(async () => true);
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
        metadata: { repositoryName: 'owner/repo', commitSha: 'abc123' },
        payload: { ok: true },
        summary: 'CI success',
      }),
    };

    const jobHandler = createInboundEventJobHandler({
      getServiceParser: () => parser,
      resolveTargets: async () => [{ sessionId: 'session-1' }],
      handlers: [handler],
      notificationRepository,
      ciCompletionChecker: mockChecker,
    });

    await jobHandler({
      jobId: 'job-1',
      service: 'github',
      rawPayload: '{}',
      headers: {},
      receivedAt: '2024-01-01T00:00:00Z',
    });

    // Handler should be called with aggregated summary
    expect(handlerMock).toHaveBeenCalledTimes(1);
    const passedEvent = handlerMock.mock.calls[0][0];
    expect(passedEvent.summary).toBe('All CI workflows passed (lint, test, build)');
  });

  it('ci:completed passes through when checker returns null (fail-open)', async () => {
    const mockChecker = mock<CICompletionChecker>(async () => null);

    const handlerMock = mock<InboundEventHandler['handle']>(async () => true);
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
        metadata: { repositoryName: 'owner/repo', commitSha: 'abc123' },
        payload: { ok: true },
        summary: 'CI success',
      }),
    };

    const jobHandler = createInboundEventJobHandler({
      getServiceParser: () => parser,
      resolveTargets: async () => [{ sessionId: 'session-1' }],
      handlers: [handler],
      notificationRepository,
      ciCompletionChecker: mockChecker,
    });

    await jobHandler({
      jobId: 'job-1',
      service: 'github',
      rawPayload: '{}',
      headers: {},
      receivedAt: '2024-01-01T00:00:00Z',
    });

    // Handler should be called with original summary (unchanged)
    expect(handlerMock).toHaveBeenCalledTimes(1);
    const passedEvent = handlerMock.mock.calls[0][0];
    expect(passedEvent.summary).toBe('CI success');
  });

  it('ci:completed passes through when no ciCompletionChecker provided', async () => {
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
        metadata: { repositoryName: 'owner/repo', commitSha: 'abc123' },
        payload: { ok: true },
        summary: 'CI success',
      }),
    };

    // No ciCompletionChecker provided (backward compatibility)
    const jobHandler = createInboundEventJobHandler({
      getServiceParser: () => parser,
      resolveTargets: async () => [{ sessionId: 'session-1' }],
      handlers: [handler],
      notificationRepository,
    });

    await jobHandler({
      jobId: 'job-1',
      service: 'github',
      rawPayload: '{}',
      headers: {},
      receivedAt: '2024-01-01T00:00:00Z',
    });

    // Handler should be called
    expect(handlerMock).toHaveBeenCalledTimes(1);
  });

  it('ci:failed is unaffected by checker', async () => {
    const mockChecker = mock<CICompletionChecker>(async () => ({
      allCompleted: false,
      totalWorkflows: 3,
      successCount: 1,
      workflowNames: ['lint'],
    }));

    const handlerMock = mock(async () => true);
    const handler: InboundEventHandler = {
      handlerId: 'test-handler',
      supportedEvents: ['ci:failed'],
      handle: handlerMock,
    };

    const parser: ServiceParser = {
      serviceId: 'github',
      authenticate: async () => true,
      parse: async () => ({
        type: 'ci:failed',
        source: 'github',
        timestamp: '2024-01-01T00:00:00Z',
        metadata: { repositoryName: 'owner/repo', commitSha: 'abc123' },
        payload: { ok: false },
        summary: 'CI failed',
      }),
    };

    const jobHandler = createInboundEventJobHandler({
      getServiceParser: () => parser,
      resolveTargets: async () => [{ sessionId: 'session-1' }],
      handlers: [handler],
      notificationRepository,
      ciCompletionChecker: mockChecker,
    });

    await jobHandler({
      jobId: 'job-1',
      service: 'github',
      rawPayload: '{}',
      headers: {},
      receivedAt: '2024-01-01T00:00:00Z',
    });

    // ciCompletionChecker should NOT be called for ci:failed
    expect(mockChecker).not.toHaveBeenCalled();
    // Handler should be called
    expect(handlerMock).toHaveBeenCalledTimes(1);
  });

  it('ci:completed forwards event.metadata.branch to ciCompletionChecker', async () => {
    // Verifies that the job-handler passes `branch` as the third argument to
    // the checker, enabling the PR-rollup-based check that resolves #699.
    const checkerCalls: Array<[string, string, string | undefined]> = [];
    const mockChecker: CICompletionChecker = async (repo, sha, branch) => {
      checkerCalls.push([repo, sha, branch]);
      return {
        allCompleted: true,
        totalWorkflows: 1,
        successCount: 1,
        workflowNames: ['test'],
      };
    };

    const handlerMock = mock<InboundEventHandler['handle']>(async () => true);
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
        metadata: {
          repositoryName: 'owner/repo',
          commitSha: 'abc123',
          branch: 'feature-x',
        },
        payload: { ok: true },
        summary: 'CI success',
      }),
    };

    const jobHandler = createInboundEventJobHandler({
      getServiceParser: () => parser,
      resolveTargets: async () => [{ sessionId: 'session-1' }],
      handlers: [handler],
      notificationRepository,
      ciCompletionChecker: mockChecker,
    });

    await jobHandler({
      jobId: 'job-1',
      service: 'github',
      rawPayload: '{}',
      headers: {},
      receivedAt: '2024-01-01T00:00:00Z',
    });

    expect(checkerCalls).toEqual([['owner/repo', 'abc123', 'feature-x']]);
    expect(handlerMock).toHaveBeenCalledTimes(1);
  });

  it('ci:completed without commitSha skips the check', async () => {
    const mockChecker = mock<CICompletionChecker>(async () => ({
      allCompleted: false,
      totalWorkflows: 3,
      successCount: 1,
      workflowNames: ['lint'],
    }));

    const handlerMock = mock<InboundEventHandler['handle']>(async () => true);
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
        metadata: { repositoryName: 'owner/repo' }, // No commitSha
        payload: { ok: true },
        summary: 'CI success',
      }),
    };

    const jobHandler = createInboundEventJobHandler({
      getServiceParser: () => parser,
      resolveTargets: async () => [{ sessionId: 'session-1' }],
      handlers: [handler],
      notificationRepository,
      ciCompletionChecker: mockChecker,
    });

    await jobHandler({
      jobId: 'job-1',
      service: 'github',
      rawPayload: '{}',
      headers: {},
      receivedAt: '2024-01-01T00:00:00Z',
    });

    // ciCompletionChecker should NOT be called (no commitSha)
    expect(mockChecker).not.toHaveBeenCalled();
    // Handler should be called with original event
    expect(handlerMock).toHaveBeenCalledTimes(1);
    const passedEvent = handlerMock.mock.calls[0][0];
    expect(passedEvent.summary).toBe('CI success');
  });
});
