import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createEmbeddedAgent } from '../../lib/api';
import { embeddedAgentKeys } from '../../lib/query-keys';
import {
  EmbeddedAgentForm,
  parseMaxToolIterations,
  toInstructionPaths,
  type EmbeddedAgentFormData,
} from './EmbeddedAgentForm';

export interface AddEmbeddedAgentFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * Wraps `EmbeddedAgentForm` in create mode. `useEmbeddedAgentRegistrySync`
 * invalidates the embedded-agent list query on the WS
 * `embedded-agent-created` broadcast (the registry is small and not
 * perf-sensitive, per that hook's own doc comment), but `onSuccess` also
 * invalidates directly -- don't rely solely on the WS broadcast in case of
 * disconnection (mirrors the delete-mutation fix in
 * `routes/agents/index.tsx`'s `EmbeddedAgentsSection`).
 */
export function AddEmbeddedAgentForm({ onSuccess, onCancel }: AddEmbeddedAgentFormProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: createEmbeddedAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: embeddedAgentKeys.all() });
      onSuccess();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to create embedded agent');
    },
  });

  const handleSubmit = (data: EmbeddedAgentFormData) => {
    setError(null);
    createMutation.mutate({
      name: data.name,
      description: data.description || undefined,
      provider: {
        baseUrl: data.baseUrl,
        model: data.model,
        apiKeyRef: data.apiKeyRef || undefined,
      },
      systemPrompt: data.systemPrompt || undefined,
      maxToolIterations: parseMaxToolIterations(data.maxToolIterationsInput),
      enabledTools: data.enabledTools,
      instructions: data.instructions.length > 0 ? toInstructionPaths(data.instructions) : undefined,
    });
  };

  return (
    <EmbeddedAgentForm
      mode="create"
      onSubmit={handleSubmit}
      onCancel={onCancel}
      isPending={createMutation.isPending}
      error={error}
    />
  );
}
