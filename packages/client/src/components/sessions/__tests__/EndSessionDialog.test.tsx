import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { EndSessionDialog, runStopSession } from '../EndSessionDialog';
import { SessionStopTasksContext } from '../../../contexts/root-contexts';
import type { UseSessionStopTasksReturn } from '../../../hooks/useSessionStopTasks';

function createStopTasks(overrides: Partial<UseSessionStopTasksReturn> = {}): UseSessionStopTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => true),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    markAsFailed: mock(() => {}),
    markAsSucceeded: mock(() => {}),
    markAsPending: mock(() => {}),
    ...overrides,
  };
}

describe('EndSessionDialog', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string; method: string }>;
  let deleteStatus: number;

  beforeEach(() => {
    fetchCalls = [];
    deleteStatus = 200;
    globalThis.fetch = Object.assign(
      mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), method: init?.method ?? 'GET' });
        return new Response(JSON.stringify(deleteStatus === 200 ? { success: true } : { error: 'nope' }), {
          status: deleteStatus,
          headers: { 'content-type': 'application/json' },
        });
      }),
      { preconnect: () => {} },
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  function renderDialog(stopTasks: UseSessionStopTasksReturn, onOpenChange = mock(() => {})) {
    return renderWithRouter(
      <SessionStopTasksContext.Provider value={stopTasks}>
        <EndSessionDialog open onOpenChange={onOpenChange} sessionId="s-1" sessionTitle="my-title" />
      </SessionStopTasksContext.Provider>,
    );
  }

  it('names the session and, on confirm, registers a stop task and deletes it by id', async () => {
    const stopTasks = createStopTasks();
    const onOpenChange = mock(() => {});
    await renderDialog(stopTasks, onOpenChange);

    expect(screen.getByText('my-title')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop Session' }));
    });

    expect(stopTasks.addTask).toHaveBeenCalledWith({ sessionId: 's-1', action: 'stop', sessionTitle: 'my-title' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => {
      expect(fetchCalls.some((c) => c.method === 'DELETE' && c.url.endsWith('/api/sessions/s-1'))).toBe(true);
    });
  });

  it('does not send the request when the task cannot be added (a stop is already in flight)', async () => {
    const stopTasks = createStopTasks({ addTask: mock(() => false) });
    await renderDialog(stopTasks);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop Session' }));
    });

    expect(fetchCalls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('runStopSession reports success and, on a server error, marks the task failed and returns false', async () => {
    const markAsFailed = mock(() => {});
    expect(await runStopSession('s-1', markAsFailed)).toBe(true);
    expect(markAsFailed).not.toHaveBeenCalled();

    deleteStatus = 500;
    expect(await runStopSession('s-1', markAsFailed)).toBe(false);
    expect(markAsFailed).toHaveBeenCalledTimes(1);
  });
});
