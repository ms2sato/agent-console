import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchNotifications, markNotificationsSeen } from '../../lib/api';
import { notificationCenterKeys } from '../../lib/query-keys';
import { useAppWsEvent, useAppWsState } from '../../hooks/useAppWs';
import { BellIcon } from '../Icons';
import { NotificationPanel } from './NotificationPanel';
import { logger } from '../../lib/logger';

/**
 * Bell + badge + anchored panel for the notification center
 * (docs/design/notification-center.md). Ruling summary:
 *
 * - Ruling 2: the badge renders ONLY the latest `GET` response's
 *   `unreadCount` -- no optimistic zero, no client-side unread math.
 *   Opening the panel fetches fresh, then (if any items exist) advances the
 *   cursor via `PUT /seen` with the newest fetched item's `occurredAt`, then
 *   invalidates so the badge reflects the server's post-advance count.
 * - Ruling 3 (N1): WebSocket broadcasts for the covered kinds are
 *   invalidation hints ONLY -- the handlers below never bind the payload to
 *   a variable, let alone render it.
 */
export function NotificationBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: notificationCenterKeys.feed(),
    queryFn: fetchNotifications,
  });

  const seenMutation = useMutation({
    mutationFn: markNotificationsSeen,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationCenterKeys.root() });
    },
    onError: (err) => {
      logger.warn('[NotificationBell] Failed to mark notifications as seen:', err);
    },
  });

  // Ruling 3 / N1: broadcast payloads are discarded entirely -- the
  // callbacks below take no parameter, so the payload is structurally
  // unreachable, not merely unused by convention.
  useAppWsEvent({
    onWorktreeDeletionCompleted: () => {
      queryClient.invalidateQueries({ queryKey: notificationCenterKeys.root() });
    },
    onWorktreeDeletionFailed: () => {
      queryClient.invalidateQueries({ queryKey: notificationCenterKeys.root() });
    },
  });

  // v1 refetch trigger: app-WS reconnect (false -> true transition only,
  // not the initial mount -- initial mount already gets a normal fetch).
  const connected = useAppWsState((s) => s.connected);
  const wasConnectedRef = useRef(connected);
  useEffect(() => {
    if (!wasConnectedRef.current && connected) {
      queryClient.invalidateQueries({ queryKey: notificationCenterKeys.root() });
    }
    wasConnectedRef.current = connected;
  }, [connected, queryClient]);

  // Close on outside click / Escape, mirroring MobileNavMenu's pattern.
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  const openAndMarkSeen = async () => {
    const result = await refetch();
    // TanStack Query v5 retains the previous successful `data` on a failed
    // refetch (it does not become undefined) and sets `isError: true`. Bail
    // out here, before reading `result.data` -- otherwise a failed refetch
    // would advance the cursor using stale/cached items that were never
    // freshly confirmed by the very fetch that was supposed to confirm them.
    if (result.isError) return;
    const items = result.data?.items ?? [];
    if (items.length === 0) return; // Nothing to mark seen; cursor stays put.
    // Server contract: items are newest-first, so items[0] is the newest.
    seenMutation.mutate(items[0].occurredAt);
  };

  const handleTriggerClick = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      void openAndMarkSeen();
    }
  };

  // Badge keeps the last known server-computed unreadCount on a failed
  // refetch (TanStack Query's default stale-data-on-error behavior) -- there
  // is no dedicated error-badge state, and this must not zero the badge.
  const unreadCount = data?.unreadCount ?? 0;
  const items = data?.items ?? [];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleTriggerClick}
        className="relative text-slate-400 hover:text-white p-1 rounded hover:bg-white/10 transition-colors"
        aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={panelId}
      >
        <BellIcon className="w-4 h-4" />
        {unreadCount > 0 && (
          <span
            className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-slate-900 text-[10px] font-medium leading-4 text-center"
            aria-hidden="true"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" aria-hidden="true" onClick={() => setOpen(false)} />
          <NotificationPanel
            id={panelId}
            items={items}
            isLoading={isLoading}
            isError={isError}
            onRetry={() => refetch()}
            onNavigate={() => setOpen(false)}
          />
        </>
      )}
    </div>
  );
}
