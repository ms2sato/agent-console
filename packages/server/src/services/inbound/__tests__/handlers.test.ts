import { describe, expect, it, mock, spyOn, setSystemTime } from 'bun:test';
import type { InboundSystemEvent, InboundEventSummary, Session } from '@agent-console/shared';
import { createInboundHandlers, canDeliverToAgentWorker } from '../handlers.js';
import type { InboundHandlerDependencies } from '../handlers.js';
import { buildWorktreeSession } from '../../../__tests__/utils/build-test-data.js';
import { writePtyNotification } from '../../../lib/pty-notification.js';
import type { PtyNotificationParams, WritePtyNotificationParams } from '../../../lib/pty-notification.js';
import { rootLogger } from '../../../lib/logger.js';

function createIssueLabeledEvent(): InboundSystemEvent {
  return {
    type: 'issue:labeled',
    source: 'github',
    timestamp: '2024-01-01T00:00:00Z',
    metadata: {
      repositoryName: 'owner/repo',
      labels: ['orchestrator-trigger'],
      url: 'https://example.com/issues/1',
    },
    payload: {},
    summary: "Issue #1 labeled 'orchestrator-trigger': Some issue",
  };
}

function createCiCompletedEvent(): InboundSystemEvent {
  return {
    type: 'ci:completed',
    source: 'github',
    timestamp: '2024-01-01T00:00:00Z',
    metadata: {
      repositoryName: 'owner/repo',
      branch: 'feature-branch',
      url: 'https://github.com/owner/repo/actions/runs/1',
    },
    payload: {},
    summary: 'CI passed: Build and Test',
  };
}

const mockSessionOverrides = {
  repositoryName: 'repo',
  worktreeId: 'feature-branch',
  locationPath: '/worktrees/repo',
  createdAt: '2024-01-01T00:00:00Z',
  workers: [
    { id: 'worker-1', type: 'agent' as const, name: 'Claude', agentId: 'claude-code-builtin', activated: true, createdAt: '2024-01-01T00:00:00Z' },
  ],
};

/**
 * Embedded-agent worker fixture used to pin Issue #1739 (delivery to
 * embedded-agent workers via the SessionManager.deliverWorkerNotification
 * seam, alongside the pre-existing PTY-agent delivery path).
 */
const EMBEDDED_WORKER = {
  id: 'worker-embedded-1',
  type: 'embedded-agent' as const,
  name: 'Embedded',
  embeddedAgentId: 'def-1',
  activated: false,
  autoCompaction: true,
  reasoningEffort: null,
  hasParameterOverride: false,
  createdAt: '2024-01-01T00:00:00Z',
};

/**
 * Fake `deliverWorkerNotification` that applies the REAL PTY branch
 * (`writePtyNotification`, with `writeInput` bound to a capture array), so
 * the bytes it produces are byte-for-byte the same as production's PTY
 * branch (SessionManager.deliverWorkerNotification's `isPtyBackedWorker`
 * branch, session-manager.ts). Used to re-point tests that used to mock
 * `writeWorkerInput` directly at the new seam without losing byte-level
 * parity coverage.
 */
function createPtyBranchSessionManager(session: Session, writes: string[]): InboundHandlerDependencies['sessionManager'] {
  return {
    getSession: mock(() => session),
    deliverWorkerNotification: mock(async (_sessionId: string, _workerId: string, params) => {
      writePtyNotification({
        ...params,
        writeInput: (data: string) => {
          writes.push(data);
        },
      } as WritePtyNotificationParams);
      return { ok: true as const };
    }),
  };
}

