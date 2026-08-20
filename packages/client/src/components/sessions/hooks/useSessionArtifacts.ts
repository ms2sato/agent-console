import { useQuery } from '@tanstack/react-query';
import { fetchArtifacts } from '../../../lib/api';
import { artifactKeys } from '../../../lib/query-keys';

/**
 * Resolve the HTML artifacts created within a specific session, for the
 * session-scoped artifacts sidebar. Thin wrapper around `fetchArtifacts`'s
 * optional `sessionId` filter, following the shape of
 * `useSessionRepoFullName` (a `useQuery` closure over a parameterized query
 * key + fetch function).
 */
export function useSessionArtifacts(sessionId: string) {
  return useQuery({
    queryKey: artifactKeys.listBySession(sessionId),
    queryFn: () => fetchArtifacts(sessionId),
  });
}
