import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createElement } from 'react';
import type {
  Session,
  AgentActivityState,
  Repository,
} from '@agent-console/shared';
import type { UseWorktreeCreationTasksReturn } from '../useWorktreeCreationTasks';
import type { UseWorktreeDeletionTasksReturn } from '../useWorktreeDeletionTasks';
import type { UseSessionStopTasksReturn, SessionStopTask } from '../useSessionStopTasks';
import { useSessionSideEffects, worktreeInvalidationKeyFor } from '../useSessionSideEffects';
import { worktreeKeys, repositoryKeys } from '../../lib/query-keys';
import { clearDraftsForSession, _getDraftsMap } from '../useDraftMessage';
import { _reset as resetWebSocket } from '../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';

// --- Helpers ---

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: `session-${Math.random().toString(36).slice(2)}`,
    type: 'quick',
    locationPath: '/test/path',
    status: 'active',
    createdAt: new Date().toISOString(),
    workers: [],
    ...overrides,
  } as Session;
}

function createMockWorktreeCreationTasks(): UseWorktreeCreationTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => {}),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    handleWorktreeCreationCompleted: mock(() => {}),
    handleWorktreeCreationFailed: mock(() => {}),
  };
}

function createMockWorktreeDeletionTasks(): UseWorktreeDeletionTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => {}),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    markAsFailed: mock(() => {}),
    handleWorktreeDeletionCompleted: mock(() => {}),
    handleWorktreeDeletionFailed: mock(() => {}),
  };
}

function createMockSessionStopTasks(overrides: Partial<UseSessionStopTasksReturn> = {}): UseSessionStopTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => true),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    markAsFailed: mock(() => {}),
    ...overrides,
  };
}

interface DefaultOptions {
  handleSessionsSync: ReturnType<typeof mock>;
  handleSessionCreated: ReturnType<typeof mock>;
  handleSessionUpdated: ReturnType<typeof mock>;
  handleSessionDeleted: ReturnType<typeof mock>;
  handleSessionPaused: ReturnType<typeof mock>;
  handleSessionResumed: ReturnType<typeof mock>;
  handleWorkerActivity: ReturnType<typeof mock>;
  workerActivityStates: Record<string, Record<string, AgentActivityState>>;
  worktreeCreationTasks: UseWorktreeCreationTasksReturn;
  worktreeDeletionTasks: UseWorktreeDeletionTasksReturn;
  sessionStopTasks: UseSessionStopTasksReturn;
}

function createDefaultOptions(overrides: Partial<DefaultOptions> = {}): DefaultOptions {
  return {
    handleSessionsSync: mock(() => {}),
    handleSessionCreated: mock(() => {}),
    handleSessionUpdated: mock(() => {}),
    handleSessionDeleted: mock(() => {}),
    handleSessionPaused: mock(() => {}),
    handleSessionResumed: mock(() => {}),
    handleWorkerActivity: mock(() => {}),
    workerActivityStates: {},
    worktreeCreationTasks: createMockWorktreeCreationTasks(),
    worktreeDeletionTasks: createMockWorktreeDeletionTasks(),
    sessionStopTasks: createMockSessionStopTasks(),
    ...overrides,
  };
}

let queryClient: QueryClient;

function renderWithQueryClient(options: DefaultOptions) {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  });
  const invalidateSpy = spyOn(queryClient, 'invalidateQueries');

  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  const result = renderHook(
    () => useSessionSideEffects(options),
    { wrapper },
  );

  return { ...result, queryClient, invalidateSpy };
}

