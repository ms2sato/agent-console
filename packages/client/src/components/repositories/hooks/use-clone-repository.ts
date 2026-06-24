import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CloneJobStatusResponse,
  CloneRepositoryRequest,
  CloneRepositoryResponse,
} from '@agent-console/shared';
import { cloneRepository, fetchCloneJobStatus } from '../../../lib/api';
import { cloneJobKeys, repositoryKeys } from '../../../lib/query-keys';

/** Default poll interval (ms) used by `useCloneJobStatus` while a Clone Job is non-terminal. */
export const CLONE_JOB_POLL_INTERVAL_MS = 1500;

/**
 * Mutation hook for `POST /api/repositories/clone`. Resolves with the
 * Clone Job's `jobId` (and an always-null `repositoryId` until the job
 * succeeds); callers pass `jobId` to `useCloneJobStatus` to track progress.
 */
export function useCloneRepository() {
  return useMutation<CloneRepositoryResponse, Error, CloneRepositoryRequest>({
    mutationFn: cloneRepository,
  });
}

/**
 * Polls `GET /api/repositories/clone/:jobId` until the job reaches a
 * terminal state (`succeeded` or `failed`). The polling interval is
 * controlled via the `refetchInterval` returning `false` once terminal,
 * so the query stops on its own without explicit cancellation.
 *
 * Pass `null` / `undefined` for `jobId` to keep the query disabled (the
 * hook is safe to mount before a clone has started).
 *
 * When the job succeeds, the repositories list cache is invalidated so
 * the new repository appears without a manual refetch. The same effect
 * is also triggered by the server's `repositoryRegistered` WebSocket
 * event; both paths are intentionally redundant since polling and WS may
 * race depending on network conditions.
 */
export function useCloneJobStatus(jobId: string | null | undefined) {
  const queryClient = useQueryClient();

  return useQuery<CloneJobStatusResponse>({
    queryKey: cloneJobKeys.status(jobId ?? ''),
    queryFn: async () => {
      const data = await fetchCloneJobStatus(jobId!);
      if (data.status === 'succeeded') {
        queryClient.invalidateQueries({ queryKey: repositoryKeys.all() });
      }
      return data;
    },
    enabled: !!jobId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'succeeded' || status === 'failed') {
        return false;
      }
      return CLONE_JOB_POLL_INTERVAL_MS;
    },
    // Aggressive default behaviour while a Clone Job is non-terminal:
    // do not cache stale status across mounts (each new dialog gets a
    // fresh poll cycle).
    gcTime: 0,
  });
}
