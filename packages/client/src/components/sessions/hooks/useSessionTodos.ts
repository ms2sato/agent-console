import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchTodos } from '../../../lib/api';
import { todoKeys } from '../../../lib/query-keys';
import { useAppWsEvent } from '../../../hooks/useAppWs';

/**
 * Resolve every to-do item whose `sessionId` is this session (both scopes,
 * every status) for the session-scoped to-do panel.
 *
 * Realtime refresh: the `todos-updated` app message is trigger-only (N1) --
 * it names at most a session, never content. This hook invalidates its own
 * scoped query key when the frame's `sessionId` equals this session, or is
 * null (a change with no single session, so any list may be affected), and
 * renders only what the refetched REST response returns. A frame for a
 * DIFFERENT session must not refetch this session's panel.
 */
export function useSessionTodos(sessionId: string) {
  const queryClient = useQueryClient();

  useAppWsEvent({
    onTodosUpdated: (msgSessionId) => {
      if (msgSessionId === null || msgSessionId === sessionId) {
        queryClient.invalidateQueries({ queryKey: todoKeys.listBySession(sessionId), exact: true });
      }
    },
  });

  const { data: todos, isPending, isError, refetch } = useQuery({
    queryKey: todoKeys.listBySession(sessionId),
    queryFn: () => fetchTodos({ sessionId }),
  });

  const items = todos ?? [];
  return {
    todos: items,
    openCount: items.filter((todo) => todo.status === 'open').length,
    isPending,
    isError,
    refetch,
  } as const;
}
