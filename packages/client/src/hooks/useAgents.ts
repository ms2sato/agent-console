import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentDefinition } from '@agent-console/shared';
import { fetchAgents } from '../lib/api';
import { agentKeys } from '../lib/query-keys';

/**
 * Terminal `AgentDefinition` registry query + resolution hooks. Mirrors
 * `hooks/useEmbeddedAgents.ts`'s role for the embedded registry.
 *
 * Extracted from `components/AgentSelector.tsx` to break a
 * hooks<->component import cycle: `useAgentDirectory.ts` needs `useAgents`,
 * and `AgentSelector.tsx` needs `useAgentDirectory` (for
 * `UnifiedAgentSelector`) -- both cannot live in the same file without a
 * circular import.
 */
function useSortedAgents(priorityAgentId?: string) {
  const { data, isLoading } = useQuery({
    queryKey: agentKeys.all(),
    queryFn: fetchAgents,
  });

  const sortedAgents = useMemo(() => {
    const agents = data?.agents ?? [];
    if (!priorityAgentId) return agents;
    return [...agents].sort((a, b) => {
      if (a.id === priorityAgentId) return -1;
      if (b.id === priorityAgentId) return 1;
      return 0;
    });
  }, [data?.agents, priorityAgentId]);

  return { sortedAgents, isLoading };
}

/**
 * Hook that resolves the effective agent ID with fallback logic.
 * Returns the given value if it matches a known agent, otherwise falls back to the first
 * sorted agent. While loading, returns the original value unchanged.
 *
 * Shares the same TanStack Query cache as the agent pickers, so no extra network request is made.
 */
export function useResolvedAgentId(
  value: string | undefined,
  priorityAgentId?: string
): string | undefined {
  const { sortedAgents, isLoading } = useSortedAgents(priorityAgentId);

  if (isLoading) return value;
  const valueExists = value != null && sortedAgents.some((a) => a.id === value);
  return valueExists ? value : sortedAgents[0]?.id;
}

export function useAgents() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: agentKeys.all(),
    queryFn: fetchAgents,
  });

  return {
    agents: data?.agents ?? [],
    isLoading,
    error,
    refetch,
  };
}

export function getAgentName(agents: AgentDefinition[], agentId?: string): string {
  if (!agentId) return 'Unknown';
  const agent = agents.find((a) => a.id === agentId);
  return agent?.name ?? 'Unknown';
}
