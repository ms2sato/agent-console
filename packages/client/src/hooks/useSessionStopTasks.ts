import { useState, useRef, useCallback } from 'react';

export type SessionStopTaskAction = 'stop' | 'pause';

export type SessionStopTaskStatus = 'pending' | 'succeeded' | 'failed';

export interface SessionStopTask {
  sessionId: string;
  action: SessionStopTaskAction;
  sessionTitle?: string;
  status: SessionStopTaskStatus;
  error: string | null;
}

export interface UseSessionStopTasksReturn {
  /** Current list of in-flight stop/pause tasks */
  tasks: SessionStopTask[];
  /**
   * Add a new task when a stop/pause request is initiated.
   * Returns `false` (structural no-op, no task created) if a task for this
   * `sessionId` already exists -- at most one task per session.
   */
  addTask: (params: { sessionId: string; action: SessionStopTaskAction; sessionTitle?: string }) => boolean;
  /** Remove a task (used when the server confirms completion, or on manual dismiss) */
  removeTask: (sessionId: string) => void;
  /** Get the task for a given session, if any */
  getTask: (sessionId: string) => SessionStopTask | undefined;
  /** Mark a task as failed (for immediate API errors) */
  markAsFailed: (sessionId: string, error: string) => void;
  /** Mark a task as succeeded (server confirmed the stop/pause); clears any error */
  markAsSucceeded: (sessionId: string) => void;
  /** Reset a task to pending (used when retrying a failed request); clears the error */
  markAsPending: (sessionId: string) => void;
}

/**
 * Hook to manage in-flight Stop/Pause session tasks on the client side.
 *
 * This scopes the pending/error UI for Stop and Pause to the affected session
 * (dashboard row + session page banner) instead of freezing the whole app
 * behind a modal for the server round-trip. Mirrors `useWorktreeDeletionTasks`'s
 * shape/lifecycle.
 *
 * Completion is event-driven off server truth (see `useSessionSideEffects`):
 * a `stop` task becomes `succeeded` when its session disappears from the
 * sessions sync (or an explicit `session-deleted` event arrives); a `pause`
 * task becomes `succeeded` when its session's status becomes `'inactive'`.
 * A succeeded task stays in the list until the dashboard result banner
 * dismisses it (manually or by auto-dismiss).
 *
 * Note: Tasks are lost on page refresh (client-side only).
 */
export function useSessionStopTasks(): UseSessionStopTasksReturn {
  const [tasks, setTasks] = useState<SessionStopTask[]>([]);
  // Ref mirror so `addTask`'s at-most-one-per-session check (and the resulting
  // mutation) is readable synchronously by the caller in the same tick. A plain
  // `setTasks(prev => ...)` functional updater is not reliably synchronous for
  // this purpose -- callers need `if (!addTask(...)) return;` to correctly guard
  // against a double-fire race.
  const tasksRef = useRef<SessionStopTask[]>([]);

  const addTask = useCallback(
    (params: { sessionId: string; action: SessionStopTaskAction; sessionTitle?: string }): boolean => {
      // A succeeded task is a finished result awaiting dismissal, not an
      // in-flight operation, so a new request for the same session replaces it.
      if (tasksRef.current.some((t) => t.sessionId === params.sessionId && t.status !== 'succeeded')) {
        return false;
      }
      const newTask: SessionStopTask = {
        sessionId: params.sessionId,
        action: params.action,
        sessionTitle: params.sessionTitle,
        status: 'pending',
        error: null,
      };
      tasksRef.current = [...tasksRef.current.filter((t) => t.sessionId !== params.sessionId), newTask];
      setTasks(tasksRef.current);
      return true;
    },
    []
  );

  const removeTask = useCallback((sessionId: string) => {
    tasksRef.current = tasksRef.current.filter((t) => t.sessionId !== sessionId);
    setTasks(tasksRef.current);
  }, []);

  const getTask = useCallback(
    (sessionId: string) => {
      return tasks.find((t) => t.sessionId === sessionId);
    },
    [tasks]
  );

  const updateTask = useCallback((sessionId: string, patch: Pick<SessionStopTask, 'status' | 'error'>) => {
    tasksRef.current = tasksRef.current.map((t) =>
      t.sessionId === sessionId ? { ...t, ...patch } : t
    );
    setTasks(tasksRef.current);
  }, []);

  const markAsFailed = useCallback((sessionId: string, error: string) => {
    updateTask(sessionId, { status: 'failed', error });
  }, [updateTask]);

  const markAsSucceeded = useCallback((sessionId: string) => {
    updateTask(sessionId, { status: 'succeeded', error: null });
  }, [updateTask]);

  const markAsPending = useCallback((sessionId: string) => {
    updateTask(sessionId, { status: 'pending', error: null });
  }, [updateTask]);

  return {
    tasks,
    addTask,
    removeTask,
    getTask,
    markAsFailed,
    markAsSucceeded,
    markAsPending,
  };
}
