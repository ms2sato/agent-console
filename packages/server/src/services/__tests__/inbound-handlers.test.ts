import { describe, expect, it, mock, jest } from 'bun:test';
import type { InboundSystemEvent, Session, InboundEventSummary } from '@agent-console/shared';
import { createInboundHandlers } from '../inbound/handlers.js';
import type { SessionManager } from '../session-manager.js';

function createReviewCommentEvent(): InboundSystemEvent {
  return {
    type: 'pr:review_comment',
    source: 'github',
    timestamp: '2024-01-01T00:00:00Z',
    metadata: {
      repositoryName: 'owner/repo',
      branch: 'feature-branch',
      url: 'https://github.com/owner/repo/pull/7#discussion_r123',
    },
    payload: {},
    summary: 'Review comment on PR #7 by reviewer (src/index.ts:42): Please fix this',
  };
}

function createChangesRequestedEvent(): InboundSystemEvent {
  return {
    type: 'pr:changes_requested',
    source: 'github',
    timestamp: '2024-01-15T00:00:00Z',
    metadata: {
      repositoryName: 'owner/repo',
      branch: 'feature-branch',
      url: 'https://github.com/owner/repo/pull/7#pullrequestreview-100',
    },
    payload: {},
    summary: 'Changes requested on PR #7 by reviewer',
  };
}

function createPrCommentEvent(): InboundSystemEvent {
  return {
    type: 'pr:comment',
    source: 'github',
    timestamp: '2024-02-01T10:00:00Z',
    metadata: {
      repositoryName: 'owner/repo',
      url: 'https://github.com/owner/repo/pull/7#issuecomment-456',
    },
    payload: {},
    summary: 'Comment on PR #7 by commenter: Looks good, but please update the docs',
  };
}

function createMockSession(): Session {
  return {
    id: 'session-1',
    type: 'worktree',
    repositoryId: 'repo-1',
    repositoryName: 'repo',
    worktreeId: 'feature-branch',
    isMainWorktree: false,
    locationPath: '/worktrees/repo',
    status: 'active',
    activationState: 'running',
    createdAt: '2024-01-01T00:00:00Z',
    workers: [
      { id: 'worker-1', type: 'agent', name: 'Claude', agentId: 'claude-code-builtin', activated: true, createdAt: '2024-01-01T00:00:00Z' },
    ],
  };
}

function createAgentHandlerWithCapture(): {
  agentHandler: ReturnType<typeof createInboundHandlers>[number];
  getCapturedMessage: () => string;
} {
  let capturedMessage = '';
  const mockSessionManager = {
    getSession: mock(() => createMockSession()),
    writeWorkerInput: mock((_sessionId: string, _workerId: string, data: string) => {
      capturedMessage = data;
      return true;
    }),
  } as unknown as SessionManager;

  const handlers = createInboundHandlers({
    sessionManager: mockSessionManager,
    broadcastToApp: () => {},
  });
  return {
    agentHandler: handlers.find((h) => h.handlerId === 'agent-worker')!,
    getCapturedMessage: () => capturedMessage,
  };
}

