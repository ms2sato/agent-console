import { useSessionDataContext } from '../contexts/root-contexts';

/**
 * The live session list and a title lookup over it. A session the list does
 * not hold (deleted, or not yet synced) has no title: callers fall back to the
 * start of its id.
 */
export function useSessionTitles() {
  const { sessions } = useSessionDataContext();
  const titleOf = (sessionId: string): string | null =>
    sessions.find((session) => session.id === sessionId)?.title ?? null;
  return { sessions, titleOf };
}
