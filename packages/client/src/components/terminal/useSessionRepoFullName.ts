import { useQuery } from '@tanstack/react-query';
import { fetchSessionPrLink } from '../../lib/api';
import { sessionKeys } from '../../lib/query-keys';

/**
 * Resolve the session's GitHub repo full name (`owner/repo`) for linkifying
 * refs (issue #958). Reuses the existing session PR-link endpoint, whose
 * `orgRepo` field is the server-resolved `owner/repo` (null for quick sessions
 * or repos without a GitHub remote). Shares the `sessionKeys.prLink` cache with
 * the PR-link menu, so no extra endpoint or client-side URL parsing is needed.
 */
export function useSessionRepoFullName(sessionId: string): string | null {
  const { data } = useQuery({
    queryKey: sessionKeys.prLink(sessionId),
    queryFn: () => fetchSessionPrLink(sessionId),
    staleTime: 5 * 60 * 1000,
  });
  return data?.orgRepo ?? null;
}
