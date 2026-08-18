/**
 * `useAppWsEvent` / `useAppWsState` are replaced per-test via `spyOn` (NOT
 * `mock.module`, which is process-global in bun:test and would leak into
 * other test files) -- see `routes/__tests__/index.test.tsx` for the same
 * pattern. `fetch` is mocked at the fetch level with a tiny stateful fake
 * server so Ruling 2 (badge is a server round trip, not optimistic) and
 * Ruling 3 / N1 (broadcast payloads are invalidation hints only) can be
 * pinned with real async timing rather than asserted from memory of the
 * implementation.
 */
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { useState as useStateReal } from 'react';
import { screen, cleanup, waitFor, act } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { WorktreeDeletionCompletedPayload } from '@agent-console/shared';
import { renderWithRouter } from '../../../test/renderWithRouter';
import * as useAppWsModule from '../../../hooks/useAppWs';
import type { AppWebSocketState } from '../../../lib/app-websocket';
import { NotificationBell } from '../NotificationBell';

// --- Fetch-level mocking: a tiny stateful fake server ---

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface FeedItem {
  kind: 'artifact-created' | 'worktree-deletion-finished';
  id: string;
  occurredAt: string;
  title: string;
  link: string;
  outcome?: 'completed' | 'failed';
}

let serverItems: FeedItem[] = [];
let serverUnreadCount = 0;
let putShouldFail = false;
/** When set, the PUT /seen handler blocks until this resolver is invoked -- lets tests observe in-flight state deterministically. */
let resolveSeenPut: (() => void) | null = null;
let blockSeenPut = false;

const mockFetch = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';

  if (url.includes('/notifications/seen') && method === 'PUT') {
    if (putShouldFail) {
      return jsonResponse({ error: 'lastSeenAt must not be in the future' }, 400);
    }
    if (blockSeenPut) {
      await new Promise<void>((resolve) => {
        resolveSeenPut = resolve;
      });
    }
    const newest = serverItems[0]?.occurredAt ?? new Date().toISOString();
    serverUnreadCount = 0;
    return jsonResponse({ lastSeenAt: newest });
  }

  if (url.includes('/notifications')) {
    return jsonResponse({ items: serverItems, lastSeenAt: null, unreadCount: serverUnreadCount });
  }

  return jsonResponse({});
});

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    kind: 'artifact-created',
    id: `artifact-${Math.random().toString(36).slice(2)}`,
    occurredAt: new Date().toISOString(),
    title: 'An artifact',
    link: '/artifacts/some-id',
    ...overrides,
  };
}

// --- useAppWsEvent / useAppWsState spies ---

let capturedWsOptions: Parameters<typeof useAppWsModule.useAppWsEvent>[0] | undefined;
let setConnectedExternally: ((connected: boolean) => void) | null = null;

let useAppWsEventSpy: ReturnType<typeof spyOn>;
let useAppWsStateSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;
  mockFetch.mockClear();
  serverItems = [];
  serverUnreadCount = 0;
  putShouldFail = false;
  blockSeenPut = false;
  resolveSeenPut = null;
  capturedWsOptions = undefined;
  setConnectedExternally = null;

  useAppWsEventSpy = spyOn(useAppWsModule, 'useAppWsEvent').mockImplementation((options) => {
    capturedWsOptions = options as Parameters<typeof useAppWsModule.useAppWsEvent>[0];
  });
  // A real, reactive hook double: owns local component state so that
  // calling `setConnectedExternally` triggers an actual React re-render of
  // NotificationBell, exercising the same false->true transition path a
  // real WebSocket reconnect would.
  useAppWsStateSpy = spyOn(useAppWsModule, 'useAppWsState').mockImplementation(
    <T,>(selector: (state: AppWebSocketState) => T): T => {
      const [connected, setConnected] = useStateReal(false);
      setConnectedExternally = setConnected;
      return selector({
        connected,
        hasEverConnected: connected,
        sessionsSynced: false,
        agentsSynced: false,
        repositoriesSynced: false,
      });
    }
  );
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  useAppWsEventSpy.mockRestore();
  useAppWsStateSpy.mockRestore();
});

