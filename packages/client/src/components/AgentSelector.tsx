import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentDefinition } from '@agent-console/shared';
import { fetchAgents } from '../lib/api';
import { agentKeys } from '../lib/query-keys';

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

interface AgentSelectorProps {
  value?: string;
  onChange: (agentId: string | undefined) => void;
  className?: string;
  disabled?: boolean;
  priorityAgentId?: string;
}

/**
 * Pure controlled select component for choosing an agent.
 * Does not push state back to the parent via useEffect.
 * Callers should use `useResolvedAgentId` to derive the effective agent ID with fallback.
 */
export function AgentSelector({
  value,
  onChange,
  className = '',
  disabled = false,
  priorityAgentId,
}: AgentSelectorProps) {
  const { sortedAgents, isLoading } = useSortedAgents(priorityAgentId);

  const valueExists = value != null && sortedAgents.some((a) => a.id === value);
  const selectedValue = valueExists ? value : (sortedAgents[0]?.id ?? '');

  if (isLoading) {
    return (
      <select className={`input ${className}`} disabled>
        <option>Loading...</option>
      </select>
    );
  }

  return (
    <select
      value={selectedValue}
      onChange={(e) => onChange(e.target.value || undefined)}
      className={`input ${className}`}
      disabled={disabled}
    >
      {sortedAgents.map((agent) => (
        <option key={agent.id} value={agent.id}>
          {agent.name}
          {agent.isBuiltIn ? ' (built-in)' : ''}
          {agent.baseAgentId ? ' (preset)' : ''}
        </option>
      ))}
    </select>
  );
}

/**
 * Hook that resolves the effective agent ID with fallback logic.
 * Returns the given value if it matches a known agent, otherwise falls back to the first
 * sorted agent. While loading, returns the original value unchanged.
 *
 * Shares the same TanStack Query cache as AgentSelector, so no extra network request is made.
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
