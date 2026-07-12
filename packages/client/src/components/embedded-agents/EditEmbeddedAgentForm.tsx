import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UpdateEmbeddedAgentRequest } from '@agent-console/shared';
import { updateEmbeddedAgent } from '../../lib/api';
import { embeddedAgentKeys } from '../../lib/query-keys';
import { EmbeddedAgentForm, parseMaxToolIterations, type EmbeddedAgentFormData } from './EmbeddedAgentForm';

export interface EditEmbeddedAgentFormProps {
  embeddedAgentId: string;
  initialData: EmbeddedAgentFormData;
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * Wraps `EmbeddedAgentForm` in edit mode. No manual cache splice on success
 * -- see `AddEmbeddedAgentForm`'s doc comment for why (invalidate-and-refetch,
 * not optimistic splice, for this small registry). `onSuccess` invalidates
 * directly rather than relying solely on the WS `embedded-agent-updated`
 * broadcast, in case the WS connection is down at the time of the edit.
 */
export function EditEmbeddedAgentForm({
  embeddedAgentId,
  initialData,
  onSuccess,
  onCancel,
}: EditEmbeddedAgentFormProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const updateMutation = useMutation({
    mutationFn: (data: UpdateEmbeddedAgentRequest) => updateEmbeddedAgent(embeddedAgentId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: embeddedAgentKeys.all() });
      onSuccess();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to update embedded agent');
    },
  });

  const handleSubmit = (data: EmbeddedAgentFormData) => {
    setError(null);
    updateMutation.mutate({
      name: data.name,
      // Send null to clear optional fields (server interprets null as
      // "clear", undefined as "no change").
      description: data.description || null,
      // provider is a whole-object replace on the server; always send it.
      provider: {
        baseUrl: data.baseUrl,
        model: data.model,
        apiKeyRef: data.apiKeyRef || undefined,
      },
      systemPrompt: data.systemPrompt || null,
      maxToolIterations: parseMaxToolIterations(data.maxToolIterationsInput) ?? null,
    });
  };

  return (
    <EmbeddedAgentForm
      mode="edit"
      initialData={initialData}
      onSubmit={handleSubmit}
      onCancel={onCancel}
      isPending={updateMutation.isPending}
      error={error}
    />
  );
}