describe('NotificationBell', () => {
  it('renders no badge when unreadCount is 0', async () => {
    serverUnreadCount = 0;
    await renderWithRouter(<NotificationBell />);

    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(0));
    expect(screen.queryByText(/^\d+$/)).toBeNull();
  });

  it('shows the server-computed unreadCount as the badge', async () => {
    serverItems = [makeItem()];
    serverUnreadCount = 2;
    await renderWithRouter(<NotificationBell />);

    await waitFor(() => expect(screen.getByText('2')).toBeTruthy());
  });

  it('shows the server unreadCount even when it exceeds the items cap (51 unread / 50 items)', async () => {
    serverItems = Array.from({ length: 50 }, (_, i) => makeItem({ id: `artifact-${i}` }));
    serverUnreadCount = 51;
    await renderWithRouter(<NotificationBell />);

    await waitFor(() => expect(screen.getByText('51')).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /notifications/i }));

    await waitFor(() => expect(screen.getAllByTestId('notification-item').length).toBe(50));
  });

  it('shows empty-state copy in the panel and sends no PUT when the feed is empty', async () => {
    serverItems = [];
    serverUnreadCount = 0;
    await renderWithRouter(<NotificationBell />);

    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(0));
    const callsBeforeOpen = mockFetch.mock.calls.length;

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /notifications/i }));

    await waitFor(() => expect(screen.getByText(/no notifications yet/i)).toBeTruthy());

    // GET refetch happened, but no PUT (nothing was seen -- cursor unchanged).
    const putCalls = (mockFetch.mock.calls as unknown[][]).filter((call) => {
      const [reqInput, reqInit] = call as [RequestInfo | URL, RequestInit | undefined];
      const url = reqInput instanceof Request ? reqInput.url : String(reqInput);
      const method = (reqInput instanceof Request ? reqInput.method : reqInit?.method) ?? 'GET';
      return url.includes('/notifications/seen') && method === 'PUT';
    });
    expect(putCalls.length).toBe(0);
    expect(mockFetch.mock.calls.length).toBeGreaterThan(callsBeforeOpen);
  });

  describe('Ruling 2: badge zeroing is a server round trip, not optimistic', () => {
    it('keeps the badge non-zero while the seen PUT is in flight, and clears it only once the PUT resolves', async () => {
      serverItems = [makeItem({ occurredAt: '2026-08-17T00:00:00.000Z' })];
      serverUnreadCount = 2;
      blockSeenPut = true;
      await renderWithRouter(<NotificationBell />);

      await waitFor(() => expect(screen.getByText('2')).toBeTruthy());

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /notifications/i }));

      // The PUT is now blocked in flight (resolveSeenPut has been captured).
      await waitFor(() => expect(resolveSeenPut).not.toBeNull());

      // Polarity pin: a naive optimistic-zero implementation would have
      // already cleared the badge by this point. It must not have.
      expect(screen.getByText('2')).toBeTruthy();

      await act(async () => {
        resolveSeenPut?.();
      });

      await waitFor(() => expect(screen.queryByText('2')).toBeNull());
    });

    it('leaves the badge non-zero when the seen PUT fails', async () => {
      serverItems = [makeItem({ occurredAt: '2026-08-17T00:00:00.000Z' })];
      serverUnreadCount = 2;
      putShouldFail = true;
      await renderWithRouter(<NotificationBell />);

      await waitFor(() => expect(screen.getByText('2')).toBeTruthy());

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /notifications/i }));

      await waitFor(() => {
        const putCalls = (mockFetch.mock.calls as unknown[][]).filter((call) => {
          const [reqInput, reqInit] = call as [RequestInfo | URL, RequestInit | undefined];
          const url = reqInput instanceof Request ? reqInput.url : String(reqInput);
          const method = (reqInput instanceof Request ? reqInput.method : reqInit?.method) ?? 'GET';
          return url.includes('/notifications/seen') && method === 'PUT';
        });
        expect(putCalls.length).toBeGreaterThan(0);
      });

      // Give any errant invalidate/refetch a chance to run, then confirm the
      // badge never cleared.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(screen.getByText('2')).toBeTruthy();
    });
  });

  describe('Ruling 3 / N1: WS broadcasts are invalidation hints only', () => {
    it('a phantom broadcast (fully-populated payload, empty backing feed) triggers exactly one refetch and renders nothing from the payload', async () => {
      serverItems = []; // Nothing backs the broadcast -- N1's "refetch finds nothing".
      serverUnreadCount = 0;
      await renderWithRouter(<NotificationBell />);

      await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(0));
      const callsBeforeBroadcast = mockFetch.mock.calls.length;

      const phantomPayload: WorktreeDeletionCompletedPayload = {
        taskId: 'phantom-task-id',
        sessionIds: ['phantom-session-1', 'phantom-session-2'],
        cleanupCommandResult: { success: true, output: 'phantom cleanup output' },
        killErrors: [{ sessionId: 'phantom-session-1', error: 'phantom kill error text' }],
      };

      expect(capturedWsOptions?.onWorktreeDeletionCompleted).toBeDefined();
      await act(async () => {
        capturedWsOptions?.onWorktreeDeletionCompleted?.(phantomPayload);
      });

      await waitFor(() => expect(mockFetch.mock.calls.length).toBe(callsBeforeBroadcast + 1));

      // Nothing from the broadcast payload is reachable in the DOM.
      expect(document.body.textContent).not.toContain('phantom');
      expect(screen.queryByText(/phantom/i)).toBeNull();
    });

    it('the deletion-failed hint also invalidates and never renders its payload', async () => {
      serverItems = [];
      serverUnreadCount = 0;
      await renderWithRouter(<NotificationBell />);

      await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(0));
      const callsBefore = mockFetch.mock.calls.length;

      expect(capturedWsOptions?.onWorktreeDeletionFailed).toBeDefined();
      await act(async () => {
        capturedWsOptions?.onWorktreeDeletionFailed?.({
          taskId: 'phantom-task-2',
          sessionIds: ['phantom-session-3'],
          error: 'phantom deletion error text',
        });
      });

      await waitFor(() => expect(mockFetch.mock.calls.length).toBe(callsBefore + 1));
      expect(document.body.textContent).not.toContain('phantom');
    });
  });

  describe('reconnect refetch trigger', () => {
    it('invalidates the feed on a WS false -> true connected transition, not on initial mount', async () => {
      serverItems = [makeItem()];
      serverUnreadCount = 1;
      await renderWithRouter(<NotificationBell />);

      await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(0));
      const callsAfterMount = mockFetch.mock.calls.length;

      // Still disconnected -- no additional fetch from mere render settling.
      expect(mockFetch.mock.calls.length).toBe(callsAfterMount);

      await act(async () => {
        setConnectedExternally?.(true);
      });

      await waitFor(() => expect(mockFetch.mock.calls.length).toBe(callsAfterMount + 1));
    });
  });
});
