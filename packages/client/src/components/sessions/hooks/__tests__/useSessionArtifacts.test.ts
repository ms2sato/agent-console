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
  describe('realtime refresh (artifact-created / artifact-deleted)', () => {
    it('refetches when an artifact-created message arrives for the SAME session (scoping positive)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ artifacts: [] }));

      const { result } = renderHook(() => useSessionArtifacts('session-A'), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isPending).toBe(false));
      expect(result.current.data).toEqual([]);

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const newArtifact = { id: 'artifact-new', title: 'New Dashboard', createdAt: '2026-08-20T00:00:00.000Z', sizeBytes: 10 };
      mockFetch.mockResolvedValueOnce(jsonResponse({ artifacts: [newArtifact] }));

      await act(async () => {
        ws?.simulateMessage(
          JSON.stringify({ type: 'artifact-created', sessionId: 'session-A', artifactId: 'artifact-new' })
        );
      });

      await waitFor(() => expect(result.current.data).toEqual([newArtifact]));
    });

    it('does NOT refetch when an artifact-created message arrives for a DIFFERENT session (scoping negative)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ artifacts: [] }));

      const { result } = renderHook(() => useSessionArtifacts('session-B'), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isPending).toBe(false));

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const callsBefore = mockFetch.mock.calls.length;

      await act(async () => {
        ws?.simulateMessage(
          JSON.stringify({ type: 'artifact-created', sessionId: 'session-OTHER', artifactId: 'artifact-x' })
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(mockFetch.mock.calls.length).toBe(callsBefore);
      expect(result.current.data).toEqual([]);
    });

    it('refetches when an artifact-deleted message arrives for the SAME session (scoping positive)', async () => {
      const existing = { id: 'artifact-1', title: 'Existing', createdAt: '2026-08-20T00:00:00.000Z', sizeBytes: 5 };
      mockFetch.mockResolvedValueOnce(jsonResponse({ artifacts: [existing] }));

      const { result } = renderHook(() => useSessionArtifacts('session-C'), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isPending).toBe(false));
      expect(result.current.data).toEqual([existing]);

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      mockFetch.mockResolvedValueOnce(jsonResponse({ artifacts: [] }));

      await act(async () => {
        ws?.simulateMessage(
          JSON.stringify({ type: 'artifact-deleted', sessionId: 'session-C', artifactId: 'artifact-1' })
        );
      });

      await waitFor(() => expect(result.current.data).toEqual([]));
    });

    it('does NOT refetch when an artifact-deleted message arrives for a DIFFERENT session (scoping negative)', async () => {
      const existing = { id: 'artifact-1', title: 'Existing', createdAt: '2026-08-20T00:00:00.000Z', sizeBytes: 5 };
      mockFetch.mockResolvedValueOnce(jsonResponse({ artifacts: [existing] }));

      const { result } = renderHook(() => useSessionArtifacts('session-D'), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isPending).toBe(false));

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      const callsBefore = mockFetch.mock.calls.length;

      await act(async () => {
        ws?.simulateMessage(
          JSON.stringify({ type: 'artifact-deleted', sessionId: 'session-OTHER', artifactId: 'artifact-1' })
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(mockFetch.mock.calls.length).toBe(callsBefore);
      expect(result.current.data).toEqual([existing]);
    });
  });
});
