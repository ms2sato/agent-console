import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import type { InboundSystemEvent, Session, Worker } from '@agent-console/shared';
import { createInboundHandlers, type InboundEventHandler, type InboundHandlerDependencies, type EventTarget } from '../handlers.js';
import { buildWorktreeSession } from '../../../__tests__/utils/build-test-data.js';
import * as gitDiffServiceModule from '../../git-diff-service.js';

// `triggerRefresh` is a standalone function import in handlers.ts (no DI
// seam via InboundHandlerDependencies exists for it yet -- see the PR
// description for this conversion). spyOn() on the real module keeps this
// test file-scoped and restorable, instead of process-globally poisoning
// every other importer of git-diff-service.js the way mock.module() would
// (`.claude/rules/testing.md` Anti-Pattern #2).
const mockTriggerRefresh = mock(() => {});
let triggerRefreshSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  triggerRefreshSpy = spyOn(gitDiffServiceModule, 'triggerRefresh').mockImplementation(mockTriggerRefresh);
});

afterEach(() => {
  triggerRefreshSpy.mockRestore();
});

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
        // DiffWorkerHandler never calls deliverWorkerNotification -- present
        // only to satisfy InboundSessionManager's shape.
        deliverWorkerNotification: mock(async () => ({ ok: true as const })),
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
    const result = await handler.handle(createEvent(), { sessionId: 'nonexistent', provenance: 'match' });
    expect(result).toBe('not-applicable');
  });

  it('returns false when session has no git-diff worker', async () => {
    const session = buildWorktreeSession({ id: 'session-1', workers: [] });
    const handler = getDiffWorkerHandler(createDeps([session]));

    const result = await handler.handle(createEvent(), { sessionId: 'session-1', provenance: 'match' });
    expect(result).toBe('not-applicable');
  });

  it('triggers refresh when session has a git-diff worker', async () => {
    mockTriggerRefresh.mockClear();
    const session = buildWorktreeSession({
      id: 'session-1',
      locationPath: '/path/to/worktree',
      workers: [createGitDiffWorker()],
    });
    const handler = getDiffWorkerHandler(createDeps([session]));

    const result = await handler.handle(createEvent(), { sessionId: 'session-1', provenance: 'match' });

    expect(result).toBe('handled');
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

    const result = await handler.handle(createEvent('pr:merged'), { sessionId: 'session-1', provenance: 'match' });

    expect(result).toBe('handled');
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

    const result = await handler.handle(createEvent(), { sessionId: 'session-1', provenance: 'match' });

    expect(result).toBe('handled');
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

    const target: EventTarget = { sessionId: 'session-1', workerId: 'some-other-worker', provenance: 'match' };
    const result = await handler.handle(createEvent(), target);

    expect(result).toBe('handled');
    expect(mockTriggerRefresh).toHaveBeenCalledWith('/path/to/worktree');
  });

  it('returns false and does not trigger refresh for a fallback-routed target, even when the session has a git-diff worker (#1661)', async () => {
    mockTriggerRefresh.mockClear();
    const session = buildWorktreeSession({
      id: 'session-1',
      locationPath: '/path/to/worktree',
      workers: [createGitDiffWorker()],
    });
    const handler = getDiffWorkerHandler(createDeps([session]));

    const result = await handler.handle(createEvent(), { sessionId: 'session-1', provenance: 'fallback' });

    expect(result).toBe('not-applicable');
    expect(mockTriggerRefresh).not.toHaveBeenCalled();
  });

  it('triggers refresh for the same session reached as a normal (non-fallback) target -- positive control for the test above', async () => {
    mockTriggerRefresh.mockClear();
    const session = buildWorktreeSession({
      id: 'session-1',
      locationPath: '/path/to/worktree',
      workers: [createGitDiffWorker()],
    });
    const handler = getDiffWorkerHandler(createDeps([session]));

    const result = await handler.handle(createEvent(), { sessionId: 'session-1', provenance: 'match' });

    expect(result).toBe('handled');
    expect(mockTriggerRefresh).toHaveBeenCalledWith('/path/to/worktree');
  });

  it("Issue #1670's polarity pair, in one test: a 'parent' target with a git-diff worker is NOT refreshed on a child's ci:completed; the matching ('match') session in the SAME event IS refreshed (fails on main: both are refreshed, because handlers.ts's pre-fix EventTarget carries no marker for a parent target at all)", async () => {
    mockTriggerRefresh.mockClear();
    const matchingSession = buildWorktreeSession({
      id: 'child-session',
      locationPath: '/path/to/child-worktree',
      workers: [createGitDiffWorker()],
    });
    const parentSession = buildWorktreeSession({
      id: 'parent-session',
      locationPath: '/path/to/parent-worktree',
      workers: [createGitDiffWorker()],
    });
    const handler = getDiffWorkerHandler(createDeps([matchingSession, parentSession]));

    // Positive control: the matching session's own tree IS refreshed.
    const matchResult = await handler.handle(createEvent(), { sessionId: 'child-session', provenance: 'match' });
    expect(matchResult).toBe('handled');
    expect(mockTriggerRefresh).toHaveBeenCalledWith('/path/to/child-worktree');

    mockTriggerRefresh.mockClear();

    // The parent's own tree has nothing to do with the child's event --
    // it must NOT be refreshed.
    const parentResult = await handler.handle(createEvent(), { sessionId: 'parent-session', provenance: 'parent' });
    expect(parentResult).toBe('not-applicable');
    expect(mockTriggerRefresh).not.toHaveBeenCalled();
  });
});
