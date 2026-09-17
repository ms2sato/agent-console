import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useRepositoryRegistrySync } from '../useRepositoryRegistrySync';
import { repositoryKeys } from '../../lib/query-keys';
import { _reset as resetWebSocket } from '../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import type { Repository } from '@agent-console/shared';

function mockRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 'repo-1',
    name: 'repo-1',
    path: '/path/to/repo-1',
    createdAt: '2024-01-01',
    orchestratorSessionIds: [],
    clonedSourceRepoPath: null,
    ...overrides,
  } as Repository;
}

describe('useRepositoryRegistrySync', () => {
  let restoreWebSocket: () => void;
  let queryClient: QueryClient;
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    restoreWebSocket = installMockWebSocket();
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
      configurable: true,
    });
    resetWebSocket();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
  });

  afterEach(() => {
    restoreWebSocket();
    queryClient.clear();
    if (originalLocation) {
      Object.defineProperty(window, 'location', originalLocation);
    }
  });

  function renderWithQueryClient() {
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    return renderHook(() => useRepositoryRegistrySync(), { wrapper });
  }

  it('repairs an errored repositories query by writing the repositories-sync payload directly, not by invalidating', async () => {
    // Polarity: measured against the pre-fix design (invalidate-only), not just
    // "hook unmounted". An invalidate-only handler cannot repair an errored
    // query with no active observer -- there is nothing to trigger a refetch,
    // so the query would stay in `error` state with stale/absent data. Only a
    // direct `setQueryData` write can restore `success` state here, which is
    // why this test asserts BOTH the repaired state AND that invalidateQueries
    // was never called for repositoryKeys.all() by this handler.
    await queryClient.fetchQuery({
      queryKey: repositoryKeys.all(),
      queryFn: () => Promise.reject(new Error('down')),
    }).catch(() => {});
    expect(queryClient.getQueryState(repositoryKeys.all())?.status).toBe('error');

    const invalidateSpy = spyOn(queryClient, 'invalidateQueries');
    renderWithQueryClient();

    const repo = mockRepository({ id: 'repo-a', orchestratorSessionIds: ['session-a'] });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({ type: 'repositories-sync', repositories: [repo] }),
      );
    });

    const state = queryClient.getQueryState(repositoryKeys.all());
    expect(state?.status).toBe('success');
    expect(queryClient.getQueryData<{ repositories: Repository[] }>(repositoryKeys.all())).toEqual({ repositories: [repo] });

    const invalidatedAllCalls = invalidateSpy.mock.calls.filter(
      ([opts]) => JSON.stringify((opts as { queryKey?: unknown } | undefined)?.queryKey) === JSON.stringify(repositoryKeys.all()),
    );
    expect(invalidatedAllCalls).toHaveLength(0);
  });

  it('replaces the cache with an empty list when repositories-sync carries zero repositories', () => {
    queryClient.setQueryData(repositoryKeys.all(), { repositories: [mockRepository()] });
    renderWithQueryClient();

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({ type: 'repositories-sync', repositories: [] }),
      );
    });

    expect(queryClient.getQueryData<{ repositories: Repository[] }>(repositoryKeys.all())).toEqual({ repositories: [] });
  });

  it('invalidates repositoryKeys.all() when repository-created arrives', () => {
    const invalidateSpy = spyOn(queryClient, 'invalidateQueries');
    renderWithQueryClient();

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({ type: 'repository-created', repository: mockRepository() }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: repositoryKeys.all() });
  });

  it('invalidates both repositoryKeys.all() and repositoryKeys.detail() when repository-deleted arrives', () => {
    const invalidateSpy = spyOn(queryClient, 'invalidateQueries');
    renderWithQueryClient();

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({ type: 'repository-deleted', repositoryId: 'repo-a' }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: repositoryKeys.all() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: repositoryKeys.detail('repo-a') });
  });

  it('splices the updated repository into the cached list and invalidates its detail key when repository-updated arrives', () => {
    const oldRepo = mockRepository({ id: 'repo-a', name: 'old-name' });
    queryClient.setQueryData(repositoryKeys.all(), { repositories: [oldRepo] });
    const invalidateSpy = spyOn(queryClient, 'invalidateQueries');
    renderWithQueryClient();

    const updatedRepo = mockRepository({ id: 'repo-a', name: 'new-name' });
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({ type: 'repository-updated', repository: updatedRepo }),
      );
    });

    expect(queryClient.getQueryData<{ repositories: Repository[] }>(repositoryKeys.all())).toEqual({ repositories: [updatedRepo] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: repositoryKeys.detail('repo-a') });
  });

  it('does not react to unrelated frames (e.g. agent-created)', () => {
    const invalidateSpy = spyOn(queryClient, 'invalidateQueries');
    renderWithQueryClient();

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({
          type: 'agent-created',
          agent: {
            id: 'agent-1',
            name: 'Claude Code',
            commandTemplate: 'claude {{prompt}}',
            isBuiltIn: false,
            createdAt: '2024-01-01',
            capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
          },
        }),
      );
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
