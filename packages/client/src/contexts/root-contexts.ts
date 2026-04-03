import { createContext, useContext } from 'react';
import type { UseWorktreeCreationTasksReturn } from '../hooks/useWorktreeCreationTasks';
import type { UseWorktreeDeletionTasksReturn } from '../hooks/useWorktreeDeletionTasks';
import type { Session, AgentActivityState } from '@agent-console/shared';

/**
 * Context for session data managed by the root layout.
 * Provides the single source of truth for session list and worker activity states
 * to all child routes, avoiding duplicate WebSocket subscriptions.
 */
export interface SessionDataContextValue {
  /** All sessions (active and paused) */
  sessions: Session[];
  /** Whether the initial WebSocket sync has been received */
  wsInitialized: boolean;
  /** Worker activity states: { sessionId: { workerId: state } } */
  workerActivityStates: Record<string, Record<string, AgentActivityState>>;
}

export const SessionDataContext = createContext<SessionDataContextValue | null>(null);

/**
 * Hook to access session data from the root layout context.
 * Must be used within a route that is a child of __root.
 */
export function useSessionDataContext(): SessionDataContextValue {
  const context = useContext(SessionDataContext);
  if (!context) {
    throw new Error('useSessionDataContext must be used within SessionDataContext.Provider');
  }
  return context;
}

/**
 * Context for worktree creation tasks.
 * This allows child routes (like Dashboard) to add tasks and the sidebar to display them.
 */
export const WorktreeCreationTasksContext = createContext<UseWorktreeCreationTasksReturn | null>(null);

/**
 * Hook to access worktree creation tasks context.
 * Must be used within a route that is a child of __root.
 */
export function useWorktreeCreationTasksContext(): UseWorktreeCreationTasksReturn {
  const context = useContext(WorktreeCreationTasksContext);
  if (!context) {
    throw new Error('useWorktreeCreationTasksContext must be used within WorktreeCreationTasksContext.Provider');
  }
  return context;
}

/**
 * Context for worktree deletion tasks.
 * This allows child routes (like SessionPage) to add tasks and the sidebar to display them.
 */
export const WorktreeDeletionTasksContext = createContext<UseWorktreeDeletionTasksReturn | null>(null);

/**
 * Hook to access worktree deletion tasks context.
 * Must be used within a route that is a child of __root.
 */
export function useWorktreeDeletionTasksContext(): UseWorktreeDeletionTasksReturn {
  const context = useContext(WorktreeDeletionTasksContext);
  if (!context) {
    throw new Error('useWorktreeDeletionTasksContext must be used within WorktreeDeletionTasksContext.Provider');
  }
  return context;
}
