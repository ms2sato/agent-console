import { useState, useCallback } from 'react';
import type {
  WorktreeCreationTask,
  WorktreeCreationCompletedPayload,
  WorktreeCreationFailedPayload,
  CreateWorktreeRequest,
} from '@agent-console/shared';

export interface UseWorktreeCreationTasksReturn {
  /** Current list of creation tasks */
  tasks: WorktreeCreationTask[];
  /** Add a new task when form is submitted */
  addTask: (params: {
    id: string;
    repositoryId: string;
    repositoryName: string;
    request: CreateWorktreeRequest;
  }) => void;
  /** Remove a task (used after completion or manual dismiss) */
  removeTask: (taskId: string) => void;
  /** Get a task by ID */
  getTask: (taskId: string) => WorktreeCreationTask | undefined;
  /** Handle WebSocket completion event */
  handleWorktreeCreationCompleted: (payload: WorktreeCreationCompletedPayload) => void;
  /** Handle WebSocket failure event */
  handleWorktreeCreationFailed: (payload: WorktreeCreationFailedPayload) => void;
}

/**
 * Hook to manage worktree creation tasks on the client side.
 * Tasks are stored in local state and updated via WebSocket events.
 *
 * Usage:
 * 1. Call `addTask()` when form is submitted with a client-generated taskId
 * 2. Listen to WebSocket events and call `handleWorktreeCreationCompleted/Failed`
 * 3. On completion: task is removed and session is shown
 * 4. On failure: task status is updated to 'failed' with error message
 *
 * Note: Tasks are lost on page refresh (client-side only).
 */
export function useWorktreeCreationTasks(): UseWorktreeCreationTasksReturn {
  const [tasks, setTasks] = useState<WorktreeCreationTask[]>([]);

  const addTask = useCallback(
    (params: {
      id: string;
      repositoryId: string;
      repositoryName: string;
      request: CreateWorktreeRequest;
    }) => {
      const newTask: WorktreeCreationTask = {
        id: params.id,
        repositoryId: params.repositoryId,
        repositoryName: params.repositoryName,
        status: 'creating',
        request: params.request,
        createdAt: new Date().toISOString(),
      };
      setTasks((prev) => [...prev, newTask]);
    },
    []
  );

  const removeTask = useCallback((taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  }, []);

  const getTask = useCallback(
    (taskId: string) => {
      return tasks.find((t) => t.id === taskId);
    },
    [tasks]
  );

  const handleWorktreeCreationCompleted = useCallback(
    (payload: WorktreeCreationCompletedPayload) => {
      // Update task to completed status with session info (keep in sidebar with "New" badge)
      setTasks((prev) =>
        prev.map((t) =>
          t.id === payload.taskId
            ? {
                ...t,
                status: 'completed' as const,
                sessionId: payload.session?.id,
                sessionTitle: payload.session?.title,
              }
            : t
        )
      );
    },
    []
  );

  const handleWorktreeCreationFailed = useCallback(
    (payload: WorktreeCreationFailedPayload) => {
      // Update task status to failed
      setTasks((prev) =>
        prev.map((t) =>
          t.id === payload.taskId
            ? { ...t, status: 'failed' as const, error: payload.error }
            : t
        )
      );
    },
    []
  );

  return {
    tasks,
    addTask,
    removeTask,
    getTask,
    handleWorktreeCreationCompleted,
    handleWorktreeCreationFailed,
  };
}
