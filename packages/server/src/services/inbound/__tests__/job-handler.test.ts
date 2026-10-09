import { describe, expect, it, mock, beforeEach, spyOn } from 'bun:test';
import type { Kysely } from 'kysely';
import type { ServiceParser } from '../service-parser.js';
import type { InboundEventHandler } from '../handlers.js';
import type { InboundEventNotification, NewInboundEventNotification } from '../../../database/schema.js';
import { createInboundEventJobHandler } from '../job-handler.js';
import { rootLogger } from '../../../lib/logger.js';
// Aliased: job-handler.ts's own dependency-interface `InboundEventNotificationRepository`
// (3 methods) shares its name with the CLASS of the same name imported below
// from the repository module (which additionally exposes `db` and
// `deleteNotificationsBySessionId`). The alias avoids that collision when a
// test needs to type an object against job-handler's narrower interface.
import type { InboundEventNotificationRepository as JobHandlerNotificationRepository } from '../job-handler.js';
import type { CICompletionChecker } from '../ci-completion-checker.js';
import { createDatabaseForTest } from '../../../database/connection.js';
import { InboundEventNotificationRepository } from '../../../repositories/inbound-event-notification-repository.js';
import type { Database } from '../../../database/schema.js';

async function createTestSession(db: Kysely<Database>, sessionId: string): Promise<void> {
  await db
    .insertInto('sessions')
    .values({
      id: sessionId,
      type: 'worktree',
      location_path: '/test/path',
      created_at: '2024-01-01T00:00:00Z',
      server_pid: null,
      initial_prompt: null,
      title: null,
      repository_id: null,
      worktree_id: null,
    })
    .execute();
}

// Mock functions with proper return types
const mockFindInboundEventNotification = mock<() => Promise<InboundEventNotification | null>>(
  async () => null
);
const mockCreatePendingNotification = mock(
  async (_notification: Omit<NewInboundEventNotification, 'status' | 'notified_at'>): Promise<void> => {}
);
const mockMarkNotificationDelivered = mock(async () => {});
const mockMarkNotificationFailed = mock(async () => {});
const notificationRepository = {
  findInboundEventNotification: mockFindInboundEventNotification,
  createPendingNotification: mockCreatePendingNotification,
  markNotificationDelivered: mockMarkNotificationDelivered,
  markNotificationFailed: mockMarkNotificationFailed,
};

