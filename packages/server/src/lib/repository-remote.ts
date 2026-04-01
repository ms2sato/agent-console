import type { Repository } from '@agent-console/shared';
import { getRemoteUrl } from './git.js';

/**
 * Enrich a Repository with its git remote URL.
 * Used by both REST API responses and WebSocket broadcasts to ensure
 * consistent repository data across all delivery channels.
 */
export async function withRepositoryRemote(repository: Repository): Promise<Repository> {
  const remoteUrl = await getRemoteUrl(repository.path);
  return {
    ...repository,
    remoteUrl: remoteUrl ?? undefined,
  };
}
