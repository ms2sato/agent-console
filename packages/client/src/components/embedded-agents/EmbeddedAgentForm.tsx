import { useForm, type FieldError } from 'react-hook-form';
import { valibotResolver } from '@hookform/resolvers/valibot';
import * as v from 'valibot';
import {
  CreateEmbeddedAgentRequestSchema,
  EmbeddedAgentProviderSchema,
  EMBEDDED_AGENT_TOOL_NAMES,
  DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS,
  type EmbeddedAgentToolName,
} from '@agent-console/shared';
import { FormField, Input, Textarea } from '../ui/FormField';
import { FormOverlay } from '../ui/Spinner';

/**
 * UI grouping of `EMBEDDED_AGENT_TOOL_NAMES` into "read-only", "command
 * execution", and "file modification" checkbox sections. These arrays must
 * partition the shared constant exactly -- the guard below throws at module
 * load if a future tool addition is not also added to one of these groups,
 * so it fails loudly instead of silently vanishing from the form. FF-1c
 * added `Write`/`Edit` as their own "file modification" group (see below)
 * rather than folding them into `COMMAND_EXECUTION_TOOL_NAMES`, since their
 * risk profile (creating/modifying files) is distinct from Bash's (running
 * arbitrary shell commands) and warrants its own warning copy.
 */
export const READ_ONLY_TOOL_NAMES: readonly EmbeddedAgentToolName[] = ['Read', 'Glob', 'Grep'];
export const COMMAND_EXECUTION_TOOL_NAMES: readonly EmbeddedAgentToolName[] = ['Bash'];
export const FILE_MODIFICATION_TOOL_NAMES: readonly EmbeddedAgentToolName[] = ['Write', 'Edit'];

const TOOL_GROUPS = [
  READ_ONLY_TOOL_NAMES,
  COMMAND_EXECUTION_TOOL_NAMES,
  FILE_MODIFICATION_TOOL_NAMES,
];

const flatToolNames = TOOL_GROUPS.flat();
if (
  flatToolNames.length !== new Set(flatToolNames).size ||
  flatToolNames.length !== EMBEDDED_AGENT_TOOL_NAMES.length ||
  !EMBEDDED_AGENT_TOOL_NAMES.every((name) => TOOL_GROUPS.some((group) => group.includes(name)))
) {
  throw new Error('EmbeddedAgentForm tool groups do not partition EMBEDDED_AGENT_TOOL_NAMES');
}

/**
 * Client-side form schema for embedded-agent creation/editing.
 *
 * Reuses field validators from the shared request schemas where the
 * server-side rule is a plain "always required" check (name, model).
 * Fields that the form allows to be empty (converted to undefined/null on
 * submit) get their own client-side pipe -- mirrors the pattern in
 * `AgentForm.tsx` (`continueTemplate`, `headlessTemplate`).
 */
const EmbeddedAgentFormSchema = v.object({
  name: CreateEmbeddedAgentRequestSchema.entries.name,
  description: v.optional(v.pipe(v.string(), v.trim())),

  // baseUrl is always required in the form (provider is a whole-object
  // replace on the server, so there is no "leave empty to clear" case).
  baseUrl: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Base URL is required'),
    v.url('Must be a valid URL, e.g. http://localhost:11434/v1')
  ),
  model: EmbeddedAgentProviderSchema.entries.model,
  // apiKeyRef is optional; empty string means "not set" (converted to
  // undefined/null on submit), same pattern as continueTemplate in AgentForm.
  apiKeyRef: v.optional(v.pipe(v.string(), v.trim())),

  systemPrompt: v.optional(v.pipe(v.string(), v.trim())),

  // Form-specific: string input for the number field (converted to a number
  // on submit via parseMaxToolIterations). Empty string means "not set".
  maxToolIterationsInput: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.check(
        (val) => !val || (/^\d+$/.test(val) && Number(val) >= 1),
        'Must be a positive integer'
      )
    )
  ),

  // Checkboxes structurally cannot produce a duplicate, so no need to
  // re-check duplicates client-side (unlike the server-side schema).
  enabledTools: v.array(v.picklist(EMBEDDED_AGENT_TOOL_NAMES)),
});

export type EmbeddedAgentFormData = v.InferOutput<typeof EmbeddedAgentFormSchema>;

export interface EmbeddedAgentFormProps {
  mode: 'create' | 'edit';
  initialData?: EmbeddedAgentFormData;
  onSubmit: (data: EmbeddedAgentFormData) => void;
  onCancel: () => void;
  isPending: boolean;
  error?: string | null;
}

