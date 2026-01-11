import { useMemo } from 'react';
import type { Session, AgentActivityState } from '@agent-console/shared';

const activityPriority: Record<AgentActivityState, number> = {
  asking: 0,   // Highest - needs user attention
  idle: 1,     // Medium
  active: 2,   // Lowest - working autonomously
  unknown: 3,  // Not shown in sidebar
};

export interface SessionWithActivity {
  session: Session;
  activityState: AgentActivityState;
}

/**
 * Get the highest priority activity state for a session.
 * A session's aggregated state is the highest priority state among all its workers.
 * Returns 'unknown' for hibernated sessions (no PTY workers running).
 */
function getSessionActivityState(
  session: Session,
  workerActivityStates: Record<string, Record<string, AgentActivityState>>
): AgentActivityState {
  // Hibernated sessions have no running workers, so return 'unknown'
  if (session.activationState === 'hibernated') {
    return 'unknown';
  }

  const workerStates = workerActivityStates[session.id];
  if (!workerStates) return 'unknown';

  const states = Object.values(workerStates);
  if (states.length === 0) return 'unknown';

  // Return the state with highest priority (lowest number)
  return states.reduce((best, current) => {
    return activityPriority[current] < activityPriority[best] ? current : best;
  }, 'unknown' as AgentActivityState);
}

/**
 * Hook that returns sessions filtered and sorted by activity state.
 * - Only includes running sessions (excludes hibernated sessions)
 * - Only includes sessions with activity state != 'unknown'
 * - Sorted by priority: asking > idle > active
 */
export function useActiveSessionsWithActivity(
  sessions: Session[],
  workerActivityStates: Record<string, Record<string, AgentActivityState>>
): SessionWithActivity[] {
  return useMemo(() => {
    const sessionsWithActivity: SessionWithActivity[] = [];

    // Filter to only running sessions (exclude hibernated)
    const runningSessions = sessions.filter(s => s.activationState === 'running');

    for (const session of runningSessions) {
      const activityState = getSessionActivityState(session, workerActivityStates);
      // Only include sessions with known activity state
      if (activityState !== 'unknown') {
        sessionsWithActivity.push({ session, activityState });
      }
    }

    // Sort by activity priority (asking first, then idle, then active)
    sessionsWithActivity.sort(
      (a, b) => activityPriority[a.activityState] - activityPriority[b.activityState]
    );

    return sessionsWithActivity;
  }, [sessions, workerActivityStates]);
}
