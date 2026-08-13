import type { AgentActivityState } from '@agent-console/shared';
import type { SessionWithActivity } from '../../hooks/useActiveSessionsWithActivity';

/**
 * repositoryId values are UUIDs (see packages/shared/src/types/repository.ts),
 * so this literal sentinel can never collide with a real repository group key.
 */
export const QUICK_SESSIONS_GROUP_KEY = 'quick';
export const QUICK_SESSIONS_GROUP_LABEL = 'Quick sessions';

export interface SessionGroup {
  /** repositoryId for worktree groups, QUICK_SESSIONS_GROUP_KEY for the quick group */
  key: string;
  /** repositoryName for worktree groups, QUICK_SESSIONS_GROUP_LABEL for the quick group */
  label: string;
  sessions: SessionWithActivity[];
}

/**
 * Groups sessions by repository (mode 1 of the grouping-mode frame; see
 * the sidebar grouping design discussion for the other modes). Pure
 * function: sessions in, ordered groups out. Callers are
 * responsible for filtering the input first (mine/shared filter) — this
 * function never produces a group for a repository that has zero sessions
 * in its input, so filter-then-group composition never leaves an empty
 * header behind.
 *
 * Ordering: repository groups sorted by label (localeCompare), quick group
 * always last. Within a group, the relative order of the incoming
 * `sessions` array is preserved (partition, not re-sort).
 *
 * Group key is always `repositoryId` (rename-stable); label is
 * `repositoryName`. If sessions sharing a `repositoryId` disagree on
 * `repositoryName` (stale data), the first occurrence's name wins.
 */
export function groupSessionsByRepository(sessions: SessionWithActivity[]): SessionGroup[] {
  const groupsByKey = new Map<string, SessionGroup>();

  for (const item of sessions) {
    const { session } = item;
    const key = session.type === 'worktree' ? session.repositoryId : QUICK_SESSIONS_GROUP_KEY;

    let group = groupsByKey.get(key);
    if (!group) {
      const label = session.type === 'worktree' ? session.repositoryName : QUICK_SESSIONS_GROUP_LABEL;
      group = { key, label, sessions: [] };
      groupsByKey.set(key, group);
    }
    group.sessions.push(item);
  }

  const repoGroups: SessionGroup[] = [];
  let quickGroup: SessionGroup | undefined;

  for (const group of groupsByKey.values()) {
    if (group.key === QUICK_SESSIONS_GROUP_KEY) {
      quickGroup = group;
    } else {
      repoGroups.push(group);
    }
  }

  repoGroups.sort((a, b) => a.label.localeCompare(b.label));

  return quickGroup ? [...repoGroups, quickGroup] : repoGroups;
}

const ATTENTION_PRIORITY: Partial<Record<AgentActivityState, number>> = {
  asking: 0,
  active: 1,
};

/**
 * Returns the highest-priority non-idle activity state present in a group,
 * or null when every session in the group is idle. Used to surface a
 * minimal aggregate indicator on a collapsed group header (M5) — without
 * it, a session waiting on input becomes invisible behind a header.
 */
export function getGroupAggregateActivityState(
  sessions: SessionWithActivity[]
): AgentActivityState | null {
  let best: AgentActivityState | null = null;
  let bestPriority = Infinity;

  for (const { activityState } of sessions) {
    const priority = ATTENTION_PRIORITY[activityState];
    if (priority === undefined) continue; // idle (or any future non-attention state)
    if (priority < bestPriority) {
      best = activityState;
      bestPriority = priority;
    }
  }

  return best;
}
