import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UpdateEmbeddedAgentRequest } from '@agent-console/shared';
import { updateEmbeddedAgent } from '../../lib/api';
import { embeddedAgentKeys } from '../../lib/query-keys';
import {
  EmbeddedAgentForm,
  parseMaxToolIterations,
  toInstructionPaths,
  parseContextWindowTokens,
  parseCompactionThreshold,
  type EmbeddedAgentFormData,
} from './EmbeddedAgentForm';

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
    const threshold = parseCompactionThreshold(data.compactionThresholdInput);
    // Compaction is a whole-object PATCH replace (no per-subfield merge) --
    // an empty threshold input means "clear to null", matching the
    // description/systemPrompt/instructions pattern below. Automatic
    // compaction itself is a per-worker toggle, never written here -- see
    // docs/design/embedded-agent-worker.md "Compaction" § Definition config,
    // migration, and forms.
    const compaction = threshold !== undefined ? { threshold } : null;
    updateMutation.mutate({
      name: data.name,
      // Send null to clear optional fields (server interprets null as
      // "clear", undefined as "no change").
      description: data.description || null,
      // provider is a whole-object replace on the server; always send it.
      // supportsImages: undefined when unchecked, omitting the key entirely
      // (never a literal false) -- same undefined-on-empty handling as
      // apiKeyRef above, not the top-level null-to-clear PATCH convention.
      provider: {
        baseUrl: data.baseUrl,
        model: data.model,
        apiKeyRef: data.apiKeyRef || undefined,
        supportsImages: data.supportsImages ? true : undefined,
      },
      systemPrompt: data.systemPrompt || null,
      maxToolIterations: parseMaxToolIterations(data.maxToolIterationsInput) ?? null,
      // Always send the explicit array the checkboxes currently represent --
      // this form exists precisely to remove the "default vs explicit" PATCH
      // ambiguity that null/undefined would otherwise carry.
      enabledTools: data.enabledTools,
      // Send null to clear (server: null = clear, undefined = no change), matching
      // the description/systemPrompt/maxToolIterations pattern above.
      instructions: data.instructions.length > 0 ? toInstructionPaths(data.instructions) : null,
      contextWindowTokens: parseContextWindowTokens(data.contextWindowTokensInput) ?? null,
      compaction,
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
