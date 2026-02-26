/**
 * Session lifecycle callback types.
 *
 * Extracted to a separate file to avoid circular dependency
 * between session-manager.ts and worker-lifecycle-manager.ts.
 */

import type { Session } from '@agent-console/shared';

export interface SessionLifecycleCallbacks {
  onSessionCreated?: (session: Session) => void;
  onSessionUpdated?: (session: Session) => void;
  onSessionDeleted?: (sessionId: string) => void;
  onWorkerActivated?: (sessionId: string, workerId: string) => void;
  onWorkerRestarted?: (sessionId: string, workerId: string) => void;
  onSessionPaused?: (sessionId: string, pausedAt: string) => void;
  onSessionResumed?: (session: Session) => void;
  onDiffBaseCommitChanged?: (sessionId: string, workerId: string, newBaseCommit: string) => void;
}