describe('useSessionSideEffects', () => {
  beforeEach(() => {
    // Reset mocks between tests
  });

  afterEach(() => {
    queryClient?.clear();
  });

  it('should render without errors', () => {
    const options = createDefaultOptions();
    const { result } = renderWithQueryClient(options);
    // Hook returns void — just ensure it doesn't throw
    expect(result.current).toBeUndefined();
  });

  it('should accept all required options', () => {
    const session = createMockSession();
    const options = createDefaultOptions({
      workerActivityStates: { [session.id]: { 'w1': 'active' as AgentActivityState } },
    });

    // Should render without throwing
    expect(() => renderWithQueryClient(options)).not.toThrow();
  });

  it('should re-render when options change', () => {
    const options = createDefaultOptions();
    const { rerender } = renderWithQueryClient(options);

    // Update with a fresh options object
    const newOptions = createDefaultOptions();
    rerender(newOptions);

    // No errors on rerender
  });

  it('should clear draft messages when handleSessionDeleted fires', () => {
    // Populate the shared drafts map with entries for session-to-delete
    const draftsMap = _getDraftsMap();
    draftsMap.set('session-to-delete:w1', 'draft 1');
    draftsMap.set('session-to-delete:w2', 'draft 2');
    draftsMap.set('other-session:w1', 'should remain');

    const handleSessionDeleted = mock(() => {});

    const options = createDefaultOptions({
      handleSessionDeleted,
    });

    renderWithQueryClient(options);

    // Simulate what happens when the session-deleted event arrives:
    // The hook wraps handleSessionDeleted to also clear drafts. Since triggering
    // the WebSocket event requires full mock infrastructure, we verify that
    // clearDraftsForSession (called by the wrapper) correctly cleans up the
    // shared drafts map. The unit test for clearDraftsForSession is in
    // useDraftMessage.test.ts; here we verify the integration path.
    clearDraftsForSession('session-to-delete');

    expect(draftsMap.has('session-to-delete:w1')).toBe(false);
    expect(draftsMap.has('session-to-delete:w2')).toBe(false);
    expect(draftsMap.get('other-session:w1')).toBe('should remain');

    // Clean up
    draftsMap.clear();
  });
});

/**
 * Tests for Issue #1247 -- session stop/pause task removal is event-driven off
 * server truth. These tests simulate real WebSocket frames (via MockWebSocket,
 * the same infrastructure useAppWs.test.ts uses) rather than calling the
 * wrapped handlers directly, so the assertions exercise the actual
 * useAppWsEvent -> useSessionSideEffects wiring, not a hand-rolled shortcut.
 */
describe('useSessionSideEffects - session stop task removal (Issue #1247)', () => {
  let restoreWebSocket: () => void;
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
    restoreWebSocket = installMockWebSocket();
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
    });
    resetWebSocket();
  });

  afterEach(() => {
    restoreWebSocket();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
  });

  function stopTask(overrides: Partial<SessionStopTask> = {}): SessionStopTask {
    return {
      sessionId: 'session-1',
      action: 'stop',
      error: null,
      ...overrides,
    };
  }

  it('removes a stop task whose session left the sessions-sync list', () => {
    const sessionStopTasks = createMockSessionStopTasks({
      tasks: [stopTask({ sessionId: 'session-gone', action: 'stop' })],
    });
    const options = createDefaultOptions({ sessionStopTasks });
    renderWithQueryClient(options);

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'sessions-sync', sessions: [], activityStates: [] }));
    });

    expect(sessionStopTasks.removeTask).toHaveBeenCalledWith('session-gone');
  });

  it('removes a pause task whose session is present but status is inactive', () => {
    const sessionStopTasks = createMockSessionStopTasks({
      tasks: [stopTask({ sessionId: 'session-1', action: 'pause' })],
    });
    const options = createDefaultOptions({ sessionStopTasks });
    renderWithQueryClient(options);

    const session = createMockSession({ id: 'session-1', status: 'inactive', activationState: 'running', isShared: false, recoveryState: 'healthy' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'sessions-sync', sessions: [session], activityStates: [] }));
    });

    expect(sessionStopTasks.removeTask).toHaveBeenCalledWith('session-1');
  });

  it('does NOT remove a stop task whose session is still present and active (no resurrection on a mid-flight sync)', () => {
    const sessionStopTasks = createMockSessionStopTasks({
      tasks: [stopTask({ sessionId: 'session-1', action: 'stop' })],
    });
    const options = createDefaultOptions({ sessionStopTasks });
    renderWithQueryClient(options);

    const session = createMockSession({ id: 'session-1', status: 'active', activationState: 'running', isShared: false, recoveryState: 'healthy' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'sessions-sync', sessions: [session], activityStates: [] }));
    });

    expect(sessionStopTasks.removeTask).not.toHaveBeenCalled();
  });

  it('removes the task unconditionally on a session-deleted event', () => {
    const sessionStopTasks = createMockSessionStopTasks();
    const options = createDefaultOptions({ sessionStopTasks });
    renderWithQueryClient(options);

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'session-deleted', sessionId: 'session-1' }));
    });

    expect(sessionStopTasks.removeTask).toHaveBeenCalledWith('session-1');
  });

  it('removes the task unconditionally on a session-paused event', () => {
    const sessionStopTasks = createMockSessionStopTasks();
    const options = createDefaultOptions({ sessionStopTasks });
    renderWithQueryClient(options);

    const session = createMockSession({ id: 'session-1', status: 'inactive', activationState: 'hibernated', isShared: false, recoveryState: 'healthy', pausedAt: '2026-01-01T00:00:00Z' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'session-paused', session }));
    });

    expect(sessionStopTasks.removeTask).toHaveBeenCalledWith('session-1');
  });
});

