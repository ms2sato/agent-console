import { describe, expect, it, mock, beforeEach } from 'bun:test';
import type { Kysely } from 'kysely';
import type { ServiceParser } from '../service-parser.js';
import type { InboundEventHandler } from '../handlers.js';
import type { InboundEventNotification, NewInboundEventNotification } from '../../../database/schema.js';
import { createInboundEventJobHandler } from '../job-handler.js';
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

        const handlerMock = mock(async () => true);
        const handler: InboundEventHandler = {
          handlerId: 'test-handler',
          supportedEvents: ['ci:completed'],
          handle: handlerMock,
        };

        const jobHandler = createInboundEventJobHandler({
          getServiceParser: () => parser,
          resolveTargets: async () => [
            { sessionId: 'dangling-session' },
            { sessionId: 'healthy-session' },
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
      const handlerMock = mock(async () => true);
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
        resolveTargets: async () => [{ sessionId: 'irrelevant-session' }],
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

    it('rethrows a deliver-step failure (markNotificationDelivered throwing after a successful handle) so the job queue retries and the idempotency check safely closes it out on retry, without re-dispatching a sibling that already reached delivered', async () => {
      // reach measured (half 1, deliver-step rethrow): temporarily dropping
      // `step === 'deliver'` from the rethrow condition (so a 'deliver'-step
      // failure is swallowed the way the old code swallowed everything)
      // makes the FIRST invocation's `.rejects` assertion below FAIL -- the
      // job resolves instead of rejecting. Restoring the real condition
      // makes it pass again. Measured 2026-09-14 against the code in this PR.
      //
      // reach measured (half 2, idempotency pending-close-out): temporarily
      // bypassing the 'pending' branch of the idempotency check (the one
      // that calls `markNotificationDelivered` WITHOUT re-invoking the
      // handler) makes the SECOND invocation's per-target handler-call-count
      // assertion below FAIL -- the handler gets re-invoked (falls through
      // to the ATOMIC SAFETY / handler-dispatch path instead of being closed
      // out administratively). Restoring the real branch makes it pass
      // again. Measured 2026-09-14 against the code in this PR.
      const db = await createDatabaseForTest();
      try {
        const repo = new InboundEventNotificationRepository(db);
        const deliverFailSessionId = 'deliver-fail-session';
        const siblingSessionId = 'sibling-healthy-session';
        await createTestSession(db, deliverFailSessionId);
        await createTestSession(db, siblingSessionId);

        // Wraps the REAL repository (real DB, real FK constraint, real
        // idempotency reads/writes) so only `markNotificationDelivered`'s
        // FIRST call for `deliverFailSessionId` is intercepted and made to
        // throw a plain (non-FK) `Error` -- simulating a transient
        // bookkeeping-write failure AFTER a real, successful `handle()` call
        // already persisted a real 'pending' row. Every other call
        // (including the sibling's, and this target's own second attempt on
        // retry) delegates straight through to the real repository.
        let deliverFailAttempts = 0;
        const wrappedRepo: JobHandlerNotificationRepository = {
          findInboundEventNotification: (jobId, sessionId, workerId, handlerId) =>
            repo.findInboundEventNotification(jobId, sessionId, workerId, handlerId),
          createPendingNotification: (notification) => repo.createPendingNotification(notification),
          markNotificationDelivered: async (jobId, sessionId, workerId, handlerId) => {
            if (sessionId === deliverFailSessionId && deliverFailAttempts === 0) {
              deliverFailAttempts++;
              throw new Error('simulated transient delivery-bookkeeping error');
            }
            return repo.markNotificationDelivered(jobId, sessionId, workerId, handlerId);
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

        const handlerMock = mock(async (_event: unknown, _target: { sessionId: string }) => true);
        const handler: InboundEventHandler = {
          handlerId: 'test-handler',
          supportedEvents: ['ci:completed'],
          handle: handlerMock as InboundEventHandler['handle'],
        };

        const jobHandler = createInboundEventJobHandler({
          getServiceParser: () => parser,
          // Sibling ordered FIRST so it reaches 'delivered' within THIS
          // SAME invocation, before the deliver-fail target's failure
          // aborts the rest of the loop -- this is what makes it "already
          // delivered before the retry" per the sibling-skip assertion.
          resolveTargets: async () => [
            { sessionId: siblingSessionId },
            { sessionId: deliverFailSessionId },
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

        // --- Half 1: fresh delivery attempt; markNotificationDelivered
        // throws for the deliver-fail target after its handler succeeded.
        await expect(jobHandler(jobPayload)).rejects.toThrow('simulated transient delivery-bookkeeping error');

        expect(
          handlerMock.mock.calls.filter((call) => call[1].sessionId === deliverFailSessionId)
        ).toHaveLength(1);
        expect(
          handlerMock.mock.calls.filter((call) => call[1].sessionId === siblingSessionId)
        ).toHaveLength(1);

        const rowsAfterHalf1 = await db.selectFrom('inbound_event_notifications').selectAll().execute();
        expect(rowsAfterHalf1.find((r) => r.session_id === deliverFailSessionId)?.status).toBe('pending');
        expect(rowsAfterHalf1.find((r) => r.session_id === siblingSessionId)?.status).toBe('delivered');

        // --- Half 2: retry (same jobId). The idempotency check closes the
        // deliver-fail target out administratively (markNotificationDelivered
        // succeeds this time; handler is NOT re-invoked). The sibling --
        // already 'delivered' -- is skipped entirely, also without
        // re-invoking its handler.
        await expect(jobHandler(jobPayload)).resolves.toBeUndefined();

        expect(
          handlerMock.mock.calls.filter((call) => call[1].sessionId === deliverFailSessionId)
        ).toHaveLength(1);
        expect(
          handlerMock.mock.calls.filter((call) => call[1].sessionId === siblingSessionId)
        ).toHaveLength(1);

        const rowsAfterHalf2 = await db.selectFrom('inbound_event_notifications').selectAll().execute();
        expect(rowsAfterHalf2.find((r) => r.session_id === deliverFailSessionId)?.status).toBe('delivered');
        expect(rowsAfterHalf2.find((r) => r.session_id === siblingSessionId)?.status).toBe('delivered');
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
          return true;
        });
        const handler: InboundEventHandler = {
          handlerId: 'test-handler',
          supportedEvents: ['ci:completed'],
          handle: handlerMock as InboundEventHandler['handle'],
        };

        const jobHandler = createInboundEventJobHandler({
          getServiceParser: () => parser,
          resolveTargets: async () => [
            { sessionId: 'failing-session' },
            { sessionId: 'healthy-session-2' },
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

        // (b) The failing target's notification row WAS created and stays
        // 'pending' -- it is never flipped to 'delivered', since the fix no
        // longer relies on job-level retry to close it out. This is the
        // current, intended behavior for a handler that throws after its
        // pending row was persisted.
        const failingRow = rows.find((row) => row.session_id === 'failing-session');
        expect(failingRow).toBeDefined();
        expect(failingRow?.status).toBe('pending');

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

        const handlerMock = mock(async () => true);
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

        const handlerMock = mock(async () => true);
        const handler: InboundEventHandler = {
          handlerId: 'test-handler',
          supportedEvents: ['ci:completed'],
          handle: handlerMock,
        };

        const jobHandler = createInboundEventJobHandler({
          getServiceParser: () => parser,
          resolveTargets: async () => [{ sessionId: 'only-dangling' }],
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

        const handlerMock = mock(async () => true);
        const handler: InboundEventHandler = {
          handlerId: 'test-handler',
          supportedEvents: ['ci:completed'],
          handle: handlerMock,
        };

        const jobHandler = createInboundEventJobHandler({
          getServiceParser: () => parser,
          resolveTargets: async () => [{ sessionId: 'dangling-a' }, { sessionId: 'dangling-b' }],
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
