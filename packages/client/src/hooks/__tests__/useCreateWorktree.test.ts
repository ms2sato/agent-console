import { mock, describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { useCreateWorktree } from '../useCreateWorktree';
import { WorktreeCreationTasksContext } from '../../contexts/root-contexts';
import type { UseWorktreeCreationTasksReturn } from '../useWorktreeCreationTasks';
import type { CreateWorktreeFormRequest } from '../../components/worktrees/CreateWorktreeForm';

// useCreateWorktree resolves its task-list callbacks from WorktreeCreationTasksContext
// (re-exported by routes/__root). The test provides a REAL context value via
// WorktreeCreationTasksContext.Provider instead of `mock.module`-ing routes/__root --
// mock.module is process-global in bun:test and would poison every other test file
// that real-imports routes/__root in the same process (testing.md Anti-Pattern #2).
const mockAddTask = mock(() => {});
const mockRemoveTask = mock(() => {});

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const contextValue: UseWorktreeCreationTasksReturn = {
    addTask: mockAddTask,
    removeTask: mockRemoveTask,
    tasks: [],
    getTask: mock(() => undefined),
    handleWorktreeCreationCompleted: mock(() => {}),
    handleWorktreeCreationFailed: mock(() => {}),
  };
  return ({ children }) => createElement(WorktreeCreationTasksContext.Provider, { value: contextValue }, children);
}

// Mock fetch at the lowest level to avoid mock.module pollution on api.ts
const originalFetch = globalThis.fetch;
const mockFetch = mock((_input: RequestInfo | URL, _init?: RequestInit) =>
  Promise.resolve(new Response(JSON.stringify({ accepted: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
);
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('useCreateWorktree', () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockRemoveTask.mockClear();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  const defaultParams = {
    repositoryId: 'repo-1',
    repositoryName: 'Test Repository',
  };

  const mockFormRequest: CreateWorktreeFormRequest = {
    mode: 'prompt',
    initialPrompt: 'Add dark mode',
    autoStartSession: true,
  };

  it('should call addTask and createWorktreeAsync on success', async () => {
    const { result } = renderHook(() => useCreateWorktree(defaultParams), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.handleCreateWorktree(mockFormRequest);
    });

    // addTask should be called once with repository info and a generated taskId
    expect(mockAddTask).toHaveBeenCalledTimes(1);
    const addTaskArg = (mockAddTask.mock.calls as unknown as Array<[{
      id: string;
      repositoryId: string;
      repositoryName: string;
      request: Record<string, unknown>;
    }]>)[0][0];
    expect(addTaskArg.repositoryId).toBe('repo-1');
    expect(addTaskArg.repositoryName).toBe('Test Repository');
    expect(typeof addTaskArg.id).toBe('string');
    expect(addTaskArg.id.length).toBeGreaterThan(0);
    // The request should include the taskId and form data
    expect(addTaskArg.request).toMatchObject({
      ...mockFormRequest,
      taskId: addTaskArg.id,
    });

    // The API should have been called (fetch was invoked)
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // No error should be set
    expect(result.current.error).toBeNull();
  });

  it('should call removeTask and set error on API failure', async () => {
    // Mock fetch to return a non-ok response
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Network error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { result } = renderHook(() => useCreateWorktree(defaultParams), { wrapper: createWrapper() });

    // The hook re-throws the error, so we catch it in the act callback
    let thrownError: unknown;
    await act(async () => {
      try {
        await result.current.handleCreateWorktree(mockFormRequest);
      } catch (err) {
        thrownError = err;
      }
    });

    expect(thrownError).toBeDefined();

    // removeTask should be called with the same taskId that was passed to addTask
    expect(mockRemoveTask).toHaveBeenCalledTimes(1);
    const addTaskId = ((mockAddTask.mock.calls as unknown as Array<[{ id: string }]>)[0][0]).id;
    expect((mockRemoveTask.mock.calls as unknown as Array<[string]>)[0][0]).toBe(addTaskId);

    // Error should be set
    expect(result.current.error).toBeTruthy();
  });

  it('should set "Unknown error" for non-Error thrown values', async () => {
    // Mock fetch to throw a non-Error value
    mockFetch.mockRejectedValue('some string error');

    const { result } = renderHook(() => useCreateWorktree(defaultParams), { wrapper: createWrapper() });

    let thrownError: unknown;
    await act(async () => {
      try {
        await result.current.handleCreateWorktree(mockFormRequest);
      } catch (err) {
        thrownError = err;
      }
    });

    expect(thrownError).toBe('some string error');
    expect(result.current.error).toBe('Unknown error');
  });

  it('should still call addTask with a valid taskId when crypto.randomUUID is unavailable (non-secure context, #1345)', async () => {
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
      const { result } = renderHook(() => useCreateWorktree(defaultParams), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.handleCreateWorktree(mockFormRequest);
      });

      expect(mockAddTask).toHaveBeenCalledTimes(1);
      const addTaskArg = (mockAddTask.mock.calls as unknown as Array<[{ id: string }]>)[0][0];
      expect(typeof addTaskArg.id).toBe('string');
      expect(addTaskArg.id.length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        writable: true,
        configurable: true,
      });
    }
  });

  it('clearError should reset error to null', async () => {
    // Mock fetch to fail
    mockFetch.mockRejectedValue(new Error('Some error'));

    const { result } = renderHook(() => useCreateWorktree(defaultParams), { wrapper: createWrapper() });

    // Trigger an error
    await act(async () => {
      try {
        await result.current.handleCreateWorktree(mockFormRequest);
      } catch {
        // expected
      }
    });

    expect(result.current.error).toBe('Some error');

    // Clear the error
    act(() => {
      result.current.clearError();
    });

    expect(result.current.error).toBeNull();
  });
});
