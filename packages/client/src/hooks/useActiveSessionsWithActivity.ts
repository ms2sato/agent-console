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
 */
function getSessionActivityState(
  sessionId: string,
  workerActivityStates: Record<string, Record<string, AgentActivityState>>
): AgentActivityState {
  const workerStates = workerActivityStates[sessionId];
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
 * - Only includes sessions with activity state != 'unknown'
 * - Sorted by priority: asking > idle > active
 */
export function useActiveSessionsWithActivity(
  sessions: Session[],
  workerActivityStates: Record<string, Record<string, AgentActivityState>>
): SessionWithActivity[] {
  return useMemo(() => {
    const sessionsWithActivity: SessionWithActivity[] = [];

    for (const session of sessions) {
      const activityState = getSessionActivityState(session.id, workerActivityStates);
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
