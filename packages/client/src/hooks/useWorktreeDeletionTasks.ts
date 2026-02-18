import { useState, useCallback } from 'react';
import type {
  WorktreeDeletionTask,
  WorktreeDeletionCompletedPayload,
  WorktreeDeletionFailedPayload,
} from '@agent-console/shared';

export interface UseWorktreeDeletionTasksReturn {
  /** Current list of deletion tasks */
  tasks: WorktreeDeletionTask[];
  /** Add a new task when deletion is initiated */
  addTask: (params: {
    id: string;
    sessionId: string;
    sessionTitle: string;
    repositoryId: string;
    worktreePath: string;
  }) => void;
  /** Remove a task (used after completion or manual dismiss) */
  removeTask: (taskId: string) => void;
  /** Get a task by ID */
  getTask: (taskId: string) => WorktreeDeletionTask | undefined;
  /** Mark a task as failed (for immediate API errors) */
  markAsFailed: (taskId: string, error: string) => void;
  /** Handle WebSocket completion event */
  handleWorktreeDeletionCompleted: (payload: WorktreeDeletionCompletedPayload) => void;
  /** Handle WebSocket failure event */
  handleWorktreeDeletionFailed: (payload: WorktreeDeletionFailedPayload) => void;
}

/**
 * Hook to manage worktree deletion tasks on the client side.
 * Tasks are stored in local state and updated via WebSocket events.
 *
 * Usage:
 * 1. Call `addTask()` when delete is initiated with a client-generated taskId
 * 2. Listen to WebSocket events and call `handleWorktreeDeletionCompleted/Failed`
 * 3. On completion: task is marked as completed, user clicks to dismiss
 * 4. On failure: task status is updated to 'failed' with error message
 *
 * Note: Tasks are lost on page refresh (client-side only).
 * Only worktree sessions use this async deletion flow.
 */
export function useWorktreeDeletionTasks(): UseWorktreeDeletionTasksReturn {
  const [tasks, setTasks] = useState<WorktreeDeletionTask[]>([]);

  const addTask = useCallback(
    (params: {
      id: string;
      sessionId: string;
      sessionTitle: string;
      repositoryId: string;
      worktreePath: string;
    }) => {
      const newTask: WorktreeDeletionTask = {
        id: params.id,
        sessionId: params.sessionId,
        sessionTitle: params.sessionTitle,
        repositoryId: params.repositoryId,
        worktreePath: params.worktreePath,
        status: 'deleting',
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

  const markAsFailed = useCallback((taskId: string, error: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? { ...t, status: 'failed' as const, error }
          : t
      )
    );
  }, []);

  const handleWorktreeDeletionCompleted = useCallback(
    (payload: WorktreeDeletionCompletedPayload) => {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === payload.taskId
            ? { ...t, status: 'completed' as const, cleanupCommandResult: payload.cleanupCommandResult }
            : t
        )
      );
    },
    []
  );

  const handleWorktreeDeletionFailed = useCallback(
    (payload: WorktreeDeletionFailedPayload) => {
      // Update task status to failed
      setTasks((prev) =>
        prev.map((t) =>
          t.id === payload.taskId
            ? {
                ...t,
                status: 'failed' as const,
                error: payload.error,
                gitStatus: payload.gitStatus,
              }
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
    markAsFailed,
    handleWorktreeDeletionCompleted,
    handleWorktreeDeletionFailed,
  };
}
