import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchArtifacts } from '../../../lib/api';
import { artifactKeys } from '../../../lib/query-keys';
import { useAppWsEvent } from '../../../hooks/useAppWs';

/**
 * Resolve the HTML artifacts created within a specific session, for the
 * session-scoped artifacts sidebar. Thin wrapper around `fetchArtifacts`'s
 * optional `sessionId` filter, following the shape of
 * `useSessionRepoFullName` (a `useQuery` closure over a parameterized query
 * key + fetch function).
 *
 * Realtime refresh: `create_html_artifact` / `delete_html_artifact` emit a
 * trigger-only WS message (no content, N1-compliant) on `/ws/app`.
 * This hook invalidates its own scoped query key when the message's
 * `sessionId` matches -- a message for a DIFFERENT session must not refetch
 * this session's panel.
 */
export function useSessionArtifacts(sessionId: string) {
  const queryClient = useQueryClient();

  useAppWsEvent({
    onArtifactCreated: (msgSessionId) => {
      if (msgSessionId === sessionId) {
        queryClient.invalidateQueries({ queryKey: artifactKeys.listBySession(sessionId), exact: true });
      }
    },
    onArtifactDeleted: (msgSessionId) => {
      if (msgSessionId === sessionId) {
        queryClient.invalidateQueries({ queryKey: artifactKeys.listBySession(sessionId), exact: true });
      }
    },
  });

  return useQuery({
    queryKey: artifactKeys.listBySession(sessionId),
    queryFn: () => fetchArtifacts(sessionId),
  });
}
