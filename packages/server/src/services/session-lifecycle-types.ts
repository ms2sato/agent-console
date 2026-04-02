/**
 * Session lifecycle callback types.
 *
 * Extracted to a separate file to avoid circular dependency
 * between session-manager.ts and worker-lifecycle-manager.ts.
 */

import type { Session, PausedSession, RunningSession, WorkerActivityInfo, AgentActivityState } from '@agent-console/shared';

export interface SessionLifecycleCallbacks {
  onSessionCreated?: (session: Session) => void;
  onSessionUpdated?: (session: Session) => void;
  onSessionDeleted?: (sessionId: string) => void;
  onWorkerActivated?: (sessionId: string, workerId: string) => void;
  onWorkerRestarted?: (sessionId: string, workerId: string, activityState: AgentActivityState) => void;
  onSessionPaused?: (session: PausedSession) => void;
  onSessionResumed?: (session: RunningSession, activityStates: WorkerActivityInfo[]) => void;
  onDiffBaseCommitChanged?: (sessionId: string, workerId: string, newBaseCommit: string) => void;
  onMemoUpdated?: (sessionId: string, content: string) => void;
}
