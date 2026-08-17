import { describe, it, expect, mock, afterEach, afterAll } from 'bun:test';
import { screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { DeleteWorktreeDialog, type DeleteWorktreeDialogProps } from '../DeleteWorktreeDialog';
import { WorktreeDeletionTasksContext } from '../../../contexts/root-contexts';
import type { UseWorktreeDeletionTasksReturn } from '../../../hooks/useWorktreeDeletionTasks';
import { renderWithRouter } from '../../../test/renderWithRouter';

// DeleteWorktreeDialog resolves addTask/markAsFailed from
// WorktreeDeletionTasksContext (re-exported by routes/__root) and navigate
// from @tanstack/react-router. Mirrors PauseSessionDialog.test.tsx's pattern
// (a real router via renderWithRouter + a real Context.Provider fed a mock
// return value) instead of `mock.module`-ing routes/__root or the router
// package -- mock.module is process-global in bun:test and would poison
// every other test file that real-imports those modules in the same process
// (testing.md Anti-Pattern #2).
const originalFetch = globalThis.fetch;
let resolveDeleteWorktree: (() => void) | null = null;
let rejectDeleteWorktree: ((err: Error) => void) | null = null;
const mockFetch = mock(
  (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      resolveDeleteWorktree = () => resolve(new Response(JSON.stringify({ accepted: true }), { status: 200 }));
      rejectDeleteWorktree = (err) => reject(err);
    })
);
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
  mockFetch.mockClear();
  resolveDeleteWorktree = null;
  rejectDeleteWorktree = null;
});

function createMockDeletionTasks(overrides: Partial<UseWorktreeDeletionTasksReturn> = {}): UseWorktreeDeletionTasksReturn {
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

async function renderDialog(
  props: Partial<DeleteWorktreeDialogProps> = {},
  deletionTasks: UseWorktreeDeletionTasksReturn = createMockDeletionTasks(),
  initialPath = '/some-session-page'
) {
  const defaultProps: DeleteWorktreeDialogProps = {
    open: true,
    onOpenChange: mock(() => {}),
    repositoryId: 'repo-1',
    worktreePath: '/tmp/worktrees/repo-1/feature-branch',
    sessionId: 'session-1',
  };

  return renderWithRouter(
    <WorktreeDeletionTasksContext.Provider value={deletionTasks}>
      <DeleteWorktreeDialog {...defaultProps} {...props} />
    </WorktreeDeletionTasksContext.Provider>,
    initialPath
  );
}

describe('DeleteWorktreeDialog', () => {
  it('adds a deletion task, closes the dialog, navigates home, and calls the delete API on confirm', async () => {
    const onOpenChange = mock(() => {});
    const deletionTasks = createMockDeletionTasks();
    const { router } = await renderDialog({ onOpenChange }, deletionTasks);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Worktree' }));

    // Assert synchronously (before resolving the mocked fetch promise) --
    // addTask/onOpenChange/navigate all happen before the API call is
    // awaited, matching PauseSessionDialog's Issue #1247 pattern.
    expect(deletionTasks.addTask).toHaveBeenCalledTimes(1);
    const addTaskArg = (deletionTasks.addTask as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      id: string;
      sessionId: string;
      sessionTitle: string;
      repositoryId: string;
      worktreePath: string;
    };
    expect(typeof addTaskArg.id).toBe('string');
    expect(addTaskArg.id.length).toBeGreaterThan(0);
    expect(addTaskArg.sessionId).toBe('session-1');
    expect(addTaskArg.repositoryId).toBe('repo-1');
    expect(addTaskArg.worktreePath).toBe('/tmp/worktrees/repo-1/feature-branch');

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(router.state.location.pathname).toBe('/');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const requestedUrl = (mockFetch.mock.calls[0]?.[0] as string | URL).toString();
    expect(requestedUrl).toContain(`taskId=${addTaskArg.id}`);

    resolveDeleteWorktree?.();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(deletionTasks.markAsFailed).not.toHaveBeenCalled();
  });

  it('marks the task as failed with the error message when the delete API call rejects', async () => {
    const deletionTasks = createMockDeletionTasks();
    await renderDialog({}, deletionTasks);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Worktree' }));

    const addTaskArg = (deletionTasks.addTask as ReturnType<typeof mock>).mock.calls[0]?.[0] as { id: string };

    rejectDeleteWorktree?.(new Error('Network error'));

    await waitFor(() => {
      expect(deletionTasks.markAsFailed).toHaveBeenCalledWith(addTaskArg.id, 'Network error');
    });
  });

  it('still produces a valid taskId and calls addTask/deleteWorktreeAsync when crypto.randomUUID is unavailable (non-secure context, #1345)', async () => {
    // Simulate non-secure context: crypto exists but without randomUUID
    // (same technique as lib/__tests__/id.test.ts's "non-secure context
    // fallback" block). This proves the renamed generateClientId import at
    // this call site actually routes through the guarded fallback, not
    // just that the helper itself works in isolation.
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) },
      writable: true,
      configurable: true,
    });

    try {
      const deletionTasks = createMockDeletionTasks();

      await renderDialog({}, deletionTasks);
      // No try/catch here: if handleDeleteWorktree threw synchronously (the
      // pre-fix crypto.randomUUID() call would throw when crypto lacks
      // randomUUID), fireEvent.click would surface it and fail the test.
      fireEvent.click(screen.getByRole('button', { name: 'Delete Worktree' }));

      expect(deletionTasks.addTask).toHaveBeenCalled();
      const addTaskArg = (deletionTasks.addTask as ReturnType<typeof mock>).mock.calls[0]?.[0] as { id: string };
      expect(typeof addTaskArg.id).toBe('string');
      expect(addTaskArg.id.length).toBeGreaterThan(0);
      expect(mockFetch).toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        writable: true,
        configurable: true,
      });
    }
  });
});
