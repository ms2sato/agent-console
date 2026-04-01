import { mock, describe, it, expect, beforeEach, afterAll } from 'bun:test';

// Mock the root route context -- this is safe because no other test file imports __root directly.
const mockAddTask = mock(() => {});
const mockRemoveTask = mock(() => {});

mock.module('../../routes/__root', () => ({
  useWorktreeCreationTasksContext: () => ({
    addTask: mockAddTask,
    removeTask: mockRemoveTask,
    tasks: [],
    getTask: mock(() => undefined),
    handleWorktreeCreationCompleted: mock(() => {}),
    handleWorktreeCreationFailed: mock(() => {}),
  }),
}));

import { renderHook, act } from '@testing-library/react';
import { useCreateWorktree } from '../useCreateWorktree';
import type { CreateWorktreeFormRequest } from '../../components/worktrees/CreateWorktreeForm';

// Mock fetch at the lowest level to avoid mock.module pollution on api.ts
const originalFetch = globalThis.fetch;
const mockFetch = mock((_input: RequestInfo | URL, _init?: RequestInit) =>
  Promise.resolve(new Response(JSON.stringify({ accepted: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
);
globalThis.fetch = mockFetch as unknown as typeof fetch;

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
    const { result } = renderHook(() => useCreateWorktree(defaultParams));

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

    const { result } = renderHook(() => useCreateWorktree(defaultParams));

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

    const { result } = renderHook(() => useCreateWorktree(defaultParams));

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

  it('clearError should reset error to null', async () => {
    // Mock fetch to fail
    mockFetch.mockRejectedValue(new Error('Some error'));

    const { result } = renderHook(() => useCreateWorktree(defaultParams));

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
