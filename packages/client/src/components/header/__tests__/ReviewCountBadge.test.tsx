import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor, act } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { waitForAbsent } from '../../../test/waitForAbsent';
import { completeWireBody } from '../../../test/wire-fixtures';
import { _reset as resetWebSocket } from '../../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import { jsonResponse } from '../../../test/todo-fixtures';
import { ReviewCountBadge } from '../ReviewCountBadge';

const originalFetch = globalThis.fetch;
const mockFetch = mock(async (_input: RequestInfo | URL): Promise<Response> => jsonResponse(completeWireBody([])));

let restoreWebSocket: () => void;

function group(id: string, workerIds: string[]) {
  return { sourceSessionId: id, sourceSessionTitle: id, items: workerIds.map((workerId) => ({ workerId })) };
}

function answerWith(groups: unknown[]) {
  return jsonResponse(completeWireBody(groups));
}

beforeEach(() => {
  globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => answerWith([]));
  restoreWebSocket = installMockWebSocket();
  resetWebSocket();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  restoreWebSocket();
});

describe('ReviewCountBadge', () => {
  it('renders nothing at zero pending items', async () => {
    const { container } = await renderWithRouter(<ReviewCountBadge />);
    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(container.textContent).toBe('');
  });

  it('shows the sum of the items across all groups', async () => {
    mockFetch.mockImplementation(async () => answerWith([group('s1', ['a', 'b']), group('s2', ['c'])]));

    await renderWithRouter(<ReviewCountBadge />);

    await waitFor(() => expect(screen.getByText('3')).toBeTruthy());
  });

  it('hides the numeric badge from assistive tech and describes it in screen-reader text', async () => {
    mockFetch.mockImplementation(async () => answerWith([group('s1', ['a', 'b']), group('s2', ['c'])]));

    await renderWithRouter(<ReviewCountBadge />);

    await waitFor(() => expect(screen.getByText('3').getAttribute('aria-hidden')).toBe('true'));
    expect(screen.getByText('3 pending reviews').className).toContain('sr-only');
  });

  it('refetches and updates on a review-queue-updated frame', async () => {
    mockFetch.mockImplementationOnce(async () => answerWith([group('s1', ['a'])]));
    await renderWithRouter(<ReviewCountBadge />);
    await waitFor(() => expect(screen.getByText('1')).toBeTruthy());
    const ws = MockWebSocket.getLastInstance();
    if (!ws) throw new Error('Expected a MockWebSocket instance to exist by this point in the test');
    act(() => {
      ws.simulateOpen();
    });
    mockFetch.mockImplementationOnce(async () => answerWith([group('s1', ['a', 'b']), group('s2', ['c', 'd'])]));

    await act(async () => {
      ws.simulateMessage(JSON.stringify({ type: 'review-queue-updated' }));
    });

    await waitFor(() => expect(screen.getByText('4')).toBeTruthy());
  });

  it('drops the badge when a refetch reports an empty queue', async () => {
    mockFetch.mockImplementationOnce(async () => answerWith([group('s1', ['a'])]));
    await renderWithRouter(<ReviewCountBadge />);
    await waitFor(() => expect(screen.getByText('1')).toBeTruthy());
    const ws = MockWebSocket.getLastInstance();
    if (!ws) throw new Error('Expected a MockWebSocket instance to exist by this point in the test');
    act(() => {
      ws.simulateOpen();
    });
    mockFetch.mockImplementationOnce(async () => answerWith([]));

    await act(async () => {
      ws.simulateMessage(JSON.stringify({ type: 'review-queue-updated' }));
    });

    await waitForAbsent(() => screen.queryByText('1'));
  });
});
