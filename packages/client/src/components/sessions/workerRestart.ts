/**
 * Pure logic for worker restart state machine.
 *
 * Extracted from SessionPage to enable direct unit testing without React component rendering.
 * The component wraps this function with setState calls and dependency injection.
 */
import type { Session, Worker } from '@agent-console/shared';

/**
 * Page state types relevant to the restart flow.
 * Uses a discriminated union matching SessionPage's PageState.
 */
export type RestartablePageState =
  | { type: 'active'; session: Session }
  | { type: 'disconnected'; session: Session };

/**
 * Result of attempting to execute a worker restart.
 */
export type WorkerRestartResult =
  | { outcome: 'skipped' }
  | { outcome: 'no_agent_worker'; errorTitle: string; errorMessage: string }
  | { outcome: 'success'; newState: { type: 'active'; session: Session } | { type: 'disconnected'; session: Session } }
  | { outcome: 'session_gone'; newState: { type: 'not_found' } }
  | { outcome: 'error'; errorTitle: string; errorMessage: string; fallbackState: { type: 'disconnected'; session: Session } };

/**
 * Dependencies injected into the restart logic.
 */
export interface WorkerRestartDeps {
  restartAgentWorker: (sessionId: string, workerId: string, continueConversation: boolean) => Promise<{ worker: Worker }>;
  getSession: (sessionId: string) => Promise<Session | null>;
}

/**
 * Extract the session from a page state if it is restartable (active or disconnected).
 * Returns null for non-restartable states (loading, not_found, etc.).
 */
export function extractRestartableSession(
  stateType: string,
  session: Session | undefined
): Session | null {
  if ((stateType === 'active' || stateType === 'disconnected') && session) {
    return session;
  }
  return null;
}

/**
 * Find the first agent worker in a session's worker list.
 */
export function findAgentWorker(workers: Worker[]): Worker | undefined {
  return workers.find(w => w.type === 'agent');
}

/**
 * Execute the worker restart flow and return the result.
 *
 * This is a pure async function (no React dependencies) that encodes the restart
 * state machine. The caller (SessionPage) maps the result to setState calls.
 */
export async function executeWorkerRestart(params: {
  session: Session;
  sessionId: string;
  continueConversation: boolean;
  deps: WorkerRestartDeps;
  updateTabsFromSession: (workers: Worker[]) => void;
}): Promise<WorkerRestartResult> {
  const { session, sessionId, continueConversation, deps, updateTabsFromSession } = params;

  const agentWorker = findAgentWorker(session.workers);
  if (!agentWorker) {
    return {
      outcome: 'no_agent_worker',
      errorTitle: 'Restart Failed',
      errorMessage: 'No agent worker found in session',
    };
  }

  try {
    await deps.restartAgentWorker(sessionId, agentWorker.id, continueConversation);

    const updatedSession = await deps.getSession(sessionId);
    if (!updatedSession) {
      return { outcome: 'session_gone', newState: { type: 'not_found' } };
    }

    if (updatedSession.status === 'active') {
      updateTabsFromSession(updatedSession.workers);
      return { outcome: 'success', newState: { type: 'active', session: updatedSession } };
    }
    return { outcome: 'success', newState: { type: 'disconnected', session: updatedSession } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to restart session';
    return {
      outcome: 'error',
      errorTitle: 'Restart Failed',
      errorMessage,
      fallbackState: { type: 'disconnected', session },
    };
  }
}
