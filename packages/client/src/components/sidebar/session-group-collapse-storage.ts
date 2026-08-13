const GROUP_COLLAPSED_KEY_PREFIX = 'agent-console:sidebar-group-collapsed:';

/**
 * Per-group collapsed state, persisted following useSidebarState's exact
 * pattern (agent-console:-prefixed key, try/catch around every localStorage
 * access, default expanded). One localStorage key per group (keyed by M1's
 * group key — repositoryId or the quick-sessions sentinel). Stale keys from
 * deleted repositories may accumulate; this is an accepted trade-off (see
 * the sidebar grouping acceptance criteria) — no pruning is implemented.
 */
export function getPersistedGroupCollapsed(groupKey: string): boolean {
  try {
    const stored = localStorage.getItem(`${GROUP_COLLAPSED_KEY_PREFIX}${groupKey}`);
    return stored ? (JSON.parse(stored) as boolean) === true : false;
  } catch {
    return false;
  }
}

export function persistGroupCollapsed(groupKey: string, collapsed: boolean): void {
  try {
    localStorage.setItem(`${GROUP_COLLAPSED_KEY_PREFIX}${groupKey}`, JSON.stringify(collapsed));
  } catch {
    // Ignore localStorage errors
  }
}
