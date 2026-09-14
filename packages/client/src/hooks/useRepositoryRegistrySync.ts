import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppWsEvent } from './useAppWs';
import { repositoryKeys } from '../lib/query-keys';
import type { Repository } from '@agent-console/shared';

/**
 * Keeps the repository registry query cache (`repositoryKeys.all()`,
 * consumed by `ActiveSessionsSidebar`'s Orchestrator-flag rendering) fresh
 * in response to WebSocket repositories-sync/created/updated/deleted events.
 *
 * Mounted at the root layout (`routes/__root.tsx`), not a specific route --
 * the same reasoning as its sibling `useEmbeddedAgentRegistrySync`: the
 * sidebar that reads this cache renders on every route, not just the
 * Dashboard (`routes/index.tsx`, which used to be the only place these four
 * handlers were wired). While the Dashboard is unmounted, a server restart's
 * `repositories-sync` reconnect frame was never consumed, leaving the
 * sidebar's Orchestrator flag on stale or errored data.
 *
 * `onRepositoriesSync` writes the payload directly via `setQueryData` rather
 * than `invalidateQueries`: the frame already carries the server's enriched
 * full repository list, so writing it repairs an errored/stale query
 * immediately, without depending on an active observer to trigger a
 * refetch.
 */
export function useRepositoryRegistrySync(): void {
  const queryClient = useQueryClient();

  const handleRepositoriesSync = useCallback((repositories: Repository[]) => {
    queryClient.setQueryData(repositoryKeys.all(), { repositories });
  }, [queryClient]);

  const handleRepositoryCreated = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: repositoryKeys.all() });
  }, [queryClient]);

  const handleRepositoryDeleted = useCallback((repositoryId: string) => {
    queryClient.invalidateQueries({ queryKey: repositoryKeys.all() });
    queryClient.invalidateQueries({ queryKey: repositoryKeys.detail(repositoryId) });
  }, [queryClient]);

  const handleRepositoryUpdated = useCallback((repository: Repository) => {
    queryClient.setQueryData<{ repositories: Repository[] } | undefined>(repositoryKeys.all(), (old) => {
      if (!old) return old;
      return { repositories: old.repositories.map(r => r.id === repository.id ? repository : r) };
    });
    queryClient.invalidateQueries({ queryKey: repositoryKeys.detail(repository.id) });
  }, [queryClient]);

  useAppWsEvent({
    onRepositoriesSync: handleRepositoriesSync,
    onRepositoryCreated: handleRepositoryCreated,
    onRepositoryDeleted: handleRepositoryDeleted,
    onRepositoryUpdated: handleRepositoryUpdated,
  });
}
