import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchTodo } from '../lib/api';
import { todoKeys } from '../lib/query-keys';
import { useAppWsEvent } from './useAppWs';

/**
 * Resolve a single Todo item for its detail view (page or in-session dialog).
 *
 * Realtime refresh: the `todos-updated` frame is trigger-only and names at most
 * a session. This hook invalidates the detail for EVERY frame, whichever
 * session (or none) it names: a re-scope moves an item between sessions, so a
 * frame naming the item's OLD session is still about this item.
 *
 * A deleted item surfaces as `error` (the server answers 404); callers render
 * that as an expected state, not as a failure.
 */
export function useTodoDetail(id: string) {
  const queryClient = useQueryClient();

  useAppWsEvent({
    onTodosUpdated: () => {
      queryClient.invalidateQueries({ queryKey: todoKeys.detail(id), exact: true });
    },
  });

  return useQuery({
    queryKey: todoKeys.detail(id),
    queryFn: () => fetchTodo(id),
    retry: false,
  });
}
