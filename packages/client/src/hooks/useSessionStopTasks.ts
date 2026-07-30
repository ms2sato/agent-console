import { useState, useRef, useCallback } from 'react';

export type SessionStopTaskAction = 'stop' | 'pause';

export interface SessionStopTask {
  sessionId: string;
  action: SessionStopTaskAction;
  sessionTitle?: string;
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
}

/**
 * Hook to manage in-flight Stop/Pause session tasks on the client side.
 *
 * This scopes the pending/error UI for Stop and Pause to the affected session
 * (dashboard row + session page banner) instead of freezing the whole app
 * behind a modal for the server round-trip. Mirrors `useWorktreeDeletionTasks`'s
 * shape/lifecycle.
 *
 * Task removal is event-driven off server truth (see `useSessionSideEffects`):
 * a `stop` task is removed when its session disappears from the sessions sync
 * (or an explicit `session-deleted` event arrives); a `pause` task is removed
 * when its session's status becomes `'inactive'`.
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
      if (tasksRef.current.some((t) => t.sessionId === params.sessionId)) {
        return false;
      }
      const newTask: SessionStopTask = {
        sessionId: params.sessionId,
        action: params.action,
        sessionTitle: params.sessionTitle,
        error: null,
      };
      tasksRef.current = [...tasksRef.current, newTask];
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

  const markAsFailed = useCallback((sessionId: string, error: string) => {
    tasksRef.current = tasksRef.current.map((t) =>
      t.sessionId === sessionId ? { ...t, error } : t
    );
    setTasks(tasksRef.current);
  }, []);

  return {
    tasks,
    addTask,
    removeTask,
    getTask,
    markAsFailed,
  };
}
