import { compareByActivityPriority, type SessionWithActivity } from '../../hooks/useActiveSessionsWithActivity';

export interface SessionTreeNode {
  item: SessionWithActivity;
  children: SessionTreeNode[];
  /**
   * True for a root that declares a parent which is not a usable parent in the
   * given list (absent from it, or part of a parent cycle). Such a session is
   * shown at the root, never hidden.
   */
  orphan: boolean;
}

function compareChildren(a: SessionWithActivity, b: SessionWithActivity): number {
  return (
    compareByActivityPriority(a, b) ||
    (a.session.title ?? '').localeCompare(b.session.title ?? '') ||
    a.session.id.localeCompare(b.session.id)
  );
}

/**
 * Build the parent/child forest of the given active sessions.
 *
 * - Roots: sessions with no `parentSessionId`, or whose parent is not in the list
 *   (flagged `orphan`). Roots keep the flat activity ordering.
 * - Children are ordered by activity priority, then title, then id.
 * - A parent cycle cannot come from the server; its members all become orphan roots.
 */
export function buildSessionTree(sessions: SessionWithActivity[]): SessionTreeNode[] {
  const byId = new Map<string, SessionWithActivity>();
  for (const item of sessions) byId.set(item.session.id, item);

  const parentOf = (item: SessionWithActivity): string | undefined => {
    const parentId = item.session.parentSessionId;
    return parentId !== undefined && byId.has(parentId) ? parentId : undefined;
  };

  // A session is in a cycle when walking up its parent chain returns to itself.
  // The visited set bounds the walk, so a tail hanging off a cycle terminates.
  const isInCycle = (item: SessionWithActivity): boolean => {
    const visited = new Set<string>();
    let current = parentOf(item);
    while (current !== undefined && !visited.has(current)) {
      if (current === item.session.id) return true;
      visited.add(current);
      current = parentOf(byId.get(current)!);
    }
    return false;
  };

  const childrenByParent = new Map<string, SessionWithActivity[]>();
  const roots: Array<{ item: SessionWithActivity; orphan: boolean }> = [];
  for (const item of sessions) {
    const parentId = parentOf(item);
    if (parentId === undefined || isInCycle(item)) {
      roots.push({ item, orphan: item.session.parentSessionId !== undefined });
    } else {
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(item);
      childrenByParent.set(parentId, siblings);
    }
  }

  const buildNode = (item: SessionWithActivity, orphan: boolean): SessionTreeNode => ({
    item,
    orphan,
    children: [...(childrenByParent.get(item.session.id) ?? [])]
      .sort(compareChildren)
      .map((child) => buildNode(child, false)),
  });

  return [...roots]
    .sort((a, b) => compareByActivityPriority(a.item, b.item))
    .map(({ item, orphan }) => buildNode(item, orphan));
}
