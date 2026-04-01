import { useState, useCallback } from 'react';
import { createWorktreeAsync } from '../lib/api';
import { generateTaskId } from '../lib/id';
import { useWorktreeCreationTasksContext } from '../routes/__root';
import type { CreateWorktreeFormRequest } from '../components/worktrees/CreateWorktreeForm';

interface UseCreateWorktreeParams {
  repositoryId: string;
  repositoryName: string;
}

interface UseCreateWorktreeReturn {
  handleCreateWorktree: (formRequest: CreateWorktreeFormRequest) => Promise<void>;
  error: string | null;
  clearError: () => void;
}

export function useCreateWorktree({ repositoryId, repositoryName }: UseCreateWorktreeParams): UseCreateWorktreeReturn {
  const { addTask, removeTask } = useWorktreeCreationTasksContext();
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const handleCreateWorktree = useCallback(async (formRequest: CreateWorktreeFormRequest) => {
    const taskId = generateTaskId();
    const request = { ...formRequest, taskId };

    try {
      // Add task to UI immediately
      addTask({
        id: taskId,
        repositoryId,
        repositoryName,
        request,
      });

      // Call async API (returns { accepted: true })
      await createWorktreeAsync(repositoryId, request);
    } catch (err) {
      // If API call fails immediately (e.g., network error), remove the task and report error
      removeTask(taskId);
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    }
  }, [repositoryId, repositoryName, addTask, removeTask]);

  return { handleCreateWorktree, error, clearError };
}
