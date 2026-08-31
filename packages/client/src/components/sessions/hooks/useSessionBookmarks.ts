import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchBookmarks, createBookmark, deleteBookmark as deleteBookmarkApi } from '../../../lib/api';
import { bookmarkKeys } from '../../../lib/query-keys';
import { useAppWsEvent } from '../../../hooks/useAppWs';

/**
 * Resolve the bookmarks registered from a specific session, plus mutations
 * to add/remove one, for the session-scoped bookmarks sidebar. Mirrors
 * `useSessionArtifacts`'s `useQuery` shape for the list, and
 * `useMessageTemplates`'s mutation-wrapping convention (mutate + invalidate
 * on success) for add/delete.
 *
 * `addBookmark` accepts optional per-call `{ onSuccess, onError }`
 * callbacks (react-query's `mutate(variables, options)` form) rather than
 * returning a promise, matching `ArtifactsPage`'s established
 * mutate-fire-and-forget-with-callbacks convention -- the caller (the
 * registration form) needs to clear its inputs on success and surface the
 * server's error message on failure.
 *
 * Realtime refresh: `create_bookmark` / `delete_bookmark` emit a
 * trigger-only WS message (no content, N1-compliant) on `/ws/app`. This
 * hook invalidates its own scoped query key when the message's `sessionId`
 * matches -- a message for a DIFFERENT session must not refetch this
 * session's panel. See `useSessionArtifacts`'s identical wiring.
 */
export function useSessionBookmarks(sessionId: string) {
  const queryClient = useQueryClient();

  useAppWsEvent({
    onBookmarkCreated: (msgSessionId) => {
      if (msgSessionId === sessionId) {
        queryClient.invalidateQueries({ queryKey: bookmarkKeys.listBySession(sessionId), exact: true });
      }
    },
    onBookmarkDeleted: (msgSessionId) => {
      if (msgSessionId === sessionId) {
        queryClient.invalidateQueries({ queryKey: bookmarkKeys.listBySession(sessionId), exact: true });
      }
    },
  });

  const { data: bookmarks, isPending } = useQuery({
    queryKey: bookmarkKeys.listBySession(sessionId),
    queryFn: () => fetchBookmarks(sessionId),
  });

  const addMutation = useMutation({
    mutationFn: ({ url, title }: { url: string; title: string | undefined }) =>
      createBookmark(url, title, sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: bookmarkKeys.listBySession(sessionId) }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteBookmarkApi(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: bookmarkKeys.listBySession(sessionId) }),
  });

  return {
    bookmarks: bookmarks ?? [],
    isPending,
    isAddingBookmark: addMutation.isPending,
    addBookmark: (
      url: string,
      title: string | undefined,
      callbacks?: { onSuccess?: () => void; onError?: (error: Error) => void }
    ) => addMutation.mutate({ url, title }, callbacks),
    deleteBookmark: (id: string) => deleteMutation.mutate(id),
  } as const;
}