describe('AgentWorkerHandler: issue:labeled', () => {
  it('handles issue:labeled with intent=triage', async () => {
    const writes: string[] = [];
    const session = buildWorktreeSession(mockSessionOverrides);
    const mockSessionManager = createPtyBranchSessionManager(session, writes);

    const handlers = createInboundHandlers({
      sessionManager: mockSessionManager,
      broadcastToApp: () => {},
    });
    const agentHandler = handlers.find((h) => h.handlerId === 'agent-worker')!;

    const result = await agentHandler.handle(createIssueLabeledEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(writes[0]).toContain('intent=triage');
    expect(writes[0]).toContain('[inbound:issue:labeled]');
    expect(writes[0]).toContain('type=issue:labeled');
  });
});

describe('AgentWorkerHandler: fallback target (#1661)', () => {
  it('still delivers a notification when the target is fallback-routed (unlike DiffWorkerHandler)', async () => {
    const writes: string[] = [];
    const session = buildWorktreeSession(mockSessionOverrides);
    const mockSessionManager = createPtyBranchSessionManager(session, writes);

    const handlers = createInboundHandlers({
      sessionManager: mockSessionManager,
      broadcastToApp: () => {},
    });
    const agentHandler = handlers.find((h) => h.handlerId === 'agent-worker')!;

    const result = await agentHandler.handle(createIssueLabeledEvent(), { sessionId: 'session-1', fallback: true });

    expect(result).toBe(true);
    expect(writes[0]).toContain('[inbound:issue:labeled]');
  });
});

describe('UINotificationHandler: issue:labeled', () => {
  it('broadcasts issue:labeled events', async () => {
    let capturedBroadcast: { type: string; sessionId: string; event: InboundEventSummary } | undefined;
    const broadcastToApp = mock((message: { type: 'inbound-event'; sessionId: string; event: InboundEventSummary }) => {
      capturedBroadcast = message;
    });

    const handlers = createInboundHandlers({
      sessionManager: {} as InboundHandlerDependencies['sessionManager'],
      broadcastToApp,
    });
    const uiHandler = handlers.find((h) => h.handlerId === 'ui-notification')!;

    const result = await uiHandler.handle(createIssueLabeledEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(broadcastToApp).toHaveBeenCalledTimes(1);
    expect(capturedBroadcast!.type).toBe('inbound-event');
    expect(capturedBroadcast!.sessionId).toBe('session-1');
    expect(capturedBroadcast!.event.type).toBe('issue:labeled');
    expect(capturedBroadcast!.event.metadata.labels).toEqual(['orchestrator-trigger']);
  });
});

describe('canDeliverToAgentWorker', () => {
  it('returns true for a session with an agent worker, regardless of PTY liveness', () => {
    // `Session.workers` is the public Worker union, which has no `pty`
    // field (that's server-internal state on `InternalPtyWorker`) -- the
    // public analog of "PTY not currently live" is `activated: false`
    // (set when a worker is hibernated). The predicate must not depend on
    // this either way, matching handlers.ts's Step 1 finding that
    // writeWorkerInput no-ops (rather than throwing) on a null pty.
    const session = buildWorktreeSession({
      workers: [
        { id: 'worker-1', type: 'agent', name: 'Claude', agentId: 'claude-code-builtin', activated: false, createdAt: '2024-01-01T00:00:00Z' },
      ],
    });

    expect(canDeliverToAgentWorker(session)).toBe(true);
  });

  it('returns true for a session with only an embedded-agent worker (Issue #1739)', () => {
    // Reach (measured 2026-09-17): temporarily reverting the predicate body
    // to `session.workers.some((worker) => worker.type === 'agent')`
    // (main@a3ffc100's shape) makes this test FAIL -- an embedded-only
    // session has no `agent`-type worker, so the old predicate returns
    // false. Restored afterwards; the rest of this file's suite stays
    // green under the revert (embedded-only cases are new).
    const session = buildWorktreeSession({
      workers: [EMBEDDED_WORKER],
    });

    expect(canDeliverToAgentWorker(session)).toBe(true);
  });

  it('returns false for a session with only a git-diff worker', () => {
    const session = buildWorktreeSession({
      workers: [
        { id: 'worker-1', type: 'git-diff', name: 'Diff', createdAt: '2024-01-01T00:00:00Z', baseCommit: 'abc123' },
      ],
    });

    expect(canDeliverToAgentWorker(session)).toBe(false);
  });

  it('returns false for a session with zero workers', () => {
    const session = buildWorktreeSession({ workers: [] });

    expect(canDeliverToAgentWorker(session)).toBe(false);
  });
});

describe('AgentWorkerHandler: embedded-agent worker delivery (Issue #1739)', () => {
  it('resolves the embedded-agent worker and calls deliverWorkerNotification with exactly the PTY-parity params', async () => {
    const deliverWorkerNotification = mock((_sessionId: string, _workerId: string, _params: PtyNotificationParams) =>
      Promise.resolve({ ok: true as const }),
    );
    const mockSessionManager: InboundHandlerDependencies['sessionManager'] = {
      getSession: mock(() => buildWorktreeSession({ ...mockSessionOverrides, workers: [EMBEDDED_WORKER] })),
      deliverWorkerNotification,
    };

    const handlers = createInboundHandlers({
      sessionManager: mockSessionManager,
      broadcastToApp: () => {},
    });
    const agentHandler = handlers.find((h) => h.handlerId === 'agent-worker')!;

    const result = await agentHandler.handle(createIssueLabeledEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(deliverWorkerNotification).toHaveBeenCalledTimes(1);
    // Reach (measured 2026-09-17): dropping the `branch` field from
    // handlers.ts's literal -> FAILS. Renaming `repo` -> `repoName` ->
    // FAILS. Swapping the order of `repo` and `branch` in the literal ->
    // PASSES (`toEqual` does not see key ORDER within the object -- pin (c)
    // below, byte-for-byte PTY parity, is what catches an order swap,
    // since key order IS observable in the rendered notification text).
    expect(deliverWorkerNotification.mock.calls[0]).toEqual([
      'session-1',
      'worker-embedded-1',
      {
        kind: 'inbound-event',
        tag: 'inbound:issue:labeled',
        fields: {
          type: 'issue:labeled',
          source: 'github',
          repo: 'owner/repo',
          branch: 'unknown',
          url: 'https://example.com/issues/1',
          summary: "Issue #1 labeled 'orchestrator-trigger': Some issue",
        },
        intent: 'triage',
      },
    ]);
  });
});

describe('AgentWorkerHandler: worker resolution order (Issue #1739)', () => {
  it('resolves to the first agent-shaped worker in workers order when both an agent and an embedded-agent worker are present', async () => {
    const deliverWorkerNotification = mock((_sessionId: string, _workerId: string, _params: PtyNotificationParams) =>
      Promise.resolve({ ok: true as const }),
    );
    const session = buildWorktreeSession({
      ...mockSessionOverrides,
      // Agent worker listed FIRST, embedded-agent worker second -- pins
      // that `session.workers.find(canReceiveSessionMessages)` resolves
      // deterministically to the first match in array order, same as the
      // pre-#1739 `.find((worker) => worker.type === 'agent')` did.
      workers: [mockSessionOverrides.workers[0], EMBEDDED_WORKER],
    });
    const mockSessionManager: InboundHandlerDependencies['sessionManager'] = {
      getSession: mock(() => session),
      deliverWorkerNotification,
    };

    const handlers = createInboundHandlers({
      sessionManager: mockSessionManager,
      broadcastToApp: () => {},
    });
    const agentHandler = handlers.find((h) => h.handlerId === 'agent-worker')!;

    await agentHandler.handle(createIssueLabeledEvent(), { sessionId: 'session-1' });

    expect(deliverWorkerNotification.mock.calls[0][1]).toBe('worker-1');
  });
});

// Captured from unmodified main at commit a3ffc100, 2026-09-17, with
// setSystemTime(new Date('2026-09-17T00:00:00.000Z')) and the PRE-#1739
// direct writePtyNotification({ ..., writeInput: (data) =>
// this.sessionManager.writeWorkerInput(sessionId, workerId, data) }) call in
// handlers.ts -- the exact bytes AgentWorkerHandler wrote to a PTY-backed
// worker's terminal before the delivery seam existed. This is the
// byte-for-byte contract deliverWorkerNotification's PTY branch (session-
// manager.ts's isPtyBackedWorker branch) must reproduce unchanged.
const PTY_BYTES_FIXTURE_FROM_MAIN_a3ffc100 = [
  "\n[inbound:issue:labeled] timestamp=2026-09-17T00:00:00.000Z type=issue:labeled source=github repo=owner/repo branch=unknown url=https://example.com/issues/1 summary=\"Issue #1 labeled 'orchestrator-trigger': Some issue\" intent=triage",
  "\r",
  "\n[inbound:ci:completed] timestamp=2026-09-17T00:00:00.000Z type=ci:completed source=github repo=owner/repo branch=feature-branch url=https://github.com/owner/repo/actions/runs/1 summary=\"CI passed: Build and Test\" intent=inform",
  "\r",
];

describe('AgentWorkerHandler: PTY byte parity through the delivery seam (Issue #1739)', () => {
  it('produces byte-for-byte identical PTY writes to the pre-seam direct writePtyNotification call', async () => {
    setSystemTime(new Date('2026-09-17T00:00:00.000Z'));
    try {
      const writes: string[] = [];
      const session = buildWorktreeSession(mockSessionOverrides);
      const mockSessionManager = createPtyBranchSessionManager(session, writes);

      const handlers = createInboundHandlers({
        sessionManager: mockSessionManager,
        broadcastToApp: () => {},
      });
      const agentHandler = handlers.find((h) => h.handlerId === 'agent-worker')!;

      await agentHandler.handle(createIssueLabeledEvent(), { sessionId: 'session-1' });
      // Real timers: writePtyNotification's Enter keystroke fires via a
      // real 150ms setTimeout.
      await new Promise((resolve) => setTimeout(resolve, 200));

      await agentHandler.handle(createCiCompletedEvent(), { sessionId: 'session-1' });
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Reach (measured 2026-09-17): swapping the order of `repo` and
      // `branch` in handlers.ts's literal -> FAILS (the rendered field
      // order changes), while pin (b) above (which asserts via `toEqual`
      // on the params object, not the rendered text) -> still PASSES under
      // the same mutation. Dropping the `branch` field, or renaming `repo`
      // -> `repoName` -> both FAIL here too (same mutations that fail pin
      // (b)). Changing the `resolveIntent` mapping for `ci:completed` to
      // return `'triage'` instead of `'inform'` -> FAILS.
      expect(writes).toEqual(PTY_BYTES_FIXTURE_FROM_MAIN_a3ffc100);
    } finally {
      setSystemTime();
    }
  });
});

describe('AgentWorkerHandler: notification delivery failure (Issue #1739)', () => {
  it('returns false and logs a warning exactly once when deliverWorkerNotification resolves { ok: false }', async () => {
    const mockSessionManager: InboundHandlerDependencies['sessionManager'] = {
      getSession: mock(() => buildWorktreeSession(mockSessionOverrides)),
      deliverWorkerNotification: mock(async () => ({ ok: false as const, error: 'boom' })),
    };

    const handlers = createInboundHandlers({
      sessionManager: mockSessionManager,
      broadcastToApp: () => {},
    });
    const agentHandler = handlers.find((h) => h.handlerId === 'agent-worker')!;

    const warnSpy = spyOn(rootLogger, 'warn');
    try {
      const result = await agentHandler.handle(createIssueLabeledEvent(), { sessionId: 'session-1' });

      expect(result).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [context, message] = warnSpy.mock.calls[0];
      expect(message).toBe('notification delivery failed for inbound event');
      expect(context).toMatchObject({
        error: 'boom',
        sessionId: 'session-1',
        workerId: 'worker-1',
        eventType: 'issue:labeled',
      });
      // Reach (measured 2026-09-17): removing the `return false;` inside
      // handlers.ts's `if (!result.ok) { ...; return false; }` block ->
      // FAILS (`result` becomes `true` instead).
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('resolves false (does not reject) and logs a warning exactly once when deliverWorkerNotification REJECTS -- e.g. an embedded-agent activation failure surfacing through ensureDeliverable', async () => {
    const mockSessionManager: InboundHandlerDependencies['sessionManager'] = {
      getSession: mock(() => buildWorktreeSession(mockSessionOverrides)),
      deliverWorkerNotification: mock(async () => {
        throw new Error('activation exploded');
      }),
    };

    const handlers = createInboundHandlers({
      sessionManager: mockSessionManager,
      broadcastToApp: () => {},
    });
    const agentHandler = handlers.find((h) => h.handlerId === 'agent-worker')!;

    const warnSpy = spyOn(rootLogger, 'warn');
    try {
      // The seam's PTY branch never throws -- only the embedded-agent
      // branch can reject. `handle()`'s contract to job-handler.ts is
      // "false, never a rejection", so `await` must resolve, not throw.
      const result = await agentHandler.handle(createIssueLabeledEvent(), { sessionId: 'session-1' });

      expect(result).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [context, message] = warnSpy.mock.calls[0];
      expect(message).toBe('notification delivery failed for inbound event');
      expect(context).toMatchObject({
        sessionId: 'session-1',
        workerId: 'worker-1',
        eventType: 'issue:labeled',
      });
      expect((context as { err: unknown }).err).toBeInstanceOf(Error);
      expect(((context as { err: Error }).err).message).toBe('activation exploded');
      // Reach (measured 2026-09-17): removing the try/catch around the
      // `deliverWorkerNotification` call (keeping the `if (!result.ok)`
      // branch) -> FAILS -- the test rejects with "activation exploded"
      // instead of `handle()` resolving `false`. Restored afterwards.
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('DiffWorkerHandler: issue:labeled', () => {
  it('does not list issue:labeled in supportedEvents (no diff-refresh relevance)', () => {
    const handlers = createInboundHandlers({
      sessionManager: {} as InboundHandlerDependencies['sessionManager'],
      broadcastToApp: () => {},
    });
    const diffHandler = handlers.find((h) => h.handlerId === 'diff-worker')!;

    expect(diffHandler.supportedEvents).not.toContain('issue:labeled');
  });
});
