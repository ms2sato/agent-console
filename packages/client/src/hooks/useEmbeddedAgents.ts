import { useQuery } from '@tanstack/react-query';
import { fetchEmbeddedAgents } from '../lib/api';
import { embeddedAgentKeys } from '../lib/query-keys';

/**
 * List of `EmbeddedAgentDefinition`s (the OpenAI-compatible-provider agent
 * registry, separate from the terminal `AgentDefinition` registry -- see
 * docs/design/embedded-agent-worker.md "Embedded agent registry"). Mirrors
 * `useAgents` in `../components/AgentSelector.tsx`.
 */
export function useEmbeddedAgents() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: embeddedAgentKeys.all(),
    queryFn: fetchEmbeddedAgents,
  });

  return {
    embeddedAgents: data?.embeddedAgents ?? [],
    isLoading,
    error,
    refetch,
  };
}
