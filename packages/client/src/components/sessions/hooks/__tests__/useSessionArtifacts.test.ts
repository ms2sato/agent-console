import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSessionArtifacts } from '../useSessionArtifacts';
import { _reset as resetWebSocket } from '../../../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../../../test/mock-websocket';

// Fetch-level mock (testing.md Anti-Pattern #2: mock at the fetch boundary,
// not via mock.module() on api.ts, which is imported for real by many other
// test files in this process).
const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function getLastFetchUrl(): string {
  const calls = mockFetch.mock.calls as unknown[][];
  const arg = calls[calls.length - 1]?.[0];
  if (typeof arg === 'string') return arg;
  if (arg instanceof URL) return arg.toString();
  if (arg instanceof Request) return arg.url;
  return String(arg);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * `getLastInstance()` returning `undefined` and then optional-chaining past
 * it (`ws?.simulateMessage(...)`) is safe in a POSITIVE assertion (the
 * expected refetch simply never happens, and the test correctly fails) but
 * turns a bare NEGATIVE assertion ("no refetch for a different session")
 * into a vacuous truth: no message is delivered, so of course nothing
 * refetched. This throws instead of silently no-op'ing (CodeRabbit finding
 * on PR #1523). The PRIMARY protection is structural, not this guard: every
 * test below runs a positive control (a SAME-session message that must
 * cause a refetch) immediately before its negative assertion, in the same
 * test -- see the describe block's own comment for why an absence
 * assertion needs a same-run positive control, not just a null check.
 *
 * Reach measured directly, twice:
 * 1. (This guard alone.) Reverted a since-merged standalone negative test to
 *    `ws?.simulateMessage(...)` and forced `getLastInstance` to return
 *    `undefined`. bun:test printed `1 pass` for it (the vacuous pass
 *    CodeRabbit flagged) while a `requireLastWs()`-guarded sibling in the
 *    same run printed `1 fail`, throwing this function's exact message.
 * 2. (The positive-control structure, current design.) Reverted the SAME
 *    forcing into the current combined "artifact-created...then does NOT"
 *    test's positive-control step (`ws?.` in place of `requireLastWs()`).
 *    bun:test printed `1 fail` -- the positive control itself timed out
 *    (`Expected [{...artifact-new}], Received []`) rather than silently
 *    passing, proving the merged structure fails loudly on non-delivery
 *    even without this function. Both reverts restored; the file is back to
 *    `4 pass / 0 fail`.
 */
function requireLastWs(): MockWebSocket {
  const ws = MockWebSocket.getLastInstance();
  if (!ws) throw new Error('Expected a MockWebSocket instance to exist by this point in the test');
  return ws;
}

describe('useSessionArtifacts', () => {
  let restoreWebSocket: () => void;

  beforeEach(() => {
    mockFetch.mockReset();
    restoreWebSocket = installMockWebSocket();
    resetWebSocket();
  });

  afterEach(() => {
    restoreWebSocket();
  });

  it('calls fetchArtifacts with the given sessionId (session-scoped query)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        artifacts: [
          { id: 'artifact-1', title: 'My Dashboard', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 1234 },
        ],
      })
    );

    const { result } = renderHook(() => useSessionArtifacts('session-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(getLastFetchUrl()).toContain('/api/artifacts');
    expect(getLastFetchUrl()).toContain('sessionId=session-1');
    expect(result.current.data).toEqual([
      { id: 'artifact-1', title: 'My Dashboard', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 1234 },
    ]);
  });

  it('resolves an empty list when the session has no artifacts', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ artifacts: [] }));

    const { result } = renderHook(() => useSessionArtifacts('session-2'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.data).toEqual([]);
  });

  // Issue #1520: realtime refresh. The message carries only routing
  // metadata (sessionId + artifactId) -- N1 -- so these tests assert
  // invalidate-and-refetch behavior via a real refetch of the REST
  // endpoint, never via binding the payload to rendered data.
  //
  // Each test below is a POSITIVE CONTROL followed by the NEGATIVE
  // assertion, in that order, inside the SAME test -- not two separate
  // tests. An absence assertion ("no refetch for a different session")
  // cannot distinguish "correctly ignored" from "never delivered": if the
  // stimulus silently failed to reach the hook for any reason (a dropped
  // WebSocket instance, a handler that never wired up, a message that
  // failed to parse), the negative assertion would pass anyway, for the
  // wrong reason. Proving delivery works in THIS render/connection first
  // closes that gap structurally (Architect ruling on PR #1523; same shape
  // as test-trigger.md's "the recall assertion needs a negative control",
  // mirrored here as "the absence assertion needs a positive control").
  describe('realtime refresh (artifact-created / artifact-deleted)', () => {
    it('refetches for a SAME-session artifact-created message, then does NOT refetch for a DIFFERENT session', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ artifacts: [] }));

      const { result } = renderHook(() => useSessionArtifacts('session-A'), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isPending).toBe(false));
      expect(result.current.data).toEqual([]);

      const ws = requireLastWs();
      act(() => {
        ws.simulateOpen();
      });

      // Positive control: a SAME-session message actually triggers a
      // refetch in this exact render/connection.
      const newArtifact = { id: 'artifact-new', title: 'New Dashboard', createdAt: '2026-08-20T00:00:00.000Z', sizeBytes: 10 };
      mockFetch.mockResolvedValueOnce(jsonResponse({ artifacts: [newArtifact] }));

      await act(async () => {
        ws.simulateMessage(
          JSON.stringify({ type: 'artifact-created', sessionId: 'session-A', artifactId: 'artifact-new' })
        );
      });

      await waitFor(() => expect(result.current.data).toEqual([newArtifact]));

      // Negative: a DIFFERENT-session message must not cause another refetch.
      const callsBefore = mockFetch.mock.calls.length;

      await act(async () => {
        ws.simulateMessage(
          JSON.stringify({ type: 'artifact-created', sessionId: 'session-OTHER', artifactId: 'artifact-x' })
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(mockFetch.mock.calls.length).toBe(callsBefore);
      expect(result.current.data).toEqual([newArtifact]);
    });

    it('refetches for a SAME-session artifact-deleted message, then does NOT refetch for a DIFFERENT session', async () => {
      const existing = { id: 'artifact-1', title: 'Existing', createdAt: '2026-08-20T00:00:00.000Z', sizeBytes: 5 };
      mockFetch.mockResolvedValueOnce(jsonResponse({ artifacts: [existing] }));

      const { result } = renderHook(() => useSessionArtifacts('session-C'), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isPending).toBe(false));
      expect(result.current.data).toEqual([existing]);

      const ws = requireLastWs();
      act(() => {
        ws.simulateOpen();
      });

      // Positive control: a SAME-session message actually triggers a
      // refetch in this exact render/connection.
      mockFetch.mockResolvedValueOnce(jsonResponse({ artifacts: [] }));

      await act(async () => {
        ws.simulateMessage(
          JSON.stringify({ type: 'artifact-deleted', sessionId: 'session-C', artifactId: 'artifact-1' })
        );
      });

      await waitFor(() => expect(result.current.data).toEqual([]));

      // Negative: a DIFFERENT-session message must not cause another refetch.
      const emptyCallsBefore = mockFetch.mock.calls.length;

      await act(async () => {
        ws.simulateMessage(
          JSON.stringify({ type: 'artifact-deleted', sessionId: 'session-OTHER', artifactId: 'artifact-1' })
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(mockFetch.mock.calls.length).toBe(emptyCallsBefore);
      expect(result.current.data).toEqual([]);
    });
  });
});