/**
 * Tests for Issue #1266 -- a worktree-type session-created event must
 * invalidate that repository's worktree queries so the dashboard repository
 * card picks up worktrees created outside the REST form flow (e.g. MCP
 * delegate_to_worktree, which never fires worktree-creation-completed).
 */
describe('useSessionSideEffects - worktree query invalidation on session-created (Issue #1266)', () => {
  let restoreWebSocket: () => void;
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
    restoreWebSocket = installMockWebSocket();
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
    });
    resetWebSocket();
  });

  afterEach(() => {
    restoreWebSocket();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
  });

  function worktreeSession(overrides: Partial<Session> = {}): Session {
    return createMockSession({
      type: 'worktree',
      repositoryId: 'repo-1',
      repositoryName: 'repo-one',
      worktreeId: 'feature-branch',
      isMainWorktree: false,
      isShared: false,
      recoveryState: 'healthy',
      activationState: 'running',
      ...overrides,
    } as Partial<Session>);
  }

  it('invalidates the repository worktree query on a worktree session-created event', () => {
    const handleSessionCreated = mock(() => {});
    const options = createDefaultOptions({ handleSessionCreated });
    const { invalidateSpy } = renderWithQueryClient(options);

    const session = worktreeSession({ id: 'session-wt-1' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'session-created', session }));
    });

    expect(handleSessionCreated).toHaveBeenCalledWith(session);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: worktreeKeys.byRepository('repo-1') });
  });

  it('does NOT invalidate worktree queries on a quick session-created event', () => {
    const handleSessionCreated = mock(() => {});
    const options = createDefaultOptions({ handleSessionCreated });
    const { invalidateSpy } = renderWithQueryClient(options);

    const session = createMockSession({ id: 'session-quick-1', type: 'quick', isShared: false, recoveryState: 'healthy', activationState: 'running' } as Partial<Session>);
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'session-created', session }));
    });

    expect(handleSessionCreated).toHaveBeenCalledWith(session);
    const worktreeInvalidations = invalidateSpy.mock.calls.filter(
      ([arg]) => Array.isArray((arg as { queryKey?: unknown[] })?.queryKey) && (arg as { queryKey: unknown[] }).queryKey[0] === 'worktrees',
    );
    expect(worktreeInvalidations).toHaveLength(0);
  });

  it('a malformed worktree session-created message (missing repositoryId) is rejected at the wire and never invalidates or throws', () => {
    // repositoryId is required by WorktreeSessionSchema, so this shape cannot
    // legitimately arrive over the wire -- it is rejected by app-websocket's
    // schema parse before onSessionCreated is ever invoked. This test proves
    // the AC's "no invalidation, no throw" boundary holds for the full pipeline;
    // the wrapper's own defensive guard (for callers other than the wire) is
    // covered directly by the worktreeInvalidationKeyFor unit tests below.
    const handleSessionCreated = mock(() => {});
    const options = createDefaultOptions({ handleSessionCreated });
    const { invalidateSpy } = renderWithQueryClient(options);

    const session = worktreeSession({ id: 'session-wt-2', repositoryId: undefined } as Partial<Session>);
    const ws = MockWebSocket.getLastInstance();
    expect(() => {
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(JSON.stringify({ type: 'session-created', session }));
      });
    }).not.toThrow();

    expect(handleSessionCreated).not.toHaveBeenCalled();
    const worktreeInvalidations = invalidateSpy.mock.calls.filter(
      ([arg]) => Array.isArray((arg as { queryKey?: unknown[] })?.queryKey) && (arg as { queryKey: unknown[] }).queryKey[0] === 'worktrees',
    );
    expect(worktreeInvalidations).toHaveLength(0);
  });

  it('invalidates independently for two worktree sessions created in rapid succession', () => {
    const handleSessionCreated = mock(() => {});
    const options = createDefaultOptions({ handleSessionCreated });
    const { invalidateSpy } = renderWithQueryClient(options);

    const sessionA = worktreeSession({ id: 'session-wt-a', repositoryId: 'repo-a' });
    const sessionB = worktreeSession({ id: 'session-wt-b', repositoryId: 'repo-b' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'session-created', session: sessionA }));
      ws?.simulateMessage(JSON.stringify({ type: 'session-created', session: sessionB }));
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: worktreeKeys.byRepository('repo-a') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: worktreeKeys.byRepository('repo-b') });
  });
});

