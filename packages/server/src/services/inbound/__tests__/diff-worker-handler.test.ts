import { describe, it, expect, mock } from 'bun:test';
import type { InboundSystemEvent, Session, Worker } from '@agent-console/shared';
import { createInboundHandlers, type InboundEventHandler, type InboundHandlerDependencies, type EventTarget } from '../handlers.js';
import { buildWorktreeSession } from '../../../__tests__/utils/build-test-data.js';

// Mock triggerRefresh at the module level since it's a standalone function import
const mockTriggerRefresh = mock(() => {});
mock.module('../../git-diff-service.js', () => ({
  triggerRefresh: mockTriggerRefresh,
}));

function createEvent(type: 'ci:completed' | 'pr:merged' = 'ci:completed'): InboundSystemEvent {
  return {
    type,
    source: 'github',
    timestamp: new Date().toISOString(),
    metadata: {
      repositoryName: 'owner/repo',
    },
    payload: {},
    summary: 'Test event',
  } as InboundSystemEvent;
}

function createGitDiffWorker(): Worker {
  return {
    id: 'worker-diff-1',
    name: 'git-diff',
    type: 'git-diff',
    baseCommit: 'abc123',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function getDiffWorkerHandler(deps: Parameters<typeof createInboundHandlers>[0]): InboundEventHandler {
  const handlers = createInboundHandlers(deps);
  const handler = handlers.find((h) => h.handlerId === 'diff-worker');
  if (!handler) throw new Error('DiffWorkerHandler not found');
  return handler;
}

describe('DiffWorkerHandler', () => {
  const mockBroadcast = mock(() => {});

  function createDeps(sessions: ReturnType<typeof buildWorktreeSession>[] = []): InboundHandlerDependencies {
    const sessionMap = new Map<string, Session>(sessions.map((s) => [s.id, s]));
    return {
      sessionManager: {
        getSession: mock((id: string): Session | undefined => sessionMap.get(id)),
        writeWorkerInput: mock((_sessionId: string, _workerId: string, _data: string): boolean => true),
      },
      broadcastToApp: mockBroadcast,
    };
  }

  it('has the correct handlerId', () => {
    const handler = getDiffWorkerHandler(createDeps());
    expect(handler.handlerId).toBe('diff-worker');
  });

  it('supports ci:completed and pr:merged events', () => {
    const handler = getDiffWorkerHandler(createDeps());
    expect(handler.supportedEvents).toEqual(['ci:completed', 'pr:merged']);
  });

  it('returns false when session does not exist', async () => {
    const handler = getDiffWorkerHandler(createDeps([]));
    const result = await handler.handle(createEvent(), { sessionId: 'nonexistent' });
    expect(result).toBe(false);
  });

  it('returns false when session has no git-diff worker', async () => {
    const session = buildWorktreeSession({ id: 'session-1', workers: [] });
    const handler = getDiffWorkerHandler(createDeps([session]));

    const result = await handler.handle(createEvent(), { sessionId: 'session-1' });
    expect(result).toBe(false);
  });

  it('triggers refresh when session has a git-diff worker', async () => {
    mockTriggerRefresh.mockClear();
    const session = buildWorktreeSession({
      id: 'session-1',
      locationPath: '/path/to/worktree',
      workers: [createGitDiffWorker()],
    });
    const handler = getDiffWorkerHandler(createDeps([session]));

    const result = await handler.handle(createEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(mockTriggerRefresh).toHaveBeenCalledWith('/path/to/worktree');
  });

  it('triggers refresh for pr:merged event', async () => {
    mockTriggerRefresh.mockClear();
    const session = buildWorktreeSession({
      id: 'session-1',
      locationPath: '/path/to/worktree',
      workers: [createGitDiffWorker()],
    });
    const handler = getDiffWorkerHandler(createDeps([session]));

    const result = await handler.handle(createEvent('pr:merged'), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(mockTriggerRefresh).toHaveBeenCalledWith('/path/to/worktree');
  });

  it('triggers refresh when session has mixed worker types including git-diff', async () => {
    mockTriggerRefresh.mockClear();
    const session = buildWorktreeSession({
      id: 'session-1',
      locationPath: '/path/to/worktree',
      workers: [
        { id: 'worker-agent-1', name: 'agent', type: 'agent', agentId: 'claude-code', activated: true, createdAt: '2026-01-01T00:00:00.000Z' },
        createGitDiffWorker(),
      ],
    });
    const handler = getDiffWorkerHandler(createDeps([session]));

    const result = await handler.handle(createEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(mockTriggerRefresh).toHaveBeenCalledTimes(1);
  });

  it('ignores workerId in target (only checks session workers)', async () => {
    mockTriggerRefresh.mockClear();
    const session = buildWorktreeSession({
      id: 'session-1',
      locationPath: '/path/to/worktree',
      workers: [createGitDiffWorker()],
    });
    const handler = getDiffWorkerHandler(createDeps([session]));

    const target: EventTarget = { sessionId: 'session-1', workerId: 'some-other-worker' };
    const result = await handler.handle(createEvent(), target);

    expect(result).toBe(true);
    expect(mockTriggerRefresh).toHaveBeenCalledWith('/path/to/worktree');
  });
});
