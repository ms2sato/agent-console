import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppWsEvent } from './useAppWs';
import { embeddedAgentKeys } from '../lib/query-keys';

/**
 * Keeps the embedded-agent definition registry query cache
 * (`embeddedAgentKeys.all()`, consumed by `useEmbeddedAgents` /
 * `AddAgentWorkerMenu`) fresh in response to WebSocket
 * embedded-agent-created/updated/deleted events.
 *
 * Mounted at the root layout (`routes/__root.tsx`), not a specific route.
 * The registry is consumed by `AddAgentWorkerMenu` on session pages, not the
 * Dashboard -- unlike the terminal `AgentDefinition` registry's cache sync
 * (`routes/index.tsx`, wired only while the Dashboard route is mounted),
 * this must stay live regardless of which route the user is currently on,
 * since that's exactly where the picker lives.
 *
 * Simplicity: this list is small and not perf-sensitive, so a plain
 * invalidate-and-refetch is used instead of the optimistic
 * `setQueryData` splice the terminal-agent handlers use.
 */
export function useEmbeddedAgentRegistrySync(): void {
  const queryClient = useQueryClient();

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: embeddedAgentKeys.all() });
  }, [queryClient]);

  useAppWsEvent({
    onEmbeddedAgentCreated: invalidate,
    onEmbeddedAgentUpdated: invalidate,
    onEmbeddedAgentDeleted: invalidate,
  });
}
