import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, fetchTodoDetail } from '../lib/api';
import { todoKeys } from '../lib/query-keys';
import { useAppWsEvent } from './useAppWs';

/**
 * Resolve a single Todo item and its activity timeline (`{ todo, activities }`,
 * the timeline already in the server's order) for its detail view (page or in-session dialog).
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
    queryFn: () => fetchTodoDetail(id),
    retry: false,
  });
}

/** True when the detail query failed because the item no longer exists (deleted, or never did). */
export function isTodoGone(error: Error | null): boolean {
  return error instanceof ApiError && error.status === 404;
}
