import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppWsState } from './useAppWs';
import { listReconnectInvalidationKeys } from '../lib/reconnect-invalidation';

/**
 * Refetches every frame-driven query family after an app-WebSocket reconnect.
 *
 * Trigger-only frames (`todos-updated`, `artifact-*`, `bookmark-*`,
 * `review-queue-updated`, `memo-updated`) are sent only to clients connected at
 * that moment and are never replayed, and the server's reconnect sync covers
 * sessions, agents and repositories only. A frame lost during a disconnect
 * therefore leaves its family stale. On a `connected` false -> true transition
 * that is NOT the page's first connection, this invalidates the root of every
 * family registered through `useAppWsEvent`'s `invalidateOnReconnect`: mounted
 * queries refetch now, unmounted ones are marked stale and refetch on remount.
 * The first connection invalidates nothing (mounting already fetches).
 *
 * React Query's own `refetchOnReconnect` follows `onlineManager` (the browser's
 * `online` event), not this socket, so it does not cover a server restart while
 * the browser stays online. Mounted once, in the root layout.
 */
export function useReconnectInvalidation(): void {
  const queryClient = useQueryClient();
  const connected = useAppWsState((s) => s.connected);
  const hasEverConnected = useAppWsState((s) => s.hasEverConnected);
  const wasConnectedRef = useRef(connected);
  // Whether this page has already seen an open socket before the current one.
  const seenConnectedRef = useRef(connected || hasEverConnected);

  useEffect(() => {
    if (connected) {
      if (!wasConnectedRef.current && seenConnectedRef.current) {
        for (const queryKey of listReconnectInvalidationKeys()) {
          queryClient.invalidateQueries({ queryKey });
        }
      }
      seenConnectedRef.current = true;
    }
    wasConnectedRef.current = connected;
  }, [connected, queryClient]);
}