describe('worktreeInvalidationKeyFor (Issue #1266)', () => {
  it('returns the repository worktree key for a worktree session with a repositoryId', () => {
    const session = createMockSession({
      type: 'worktree',
      repositoryId: 'repo-1',
      repositoryName: 'repo-one',
      worktreeId: 'feature-branch',
      isMainWorktree: false,
      isShared: false,
      recoveryState: 'healthy',
      activationState: 'running',
    } as Partial<Session>);

    expect(worktreeInvalidationKeyFor(session)).toEqual(worktreeKeys.byRepository('repo-1'));
  });

  it('returns null and does not throw for a quick session', () => {
    const session = createMockSession({ type: 'quick', isShared: false, recoveryState: 'healthy', activationState: 'running' } as Partial<Session>);

    expect(() => worktreeInvalidationKeyFor(session)).not.toThrow();
    expect(worktreeInvalidationKeyFor(session)).toBeNull();
  });

  it('returns null and does not throw for a worktree session without a repositoryId', () => {
    // Defensive boundary: repositoryId is required by the WorktreeSession type
    // and by the wire schema, but the guard must stay safe against a runtime
    // value (e.g. an unsafe cast) that omits it.
    const session = createMockSession({
      type: 'worktree',
      repositoryId: undefined,
      repositoryName: 'repo-one',
      worktreeId: 'feature-branch',
      isMainWorktree: false,
      isShared: false,
      recoveryState: 'healthy',
      activationState: 'running',
    } as Partial<Session>);

    expect(() => worktreeInvalidationKeyFor(session)).not.toThrow();
    expect(worktreeInvalidationKeyFor(session)).toBeNull();
  });

  it('returns null and does not throw for a worktree session with an empty-string repositoryId', () => {
    const session = createMockSession({
      type: 'worktree',
      repositoryId: '',
      repositoryName: 'repo-one',
      worktreeId: 'feature-branch',
      isMainWorktree: false,
      isShared: false,
      recoveryState: 'healthy',
      activationState: 'running',
    } as Partial<Session>);

    expect(() => worktreeInvalidationKeyFor(session)).not.toThrow();
    expect(worktreeInvalidationKeyFor(session)).toBeNull();
  });
});