describe('AgentWorkerHandler', () => {
  it('handles pr:review_comment with intent=triage', async () => {
    const { agentHandler, getCapturedMessage } = createAgentHandlerWithCapture();

    const result = await agentHandler.handle(createReviewCommentEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(getCapturedMessage()).toContain('intent=triage');
    expect(getCapturedMessage()).toContain('[inbound:pr:review_comment]');
    expect(getCapturedMessage()).toContain('type=pr:review_comment');
    // Notification text should not end with \n (Enter is sent separately)
    expect(getCapturedMessage().endsWith('\n')).toBe(false);
  });

  it('handles pr:changes_requested with intent=triage', async () => {
    const { agentHandler, getCapturedMessage } = createAgentHandlerWithCapture();

    const result = await agentHandler.handle(createChangesRequestedEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(getCapturedMessage()).toContain('intent=triage');
    expect(getCapturedMessage()).toContain('[inbound:pr:changes_requested]');
    expect(getCapturedMessage()).toContain('type=pr:changes_requested');
  });

  it('handles pr:comment with intent=triage', async () => {
    const { agentHandler, getCapturedMessage } = createAgentHandlerWithCapture();

    const result = await agentHandler.handle(createPrCommentEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(getCapturedMessage()).toContain('intent=triage');
    expect(getCapturedMessage()).toContain('[inbound:pr:comment]');
    expect(getCapturedMessage()).toContain('type=pr:comment');
  });

  it('returns false for unrecognized event type', async () => {
    const mockSessionManager = {
      getSession: mock(() => createMockSession()),
      writeWorkerInput: mock(),
    } as unknown as SessionManager;

    const handlers = createInboundHandlers({
      sessionManager: mockSessionManager,
      broadcastToApp: () => {},
    });
    const agentHandler = handlers.find((h) => h.handlerId === 'agent-worker')!;

    // Force an invalid event type through the handler (simulates a bug or unexpected dispatch)
    const invalidEvent = {
      type: 'issue:closed' as InboundSystemEvent['type'],
      source: 'github' as const,
      timestamp: '2024-01-01T00:00:00Z',
      metadata: { repositoryName: 'owner/repo' },
      payload: {},
      summary: 'Issue closed',
    };

    const result = await agentHandler.handle(invalidEvent, { sessionId: 'session-1' });

    expect(result).toBe(false);
    expect(mockSessionManager.writeWorkerInput).not.toHaveBeenCalled();
  });

  it('sends Enter keystroke separately after a 150ms delay', async () => {
    jest.useFakeTimers();
    try {
      const writtenData: string[] = [];
      const mockSessionManager = {
        getSession: mock(() => createMockSession()),
        writeWorkerInput: mock((_sessionId: string, _workerId: string, data: string) => {
          writtenData.push(data);
          return true;
        }),
      } as unknown as SessionManager;

      const handlers = createInboundHandlers({
        sessionManager: mockSessionManager,
        broadcastToApp: () => {},
      });
      const agentHandler = handlers.find((h) => h.handlerId === 'agent-worker')!;

      await agentHandler.handle(createReviewCommentEvent(), { sessionId: 'session-1' });

      // Before the timer fires, only the notification text should be written
      expect(writtenData).toHaveLength(1);
      expect(writtenData[0]).toContain('[inbound:pr:review_comment]');
      expect(writtenData[0]).not.toContain('\r');

      // Advance past the 150ms delay
      jest.advanceTimersByTime(150);

      // Now the Enter keystroke should have been sent as a second write
      expect(writtenData).toHaveLength(2);
      expect(writtenData[1]).toBe('\r');
    } finally {
      jest.useRealTimers();
    }
  });
});

function createUIHandlerWithCapture(): {
  uiHandler: ReturnType<typeof createInboundHandlers>[number];
  broadcastToApp: ReturnType<typeof mock>;
  getCapturedBroadcast: () => { type: string; sessionId: string; event: InboundEventSummary };
} {
  let capturedBroadcast: { type: string; sessionId: string; event: InboundEventSummary } | undefined;
  const broadcastToApp = mock((message: { type: 'inbound-event'; sessionId: string; event: InboundEventSummary }) => {
    capturedBroadcast = message;
  });

  const handlers = createInboundHandlers({
    sessionManager: {} as SessionManager,
    broadcastToApp,
  });
  return {
    uiHandler: handlers.find((h) => h.handlerId === 'ui-notification')!,
    broadcastToApp,
    getCapturedBroadcast: () => capturedBroadcast!,
  };
}

describe('UINotificationHandler', () => {
  it('broadcasts pr:review_comment event', async () => {
    const { uiHandler, broadcastToApp, getCapturedBroadcast } = createUIHandlerWithCapture();

    const result = await uiHandler.handle(createReviewCommentEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(broadcastToApp).toHaveBeenCalledTimes(1);
    const broadcast = getCapturedBroadcast();
    expect(broadcast.type).toBe('inbound-event');
    expect(broadcast.sessionId).toBe('session-1');
    expect(broadcast.event.type).toBe('pr:review_comment');
    expect(broadcast.event.source).toBe('github');
    expect(broadcast.event.summary).toContain('PR #7');
    expect(broadcast.event.metadata.repositoryName).toBe('owner/repo');
  });

  it('broadcasts pr:changes_requested event', async () => {
    const { uiHandler, broadcastToApp, getCapturedBroadcast } = createUIHandlerWithCapture();

    const result = await uiHandler.handle(createChangesRequestedEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(broadcastToApp).toHaveBeenCalledTimes(1);
    const broadcast = getCapturedBroadcast();
    expect(broadcast.type).toBe('inbound-event');
    expect(broadcast.sessionId).toBe('session-1');
    expect(broadcast.event.type).toBe('pr:changes_requested');
    expect(broadcast.event.source).toBe('github');
    expect(broadcast.event.summary).toContain('PR #7');
  });

  it('broadcasts pr:comment event', async () => {
    const { uiHandler, broadcastToApp, getCapturedBroadcast } = createUIHandlerWithCapture();

    const result = await uiHandler.handle(createPrCommentEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(broadcastToApp).toHaveBeenCalledTimes(1);
    const broadcast = getCapturedBroadcast();
    expect(broadcast.type).toBe('inbound-event');
    expect(broadcast.sessionId).toBe('session-1');
    expect(broadcast.event.type).toBe('pr:comment');
    expect(broadcast.event.source).toBe('github');
    expect(broadcast.event.summary).toContain('PR #7');
    expect(broadcast.event.metadata.repositoryName).toBe('owner/repo');
  });
});
