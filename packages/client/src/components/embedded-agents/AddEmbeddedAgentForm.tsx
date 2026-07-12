import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createEmbeddedAgent } from '../../lib/api';
import { EmbeddedAgentForm, parseMaxToolIterations, type EmbeddedAgentFormData } from './EmbeddedAgentForm';

export interface AddEmbeddedAgentFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * Wraps `EmbeddedAgentForm` in create mode. No manual cache splice on
 * success -- `useEmbeddedAgentRegistrySync` invalidates the embedded-agent
 * list query on the WS `embedded-agent-created` broadcast (the registry is
 * small and not perf-sensitive, per that hook's own doc comment), so a plain
 * `onSuccess()` callback is sufficient.
 */
export function AddEmbeddedAgentForm({ onSuccess, onCancel }: AddEmbeddedAgentFormProps) {
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: createEmbeddedAgent,
    onSuccess: () => {
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
