import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentDefinition } from '@agent-console/shared';
import { registerAgent } from '../../lib/api';
import { AgentForm, parseAskingPatterns, type AgentFormData } from './AgentForm';

export interface AddAgentFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

export function AddAgentForm({ onSuccess, onCancel }: AddAgentFormProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const registerMutation = useMutation({
    mutationFn: registerAgent,
    onSuccess: (response) => {
      // Optimistic cache update (don't rely solely on WebSocket in case of disconnection)
      const newAgent = response.agent;
      queryClient.setQueryData<{ agents: AgentDefinition[] } | undefined>(['agents'], (old) => {
        if (!old) return { agents: [newAgent] };
        return { agents: [...old.agents, newAgent] };
      });
      onSuccess();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to register agent');
    },
  });

  const handleSubmit = (data: AgentFormData) => {
    setError(null);
    const askingPatterns = parseAskingPatterns(data.askingPatternsInput);
    registerMutation.mutate({
      name: data.name,
      agentType: data.agentType,
      commandTemplate: data.commandTemplate,
      continueTemplate: data.continueTemplate || undefined,
      headlessTemplate: data.headlessTemplate || undefined,
      description: data.description || undefined,
      activityPatterns: askingPatterns ? { askingPatterns } : undefined,
    });
  };

  return (
    <AgentForm
      mode="create"
      onSubmit={handleSubmit}
      onCancel={onCancel}
      isPending={registerMutation.isPending}
      error={error}
    />
  );
}
