import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { renderHook, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { renderWithRouter } from '../../test/renderWithRouter';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import { _reset as resetWebSocket } from '../../lib/app-websocket';
import { listReconnectInvalidationKeys, _resetReconnectInvalidation } from '../../lib/reconnect-invalidation';
import { todoKeys, artifactKeys, bookmarkKeys, reviewQueueKeys, notificationCenterKeys, sessionKeys } from '../../lib/query-keys';
import { useSessionTodos } from '../../components/sessions/hooks/useSessionTodos';
import { useFilteredTodos } from '../useFilteredTodos';
import { useTodoDetail } from '../useTodoDetail';
import { useSessionArtifacts } from '../../components/sessions/hooks/useSessionArtifacts';
import { useSessionBookmarks } from '../../components/sessions/hooks/useSessionBookmarks';
import { NotificationBell } from '../../components/notifications/NotificationBell';
import { ReviewCountBadge } from '../../components/header/ReviewCountBadge';
import { MemoPanel } from '../../components/sessions/MemoPanel';
import { ArtifactsPage } from '../../routes/artifacts/index';

/**
 * Registry completeness, at runtime: every consumer of a trigger-only frame
 * family registers that family's ROOT key for the reconnect invalidation. The
 * type (`useAppWsEvent`'s `invalidateOnReconnect`) forces a consumer to declare
 * keys; it cannot force the declared key to be the family's root, and it cannot
 * see a handler name dropped from `FRAME_DRIVEN_HANDLERS`. This table is that
 * direction.
 *
 * Not in the table: the two review route pages (`routes/review/index.tsx`,
 * `routes/review/$sourceSessionId.tsx`) read their params from a file route and
 * cannot be mounted here without a route tree; they register the same
 * `reviewQueueKeys.root()` as `ReviewCountBadge`, and the compile-time rule
 * covers the omission of the declaration itself.
 */

const originalFetch = globalThis.fetch;
const mockFetch = mock(async (_input: unknown) => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

let restoreWebSocket: () => void;

beforeEach(() => {
  restoreWebSocket = installMockWebSocket();
  resetWebSocket();
  _resetReconnectInvalidation();
});

afterEach(() => {
  cleanup();
  resetWebSocket();
  restoreWebSocket();
  MockWebSocket.clearInstances();
});

function hookWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
}

const HOOKS: Array<[string, () => unknown, QueryKey]> = [
  ['todos: useSessionTodos', () => useSessionTodos('s1'), todoKeys.root()],
  ['todos: useFilteredTodos', () => useFilteredTodos({}), todoKeys.root()],
  ['todos: useTodoDetail', () => useTodoDetail('t1'), todoKeys.root()],
  ['artifacts: useSessionArtifacts', () => useSessionArtifacts('s1'), artifactKeys.root()],
  ['bookmarks: useSessionBookmarks', () => useSessionBookmarks('s1'), bookmarkKeys.root()],
];

describe('reconnect registry completeness', () => {
  it.each(HOOKS)('%s registers its family root', (_label, useConsumer, root) => {
    renderHook(() => useConsumer(), { wrapper: hookWrapper() });

    expect(listReconnectInvalidationKeys()).toContainEqual(root);
  });

  const COMPONENTS: Array<[string, () => React.ReactNode, QueryKey]> = [
    ['notification center: NotificationBell', () => <NotificationBell />, notificationCenterKeys.root()],
    ['review queue: ReviewCountBadge', () => <ReviewCountBadge />, reviewQueueKeys.root()],
    ['artifacts: ArtifactsPage', () => <ArtifactsPage />, artifactKeys.root()],
    [
      'session memo: MemoPanel',
      () => <MemoPanel sessionId="s1" isExpanded onToggleExpanded={() => {}} onEnsureExpanded={() => {}} compact={false} />,
      sessionKeys.memoRoot(),
    ],
  ];

  it.each(COMPONENTS)('%s registers its family root', async (_label, ui, root) => {
    await renderWithRouter(ui());

    expect(listReconnectInvalidationKeys()).toContainEqual(root);
  });

  it('the memo root is the prefix of the per-session memo key (one root covers every session)', () => {
    expect(sessionKeys.memo('any-session').slice(0, 1)).toEqual([...sessionKeys.memoRoot()]);
  });
});
