import { useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { valibotResolver } from '@hookform/resolvers/valibot';
import * as v from 'valibot';
import {
  AgentFieldsBaseSchema,
  isValidRegex,
  isPromptQuoted,
  hasMalformedPlaceholder,
  AGENT_TYPE_LABELS,
  AGENT_TYPES,
  DEFAULT_AGENT_TYPE,
} from '@agent-console/shared';
import { FormField, Input, Textarea } from '../ui/FormField';
import { FormOverlay } from '../ui/Spinner';

/**
 * Client-side form schema for agent creation/editing.
 *
 * Uses AgentFieldsBaseSchema for fields with identical validation (name, commandTemplate, description).
 * Overrides optional template fields to allow empty strings (form uses "" for "not set").
 * Adds askingPatternsInput which is form-specific (string instead of array).
 */
const AgentFormSchema = v.object({
  // From base: name, commandTemplate, description (identical validation)
  name: AgentFieldsBaseSchema.entries.name,
  commandTemplate: AgentFieldsBaseSchema.entries.commandTemplate,
  description: AgentFieldsBaseSchema.entries.description,

  // Agent type selector
  agentType: v.optional(v.picklist(AGENT_TYPES)),

  // Override optional templates: allow empty string (converted to undefined on submit)
  // Non-empty strings are validated with same rules as server
  continueTemplate: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.check(
        (val) => !val || !hasMalformedPlaceholder(val),
        'Use exactly {{cwd}} (no spaces inside braces)'
      ),
      v.check(
        (val) => !val || !val.includes('{{prompt}}'),
        'Continue template should not contain {{prompt}}'
      )
    )
  ),
  headlessTemplate: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.check(
        (val) => !val || !hasMalformedPlaceholder(val),
        'Use exactly {{prompt}} or {{cwd}} (no spaces inside braces)'
      ),
      v.check(
        (val) => !val || val.includes('{{prompt}}'),
        'Headless template must contain {{prompt}}'
      ),
      v.check(
        (val) => !val || !isPromptQuoted(val),
        '{{prompt}} should not be quoted - it is automatically wrapped'
      )
    )
  ),

  // Form-specific: string input for asking patterns (converted to array on submit)
  askingPatternsInput: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.check(
        (val) => {
          if (!val) return true;
          // Validate each non-empty line is a valid regex using shared validation
          const patterns = val.split('\n').map((p) => p.trim()).filter((p) => p.length > 0);
          return patterns.every((pattern) => isValidRegex(pattern).valid);
        },
        'All patterns must be valid regular expressions'
      )
    )
  ),
});

export type AgentFormData = v.InferOutput<typeof AgentFormSchema>;

export interface AgentFormProps {
  mode: 'create' | 'edit';
  initialData?: AgentFormData;
  onSubmit: (data: AgentFormData) => void;
  onCancel: () => void;
  isPending: boolean;
  error?: string | null;
}

