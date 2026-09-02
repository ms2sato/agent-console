import { useForm } from 'react-hook-form';
import { valibotResolver } from '@hookform/resolvers/valibot';
import { FormField, Input } from '../ui/FormField';
import { AgentParameterFields } from '../agents/AgentParameterFields';
import {
  UnifiedAgentSelector,
  useResolvedEmbeddedAgentId,
  type AgentSelection,
} from '../AgentSelector';
import { useResolvedAgentId } from '../../hooks/useAgents';
import { FormOverlay } from '../ui/Spinner';
import { useAuth } from '../../lib/auth';
import type { CreateQuickSessionRequest } from '@agent-console/shared';
import { CreateQuickSessionRequestSchema } from '@agent-console/shared';

export interface QuickSessionFormProps {
  isPending: boolean;
  onSubmit: (data: CreateQuickSessionRequest) => Promise<void>;
  onCancel: () => void;
}

export function QuickSessionForm({
  isPending,
  onSubmit,
  onCancel,
}: QuickSessionFormProps) {
  const {
    register,
    handleSubmit,
    setError,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateQuickSessionRequest>({
    resolver: valibotResolver(CreateQuickSessionRequestSchema),
    defaultValues: {
      type: 'quick',
      locationPath: '/tmp',
      agentId: undefined,
      embeddedAgentId: undefined,
      model: undefined,
      reasoningEffort: undefined,
      contextWindowTokens: undefined,
    },
    mode: 'onBlur',
  });

  const { sharedAccountsAvailable } = useAuth();
  const agentId = watch('agentId');
  const embeddedAgentId = watch('embeddedAgentId');
  // Default selection stays the terminal default agent (owner decision:
  // the uniform-listing principle governs what the picker *shows*, not
  // what it defaults to -- embedded agents must never auto-select).
  const resolvedAgentId = useResolvedAgentId(agentId);
  const resolvedEmbeddedAgentId = useResolvedEmbeddedAgentId(embeddedAgentId);
  const model = watch('model');
  const reasoningEffort = watch('reasoningEffort');
  const contextWindowTokens = watch('contextWindowTokens');

  const handleAgentSelectionChange = (selection: AgentSelection) => {
    // model/reasoningEffort/contextWindowTokens are gated by the NEWLY
    // selected agent's capability (AgentParameterFields hides the input the
    // moment the agent switch makes it inapplicable). Clear all three here
    // so a stale value from the previous agent never rides along in a
    // submit for a field the user can no longer see or edit.
    switch (selection.kind) {
      case 'terminal':
        setValue('agentId', selection.agentId);
        setValue('embeddedAgentId', undefined);
        setValue('model', undefined);
        setValue('reasoningEffort', undefined);
        setValue('contextWindowTokens', undefined);
        return;
      case 'embedded':
        setValue('embeddedAgentId', selection.embeddedAgentId);
        setValue('agentId', undefined);
        setValue('model', undefined);
        setValue('reasoningEffort', undefined);
        setValue('contextWindowTokens', undefined);
        return;
    }
  };

  const handleFormSubmit = async (data: CreateQuickSessionRequest) => {
    try {
      // Exactly one of agentId / embeddedAgentId is submitted -- never both.
      const agentFields: Pick<CreateQuickSessionRequest, 'agentId' | 'embeddedAgentId'> =
        resolvedEmbeddedAgentId
          ? { agentId: undefined, embeddedAgentId: resolvedEmbeddedAgentId }
          : { agentId: resolvedAgentId, embeddedAgentId: undefined };
      await onSubmit({
        ...data,
        ...agentFields,
        model: data.model?.trim() || undefined,
        reasoningEffort: data.reasoningEffort?.trim() || undefined,
        contextWindowTokens: data.contextWindowTokens,
      });
    } catch (err) {
      setError('root', {
        message: err instanceof Error ? err.message : 'Failed to start session',
      });
    }
  };

  return (
    <div className="relative card mb-4 bg-slate-800">
      <FormOverlay isVisible={isPending} message="Starting session..." />
      <h3 className="text-sm font-medium mb-3">Start Session in Any Directory</h3>
      <form onSubmit={handleSubmit(handleFormSubmit)}>
        <input type="hidden" {...register('type')} value="quick" />
        <fieldset disabled={isPending} className="flex flex-col gap-3">
          <FormField error={errors.locationPath}>
            <Input
              {...register('locationPath')}
              placeholder="Path (e.g., /path/to/project)"
              autoFocus
              error={errors.locationPath}
            />
          </FormField>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400">Agent:</span>
            <UnifiedAgentSelector
              agentId={resolvedEmbeddedAgentId ? undefined : resolvedAgentId}
              embeddedAgentId={resolvedEmbeddedAgentId}
              onChange={handleAgentSelectionChange}
              className="flex-1"
            />
          </div>
          <AgentParameterFields
            selection={
              resolvedEmbeddedAgentId
                ? { kind: 'embedded', embeddedAgentId: resolvedEmbeddedAgentId }
                : resolvedAgentId
                  ? { kind: 'terminal', agentId: resolvedAgentId }
                  : undefined
            }
            model={model}
            reasoningEffort={reasoningEffort}
            contextWindowTokens={contextWindowTokens}
            // CreateQuickSessionRequestSchema (used directly as this form's
            // resolver -- there is no looser client-only schema here, unlike
            // CreateWorktreeForm) requires model/reasoningEffort to be
            // non-empty-after-trim WHEN PRESENT. Collapse a fully-cleared OR
            // whitespace-only input to `undefined` immediately so a blank
            // field never fails that constraint at submit time -- trimming
            // here (not just at submit) keeps the value the schema sees in
            // sync with what onModelChange decided to pass through. A
            // cleared model also clears contextWindowTokens: the field is
            // only meaningful alongside a model override (agent-surface.md
            // Ruling 4), so a stale window value must not survive a
            // model-clear even though AgentParameterFields also stops
            // rendering the input the moment model is empty -- the value
            // needs to leave form state, not just the DOM.
            onModelChange={(value) => {
              const trimmed = value.trim() || undefined;
              setValue('model', trimmed);
              if (!trimmed) setValue('contextWindowTokens', undefined);
            }}
            onReasoningEffortChange={(value) => setValue('reasoningEffort', value.trim() || undefined)}
            onContextWindowTokensChange={(value) => setValue('contextWindowTokens', value)}
            contextWindowTokensError={errors.contextWindowTokens}
          />
          {sharedAccountsAvailable && (
            <label className="flex items-center gap-2 text-sm text-gray-400">
              <input
                type="checkbox"
                {...register('shared')}
                className="accent-indigo-600"
              />
              Create as shared session
            </label>
          )}
          {errors.root && (
            <p className="text-sm text-red-400" role="alert">{errors.root.message}</p>
          )}
          <div className="flex gap-3">
            <button
              type="submit"
              className="btn btn-primary text-sm"
            >
              Start
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="btn btn-danger text-sm"
            >
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
