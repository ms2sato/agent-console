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

describe('AgentWorkerHandler', () => {
  it('handles pr:review_comment with intent=triage', async () => {
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
    const agentHandler = handlers.find((h) => h.handlerId === 'agent-worker')!;

    const result = await agentHandler.handle(createReviewCommentEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(capturedMessage).toContain('intent=triage');
    expect(capturedMessage).toContain('[inbound:pr:review_comment]');
    expect(capturedMessage).toContain('type=pr:review_comment');
    // Notification text should not end with \n (Enter is sent separately)
    expect(capturedMessage.endsWith('\n')).toBe(false);
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

describe('UINotificationHandler', () => {
  it('broadcasts pr:review_comment event', async () => {
    let capturedBroadcast: { type: string; sessionId: string; event: InboundEventSummary } | undefined;
    const broadcastToApp = mock((message: { type: 'inbound-event'; sessionId: string; event: InboundEventSummary }) => {
      capturedBroadcast = message;
    });

    const handlers = createInboundHandlers({
      sessionManager: {} as SessionManager,
      broadcastToApp,
    });
    const uiHandler = handlers.find((h) => h.handlerId === 'ui-notification')!;

    const result = await uiHandler.handle(createReviewCommentEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(broadcastToApp).toHaveBeenCalledTimes(1);
    expect(capturedBroadcast).toBeDefined();
    expect(capturedBroadcast!.type).toBe('inbound-event');
    expect(capturedBroadcast!.sessionId).toBe('session-1');
    expect(capturedBroadcast!.event.type).toBe('pr:review_comment');
    expect(capturedBroadcast!.event.source).toBe('github');
    expect(capturedBroadcast!.event.summary).toContain('PR #7');
    expect(capturedBroadcast!.event.metadata.repositoryName).toBe('owner/repo');
  });
});