export function AgentForm({
  mode,
  initialData,
  onSubmit,
  onCancel,
  isPending,
  error,
}: AgentFormProps) {
  const [showAdvanced, setShowAdvanced] = useState(
    // Show advanced settings if any advanced field has a value
    !!(initialData?.headlessTemplate || initialData?.askingPatternsInput)
  );

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<AgentFormData>({
    resolver: valibotResolver(AgentFormSchema),
    defaultValues: initialData ?? {
      name: '',
      commandTemplate: '',
      continueTemplate: '',
      headlessTemplate: '',
      description: '',
      askingPatternsInput: '',
      agentType: DEFAULT_AGENT_TYPE,
    },
    mode: 'onBlur',
  });

  // Watch askingPatternsInput for live preview
  const askingPatternsValue = watch('askingPatternsInput');
  const parsedPatterns = useMemo(() => {
    return parseAskingPatternsWithValidation(askingPatternsValue);
  }, [askingPatternsValue]);

  const title = mode === 'create' ? 'Add New Agent' : 'Edit Agent';
  const submitLabel = mode === 'create' ? 'Add Agent' : 'Save Changes';
  const pendingMessage = mode === 'create' ? 'Adding agent...' : 'Saving changes...';

  return (
    <div className={`relative ${mode === 'create' ? 'card mb-6' : 'card'}`}>
      <FormOverlay isVisible={isPending} message={pendingMessage} />
      {mode === 'create' && <h3 className="text-lg font-medium mb-4">{title}</h3>}
      <form onSubmit={handleSubmit(onSubmit)}>
        <fieldset disabled={isPending} className="flex flex-col gap-4">
          <FormField label="Name" error={errors.name}>
            <Input
              {...register('name')}
              placeholder="e.g., Aider"
              error={errors.name}
            />
          </FormField>

          <FormField label="Description (optional)" error={errors.description}>
            <Input
              {...register('description')}
              placeholder="e.g., GPT/Claude pair programming tool"
              error={errors.description}
            />
          </FormField>

          <FormField label="Agent Type" error={errors.agentType}>
            <select
              {...register('agentType')}
              className="bg-slate-800 border-slate-700 text-white rounded px-3 py-2 w-full"
            >
              {AGENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {AGENT_TYPE_LABELS[type]}
                  {type === DEFAULT_AGENT_TYPE ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Command Template" error={errors.commandTemplate}>
            <Input
              {...register('commandTemplate')}
              placeholder="e.g., aider --yes -m {{prompt}}"
              error={errors.commandTemplate}
            />
            <p className="text-xs text-gray-500 mt-1">
              Use <code className="bg-slate-700 px-1 rounded">{'{{prompt}}'}</code> where the initial prompt should be inserted
            </p>
          </FormField>

          <FormField label="Continue Template (optional)" error={errors.continueTemplate}>
            <Input
              {...register('continueTemplate')}
              placeholder="e.g., aider --yes --restore-chat-history"
              error={errors.continueTemplate}
            />
            <p className="text-xs text-gray-500 mt-1">
              Command to resume a conversation. Leave empty to disable Continue button.
            </p>
          </FormField>

          {/* Advanced Settings Toggle */}
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-300"
          >
            <span className={`transition-transform ${showAdvanced ? 'rotate-90' : ''}`}>
              ▶
            </span>
            Advanced Settings
          </button>

          {showAdvanced && (
            <div className="pl-4 border-l border-slate-700 flex flex-col gap-4">
              <FormField label="Headless Template (optional)" error={errors.headlessTemplate}>
                <Input
                  {...register('headlessTemplate')}
                  placeholder="e.g., aider --yes -m {{prompt}} --exit"
                  error={errors.headlessTemplate}
                />
                <p className="text-xs text-gray-500 mt-1">
                  For headless execution (branch name generation). Must contain <code className="bg-slate-700 px-1 rounded">{'{{prompt}}'}</code>.
                </p>
              </FormField>

              <FormField label="Asking Patterns (optional)" error={errors.askingPatternsInput}>
                <Textarea
                  {...register('askingPatternsInput')}
                  placeholder={`Enter one regex pattern per line, e.g.:\nDo you want to.*\\?\n\\[y\\].*\\[n\\]`}
                  rows={4}
                  className="font-mono text-sm"
                  error={errors.askingPatternsInput}
                />
                <p className="text-xs text-gray-500 mt-1">
                  Regex patterns that indicate agent is waiting for input. One pattern per line.
                </p>
                {/* Pattern Preview */}
                {parsedPatterns.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs text-gray-500 mb-1">
                      Preview ({parsedPatterns.filter(p => p.valid).length}/{parsedPatterns.length} valid):
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {parsedPatterns.map((pattern, i) => (
                        <span
                          key={i}
                          className={`text-xs px-2 py-0.5 rounded font-mono ${
                            pattern.valid
                              ? 'bg-green-900/50 text-green-300'
                              : 'bg-red-900/50 text-red-300'
                          }`}
                          title={pattern.valid ? 'Valid regex' : pattern.error}
                        >
                          {pattern.valid ? '✓' : '✗'} {pattern.pattern.length > 30 ? pattern.pattern.slice(0, 30) + '...' : pattern.pattern}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </FormField>
            </div>
          )}

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn btn-primary text-sm"
            >
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
 * Result of parsing a single pattern with validation
 */
export interface ParsedPattern {
  pattern: string;
  valid: boolean;
  error?: string;
}

/**
 * Parse asking patterns from newline-separated input string with validation
 * Used for live preview in the form
 * Uses shared isValidRegex from @agent-console/shared
 */
export function parseAskingPatternsWithValidation(input?: string): ParsedPattern[] {
  if (!input) return [];
  return input
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((pattern) => {
      const validation = isValidRegex(pattern);
      return {
        pattern,
        valid: validation.valid,
        error: validation.error,
      };
    });
}

/**
 * Parse asking patterns from newline-separated input string
 * Returns only the pattern strings (for API submission)
 */
export function parseAskingPatterns(input?: string): string[] | undefined {
  if (!input) return undefined;
  const patterns = input
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return patterns.length > 0 ? patterns : undefined;
}
