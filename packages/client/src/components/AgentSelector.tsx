import { useQuery } from '@tanstack/react-query';
import type { AgentDefinition } from '@agent-console/shared';
import { fetchAgents } from '../lib/api';

interface AgentSelectorProps {
  value?: string;
  onChange: (agentId: string | undefined) => void;
  className?: string;
  disabled?: boolean;
}

export function AgentSelector({
  value,
  onChange,
  className = '',
  disabled = false,
}: AgentSelectorProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: fetchAgents,
  });

  const agents = data?.agents ?? [];

  // Default to first agent (Claude Code) if no value provided or value doesn't match any agent
  const selectedValue = (value && agents.some(a => a.id === value)) ? value : (agents[0]?.id ?? '');

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
      {agents.map((agent) => (
        <option key={agent.id} value={agent.id}>
          {agent.name}
          {agent.isBuiltIn ? ' (built-in)' : ''}
        </option>
      ))}
    </select>
  );
}

// Hook to get agents list for use in other components
export function useAgents() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['agents'],
    queryFn: fetchAgents,
  });

  return {
    agents: data?.agents ?? [],
    isLoading,
    error,
    refetch,
  };
}

// Helper to get agent by ID
export function getAgentName(agents: AgentDefinition[], agentId?: string): string {
  if (!agentId) return 'Unknown';
  const agent = agents.find((a) => a.id === agentId);
  return agent?.name ?? 'Unknown';
}
