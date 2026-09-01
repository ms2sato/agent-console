import type { AgentDefinition, AgentParameterCapabilities } from '@agent-console/shared';
import { getAgentParameterCapabilities } from '@agent-console/shared';
import { useAgents } from '../../hooks/useAgents';
import { FormField, Input } from '../ui/FormField';

export interface ModelEffortFieldsProps {
  /**
   * Resolved TERMINAL agentId (the currently-selected terminal agent).
   * `undefined` when an embedded agent is selected, or the agent list has
   * not resolved yet -- both `model` and `reasoningEffort` are terminal-only
   * for Phase 1 (docs/design/agent-surface.md), so this component renders
   * nothing in either case. Do not add embedded-agent logic here.
   */
  agentId: string | undefined;
  model: string | undefined;
  reasoningEffort: string | undefined;
  onModelChange: (value: string) => void;
  onReasoningEffortChange: (value: string) => void;
  /**
   * Injectable seam, defaulting to the real `getAgentParameterCapabilities`
   * (the single derivation site, per that function's own doc comment).
   * Exists so a test can prove this component follows the injected
   * function's return value rather than re-deriving capability itself from
   * `agent.commandTemplate`.
   */
  getCapabilitiesImpl?: (agent: AgentDefinition) => AgentParameterCapabilities;
}

/**
 * Renders "Model" / "Reasoning effort" text inputs, gated by the resolved
 * terminal agent's actual capability (see docs/design/agent-surface.md
 * "Model & Reasoning-Effort Parameters"). Neither input renders for an
 * agent whose commandTemplate does not consume the corresponding
 * {{ model...}} / {{ effort...}} placeholder.
 */
export function ModelEffortFields({
  agentId,
  model,
  reasoningEffort,
  onModelChange,
  onReasoningEffortChange,
  getCapabilitiesImpl = getAgentParameterCapabilities,
}: ModelEffortFieldsProps) {
  const { agents } = useAgents();
  const agent = agentId ? agents.find((a) => a.id === agentId) : undefined;

  if (!agent) return null;

  const capabilities = getCapabilitiesImpl(agent);
  if (!capabilities.model && !capabilities.reasoningEffort) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {capabilities.model && (
        <FormField label="Model">
          <Input
            value={model ?? ''}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder="e.g. opus"
            className="w-32"
          />
        </FormField>
      )}
      {capabilities.reasoningEffort && (
        <FormField label="Reasoning effort">
          <Input
            value={reasoningEffort ?? ''}
            onChange={(e) => onReasoningEffortChange(e.target.value)}
            placeholder="e.g. high"
            className="w-32"
          />
        </FormField>
      )}
    </div>
  );
}