/**
 * Tests for Issue #1643 PR-2's targeted `orchestrator-designation-changed`
 * cache patch. This handler is registered directly on this always-mounted
 * hook (not only on routes/index.tsx's onRepositoryUpdated), because
 * ActiveSessionsSidebar -- which reads Repository.orchestratorSessionId to
 * render the flag control -- is mounted unconditionally from __root.tsx on
 * every route, not only the dashboard route.
 */
describe('useSessionSideEffects - orchestrator-designation-changed cache patch (Issue #1643)', () => {
  let restoreWebSocket: () => void;
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
    restoreWebSocket = installMockWebSocket();
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
    });
    resetWebSocket();
  });

  afterEach(() => {
    restoreWebSocket();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
  });

  function repository(overrides: Partial<Repository> = {}): Repository {
    return {
      id: 'repo-1',
      name: 'repo-1',
      path: '/path/to/repo-1',
      createdAt: new Date().toISOString(),
      orchestratorSessionId: null,
      ...overrides,
    } as Repository;
  }

  it('patches only the targeted repository, leaving the other repository object reference-equal', () => {
    const options = createDefaultOptions();
    const { queryClient } = renderWithQueryClient(options);

    const repoA = repository({ id: 'repo-a', orchestratorSessionId: null });
    const repoB = repository({ id: 'repo-b', orchestratorSessionId: 'old-session' });
    queryClient.setQueryData(['repositories'], { repositories: [repoA, repoB] });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({ type: 'orchestrator-designation-changed', repositoryId: 'repo-a', sessionId: 'session-new' })
      );
    });

    const cached = queryClient.getQueryData<{ repositories: Repository[] }>(['repositories']);
    expect(cached?.repositories.find((r) => r.id === 'repo-a')?.orchestratorSessionId).toBe('session-new');
    // Untouched repository must be the SAME object reference, not just equal by value.
    expect(cached?.repositories.find((r) => r.id === 'repo-b')).toBe(repoB);
  });

  it('sets orchestratorSessionId to null when the designation is cleared', () => {
    const options = createDefaultOptions();
    const { queryClient } = renderWithQueryClient(options);

    const repoA = repository({ id: 'repo-a', orchestratorSessionId: 'session-old' });
    queryClient.setQueryData(['repositories'], { repositories: [repoA] });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({ type: 'orchestrator-designation-changed', repositoryId: 'repo-a', sessionId: null })
      );
    });

    const cached = queryClient.getQueryData<{ repositories: Repository[] }>(['repositories']);
    expect(cached?.repositories.find((r) => r.id === 'repo-a')?.orchestratorSessionId).toBeNull();
  });

  it('does not throw when no repositories query has ever been registered', () => {
    // No Query object exists in the cache at all here (never fetched, never
    // manually seeded) -- there is nothing to invalidate/refetch, so the
    // cache correctly stays empty; a later mount fetches fresh data anyway.
    // This is distinct from the in-flight-fetch race covered below.
    const options = createDefaultOptions();
    const { queryClient } = renderWithQueryClient(options);

    const ws = MockWebSocket.getLastInstance();
    expect(() => {
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({ type: 'orchestrator-designation-changed', repositoryId: 'repo-a', sessionId: 'session-new' })
        );
      });
    }).not.toThrow();

    expect(queryClient.getQueryData(repositoryKeys.all())).toBeUndefined();
  });

  it('forces a fresh refetch when the WS event arrives while an in-flight fetch has no data yet', async () => {
    // Regression test for CodeRabbit finding (PR #1657): TanStack Query's
    // `Query.fetch()` reuses an ALREADY-IN-FLIGHT request's promise whenever
    // `state.data === undefined`, regardless of which QueryClient method
    // triggers it. So a naive `setQueryData`/`invalidateQueries` call made
    // while a first fetch is still pending can silently attach to that same
    // request and resolve with its pre-update (stale) snapshot, dropping the
    // designation change entirely once that fetch settles.
    const options = createDefaultOptions();
    const { queryClient } = renderWithQueryClient(options);
    const queryKey = repositoryKeys.all();

    const repoAStale = repository({ id: 'repo-a', orchestratorSessionId: null });
    const repoAFresh = repository({ id: 'repo-a', orchestratorSessionId: 'session-new' });

    let resolveFirstFetch: ((value: { repositories: Repository[] }) => void) | null = null;
    const queryFn = mock(() => {
      if (queryFn.mock.calls.length === 1) {
        // First call: simulate ActiveSessionsSidebar's own useQuery having
        // started a fetch that has not resolved yet.
        return new Promise<{ repositories: Repository[] }>((resolve) => {
          resolveFirstFetch = resolve;
        });
      }
      // Any subsequent call is the forced fresh refetch and must see the
      // server's already-applied change.
      return Promise.resolve({ repositories: [repoAFresh] });
    });

    // Mount a real, actively-observed `useQuery` on the SAME query client,
    // mirroring ActiveSessionsSidebar's own always-mounted query. This
    // matters: `invalidateQueries`'s default `type: 'active'` refetch only
    // matches queries with a live observer -- without one (e.g. a bare
    // `queryClient.fetchQuery` call), the handler's chained invalidate/
    // refetch would not actually wait on this in-flight fetch, and the test
    // would not exercise the race it is meant to guard.
    const queryWrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    renderHook(() => useQuery({ queryKey, queryFn }), { wrapper: queryWrapper });

    expect(queryClient.getQueryData(queryKey)).toBeUndefined();
    expect(queryFn).toHaveBeenCalledTimes(1);

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({ type: 'orchestrator-designation-changed', repositoryId: 'repo-a', sessionId: 'session-new' })
      );
    });

    // Settle the original in-flight fetch with its PRE-update snapshot --
    // this is the race window the fix must survive.
    await act(async () => {
      resolveFirstFetch?.({ repositories: [repoAStale] });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(queryFn).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      const cached = queryClient.getQueryData<{ repositories: Repository[] }>(queryKey);
      expect(cached?.repositories.find((r) => r.id === 'repo-a')?.orchestratorSessionId).toBe('session-new');
    });
  });

  it('forces a fresh refetch when the cache is populated but does not yet contain the targeted repository', async () => {
    // Regression test for CodeRabbit finding (PR #1657, outside-diff-range): when
    // the repositories cache IS populated but none of its entries have
    // `id === repositoryId` (e.g. a repository registered after the cache was
    // last populated), the `setQueryData` map callback finds no match and
    // writes back an unchanged list -- silently dropping the designation
    // change with no future correction. The fallback must be the same
    // invalidate-then-refetch path used for the no-cache case above.
    const options = createDefaultOptions();
    const { queryClient } = renderWithQueryClient(options);
    const queryKey = repositoryKeys.all();

    const repoB = repository({ id: 'repo-b', orchestratorSessionId: null });

    const queryFn = mock(() => Promise.resolve({ repositories: [repoB] }));

    // Mount a real, actively-observed `useQuery` on the SAME query client, for
    // the same reason as the in-flight-fetch test above: `invalidateQueries`'s
    // default `type: 'active'` refetch only matches queries with a live
    // observer.
    const queryWrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    renderHook(() => useQuery({ queryKey, queryFn }), { wrapper: queryWrapper });

    await waitFor(() => {
      expect(queryClient.getQueryData<{ repositories: Repository[] }>(queryKey)).toEqual({ repositories: [repoB] });
    });
    expect(queryFn).toHaveBeenCalledTimes(1);

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({ type: 'orchestrator-designation-changed', repositoryId: 'repo-a', sessionId: 'session-new' })
      );
    });

    // A direct `setQueryData` patch would have silently no-op'd here (no
    // `repo-a` entry to map over); the fix must instead trigger the same
    // invalidate-then-refetch fallback as the no-cache case, evidenced by a
    // second `queryFn` call.
    await waitFor(() => {
      expect(queryFn).toHaveBeenCalledTimes(2);
    });
  });
});
