import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { WorktreeDeletionTasksContext } from '../../../contexts/root-contexts';
import { DeleteWorktreeDialog } from '../DeleteWorktreeDialog';
import type { UseWorktreeDeletionTasksReturn } from '../../../hooks/useWorktreeDeletionTasks';

// deleteWorktreeAsync uses manual fetch (wildcard route), so mock at the
// network boundary per testing.md rather than mocking lib/api.
const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));

beforeEach(() => {
  globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, options: { status?: number; ok?: boolean } = {}) {
  const { status = 200, ok = true } = options;
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function createMockDeletionContext(
  overrides?: Partial<UseWorktreeDeletionTasksReturn>
): UseWorktreeDeletionTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => {}),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    markAsFailed: mock(() => {}),
    handleWorktreeDeletionCompleted: mock(() => {}),
    handleWorktreeDeletionFailed: mock(() => {}),
    ...overrides,
  };
}

async function renderDialog(ctx?: UseWorktreeDeletionTasksReturn, initialPath = '/') {
  const onOpenChange = mock(() => {});
  const context = ctx ?? createMockDeletionContext();
  const result = await renderWithRouter(
    <WorktreeDeletionTasksContext.Provider value={context}>
      <DeleteWorktreeDialog
        open={true}
        onOpenChange={onOpenChange}
        repositoryId="repo-1"
        worktreePath="/path/to/worktree"
        sessionId="session-1"
        sessionTitle="My Session"
      />
    </WorktreeDeletionTasksContext.Provider>,
    initialPath
  );
  return { ...result, onOpenChange, context };
}

describe('DeleteWorktreeDialog', () => {
  it('addTask is keyed off the server-generated jobId, not a client-generated id (new-mechanism contract)', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(jsonResponse({ accepted: true, jobId: 'server-job-999' }));
    const { context, onOpenChange } = await renderDialog();

    await user.click(screen.getByRole('button', { name: 'Delete Worktree' }));

    // Dialog closes and navigates immediately, before the network call resolves.
    expect(onOpenChange).toHaveBeenCalledWith(false);

    await waitFor(() => {
      expect(context.addTask).toHaveBeenCalledTimes(1);
    });
    expect(context.addTask).toHaveBeenCalledWith({
      id: 'server-job-999',
      sessionId: 'session-1',
      sessionTitle: 'My Session',
      repositoryId: 'repo-1',
      worktreePath: '/path/to/worktree',
    });
  });

  it('sends the async=true query param (bug-polarity: old taskId param must be gone)', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(jsonResponse({ accepted: true, jobId: 'job-1' }));
    await renderDialog();

    await user.click(screen.getByRole('button', { name: 'Delete Worktree' }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    const calls = mockFetch.mock.calls as unknown[][];
    const url = String(calls[calls.length - 1]?.[0]);
    expect(url).toContain('async=true');
    expect(url).not.toContain('taskId=');
  });

  it('does not add a task when the API call fails immediately, and surfaces the error instead (bug-polarity: prior code navigated away before the failure could be shown, unmounting the ErrorDialog)', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(
      jsonResponse({ error: 'Network unreachable' }, { ok: false, status: 500 })
    );
    const { context, router } = await renderDialog(undefined, '/session/session-1');

    await user.click(screen.getByRole('button', { name: 'Delete Worktree' }));

    await waitFor(() => {
      expect(screen.getByText('Network unreachable')).toBeTruthy();
    });
    expect(context.addTask).not.toHaveBeenCalled();
    // The component must still be mounted for the error to be visible above,
    // which requires that navigation did NOT happen on an immediate failure.
    expect(router.state.location.pathname).not.toBe('/');
  });
});
