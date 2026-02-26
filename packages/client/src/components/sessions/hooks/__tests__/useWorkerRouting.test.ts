import { describe, it, expect } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from '@tanstack/react-router';
import { createElement, type ReactNode } from 'react';
import { useWorkerRouting } from '../useWorkerRouting';

/**
 * Creates a test router with session/worker routes and returns both the router
 * and a wrapper component that can be used with renderHook.
 *
 * The wrapper renders RouterProvider where the root route's component
 * is a "slot" that renders whatever children are passed in. This allows
 * renderHook to place its test component inside the router context.
 */
function createRouterWrapper(initialPath = '/') {
  // Use a mutable ref to hold children, since the root component
  // is rendered by RouterProvider (not via React children prop).
  let childrenSlot: ReactNode = null;

  const rootRoute = createRootRoute({
    component: () => createElement('div', null, childrenSlot),
  });
  const sessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/$sessionId',
  });
  const workerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/$sessionId/$workerId',
  });
  rootRoute.addChildren([sessionRoute, workerRoute]);

  const memoryHistory = createMemoryHistory({ initialEntries: [initialPath] });
  const router = createRouter({
    routeTree: rootRoute,
    history: memoryHistory,
    defaultPendingMinMs: 0,
  });

  const wrapper = ({ children }: { children: ReactNode }) => {
    childrenSlot = children;
    return createElement(RouterProvider, { router });
  };

  return { router, wrapper };
}

describe('useWorkerRouting', () => {
  describe('navigateToWorker', () => {
    it('navigates to /sessions/{sessionId}/{workerId}', async () => {
      const { router, wrapper } = createRouterWrapper('/');
      await router.load();

      const { result } = renderHook(() => useWorkerRouting('session-1'), {
        wrapper,
      });

      await act(async () => {
        result.current.navigateToWorker('worker-1');
      });

      expect(router.state.location.pathname).toBe(
        '/sessions/session-1/worker-1'
      );
    });

    it('uses replace navigation when replace is true', async () => {
      const { router, wrapper } = createRouterWrapper('/');
      await router.load();

      const { result } = renderHook(() => useWorkerRouting('session-1'), {
        wrapper,
      });

      // Navigate to an initial location first
      await act(async () => {
        result.current.navigateToWorker('worker-1');
      });

      const historyLengthBefore = router.history.length;

      // Navigate with replace: true - should not add a new history entry
      await act(async () => {
        result.current.navigateToWorker('worker-2', true);
      });

      expect(router.state.location.pathname).toBe(
        '/sessions/session-1/worker-2'
      );
      expect(router.history.length).toBe(historyLengthBefore);
    });
  });

  describe('navigateToSession', () => {
    it('navigates to /sessions/{sessionId} with replace', async () => {
      const { router, wrapper } = createRouterWrapper(
        '/sessions/session-1/worker-1'
      );
      await router.load();

      const { result } = renderHook(() => useWorkerRouting('session-1'), {
        wrapper,
      });

      const historyLengthBefore = router.history.length;

      await act(async () => {
        result.current.navigateToSession();
      });

      expect(router.state.location.pathname).toBe('/sessions/session-1');
      // navigateToSession always uses replace: true
      expect(router.history.length).toBe(historyLengthBefore);
    });
  });

  describe('reference stability', () => {
    it('returns stable function references when sessionId does not change', async () => {
      const { router, wrapper } = createRouterWrapper('/');
      await router.load();

      const { result, rerender } = renderHook(
        () => useWorkerRouting('session-1'),
        { wrapper }
      );

      const firstNavigateToWorker = result.current.navigateToWorker;
      const firstNavigateToSession = result.current.navigateToSession;

      rerender();

      expect(result.current.navigateToWorker).toBe(firstNavigateToWorker);
      expect(result.current.navigateToSession).toBe(firstNavigateToSession);
    });
  });
});
