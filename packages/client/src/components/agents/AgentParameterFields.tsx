import type { AgentDirectoryEntry, AgentParameterCapabilitiesByKind } from '@agent-console/shared';
import { getAgentParameterCapabilitiesFor } from '@agent-console/shared';
import type { AgentSelection } from '../AgentSelector';
import { useAgentDirectory } from '../../hooks/useAgentDirectory';
import { FormField, Input } from '../ui/FormField';

export interface AgentParameterFieldsProps {
  /**
   * The current agent selection (terminal or embedded), or `undefined` when
   * nothing is resolved yet.
   */
  selection: AgentSelection | undefined;
  model: string | undefined;
  reasoningEffort: string | undefined;
  contextWindowTokens: number | undefined;
  onModelChange: (value: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onContextWindowTokensChange: (value: number | undefined) => void;
  /**
   * Injectable seam for the kind-dispatch capability accessor, defaulting to
   * the real `getAgentParameterCapabilitiesFor` (agent-surface.ts's SINGLE
   * kind-dispatch entry point). This component itself never branches on
   * `entry.kind` to decide which capability function to call -- it resolves
   * `selection` to an `AgentDirectoryEntry` (via `useAgentDirectory`) and
   * hands the WHOLE entry to this one seam, which does the kind dispatch
   * internally. A test can inject a stub here to prove the component
   * follows the seam's return value for BOTH kinds, not just one.
   */
  getCapabilitiesImpl?: (entry: AgentDirectoryEntry) => AgentParameterCapabilitiesByKind;
}

function findEntry(
  entries: AgentDirectoryEntry[],
  selection: AgentSelection
): AgentDirectoryEntry | undefined {
  switch (selection.kind) {
    case 'terminal':
      return entries.find((entry) => entry.kind === 'terminal' && entry.agent.id === selection.agentId);
    case 'embedded':
      return entries.find(
        (entry) => entry.kind === 'embedded' && entry.agent.id === selection.embeddedAgentId
      );
  }
}

/**
 * Renders "Model" / "Reasoning effort" / "Context window (tokens)" inputs,
 * gated by the currently-selected agent's actual parameter capability (see
 * docs/design/agent-surface.md "Model & Reasoning-Effort Parameters" and
 * Ruling 4).
 *
 * Resolves `selection` to a full `AgentDirectoryEntry` via
 * `useAgentDirectory` and passes the whole entry to `getCapabilitiesImpl`
 * (default `getAgentParameterCapabilitiesFor`, agent-surface.ts's single
 * kind-dispatch entry point). This component does not itself branch on
 * `entry.kind` to decide capability -- that dispatch lives entirely in the
 * injected function, so both the real accessor and any test stub only need
 * to be swapped in one place to affect both kinds.
 *
 * `contextWindowTokens` additionally requires the resolved capability's own
 * `contextWindowTokens: true` (which `getAgentParameterCapabilitiesFor`
 * already derives as kind-and-model-capability-aware -- always `false` for
 * terminal, `true` for embedded only when Model is capable) AND the current
 * `model` value to be non-empty after trim -- a declared context window
 * with no model override would silently apply to a model it wasn't
 * declared for (Ruling 4).
 *
 * `undefined` selection, or a selection that does not resolve to any entry
 * in the loaded directory yet, renders nothing.
 */
export function AgentParameterFields({
  selection,
  model,
  reasoningEffort,
  contextWindowTokens,
  onModelChange,
  onReasoningEffortChange,
  onContextWindowTokensChange,
  getCapabilitiesImpl = getAgentParameterCapabilitiesFor,
}: AgentParameterFieldsProps) {
  const { entries } = useAgentDirectory();

  const entry = selection ? findEntry(entries, selection) : undefined;
  if (!entry) return null;

  const capabilities = getCapabilitiesImpl(entry);
  const { model: showModel, reasoningEffort: showReasoningEffort } = capabilities;
  if (!showModel && !showReasoningEffort) return null;

  const showContextWindowTokens = capabilities.contextWindowTokens && !!model?.trim();

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {showModel && (
        <FormField label="Model">
          <Input
            value={model ?? ''}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder="e.g. opus"
            className="w-32"
          />
        </FormField>
      )}
      {showReasoningEffort && (
        <FormField label="Reasoning effort">
          <Input
            value={reasoningEffort ?? ''}
            onChange={(e) => onReasoningEffortChange(e.target.value)}
            placeholder="e.g. high"
            className="w-32"
          />
        </FormField>
      )}
      {showContextWindowTokens && (
        <FormField label="Context window (tokens)">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={contextWindowTokens ?? ''}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw.trim() === '') {
                onContextWindowTokensChange(undefined);
                return;
              }
              const parsed = Number(raw);
              onContextWindowTokensChange(Number.isFinite(parsed) ? parsed : undefined);
            }}
            placeholder="e.g. 128000"
            className="w-32"
          />
          <p className="text-xs text-gray-500 mt-1">
            Leave blank to run with an undeclared window (compaction stays inert).
          </p>
        </FormField>
      )}
    </div>
  );
}