export function EmbeddedAgentForm({
  mode,
  initialData,
  onSubmit,
  onCancel,
  isPending,
  error,
}: EmbeddedAgentFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<EmbeddedAgentFormData>({
    resolver: valibotResolver(EmbeddedAgentFormSchema),
    defaultValues: initialData ?? {
      name: '',
      description: '',
      baseUrl: '',
      model: '',
      apiKeyRef: '',
      systemPrompt: '',
      maxToolIterationsInput: '',
      enabledTools: [...DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS],
    },
    mode: 'onBlur',
  });

  const title = mode === 'create' ? 'Add New Embedded Agent' : 'Edit Embedded Agent';
  const submitLabel = mode === 'create' ? 'Add Embedded Agent' : 'Save Changes';
  const pendingMessage = mode === 'create' ? 'Adding embedded agent...' : 'Saving changes...';

  return (
    <div className={`relative ${mode === 'create' ? 'card mb-6' : 'card'}`}>
      <FormOverlay isVisible={isPending} message={pendingMessage} />
      {mode === 'create' && <h3 className="text-lg font-medium mb-4">{title}</h3>}
      <div className="text-xs text-gray-500 mb-4">
        Embedded Agent is an experimental feature. API and behavior may change.
      </div>
      <form onSubmit={handleSubmit(onSubmit)}>
        <fieldset disabled={isPending} className="flex flex-col gap-4">
          <FormField label="Name" error={errors.name}>
            <Input
              {...register('name')}
              placeholder="e.g., Ollama qwen3:32b"
              error={errors.name}
            />
          </FormField>

          <FormField label="Description (optional)" error={errors.description}>
            <Input
              {...register('description')}
              placeholder="e.g., Local Ollama instance running qwen3"
              error={errors.description}
            />
          </FormField>

          <FormField label="Base URL" error={errors.baseUrl}>
            <Input
              {...register('baseUrl')}
              placeholder="http://localhost:11434/v1"
              error={errors.baseUrl}
            />
            <p className="text-xs text-gray-500 mt-1">
              OpenAI-compatible API root.
            </p>
          </FormField>

          <FormField label="Model" error={errors.model}>
            <Input
              {...register('model')}
              placeholder="e.g., qwen3:32b"
              error={errors.model}
            />
          </FormField>

          <FormField label="API Key Ref (optional)" error={errors.apiKeyRef}>
            <Input
              {...register('apiKeyRef')}
              placeholder="Name of a key in the server-side key store"
              error={errors.apiKeyRef}
            />
            <p className="text-xs text-gray-500 mt-1">
              Leave empty for local LLMs that don't require authentication.
            </p>
          </FormField>

          <FormField label="System Prompt (optional)" error={errors.systemPrompt}>
            <Textarea
              {...register('systemPrompt')}
              placeholder="Prepended to every conversation"
              rows={4}
              error={errors.systemPrompt}
            />
          </FormField>

          <FormField label="Max Tool Iterations (optional)" error={errors.maxToolIterationsInput}>
            <Input
              {...register('maxToolIterationsInput')}
              placeholder="25"
              inputMode="numeric"
              error={errors.maxToolIterationsInput}
            />
            <p className="text-xs text-gray-500 mt-1">
              Maximum tool-call iterations per user turn. Defaults to 25 if left empty.
            </p>
          </FormField>

          <FormField label="Tools" error={errors.enabledTools as FieldError | undefined}>
            <div className="flex flex-col gap-3">
              <div>
                <p className="text-xs font-medium text-gray-400 mb-1">Read-only</p>
                <div className="flex flex-col gap-1">
                  {READ_ONLY_TOOL_NAMES.map((name) => (
                    <label key={name} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" value={name} {...register('enabledTools')} />
                      {name}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-400 mb-1">Command execution</p>
                <div className="flex flex-col gap-1">
                  {COMMAND_EXECUTION_TOOL_NAMES.map((name) => (
                    <label key={name} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" value={name} {...register('enabledTools')} />
                      {name}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-amber-500 mt-1">
                  Runs arbitrary shell commands as the session user.
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-400 mb-1">File modification</p>
                <div className="flex flex-col gap-1">
                  {FILE_MODIFICATION_TOOL_NAMES.map((name) => (
                    <label key={name} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" value={name} {...register('enabledTools')} />
                      {name}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-amber-500 mt-1">
                  Creates and modifies files as the session user.
                </p>
              </div>
            </div>
          </FormField>

          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-sm">
              {submitLabel}
            </button>
            <button type="button" onClick={onCancel} className="btn btn-danger text-sm">
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}

/**
 * Parse the form's `maxToolIterationsInput` string into the request's numeric
 * `maxToolIterations` field. Empty string means "not set".
 */
export function parseMaxToolIterations(input?: string): number | undefined {
  const trimmed = input?.trim();
  return trimmed ? Number(trimmed) : undefined;
}