describe('createInboundEventJobHandler', () => {
  beforeEach(() => {
    mockFindInboundEventNotification.mockClear();
    mockCreatePendingNotification.mockClear();
    mockMarkNotificationDelivered.mockClear();
    mockMarkNotificationFailed.mockClear();
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
      handle: async () => 'handled' as const,
    };

    const jobHandler = createInboundEventJobHandler({
      getServiceParser: () => parser,
      resolveTargets: async () => [{ sessionId: 'session-1', provenance: 'match' }],
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

    const handlerMock = mock(async () => 'handled' as const);
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
      resolveTargets: async () => [{ sessionId: 'session-1', provenance: 'match' }],
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

  it("leaves an existing pending notification pending without re-executing the handler -- never promoted to delivered (CodeRabbit r4226123346, Issue #1653/#1679 (vii); fails on commit fb08a3cc)", async () => {
    // Q12 polarity: on commit fb08a3cc (this PR's first fix, before the
    // CodeRabbit finding r4226123346 was addressed), the idempotency
    // check's 'pending' branch still called markNotificationDelivered
    // unconditionally -- this test's `not.toHaveBeenCalled()` assertion
    // below FAILS against that commit.
    //
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

    const handlerMock = mock(async () => 'handled' as const);
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
      resolveTargets: async () => [{ sessionId: 'session-1', provenance: 'match' }],
      handlers: [handler],
      notificationRepository,
    });

    const warnSpy = spyOn(rootLogger, 'warn');
    try {
      await jobHandler({
        jobId: 'job-1',
        service: 'github',
        rawPayload: '{}',
        headers: {},
        receivedAt: '2024-01-01T00:00:00Z',
      });

      // Should NOT re-execute handler, and should NOT be promoted to
      // delivered -- the retry cannot tell whether this row's handler
      // outcome was 'handled'/'not-applicable' or 'delivery-failed', so it
      // stays 'pending' and is logged instead.
      expect(handlerMock).not.toHaveBeenCalled();
      expect(mockCreatePendingNotification).not.toHaveBeenCalled();
      expect(mockMarkNotificationDelivered).not.toHaveBeenCalled();
      expect(mockMarkNotificationFailed).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [context, message] = warnSpy.mock.calls[0];
      expect(message).toBe('Pending notification from a previous attempt left unconfirmed; handler not re-invoked');
      expect(context).toMatchObject({
        jobId: 'job-1',
        handlerId: 'test-handler',
        sessionId: 'session-1',
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("marks notification as delivered when handler returns 'not-applicable' (Issue #1653, (iv))", async () => {
    // Handler returns 'not-applicable' (e.g., session not found, no action taken)
    const handlerMock = mock(async () => 'not-applicable' as const);
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
      resolveTargets: async () => [{ sessionId: 'session-1', provenance: 'match' }],
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

    // Handler was called, returned 'not-applicable'
    expect(handlerMock).toHaveBeenCalledTimes(1);
    // Notification should still be marked as delivered to prevent forever-pending state
    expect(mockCreatePendingNotification).toHaveBeenCalledTimes(1);
    expect(mockMarkNotificationDelivered).toHaveBeenCalledTimes(1);
    expect(mockMarkNotificationFailed).not.toHaveBeenCalled();
  });

  it("marks notification as failed (not delivered) and warns once when handler returns 'delivery-failed', and the job still completes without a job-level retry (Issue #1653/#1679, (i))", async () => {
    // Q12 polarity: on unmodified main (handle() returns a plain boolean,
    // no 'delivery-failed' outcome exists), this exact scenario is
    // unreachable -- a handler returning `false` is marked `delivered`,
    // not `failed`. Verified directly (see PR body) by reverting job-handler.ts
    // / handlers.ts / the repository to their pre-fix state and observing
    // this test fail to compile / fail its assertions.
    const handlerMock = mock(async () => 'delivery-failed' as const);
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
      resolveTargets: async () => [{ sessionId: 'session-1', provenance: 'match' }],
      handlers: [handler],
      notificationRepository,
    });

    const warnSpy = spyOn(rootLogger, 'warn');
    try {
      // "job completes" -- resolves without throwing, i.e. no job-level
      // retry is triggered by a delivery-failed outcome.
      await expect(
        jobHandler({
          jobId: 'job-1',
          service: 'github',
          rawPayload: '{}',
          headers: {},
          receivedAt: '2024-01-01T00:00:00Z',
        })
      ).resolves.toBeUndefined();

      expect(handlerMock).toHaveBeenCalledTimes(1);
      expect(mockCreatePendingNotification).toHaveBeenCalledTimes(1);
      expect(mockMarkNotificationFailed).toHaveBeenCalledTimes(1);
      expect(mockMarkNotificationDelivered).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [context, message] = warnSpy.mock.calls[0];
      expect(message).toBe('Inbound notification delivery failed');
      expect(context).toMatchObject({
        jobId: 'job-1',
        handlerId: 'test-handler',
        sessionId: 'session-1',
        eventType: 'ci:completed',
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('ci:completed suppressed when not all workflows are done', async () => {
    const mockChecker = mock<CICompletionChecker>(async () => ({
      allCompleted: false,
      totalWorkflows: 3,
      successCount: 1,
      workflowNames: ['lint'],
    }));

    const handlerMock = mock(async () => 'handled' as const);
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
      resolveTargets: async () => [{ sessionId: 'session-1', provenance: 'match' }],
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

    const handlerMock = mock<InboundEventHandler['handle']>(async () => 'handled');
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
      resolveTargets: async () => [{ sessionId: 'session-1', provenance: 'match' }],
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

    const handlerMock = mock<InboundEventHandler['handle']>(async () => 'handled');
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
      resolveTargets: async () => [{ sessionId: 'session-1', provenance: 'match' }],
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
    const handlerMock = mock(async () => 'handled' as const);
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
      resolveTargets: async () => [{ sessionId: 'session-1', provenance: 'match' }],
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

    const handlerMock = mock(async () => 'handled' as const);
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
      resolveTargets: async () => [{ sessionId: 'session-1', provenance: 'match' }],
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

    const handlerMock = mock<InboundEventHandler['handle']>(async () => 'handled');
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
      resolveTargets: async () => [{ sessionId: 'session-1', provenance: 'match' }],
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

    const handlerMock = mock<InboundEventHandler['handle']>(async () => 'handled');
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
      resolveTargets: async () => [{ sessionId: 'session-1', provenance: 'match' }],
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

  describe('per-target failure isolation (real DB, FK-backed repository)', () => {
    it('isolates a dangling target (FOREIGN KEY constraint failure) from other targets in the same event', async () => {
      const db = await createDatabaseForTest();
      try {
        const repo = new InboundEventNotificationRepository(db);
        await createTestSession(db, 'healthy-session');
        // 'dangling-session' deliberately has NO row in `sessions`.

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

        const handlerMock = mock(async () => 'handled' as const);
        const handler: InboundEventHandler = {
          handlerId: 'test-handler',
          supportedEvents: ['ci:completed'],
          handle: handlerMock,
        };

        const jobHandler = createInboundEventJobHandler({
          getServiceParser: () => parser,
          resolveTargets: async () => [
            { sessionId: 'dangling-session', provenance: 'match' },
            { sessionId: 'healthy-session', provenance: 'match' },
          ],
          handlers: [handler],
          notificationRepository: repo,
        });

        await expect(
          jobHandler({
            jobId: 'job-regress-1',
            service: 'github',
            rawPayload: '{}',
            headers: {},
            receivedAt: '2024-01-01T00:00:00Z',
          })
        ).resolves.toBeUndefined();

        const rows = await db.selectFrom('inbound_event_notifications').selectAll().execute();
        expect(rows).toHaveLength(1);
        expect(rows[0].session_id).toBe('healthy-session');
        expect(rows[0].status).toBe('delivered');
        expect(handlerMock).toHaveBeenCalledTimes(1);
      } finally {
        await db.destroy();
      }
    });

    it('rethrows a persist-step failure that is NOT a foreign-key-constraint violation, so the job queue retries it as a legitimate first attempt', async () => {
      // reach measured: temporarily reverting the fix to swallow every
      // 'persist'-step error uniformly (removing the
      // `isForeignKeyConstraintError` check) makes this test FAIL -- the
      // job resolves instead of rejecting, because the old, overly-broad
      // catch logged and swallowed this too. Restoring the real fix makes
      // it pass again. Measured 2026-09-14 against the code in this PR.
      const createPendingNotificationMock = mock(async () => {});
      const markNotificationDeliveredMock = mock(async () => {});
      const handlerMock = mock(async () => 'handled' as const);
      const jobHandler = createInboundEventJobHandler({
        getServiceParser: () => ({
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
        }),
        resolveTargets: async () => [{ sessionId: 'irrelevant-session', provenance: 'match' }],
        handlers: [
          {
            handlerId: 'test-handler',
            supportedEvents: ['ci:completed'],
            handle: handlerMock,
          },
        ],
        // This repository is entirely faked -- no real DB, no real FK
        // constraint. `findInboundEventNotification` throws a plain `Error`
        // to simulate a transient DB failure (e.g. SQLITE_BUSY, an I/O
        // error) at the 'persist' step, distinct from the FK-constraint
        // class covered by the previous test.
        notificationRepository: {
          findInboundEventNotification: async () => {
            throw new Error('simulated transient DB error');
          },
          createPendingNotification: createPendingNotificationMock,
          markNotificationDelivered: markNotificationDeliveredMock,
          markNotificationFailed: mock(async () => {}),
        },
      });

      await expect(
        jobHandler({
          jobId: 'job-regress-6',
          service: 'github',
          rawPayload: '{}',
          headers: {},
          receivedAt: '2024-01-01T00:00:00Z',
        })
      ).rejects.toThrow('simulated transient DB error');

      expect(createPendingNotificationMock).not.toHaveBeenCalled();
      expect(handlerMock).not.toHaveBeenCalled();
      expect(markNotificationDeliveredMock).not.toHaveBeenCalled();
    });

    it("logs and skips (without rethrowing, no job-level retry) when markNotificationDelivered throws after a successful handle -- leaves the row 'pending', never promotes it (CodeRabbit r4226123346; sibling target still reaches delivered normally)", async () => {
      // This test's assertions used to read `toBe('delivered')` for
      // deliverFailSessionId after a forced job retry, encoding a guess:
      // "the handler probably ran, so a retry may promote this pending
      // row to delivered". That guess is exactly what let a KNOWN
      // delivery failure (a 'delivery-failed' outcome whose own
      // markNotificationFailed write also failed) get silently recorded
      // as a successful delivery on a later, unrelated retry -- CodeRabbit
      // finding r4226123346. The fix removed the 'deliver' rethrow class
      // entirely: a markNotificationDelivered write failure is now logged
      // and skipped in its own try/catch, exactly like a
      // markNotificationFailed write failure, and the job resolves
      // without retrying. There is no more "retry" half to this test --
      // the row simply stays 'pending' from the one and only attempt.
      // Measured: temporarily removing this write's own try/catch (so the
      // throw reaches the outer catch and rethrows under the old
      // 'deliver'-step condition) makes the `.resolves` assertion below
      // FAIL (the job rejects instead).
      const db = await createDatabaseForTest();
      try {
        const repo = new InboundEventNotificationRepository(db);
        const deliverFailSessionId = 'deliver-fail-session';
        const siblingSessionId = 'sibling-healthy-session';
        await createTestSession(db, deliverFailSessionId);
        await createTestSession(db, siblingSessionId);

        // Wraps the REAL repository (real DB, real FK constraint, real
        // idempotency reads/writes) so only `markNotificationDelivered`'s
        // call for `deliverFailSessionId` is intercepted and made to
        // throw a plain (non-FK) `Error` -- simulating a transient
        // bookkeeping-write failure AFTER a real, successful `handle()`
        // call already persisted a real 'pending' row. The sibling's call
        // delegates straight through to the real repository.
        const wrappedRepo: JobHandlerNotificationRepository = {
          findInboundEventNotification: (jobId, sessionId, workerId, handlerId) =>
            repo.findInboundEventNotification(jobId, sessionId, workerId, handlerId),
          createPendingNotification: (notification) => repo.createPendingNotification(notification),
          markNotificationDelivered: async (jobId, sessionId, workerId, handlerId) => {
            if (sessionId === deliverFailSessionId) {
              throw new Error('simulated transient delivery-bookkeeping error');
            }
            return repo.markNotificationDelivered(jobId, sessionId, workerId, handlerId);
          },
          markNotificationFailed: (jobId, sessionId, workerId, handlerId) =>
            repo.markNotificationFailed(jobId, sessionId, workerId, handlerId),
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

        const handlerMock = mock(async (_event: unknown, _target: { sessionId: string }) => 'handled' as const);
        const handler: InboundEventHandler = {
          handlerId: 'test-handler',
          supportedEvents: ['ci:completed'],
          handle: handlerMock as InboundEventHandler['handle'],
        };

        const jobHandler = createInboundEventJobHandler({
          getServiceParser: () => parser,
          resolveTargets: async () => [
            { sessionId: siblingSessionId, provenance: 'match' },
            { sessionId: deliverFailSessionId, provenance: 'match' },
          ],
          handlers: [handler],
          notificationRepository: wrappedRepo,
        });

        const jobPayload = {
          jobId: 'job-regress-7',
          service: 'github',
          rawPayload: '{}',
          headers: {},
          receivedAt: '2024-01-01T00:00:00Z',
        };

        const errorSpy = spyOn(rootLogger, 'error');
        try {
          // The job resolves -- the bookkeeping write failure is logged
          // and skipped, never rethrown, so there is no job-level retry.
          await expect(jobHandler(jobPayload)).resolves.toBeUndefined();

          expect(
            handlerMock.mock.calls.filter((call) => call[1].sessionId === deliverFailSessionId)
          ).toHaveLength(1);
          expect(
            handlerMock.mock.calls.filter((call) => call[1].sessionId === siblingSessionId)
          ).toHaveLength(1);

          const rows = await db.selectFrom('inbound_event_notifications').selectAll().execute();
          // Never promoted to 'delivered' -- this is the exact bug the
          // Architect/CodeRabbit caught.
          expect(rows.find((r) => r.session_id === deliverFailSessionId)?.status).toBe('pending');
          expect(rows.find((r) => r.session_id === siblingSessionId)?.status).toBe('delivered');

          const messages = errorSpy.mock.calls.map((call) => call[1]);
          expect(messages).toContain('Failed to mark notification as delivered; row left pending');
        } finally {
          errorSpy.mockRestore();
        }
      } finally {
        await db.destroy();
      }
    });

    it('isolates a handler that throws after the pending row is already created (the "handle" failure class), while a second healthy target is still processed normally', async () => {
      const db = await createDatabaseForTest();
      try {
        const repo = new InboundEventNotificationRepository(db);
        // Both sessions are healthy rows -- this test is about a handler
        // throwing AFTER the pending notification row was persisted, not
        // about a dangling session_id (that is the 'persist' class, covered
        // by the previous test).
        await createTestSession(db, 'failing-session');
        await createTestSession(db, 'healthy-session-2');

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

        const handlerMock = mock(async (_event: unknown, target: { sessionId: string }) => {
          if (target.sessionId === 'failing-session') {
            throw new Error('boom');
          }
          return 'handled' as const;
        });
        const handler: InboundEventHandler = {
          handlerId: 'test-handler',
          supportedEvents: ['ci:completed'],
          handle: handlerMock as InboundEventHandler['handle'],
        };

        const jobHandler = createInboundEventJobHandler({
          getServiceParser: () => parser,
          resolveTargets: async () => [
            { sessionId: 'failing-session', provenance: 'match' },
            { sessionId: 'healthy-session-2', provenance: 'match' },
          ],
          handlers: [handler],
          notificationRepository: repo,
        });

        // (a) The job resolves without throwing -- the handler failure is
        // isolated and does not propagate out of the job.
        await expect(
          jobHandler({
            jobId: 'job-regress-5',
            service: 'github',
            rawPayload: '{}',
            headers: {},
            receivedAt: '2024-01-01T00:00:00Z',
          })
        ).resolves.toBeUndefined();

        const rows = await db.selectFrom('inbound_event_notifications').selectAll().execute();
        expect(rows).toHaveLength(2);

        // (b) The failing target's notification row WAS created and is
        // marked 'failed' -- a terminal status, never left 'pending'
        // forever (Issue #1679's polarity: on unmodified main, this row
        // stays 'pending' since nothing ever closes it out without
        // job-level retry).
        const failingRow = rows.find((row) => row.session_id === 'failing-session');
        expect(failingRow).toBeDefined();
        expect(failingRow?.status).toBe('failed');

        // (c) The second, healthy target/handler pair in the same event is
        // still processed normally -- proving the 'handle' failure class is
        // isolated exactly like the 'persist' failure class above.
        const healthyRow = rows.find((row) => row.session_id === 'healthy-session-2');
        expect(healthyRow).toBeDefined();
        expect(healthyRow?.status).toBe('delivered');
        expect(handlerMock).toHaveBeenCalledTimes(2);
      } finally {
        await db.destroy();
      }
    });

    it("skips an existing 'failed' row on a retried job without re-invoking the handler (Issue #1653/#1679, (iii))", async () => {
      const db = await createDatabaseForTest();
      try {
        const repo = new InboundEventNotificationRepository(db);
        const sessionId = 'already-failed-session';
        await createTestSession(db, sessionId);

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

        const handlerMock = mock(async () => 'handled' as const);
        const handler: InboundEventHandler = {
          handlerId: 'test-handler',
          supportedEvents: ['ci:completed'],
          handle: handlerMock,
        };

        const jobHandler = createInboundEventJobHandler({
          getServiceParser: () => parser,
          resolveTargets: async () => [{ sessionId, provenance: 'match' }],
          handlers: [handler],
          notificationRepository: repo,
        });

        const jobPayload = {
          jobId: 'job-already-failed',
          service: 'github',
          rawPayload: '{}',
          headers: {},
          receivedAt: '2024-01-01T00:00:00Z',
        };

        // First run: create the pending row directly, then mark it
        // 'failed' through the real repository, simulating an earlier
        // attempt's outcome -- WITHOUT the handler ever running for this
        // jobId, so the second run's zero-calls assertion below is
        // attributable to the idempotency skip, not to a first run that
        // already happened to call it zero times.
        await repo.createPendingNotification({
          id: crypto.randomUUID(),
          job_id: jobPayload.jobId,
          session_id: sessionId,
          worker_id: 'all',
          handler_id: 'test-handler',
          event_type: 'ci:completed',
          event_summary: 'CI success',
          created_at: new Date().toISOString(),
        });
        await repo.markNotificationFailed(jobPayload.jobId, sessionId, 'all', 'test-handler');

        // Retry (same jobId): the idempotency check must see the existing
        // 'failed' row and skip it entirely, exactly like 'delivered'.
        await expect(jobHandler(jobPayload)).resolves.toBeUndefined();

        expect(handlerMock).not.toHaveBeenCalled();

        const rows = await db.selectFrom('inbound_event_notifications').selectAll().execute();
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('failed');
      } finally {
        await db.destroy();
      }
    });

    it('logs and skips (without rethrowing, no retry) when markNotificationFailed itself throws after handler.handle() threw (Issue #1653/#1679, (v))', async () => {
      const createPendingNotificationMock = mock(async () => {});
      const markNotificationFailedMock = mock(async () => {
        throw new Error('simulated transient markNotificationFailed error');
      });
      const markNotificationDeliveredMock = mock(async () => {});
      const handlerMock = mock(async () => {
        throw new Error('handler boom');
      });

      const jobHandler = createInboundEventJobHandler({
        getServiceParser: () => ({
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
        }),
        resolveTargets: async () => [{ sessionId: 'irrelevant-session', provenance: 'match' }],
        handlers: [
          {
            handlerId: 'test-handler',
            supportedEvents: ['ci:completed'],
            handle: handlerMock as InboundEventHandler['handle'],
          },
        ],
        notificationRepository: {
          findInboundEventNotification: async () => null,
          createPendingNotification: createPendingNotificationMock,
          markNotificationDelivered: markNotificationDeliveredMock,
          markNotificationFailed: markNotificationFailedMock,
        },
      });

      const errorSpy = spyOn(rootLogger, 'error');
      try {
        // The job still completes -- neither the handler's throw nor the
        // markNotificationFailed write's own throw propagates out, and
        // there is no job-level retry either way.
        await expect(
          jobHandler({
            jobId: 'job-mark-failed-throws',
            service: 'github',
            rawPayload: '{}',
            headers: {},
            receivedAt: '2024-01-01T00:00:00Z',
          })
        ).resolves.toBeUndefined();

        expect(handlerMock).toHaveBeenCalledTimes(1);
        expect(markNotificationFailedMock).toHaveBeenCalledTimes(1);
        expect(markNotificationDeliveredMock).not.toHaveBeenCalled();

        // Both the markNotificationFailed-failure log and the general
        // per-target failure log fire.
        expect(errorSpy).toHaveBeenCalledTimes(2);
        const messages = errorSpy.mock.calls.map((call) => call[1]);
        expect(messages).toContain('Failed to mark notification as failed after handler threw; row left pending');
        expect(messages).toContain('Failed to process inbound event notification for target; skipping');
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("logs and skips (without rethrowing, no retry) when markNotificationFailed itself throws after handler.handle() resolved 'delivery-failed' -- NEVER falls through to the 'deliver' rethrow class and NEVER marks the row delivered (Issue #1653/#1679, (vi))", async () => {
      // Architect finding on PR #1865 (measured against commit 9d333b4d):
      // before this test's fix, the 'delivery-failed' branch called
      // markNotificationFailed under `step = 'deliver'` with no own
      // try/catch -- a throw there fell into the catch block's 'deliver'
      // rethrow class (same as a markNotificationDelivered failure),
      // triggering a job-queue retry whose idempotency check would find
      // the still-'pending' row and administratively close it out as
      // 'delivered' -- silently turning a KNOWN delivery failure into a
      // false 'delivered'. This test's `markNotificationDelivered` /
      // `errorSpy` assertions below FAIL against 9d333b4d (the job
      // rejects instead of resolving, because the throw propagates
      // uncaught out of the per-target catch's rethrow). Restoring the
      // own try/catch (this PR's fix) makes it pass again.
      const createPendingNotificationMock = mock(async () => {});
      const markNotificationFailedMock = mock(async () => {
        throw new Error('simulated transient markNotificationFailed error');
      });
      const markNotificationDeliveredMock = mock(async () => {});
      const handlerMock = mock(async () => 'delivery-failed' as const);

      const jobHandler = createInboundEventJobHandler({
        getServiceParser: () => ({
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
        }),
        resolveTargets: async () => [{ sessionId: 'irrelevant-session', provenance: 'match' }],
        handlers: [
          {
            handlerId: 'test-handler',
            supportedEvents: ['ci:completed'],
            handle: handlerMock,
          },
        ],
        notificationRepository: {
          findInboundEventNotification: async () => null,
          createPendingNotification: createPendingNotificationMock,
          markNotificationDelivered: markNotificationDeliveredMock,
          markNotificationFailed: markNotificationFailedMock,
        },
      });

      const errorSpy = spyOn(rootLogger, 'error');
      const warnSpy = spyOn(rootLogger, 'warn');
      try {
        // The job still completes -- the markNotificationFailed write's
        // own throw never propagates out, and there is no job-level
        // retry either way.
        await expect(
          jobHandler({
            jobId: 'job-delivery-failed-mark-failed-throws',
            service: 'github',
            rawPayload: '{}',
            headers: {},
            receivedAt: '2024-01-01T00:00:00Z',
          })
        ).resolves.toBeUndefined();

        expect(handlerMock).toHaveBeenCalledTimes(1);
        expect(markNotificationFailedMock).toHaveBeenCalledTimes(1);
        // The row must NEVER be closed out as delivered -- this is the
        // exact bug the Architect caught: a retry's idempotency
        // close-out would otherwise mark a known delivery failure as
        // 'delivered'.
        expect(markNotificationDeliveredMock).not.toHaveBeenCalled();
        // The 'Inbound notification delivery failed' warn (which fires
        // only on a successful markNotificationFailed write) must NOT
        // have fired, since the write itself failed.
        expect(warnSpy).not.toHaveBeenCalled();

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0][1]).toBe(
          'Failed to mark notification as failed; row left pending'
        );
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("CodeRabbit r4226123346's own scenario on a real-DB harness: A ('delivery-failed', markNotificationFailed rejects) and B ('handled', markNotificationDelivered rejects) in the SAME job -> job RESOLVES, both rows left 'pending' (never promoted), two error lines naming each row's intended terminal; a forced second run re-invokes NEITHER handler and warns for both (Issue #1653/#1679, (viii); fails on commit fb08a3cc)", async () => {
      // Q12 polarity: on commit fb08a3cc, the idempotency 'pending' branch
      // still called markNotificationDelivered unconditionally, so the
      // forced second run's `not.toHaveBeenCalled()` assertions for the
      // handlers below FAIL against that commit (B's row, promoted to
      // 'delivered' by the retry, would also fail the `toBe('pending')`
      // assertion -- though on fb08a3cc B's row reaches 'delivered'
      // WITHOUT needing a second run at all, since that commit still had
      // the 'deliver' rethrow class forcing an actual job-level retry;
      // this test's single first run already diverges at that point).
      const db = await createDatabaseForTest();
      try {
        const repo = new InboundEventNotificationRepository(db);
        const sessionA = 'coderabbit-scenario-a';
        const sessionB = 'coderabbit-scenario-b';
        await createTestSession(db, sessionA);
        await createTestSession(db, sessionB);

        const wrappedRepo: JobHandlerNotificationRepository = {
          findInboundEventNotification: (jobId, sessionId, workerId, handlerId) =>
            repo.findInboundEventNotification(jobId, sessionId, workerId, handlerId),
          createPendingNotification: (notification) => repo.createPendingNotification(notification),
          markNotificationDelivered: async (jobId, sessionId, workerId, handlerId) => {
            if (sessionId === sessionB) {
              throw new Error('simulated transient delivery-bookkeeping error for B');
            }
            return repo.markNotificationDelivered(jobId, sessionId, workerId, handlerId);
          },
          markNotificationFailed: async (jobId, sessionId, workerId, handlerId) => {
            if (sessionId === sessionA) {
              throw new Error('simulated transient failure-bookkeeping error for A');
            }
            return repo.markNotificationFailed(jobId, sessionId, workerId, handlerId);
          },
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

        const handlerMock = mock(async (_event: unknown, target: { sessionId: string }) =>
          target.sessionId === sessionA ? ('delivery-failed' as const) : ('handled' as const)
        );
        const handler: InboundEventHandler = {
          handlerId: 'test-handler',
          supportedEvents: ['ci:completed'],
          handle: handlerMock as InboundEventHandler['handle'],
        };

        const jobHandler = createInboundEventJobHandler({
          getServiceParser: () => parser,
          resolveTargets: async () => [{ sessionId: sessionA, provenance: 'match' }, { sessionId: sessionB, provenance: 'match' }],
          handlers: [handler],
          notificationRepository: wrappedRepo,
        });

        const jobPayload = {
          jobId: 'job-cr-r4226123346',
          service: 'github',
          rawPayload: '{}',
          headers: {},
          receivedAt: '2024-01-01T00:00:00Z',
        };

        const errorSpy = spyOn(rootLogger, 'error');
        try {
          // The job resolves -- neither bookkeeping-write failure is
          // rethrown, so there is no job-level retry triggered here.
          await expect(jobHandler(jobPayload)).resolves.toBeUndefined();

          expect(handlerMock).toHaveBeenCalledTimes(2);

          const rows = await db.selectFrom('inbound_event_notifications').selectAll().execute();
          expect(rows.find((r) => r.session_id === sessionA)?.status).toBe('pending');
          expect(rows.find((r) => r.session_id === sessionB)?.status).toBe('pending');

          const errorMessages = errorSpy.mock.calls.map((call) => call[1]);
          // A's outcome resolved ('delivery-failed'); it did not throw --
          // its own-try/catch error line is the resolved-outcome one
          // ('mark ... as failed'), not the 'handle'-step-throw one.
          expect(errorMessages).toContain('Failed to mark notification as failed; row left pending');
          expect(errorMessages).toContain('Failed to mark notification as delivered; row left pending');
        } finally {
          errorSpy.mockRestore();
        }

        // --- Forced second run (same jobId): both rows are still
        // 'pending', so the idempotency check must skip both without
        // re-invoking either handler, warning once per row.
        const warnSpy = spyOn(rootLogger, 'warn');
        try {
          await expect(jobHandler(jobPayload)).resolves.toBeUndefined();

          expect(handlerMock).toHaveBeenCalledTimes(2); // unchanged -- no new calls

          const rowsAfterSecondRun = await db.selectFrom('inbound_event_notifications').selectAll().execute();
          expect(rowsAfterSecondRun.find((r) => r.session_id === sessionA)?.status).toBe('pending');
          expect(rowsAfterSecondRun.find((r) => r.session_id === sessionB)?.status).toBe('pending');

          const warnedSessionIds = warnSpy.mock.calls
            .filter((call) => call[1] === 'Pending notification from a previous attempt left unconfirmed; handler not re-invoked')
            .map((call) => (call[0] as { sessionId: string }).sessionId);
          expect(warnedSessionIds.sort()).toEqual([sessionA, sessionB].sort());
        } finally {
          warnSpy.mockRestore();
        }
      } finally {
        await db.destroy();
      }
    });

    it("isolates a sibling target's transient 'persist'-step failure (SQLITE_BUSY-shaped) from a target whose row is already pending from a prior attempt -- the job rethrows for the retry-eligible failure, and on retry the already-pending target's handler is still not re-invoked (Issue #1653/#1679, (ix))", async () => {
      const db = await createDatabaseForTest();
      try {
        const repo = new InboundEventNotificationRepository(db);
        const pendingSessionId = 'already-pending-session';
        const transientFailSessionId = 'transient-persist-fail-session';
        await createTestSession(db, pendingSessionId);
        await createTestSession(db, transientFailSessionId);

        // Seed a real 'pending' row for pendingSessionId, simulating an
        // earlier attempt whose outcome was never confirmed.
        await repo.createPendingNotification({
          id: crypto.randomUUID(),
          job_id: 'job-regress-9',
          session_id: pendingSessionId,
          worker_id: 'all',
          handler_id: 'test-handler',
          event_type: 'ci:completed',
          event_summary: 'CI success',
          created_at: new Date().toISOString(),
        });

        let findCallCount = 0;
        const wrappedRepo: JobHandlerNotificationRepository = {
          findInboundEventNotification: async (jobId, sessionId, workerId, handlerId) => {
            if (sessionId === transientFailSessionId) {
              findCallCount++;
              if (findCallCount === 1) {
                throw new Error('simulated SQLITE_BUSY-shaped transient error');
              }
            }
            return repo.findInboundEventNotification(jobId, sessionId, workerId, handlerId);
          },
          createPendingNotification: (notification) => repo.createPendingNotification(notification),
          markNotificationDelivered: (jobId, sessionId, workerId, handlerId) =>
            repo.markNotificationDelivered(jobId, sessionId, workerId, handlerId),
          markNotificationFailed: (jobId, sessionId, workerId, handlerId) =>
            repo.markNotificationFailed(jobId, sessionId, workerId, handlerId),
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

        const handlerMock = mock<InboundEventHandler['handle']>(async () => 'handled');
        const handler: InboundEventHandler = {
          handlerId: 'test-handler',
          supportedEvents: ['ci:completed'],
          handle: handlerMock,
        };

        const jobHandler = createInboundEventJobHandler({
          getServiceParser: () => parser,
          resolveTargets: async () => [
            { sessionId: pendingSessionId, provenance: 'match' },
            { sessionId: transientFailSessionId, provenance: 'match' },
          ],
          handlers: [handler],
          notificationRepository: wrappedRepo,
        });

        const jobPayload = {
          jobId: 'job-regress-9',
          service: 'github',
          rawPayload: '{}',
          headers: {},
          receivedAt: '2024-01-01T00:00:00Z',
        };

        // --- Attempt 1: the already-pending target is skipped (warned,
        // handler not invoked); the transient-fail target's 'persist'-step
        // read throws, which is NOT a foreign-key-constraint violation,
        // so it rethrows and the job rejects.
        await expect(jobHandler(jobPayload)).rejects.toThrow('simulated SQLITE_BUSY-shaped transient error');
        expect(handlerMock).not.toHaveBeenCalled();

        // --- Attempt 2 (retry, same jobId): the already-pending target is
        // STILL skipped without re-invoking its handler; the
        // transient-fail target's read now succeeds (findCallCount === 2)
        // and proceeds normally.
        await expect(jobHandler(jobPayload)).resolves.toBeUndefined();
        expect(handlerMock).toHaveBeenCalledTimes(1);
        expect(handlerMock.mock.calls[0][1]).toEqual({ sessionId: transientFailSessionId, provenance: 'match' });

        const rows = await db.selectFrom('inbound_event_notifications').selectAll().execute();
        expect(rows.find((r) => r.session_id === pendingSessionId)?.status).toBe('pending');
        expect(rows.find((r) => r.session_id === transientFailSessionId)?.status).toBe('delivered');
      } finally {
        await db.destroy();
      }
    });

    it('resolves without error and does nothing when there are zero targets', async () => {
      const db = await createDatabaseForTest();
      try {
        const repo = new InboundEventNotificationRepository(db);

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

        const handlerMock = mock(async () => 'handled' as const);
        const handler: InboundEventHandler = {
          handlerId: 'test-handler',
          supportedEvents: ['ci:completed'],
          handle: handlerMock,
        };

        const jobHandler = createInboundEventJobHandler({
          getServiceParser: () => parser,
          resolveTargets: async () => [],
          handlers: [handler],
          notificationRepository: repo,
        });

        await expect(
          jobHandler({
            jobId: 'job-regress-2',
            service: 'github',
            rawPayload: '{}',
            headers: {},
            receivedAt: '2024-01-01T00:00:00Z',
          })
        ).resolves.toBeUndefined();

        const rows = await db.selectFrom('inbound_event_notifications').selectAll().execute();
        expect(rows).toHaveLength(0);
        expect(handlerMock).not.toHaveBeenCalled();
      } finally {
        await db.destroy();
      }
    });

    it('resolves without error when the only target is dangling', async () => {
      const db = await createDatabaseForTest();
      try {
        const repo = new InboundEventNotificationRepository(db);
        // 'only-dangling' deliberately has NO row in `sessions`.

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

        const handlerMock = mock(async () => 'handled' as const);
        const handler: InboundEventHandler = {
          handlerId: 'test-handler',
          supportedEvents: ['ci:completed'],
          handle: handlerMock,
        };

        const jobHandler = createInboundEventJobHandler({
          getServiceParser: () => parser,
          resolveTargets: async () => [{ sessionId: 'only-dangling', provenance: 'match' }],
          handlers: [handler],
          notificationRepository: repo,
        });

        await expect(
          jobHandler({
            jobId: 'job-regress-3',
            service: 'github',
            rawPayload: '{}',
            headers: {},
            receivedAt: '2024-01-01T00:00:00Z',
          })
        ).resolves.toBeUndefined();

        const rows = await db.selectFrom('inbound_event_notifications').selectAll().execute();
        expect(rows).toHaveLength(0);
        expect(handlerMock).not.toHaveBeenCalled();
      } finally {
        await db.destroy();
      }
    });

    it('resolves without error when all targets are dangling', async () => {
      const db = await createDatabaseForTest();
      try {
        const repo = new InboundEventNotificationRepository(db);
        // 'dangling-a' and 'dangling-b' deliberately have NO rows in `sessions`.

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

        const handlerMock = mock(async () => 'handled' as const);
        const handler: InboundEventHandler = {
          handlerId: 'test-handler',
          supportedEvents: ['ci:completed'],
          handle: handlerMock,
        };

        const jobHandler = createInboundEventJobHandler({
          getServiceParser: () => parser,
          resolveTargets: async () => [{ sessionId: 'dangling-a', provenance: 'match' }, { sessionId: 'dangling-b', provenance: 'match' }],
          handlers: [handler],
          notificationRepository: repo,
        });

        await expect(
          jobHandler({
            jobId: 'job-regress-4',
            service: 'github',
            rawPayload: '{}',
            headers: {},
            receivedAt: '2024-01-01T00:00:00Z',
          })
        ).resolves.toBeUndefined();

        const rows = await db.selectFrom('inbound_event_notifications').selectAll().execute();
        expect(rows).toHaveLength(0);
        expect(handlerMock).not.toHaveBeenCalled();
      } finally {
        await db.destroy();
      }
    });
  });
});
