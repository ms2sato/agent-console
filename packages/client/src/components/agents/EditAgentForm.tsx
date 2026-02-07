import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UpdateAgentRequest, AgentDefinition } from '@agent-console/shared';
import { updateAgent } from '../../lib/api';
import { AgentForm, parseAskingPatterns, type AgentFormData } from './AgentForm';

export interface EditAgentFormProps {
  agentId: string;
  initialData: AgentFormData;
  onSuccess: () => void;
  onCancel: () => void;
}

export function EditAgentForm({ agentId, initialData, onSuccess, onCancel }: EditAgentFormProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const updateMutation = useMutation({
    mutationFn: (data: UpdateAgentRequest) => updateAgent(agentId, data),
    onSuccess: (response) => {
      // Optimistic cache update (don't rely solely on WebSocket in case of disconnection)
      const updatedAgent = response.agent;
      queryClient.setQueryData(['agent', agentId], { agent: updatedAgent });
      queryClient.setQueryData<{ agents: AgentDefinition[] } | undefined>(['agents'], (old) => {
        if (!old) return { agents: [updatedAgent] };
        return { agents: old.agents.map((a) => (a.id === agentId ? updatedAgent : a)) };
      });
      onSuccess();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to update agent');
    },
  });

  const handleSubmit = (data: AgentFormData) => {
    setError(null);
    const askingPatterns = parseAskingPatterns(data.askingPatternsInput);
    updateMutation.mutate({
      name: data.name,
      agentType: data.agentType,
      commandTemplate: data.commandTemplate,
      // Send null to clear optional fields (server interprets null as "clear", undefined as "no change")
      continueTemplate: data.continueTemplate || null,
      headlessTemplate: data.headlessTemplate || null,
      description: data.description || undefined,
      activityPatterns: askingPatterns ? { askingPatterns } : null,
    });
  };

  return (
    <AgentForm
      mode="edit"
      initialData={initialData}
      onSubmit={handleSubmit}
      onCancel={onCancel}
      isPending={updateMutation.isPending}
      error={error}
    />
  );
}
