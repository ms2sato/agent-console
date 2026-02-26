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
 * - Excludes paused sessions (they are handled separately in the dashboard)
 * - Includes running sessions with known activity state
 * - Includes phantom sessions (hibernated, not paused) with 'unknown' activity state
 * - Sorted by priority: asking > idle > active, then hibernated at the end
 */
export function useActiveSessionsWithActivity(
  sessions: Session[],
  workerActivityStates: Record<string, Record<string, AgentActivityState>>
): SessionWithActivity[] {
  return useMemo(() => {
    const sessionsWithActivity: SessionWithActivity[] = [];

    for (const session of sessions) {
      // Exclude paused sessions (they're handled separately in the dashboard)
      if (session.paused) continue;

      const activityState = getSessionActivityState(session, workerActivityStates);

      // Include sessions with known activity state OR phantom (hibernated) sessions.
      // Note: getSessionActivityState already returns 'unknown' for hibernated sessions,
      // so the condition below correctly includes them.
      if (activityState !== 'unknown' || session.activationState === 'hibernated') {
        sessionsWithActivity.push({ session, activityState });
      }
    }

    // Sort: running sessions first (by priority), then hibernated at the end
    sessionsWithActivity.sort((a, b) => {
      const aHibernated = a.session.activationState === 'hibernated' ? 1 : 0;
      const bHibernated = b.session.activationState === 'hibernated' ? 1 : 0;
      if (aHibernated !== bHibernated) return aHibernated - bHibernated;
      return activityPriority[a.activityState] - activityPriority[b.activityState];
    });

    return sessionsWithActivity;
  }, [sessions, workerActivityStates]);
}
