import { useMemo } from 'react';
import type { AgentDirectoryEntry } from '@agent-console/shared';
import { useAgents } from './useAgents';
import { useEmbeddedAgents } from './useEmbeddedAgents';

export interface UseAgentDirectoryResult {
  entries: AgentDirectoryEntry[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Merges the terminal `AgentDefinition` registry (`useAgents`) and the
 * embedded `EmbeddedAgentDefinition` registry (`useEmbeddedAgents`) into a
 * single kind-tagged `AgentDirectoryEntry[]` (see
 * `@agent-console/shared` `packages/shared/src/types/agent-surface.ts`).
 *
 * Order: terminal entries first, then embedded entries. This mirrors the
 * server's `AgentDirectory.listAll()` order
 * (`packages/server/src/services/agent-directory.ts`), so client and server
 * present agents consistently.
 *
 * This hook applies no sorting or priority policy -- that decision stays at
 * each consumer, mirroring the existing internal `useSortedAgents(priorityAgentId)`
 * pattern in `hooks/useAgents.ts` (unaffected by this hook).
 */
export function useAgentDirectory(): UseAgentDirectoryResult {
  const {
    agents,
    isLoading: agentsLoading,
    error: agentsError,
    refetch: refetchAgents,
  } = useAgents();
  const {
    embeddedAgents,
    isLoading: embeddedLoading,
    error: embeddedError,
    refetch: refetchEmbedded,
  } = useEmbeddedAgents();

  const entries = useMemo<AgentDirectoryEntry[]>(
    () => [
      ...agents.map((agent) => ({ kind: 'terminal' as const, agent })),
      ...embeddedAgents.map((agent) => ({ kind: 'embedded' as const, agent })),
    ],
    [agents, embeddedAgents]
  );

  return {
    entries,
    isLoading: agentsLoading || embeddedLoading,
    error: agentsError ?? embeddedError ?? null,
    refetch: () => {
      refetchAgents();
      refetchEmbedded();
    },
  };
}
