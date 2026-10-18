import { useQuery } from '@tanstack/react-query';
import { fetchSessionPrLink } from '../../lib/api';
import { sessionKeys } from '../../lib/query-keys';

/**
 * Resolve the session's GitHub repo full name (`owner/repo`) for linkifying
 * refs (issue #958). Reuses the existing session PR-link endpoint, whose
 * `orgRepo` field is the server-resolved `owner/repo` (null for quick sessions
 * or repos without a GitHub remote). The endpoint only serves worktree
 * sessions (it answers 400 otherwise), so a caller with a quick session passes
 * `enabled: false` and no request is made. Shares the `sessionKeys.prLink` cache with
 * the PR-link menu, so no extra endpoint or client-side URL parsing is needed.
 */
export function useSessionRepoFullName(sessionId: string, enabled: boolean): string | null {
  const { data } = useQuery({
    queryKey: sessionKeys.prLink(sessionId),
    queryFn: () => fetchSessionPrLink(sessionId),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
  return data?.orgRepo ?? null;
}
