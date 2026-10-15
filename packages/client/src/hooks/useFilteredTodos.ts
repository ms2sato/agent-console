import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchTodos, type FetchTodosFilter } from '../lib/api';
import { todoKeys } from '../lib/query-keys';
import { useAppWsEvent } from './useAppWs';

/**
 * Fetch to-do items under a server-side filter and keep them fresh.
 *
 * Realtime refresh: every `todos-updated` frame (any session, including a
 * null one) and every `session-deleted` frame invalidates ALL filtered lists.
 * The server emits no `todos-updated` when a session deletion withdraws its
 * items, so `session-deleted` is the signal for that case. Both frames are
 * trigger-only (N1): this hook never patches the cache from a frame, it only
 * invalidates and renders what the refetched REST response returns.
 */
export function useFilteredTodos(filters: FetchTodosFilter, options: { enabled?: boolean } = {}) {
  const queryClient = useQueryClient();

  useAppWsEvent({
    onTodosUpdated: () => {
      queryClient.invalidateQueries({ queryKey: todoKeys.listRoot() });
    },
    onSessionDeleted: () => {
      queryClient.invalidateQueries({ queryKey: todoKeys.listRoot() });
    },
  });

  return useQuery({
    queryKey: todoKeys.list(filters),
    queryFn: () => fetchTodos(filters),
    enabled: options.enabled ?? true,
  });
}
