import { describe, expect, it, mock } from 'bun:test';
import type { InboundSystemEvent, InboundEventSummary } from '@agent-console/shared';
import { createInboundHandlers, canDeliverToAgentWorker } from '../handlers.js';
import type { InboundHandlerDependencies } from '../handlers.js';
import { buildWorktreeSession } from '../../../__tests__/utils/build-test-data.js';

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

const mockSessionOverrides = {
  repositoryName: 'repo',
  worktreeId: 'feature-branch',
  locationPath: '/worktrees/repo',
  createdAt: '2024-01-01T00:00:00Z',
  workers: [
    { id: 'worker-1', type: 'agent' as const, name: 'Claude', agentId: 'claude-code-builtin', activated: true, createdAt: '2024-01-01T00:00:00Z' },
  ],
};

describe('AgentWorkerHandler: issue:labeled', () => {
  it('handles issue:labeled with intent=triage', async () => {
    let capturedMessage = '';
    const mockSessionManager: InboundHandlerDependencies['sessionManager'] = {
      getSession: mock(() => buildWorktreeSession(mockSessionOverrides)),
      writeWorkerInput: mock((_sessionId: string, _workerId: string, data: string) => {
        capturedMessage = data;
        return true;
      }),
    };

    const handlers = createInboundHandlers({
      sessionManager: mockSessionManager,
      broadcastToApp: () => {},
    });
    const agentHandler = handlers.find((h) => h.handlerId === 'agent-worker')!;

    const result = await agentHandler.handle(createIssueLabeledEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(capturedMessage).toContain('intent=triage');
    expect(capturedMessage).toContain('[inbound:issue:labeled]');
    expect(capturedMessage).toContain('type=issue:labeled');
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
