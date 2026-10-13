import { useAuth } from '../../lib/auth';

interface CreatorBadgeProps {
  /** Stable user UUID of the session's owner (`Session.createdBy`). */
  createdBy?: string;
  /** OS username of the owner (`Session.createdByUsername`); null for legacy sessions. */
  createdByUsername?: string | null;
  /**
   * Positioning classes of the call site (e.g. the sidebar pins the badge to the
   * row's corner). Prepended to the badge's own classes; omit for an inline badge.
   */
  positionClassName?: string;
}

/**
 * Whether the owner badge renders for a session with this owner username:
 * multi-user AND an owner username present. Exposed so a call site that lays out
 * around the badge (the sidebar reserves room for it) reads the SAME gate as
 * the badge itself instead of restating it.
 */
export function useCreatorBadgeVisible(createdByUsername: string | null | undefined): boolean {
  const { isMultiUser } = useAuth();
  return isMultiUser && Boolean(createdByUsername);
}

/**
 * The session owner badge, in multi-user mode only. Single writer of the rule
 * every list uses:
 * - shown iff multi-user AND the session has an owner username (single-user and
 *   legacy ownerless sessions render nothing);
 * - coloured by `currentUser.id === createdBy` (indigo = mine, amber = someone
 *   else's), matched by the stable user UUID, never the username string, so
 *   users can scan a list and spot their own sessions at a glance.
 */
export function CreatorBadge({ createdBy, createdByUsername, positionClassName }: CreatorBadgeProps) {
  const { currentUser } = useAuth();
  const visible = useCreatorBadgeVisible(createdByUsername);
  if (!visible || !createdByUsername) return null;

  const isSelfSession = currentUser !== null && createdBy !== undefined && currentUser.id === createdBy;
  const colorClass = isSelfSession ? 'bg-indigo-500/20 text-indigo-200' : 'bg-amber-500/20 text-amber-200';

  return (
    <span
      data-testid="session-creator-username"
      className={`${positionClassName ? `${positionClassName} ` : ''}max-w-[6rem] truncate text-[10px] font-mono px-1.5 py-0.5 rounded ${colorClass}`}
      title={createdByUsername}
    >
      {createdByUsername}
    </span>
  );
}
